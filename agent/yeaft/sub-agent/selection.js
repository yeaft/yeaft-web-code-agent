/**
 * selection.js — Sub-agent model, effort, and scene resolution.
 *
 * Keeps all child routing policy in one pure module so SpawnAgent validation,
 * delegation identity hashing, runner Engine startup, and parent prompt catalog
 * summaries never drift.
 *
 * Rules:
 *   - Explicit `model` must match an allowed entry in `config.availableModels`
 *     (fail-closed: never silently fall back to another model). Supports exact
 *     `provider/model` refs and unambiguous bare `modelId`.
 *   - Omitted `model` routes by persona:
 *       * fast tier (`explorer`, `researcher`): `config.fastModel` if configured
 *         and routable, else parent model.
 *       * primary tier (`designer`, `implementer`, `reviewer`, or no persona):
 *         parent model.
 *   - Explicit `effort` is validated against the resolved model's supported
 *     effort options (fail-closed) and carries `explicit: true` so sub-agent
 *     enforcement honors it instead of clamping to the legacy `medium` ceiling.
 *   - Omitted `effort` follows persona defaults:
 *       * `designer` (or any persona declaring `defaultEffort`): adapts the
 *         persona's defaultEffort (`xhigh`) to the resolved model's closest
 *         supported tier at or below it (e.g. `high` on Gemini 3.x), and sets
 *         `targetEffort` so the child is not downgraded to `medium`.
 *       * Other personas / no persona: preserves the inherited parent effort
 *         floor/ceiling contract (at least `medium` when the parent ran at or
 *         above `medium`, or inheriting a lower native ceiling such as `low`).
 *   - `scene` validates against `SESSION_SCENE_IDS`; omitted inherits parent
 *     Session `sceneId` (if any).
 */

import { EFFORT_LEVELS } from '../effort.js';
import { inferProtocolFromModelId, normalizeProtocolName } from '../llm/router.js';
import {
  getModelEffortOptions,
  getThinkingCapability,
  normalizeChatEffort,
  normalizeEffort,
  parseModelRef,
  resolveGeminiEffort,
} from '../models.js';
import { isZhLanguage } from '../prompts.js';
import { findEffortModelEntry, usesNativeGeminiLevels } from '../sessions/session-config.js';
import { isSessionSceneId, SESSION_SCENE_IDS } from '../sessions/scene-ids.js';
import { getPersona } from '../personas.js';

const effortRank = value => EFFORT_LEVELS.indexOf(normalizeEffort(value, true));

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function catalogEntryRef(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.ref === 'string' && entry.ref.trim()) return entry.ref.trim();
  if (typeof entry.provider === 'string' && entry.provider.trim() && typeof entry.id === 'string' && entry.id.trim()) {
    return `${entry.provider.trim()}/${entry.id.trim()}`;
  }
  return typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
}

function modelRefMatches(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const a = parseModelRef(left);
  const b = parseModelRef(right);
  if (!a.modelId || a.modelId !== b.modelId) return false;
  return !a.providerName || !b.providerName || a.providerName === b.providerName;
}

function wireProtocolFromEffortProtocol(effortProtocol) {
  if (effortProtocol === 'gemini') return 'gemini';
  if (effortProtocol === 'anthropic' || effortProtocol === 'anthropic-adaptive') return 'anthropic';
  if (effortProtocol === 'openai-reasoning') return 'openai-responses';
  return null;
}

function protocolForEntry(modelRef, entry, config) {
  return normalizeProtocolName(entry?.protocol)
    || wireProtocolFromEffortProtocol(entry?.effortProtocol || entry?.thinkingProtocol)
    || inferProtocolFromModelId(parseModelRef(modelRef).modelId)
    || normalizeProtocolName(config?.adapter)
    || 'openai-responses';
}

function effortContextForEntry(modelRef, entry, config) {
  const protocol = protocolForEntry(modelRef, entry, config);
  return {
    protocol,
    supportsEffort: entry?.supportsEffort,
    effortOptions: entry?.effortOptions,
    thinkingProtocol: entry?.thinkingProtocol || entry?.effortProtocol,
    maxBudgetTokens: entry?.maxBudgetTokens,
  };
}

function supportedEffortsForModel(modelRef, entry, config) {
  const context = effortContextForEntry(modelRef, entry, config);
  const cap = getThinkingCapability(modelRef, context);
  if (!cap.supportsThinking || cap.thinkingProtocol === 'none') {
    return { supportsThinking: false, preserveNative: false, protocol: context.protocol, options: [] };
  }
  const options = getModelEffortOptions(modelRef, context);
  const preserveNative = usesNativeGeminiLevels(modelRef, entry, context.protocol);
  return { supportsThinking: options.length > 0, preserveNative, protocol: context.protocol, options };
}

function modelMatchesRef(entry, requested) {
  if (!entry || !requested) return false;
  const ref = catalogEntryRef(entry);
  if (ref === requested) return true;
  const parsed = parseModelRef(requested);
  if (parsed.providerName) {
    return entry.provider === parsed.providerName && entry.id === parsed.modelId;
  }
  return entry.id === parsed.modelId;
}

function formatAvailableModelSummary(catalog) {
  return catalog
    .map(entry => catalogEntryRef(entry))
    .filter(Boolean)
    .slice(0, 16)
    .join(', ');
}

function resolveCatalogModel(requested, config) {
  const catalog = Array.isArray(config?.availableModels) ? config.availableModels : [];
  if (catalog.length === 0) {
    // Minimal/legacy test harnesses may omit availableModels and only supply config.model.
    const parentModel = cleanString(config?.model) || cleanString(config?.primaryModel);
    if (parentModel && (requested === parentModel || parseModelRef(parentModel).modelId === requested)) {
      return { ok: true, model: parentModel, entry: null };
    }
    return {
      ok: false,
      error: `Model "${requested}" is not in the configured model catalog${parentModel ? ` (active model: ${parentModel})` : ''}.`,
    };
  }

  const parsed = parseModelRef(requested);
  if (parsed.providerName) {
    const exact = catalog.find(entry => modelMatchesRef(entry, requested));
    if (!exact) {
      return {
        ok: false,
        error: `Model "${requested}" is not available. Allowed models: ${formatAvailableModelSummary(catalog)}.`,
      };
    }
    return { ok: true, model: catalogEntryRef(exact), entry: exact };
  }

  const matches = catalog.filter(entry => entry.id === parsed.modelId || catalogEntryRef(entry) === requested);
  if (matches.length === 0) {
    return {
      ok: false,
      error: `Model "${requested}" is not available. Allowed models: ${formatAvailableModelSummary(catalog)}.`,
    };
  }
  if (matches.length > 1) {
    const refs = matches.map(entry => catalogEntryRef(entry)).filter(Boolean);
    return {
      ok: false,
      error: `Model "${requested}" is ambiguous across providers (${refs.join(', ')}). Specify the full provider/model ref.`,
    };
  }
  return { ok: true, model: catalogEntryRef(matches[0]), entry: matches[0] };
}

function pickClosestAtOrBelow(target, options, { modelRef, protocol, preserveNative }) {
  if (!Array.isArray(options) || options.length === 0) return null;
  if (protocol === 'gemini') {
    const resolved = resolveGeminiEffort(modelRef, target, options);
    if (resolved) return resolved;
  }
  const normalizedTarget = protocol === 'openai-chat-completions' ? normalizeChatEffort(target) : normalizeEffort(target, preserveNative);
  if (normalizedTarget && options.includes(normalizedTarget)) return normalizedTarget;
  const targetRank = effortRank(target);
  if (targetRank < 0) return null;
  const eligible = options.filter(option => {
    const rank = effortRank(option);
    return rank >= 0 && rank <= targetRank;
  });
  if (eligible.length > 0) {
    return eligible.sort((a, b) => effortRank(a) - effortRank(b)).at(-1);
  }
  return null;
}

function resolveInheritedModelRef(parentModel, config) {
  const explicitParent = cleanString(parentModel);
  const configModel = cleanString(config?.model);
  const primaryModel = cleanString(config?.primaryModel);
  const raw = explicitParent || configModel || primaryModel;
  if (!raw) return null;
  // loadConfig exposes the configured ref in primaryModel and may leave an
  // unqualified ID in model. Retain the provider qualification when IDs match
  // so multi-provider catalogs resolve the exact owning entry.
  if (!parseModelRef(raw).providerName && primaryModel && parseModelRef(primaryModel).providerName
      && modelRefMatches(raw, primaryModel)) {
    return primaryModel;
  }
  return raw;
}

/**
 * Resolve explicit or default sub-agent model, effort, and scene.
 *
 * @param {object} params
 * @param {string|null} [params.requestedModel]
 * @param {string|null} [params.requestedEffort]
 * @param {string|null} [params.requestedScene]
 * @param {string|null} [params.personaId]
 * @param {object|null} [params.personaData]
 * @param {object|null} [params.config]
 * @param {string|null} [params.parentModel]
 * @param {string|null} [params.parentSceneId]
 * @returns {{
 *   ok: true,
 *   model: string|null,
 *   modelSource: 'explicit'|'persona-fast'|'inherited',
 *   modelEntry: object|null,
 *   effort: string|null,
 *   effortSource: 'explicit'|'persona-default'|'inherited',
 *   sceneId: string|null,
 *   sceneSource: 'explicit'|'inherited'|'none',
 * } | { ok: false, error: string }}
 */
export function resolveSubAgentSelection({
  requestedModel = null,
  requestedEffort = null,
  requestedScene = null,
  personaId = null,
  personaData = null,
  config = null,
  parentModel = null,
  parentSceneId = null,
} = {}) {
  const persona = personaData || (personaId ? getPersona(personaId) : null);

  // 1. Scene resolution (explicit > inherited parent scene > none).
  const explicitScene = cleanString(requestedScene);
  let sceneId = null;
  let sceneSource = 'none';
  if (explicitScene) {
    if (!isSessionSceneId(explicitScene)) {
      return {
        ok: false,
        error: `unknown scene "${explicitScene}"; available: ${SESSION_SCENE_IDS.join(', ')}`,
      };
    }
    sceneId = explicitScene;
    sceneSource = 'explicit';
  } else if (isSessionSceneId(parentSceneId)) {
    sceneId = parentSceneId;
    sceneSource = 'inherited';
  }

  // 2. Model resolution (explicit fail-closed > persona fastModel > parent model).
  const explicitModel = cleanString(requestedModel);
  const rawInheritedModel = resolveInheritedModelRef(parentModel, config);
  let modelEntry = rawInheritedModel ? findEffortModelEntry(config, rawInheritedModel) || null : null;
  const inheritedModel = (modelEntry && catalogEntryRef(modelEntry)) || rawInheritedModel;
  let model = inheritedModel;
  let modelSource = 'inherited';

  if (explicitModel) {
    const resolved = resolveCatalogModel(explicitModel, config);
    if (!resolved.ok) return resolved;
    model = resolved.model;
    modelEntry = resolved.entry;
    modelSource = 'explicit';
  } else if (persona?.modelTier === 'fast') {
    const fastCandidate = cleanString(config?.fastModel);
    if (fastCandidate && !modelRefMatches(fastCandidate, inheritedModel)) {
      const fastResolved = resolveCatalogModel(fastCandidate, config);
      if (fastResolved.ok) {
        model = fastResolved.model;
        modelEntry = fastResolved.entry;
        modelSource = 'persona-fast';
      } else {
        // Fallback for legacy configs where config.fastModel is an unqualified
        // modelId that appears in multiple providers; match router.js's
        // first-provider ownership so persona fast routing stays usable.
        const fallbackEntry = findEffortModelEntry(config, fastCandidate);
        if (fallbackEntry) {
          model = catalogEntryRef(fallbackEntry);
          modelEntry = fallbackEntry;
          modelSource = 'persona-fast';
        }
      }
    }
  }

  // 3. Effort resolution.
  const explicitEffort = cleanString(requestedEffort);
  let effort = null;
  let effortSource = 'inherited';

  if (explicitEffort) {
    if (effortRank(explicitEffort) < 0) {
      return {
        ok: false,
        error: `invalid effort "${explicitEffort}"; valid levels: ${EFFORT_LEVELS.join(', ')}`,
      };
    }
    if (model) {
      const support = supportedEffortsForModel(model, modelEntry, config);
      if (!support.supportsThinking || support.options.length === 0) {
        return {
          ok: false,
          error: `Model "${model}" does not support reasoning effort overrides.`,
        };
      }
      // Fail closed on explicit effort overrides: require exact membership in
      // the resolved model's supported effort options (never silently escalate
      // e.g. `low` -> `medium` or remap `high` -> `xhigh`).
      if (!support.options.includes(explicitEffort)) {
        return {
          ok: false,
          error: `Model "${model}" does not support effort "${explicitEffort}". Supported efforts: ${support.options.join(', ')}.`,
        };
      }
      effort = explicitEffort;
    } else {
      effort = normalizeEffort(explicitEffort, true);
    }
    effortSource = 'explicit';
  } else if (persona?.defaultEffort && model) {
    const support = supportedEffortsForModel(model, modelEntry, config);
    if (support.supportsThinking && support.options.length > 0) {
      const adapted = pickClosestAtOrBelow(persona.defaultEffort, support.options, {
        modelRef: model,
        protocol: support.protocol,
        preserveNative: support.preserveNative,
      });
      if (adapted) {
        effort = adapted;
        effortSource = 'persona-default';
      }
    }
  } else if (persona?.defaultEffort) {
    effort = normalizeEffort(persona.defaultEffort, true);
    effortSource = 'persona-default';
  }

  // Only allow the child to rise above the legacy medium ceiling when the
  // caller explicitly requested an effort or chose a persona with a higher
  // default (e.g. designer -> xhigh). Keep Person's pinned child-provider
  // untouched: Person's guard owns its own ceiling and ignores targetEffort.
  const explicitEffortTarget = (effortSource === 'explicit' || effortSource === 'persona-default')
    ? effort
    : null;

  return {
    ok: true,
    model,
    modelSource,
    modelEntry,
    effort,
    effortSource,
    explicitEffortTarget,
    sceneId,
    sceneSource,
  };
}

/**
 * Format a compact, single-block model+effort inventory for parent-model context
 * when multiple models are configured. Returns '' when <=1 model is available
 * so single-model sessions pay zero prompt token overhead.
 *
 * @param {object|null} config
 * @param {'en'|'zh'} [language='en']
 * @returns {string}
 */
export function formatSubAgentModelCatalogNotice(config, language = 'en') {
  const catalog = Array.isArray(config?.availableModels) ? config.availableModels : [];
  if (catalog.length <= 1) return '';

  const seen = new Set();
  const entries = [];
  let totalUnique = 0;
  for (const item of catalog) {
    const ref = catalogEntryRef(item);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    totalUnique += 1;
    if (entries.length >= 24) continue;
    const support = supportedEffortsForModel(ref, item, config);
    const efforts = support.supportsThinking && support.options.length
      ? `[${support.options.join(',')}]`
      : '[no-effort]';
    entries.push(`${ref} ${efforts}`);
  }
  if (entries.length <= 1) return '';

  const truncated = totalUnique > entries.length ? ` (+${totalUnique - entries.length} more)` : '';
  const list = entries.join('; ') + truncated;
  if (isZhLanguage(language)) {
    return `SpawnAgent 可选模型与 effort（仅按需覆写；省略 model 时 explorer/researcher 默认优先 fastModel，其余继承当前模型；designer 默认 effort=xhigh，其余默认至少 medium）：${list}`;
  }
  return `SpawnAgent available models and efforts (override only when needed; omitting model uses fastModel for explorer/researcher and inherits current model otherwise; designer defaults to effort=xhigh): ${list}`;
}
