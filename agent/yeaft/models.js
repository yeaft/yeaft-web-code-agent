/**
 * models.js — Model ID registry for Yeaft
 *
 * Maps model IDs (e.g. "gpt-5", "claude-sonnet-4-20250514") to the *adapter*
 * metadata Yeaft needs to dispatch requests: protocol and base URL. Effort
 * options are resolved separately from the effective API, never model IDs.
 *
 * Yeaft does not provide its own models. The "model" field is always a
 * model ID from an external provider. This registry lets Yeaft auto-detect
 * the correct adapter and endpoint from just the model ID, so users only
 * need to set YEAFT_MODEL=gpt-5 without configuring adapter/baseUrl separately.
 *
 * **Token limits (contextWindow / maxOutput) are NOT stored here.** They are
 * resolved at runtime from the models.dev community catalog
 * (`agent/yeaft/llm/models-dev.js`), with a per-provider config override
 * (`~/.yeaft/config.json: providers[].models[].contextWindow`) and a
 * DEFAULT as the final rung. See {@link resolveContextWindow}
 * and {@link resolveMaxOutputTokens} for the full ladder.
 *
 * Unknown model IDs return null — caller falls back to env-based detection.
 */

import { lookupModelLimitSync } from './llm/models-dev.js';

/**
 * @typedef {Object} ModelInfo
 * @property {'anthropic' | 'openai' | 'deepseek' | 'google'} provider — Which provider this model belongs to.
 *   These ids are intentionally aligned with the top-level keys in the models.dev
 *   catalog so they can be used as a `providerHint` to {@link lookupModelLimitSync}.
 * @property {'anthropic' | 'openai-responses'} adapter — Which wire protocol to use
 * @property {string} baseUrl — Official API endpoint base URL
 * @property {string} displayName — Human-readable model name
 */

/** @type {Map<string, ModelInfo>} */
export const MODEL_REGISTRY = new Map([
  // ── Anthropic ──────────────────────────────────────────────────
  ['claude-sonnet-4-20250514', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Claude Sonnet 4',
  }],
  ['claude-opus-4-20250514', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Claude Opus 4',
  }],
  ['claude-opus-4-8', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Claude Opus 4.8',
  }],
  ['claude-opus-4.8', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Claude Opus 4.8',
  }],
  ['claude-haiku-3-20250414', {
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Claude Haiku 3',
  }],

  // ── OpenAI ─────────────────────────────────────────────────────
  ['gpt-5', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5',
  }],
  ['gpt-5-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Mini',
  }],
  ['gpt-5-nano', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Nano',
  }],
  ['gpt-5-pro', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5 Pro',
  }],
  ['gpt-5.4', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5.4',
  }],
  ['gpt-5.5', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-5.5',
  }],
  ['gpt-4.1', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-4.1',
  }],
  ['gpt-4.1-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-4.1 Mini',
  }],
  ['gpt-4.1-nano', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'GPT-4.1 Nano',
  }],
  ['o3', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'o3',
  }],
  ['o4-mini', {
    provider: 'openai',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'o4-mini',
  }],

  // ── DeepSeek ───────────────────────────────────────────────────
  ['deepseek-chat', {
    provider: 'deepseek',
    adapter: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    displayName: 'DeepSeek Chat',
  }],
  ['deepseek-reasoner', {
    provider: 'deepseek',
    adapter: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    displayName: 'DeepSeek Reasoner',
  }],

  // ── Google (via OpenAI-compatible API) ─────────────────────────
  ['gemini-2.5-pro', {
    provider: 'google',
    adapter: 'openai-responses',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    displayName: 'Gemini 2.5 Pro',
  }],
  ['gemini-2.5-flash', {
    provider: 'google',
    adapter: 'openai-responses',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    displayName: 'Gemini 2.5 Flash',
  }],
]);

/**
 * Resolve a model name to its registry info.
 *
 * @param {string} modelName — The model name (e.g., 'gpt-5', 'claude-sonnet-4-20250514')
 * @returns {ModelInfo | null} — Model info, or null if not in registry
 */
export function resolveModel(modelName) {
  if (!modelName) return null;
  const info = MODEL_REGISTRY.get(modelName);
  // Return a shallow copy so callers can't mutate the registry
  return info ? { ...info } : null;
}

/**
 * Default context window when no upstream source has a value. Use 1M for
 * unknown models; explicit per-model limits and catalog metadata still win,
 * including smaller windows. Gateways can override each model in config.json.
 *
 * Single source of truth: callers (engine.js pre-flight guard,
 * tools/registry.js per-result cap) MUST use this constant or
 * {@link resolveContextWindow} instead of hardcoding a fallback.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Default per-call output cap when no upstream source has a value. This is
 * the floor the adapters use to size `max_tokens`; production models give us
 * more, but 16K is enough to make progress on any single turn without
 * tripping a provider-side reject.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Look up a model capability without mistaking a local provider label for part
 * of its catalog ID. Preserve literal namespaced IDs first; remove only one
 * configured prefix so gateway/vendor/model remains vendor/model. Do not
 * change the requested wire model, catalog collision policy or explicit limits.
 * @param {string} modelName
 * @returns {{ context?: number, output?: number } | null}
 */
function lookupRuntimeModelLimit(modelName) {
  const literal = lookupModelLimitSync(modelName, MODEL_REGISTRY.get(modelName)?.provider || null);
  if (literal) return literal;
  if (typeof modelName !== 'string') return null;
  const slash = modelName.indexOf('/');
  if (slash < 1) return null;
  const bare = modelName.slice(slash + 1);
  return lookupModelLimitSync(bare, MODEL_REGISTRY.get(bare)?.provider || null);
}

/**
 * Resolve the live context window for a model.
 *
 * Fallback ladder (first match wins):
 *   1. `config.modelInfo.contextWindow` — per-provider override originating
 *      from `~/.yeaft/config.json: providers[].models[].contextWindow`. The
 *      caller is responsible for passing the relevant entry; loadConfig
 *      threads it through `config.modelInfo` already.
 *   2. {@link lookupModelLimitSync} against the warmed models.dev snapshot,
 *      hinted by the MODEL_REGISTRY provider when available so collisions
 *      across providers resolve to the right entry.
 *   3. `config.maxContextTokens` — global ceiling from config / CLI.
 *   4. {@link DEFAULT_CONTEXT_WINDOW}.
 *
 * Used by the per-tool-result cap and the pre-flight token guard so the
 * defense layers always see the same number, regardless of which seam
 * resolves it first.
 *
 * @param {string} modelName
 * @param {{ maxContextTokens?: number, modelInfo?: { contextWindow?: number } } | null} [config]
 * @returns {number}
 */
export function resolveContextWindow(modelName, config) {
  // Rung 1: per-provider config override threaded via config.modelInfo.
  const overrideCtx = config?.modelInfo?.contextWindow;
  if (Number.isFinite(overrideCtx) && overrideCtx > 0) return overrideCtx;

  // Rung 2: models.dev snapshot (warmed at agent boot).
  const limit = lookupRuntimeModelLimit(modelName);
  if (limit && Number.isFinite(limit.context) && limit.context > 0) {
    return limit.context;
  }

  // Rung 3: global config ceiling.
  const cfg = config && Number.isFinite(config.maxContextTokens) && config.maxContextTokens > 0
    ? config.maxContextTokens : null;
  if (cfg !== null) return cfg;

  // Rung 4: default.
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve the live per-call output cap for a model. Same ladder as
 * {@link resolveContextWindow} but for the `output` axis:
 *   1. `config.modelInfo.maxOutput` override
 *   2. models.dev `limit.output`
 *   3. `config.maxOutputTokens`
 *   4. {@link DEFAULT_MAX_OUTPUT_TOKENS}
 *
 * @param {string} modelName
 * @param {{ maxOutputTokens?: number, modelInfo?: { maxOutput?: number, maxOutputTokens?: number } } | null} [config]
 * @returns {number}
 */
export function resolveMaxOutputTokens(modelName, config) {
  const overrideOut = config?.modelInfo?.maxOutput
    ?? config?.modelInfo?.maxOutputTokens;
  if (Number.isFinite(overrideOut) && overrideOut > 0) return overrideOut;

  const limit = lookupRuntimeModelLimit(modelName);
  if (limit && Number.isFinite(limit.output) && limit.output > 0) {
    return limit.output;
  }

  const cfg = config && Number.isFinite(config.maxOutputTokens) && config.maxOutputTokens > 0
    ? config.maxOutputTokens : null;
  if (cfg !== null) return cfg;

  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * List all known models with their resolved token limits.
 *
 * Token limits are resolved at call time — they reflect whatever models.dev
 * snapshot is currently warmed, plus the DEFAULT fallback for models the
 * snapshot doesn't cover. The returned objects therefore mirror what
 * `resolveContextWindow` / `resolveMaxOutputTokens` would return for the
 * same model id.
 *
 * @returns {{ name: string, adapter: string, baseUrl: string, contextWindow: number, maxOutputTokens: number, displayName: string }[]}
 */
export function listModels() {
  const result = [];
  for (const [name, info] of MODEL_REGISTRY) {
    result.push({
      name,
      ...info,
      contextWindow: resolveContextWindow(name, null),
      maxOutputTokens: resolveMaxOutputTokens(name, null),
    });
  }
  return result;
}

/**
 * Check if a model name is in the registry.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
export function isKnownModel(modelName) {
  return MODEL_REGISTRY.has(modelName);
}

/**
 * Get the provider name for a model.
 *
 * @param {string} modelName
 * @returns {string|null} — Provider name ('anthropic', 'openai', 'deepseek', 'google') or null
 */
export function getProviderForModel(modelName) {
  const info = MODEL_REGISTRY.get(modelName);
  return info ? info.provider : null;
}

/**
 * Parse a model reference in "providerName/modelId" format.
 *
 * @param {string} ref — e.g. "my-proxy/claude-sonnet-4-20250514" or "claude-sonnet-4-20250514"
 * @returns {{ providerName: string|null, modelId: string }}
 */
export function parseModelRef(ref) {
  if (!ref) return { providerName: null, modelId: '' };
  const slashIdx = ref.indexOf('/');
  if (slashIdx === -1) {
    return { providerName: null, modelId: ref };
  }
  return {
    providerName: ref.slice(0, slashIdx),
    modelId: ref.slice(slashIdx + 1),
  };
}

// ─── task-327a: thinking / reasoning capability ─────────────────

/**
 * Valid effort levels accepted by Yeaft adapters.
 * @typedef {'medium' | 'xhigh' | 'max' | 'ultra'} Effort
 */

/**
 * Budget-token map for the Anthropic extended-thinking protocol.
 * Explicit thinkingProtocol:'anthropic' selects these legacy manual budgets.
 * A configured maxBudgetTokens can cap them at the request boundary.
 */
export const ANTHROPIC_THINKING_BUDGETS = {
  medium: 8192,
  xhigh: 16384,
  max: 32000,
};

/**
 * Map a Yeaft effort level to the OpenAI reasoning.effort enum. Supported
 * values are API/explicit-config dependent; filtering happens before this wire
 * translation. Unsupported values are dropped; the adapter MUST NOT error.
 *
 * @param {Effort} effort
 * @returns {'medium' | 'xhigh' | 'max' | 'ultra' | null}
 */
export function mapEffortToOpenAIReasoning(effort) {
  if (!effort) return null;
  switch (effort) {
    case 'medium': return 'medium';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    case 'ultra': return 'ultra';
    default: return null;
  }
}

// Effort is an API contract, not a model-name allowlist. Compatible gateways
// can expose new IDs/aliases without requiring a Yeaft release.
export const OPENAI_REASONING_EFFORT_OPTIONS = Object.freeze(['medium', 'xhigh', 'max', 'ultra']);
export const ANTHROPIC_ADAPTIVE_EFFORT_OPTIONS = Object.freeze(['medium', 'xhigh', 'max']);
export const ANTHROPIC_MANUAL_EFFORT_OPTIONS = Object.freeze(['medium', 'xhigh', 'max']);

export function normalizeEffortOptions(options) {
  if (!Array.isArray(options)) return null;
  const out = [...new Set(options.map(normalizeEffort).filter(Boolean))];
  return out.length ? out : null;
}

/**
 * Resolve the Anthropic thinking budget_tokens value for a given (model, effort).
 *
 * API-level defaults; model IDs do not change manual budgets.
 *
 * @param {string} model
 * @param {Effort} effort
 * @returns {number | null} Null when effort is unknown/falsy.
 */
export function thinkingBudgetForEffort(model, effort) {
  if (!effort) return null;
  return ANTHROPIC_THINKING_BUDGETS[effort] ?? null;
}

/**
 * Resolve effort from the effective wire API. Callers with a resolved route must
 * supply protocol; model IDs are only a legacy fallback for choosing that API.
 * Explicit capability overrides can narrow/disable effort or opt into Anthropic
 * manual budgets, but registry/model-family metadata never gates API effort.
 * @param {string} model
 * @param {{protocol?: string, supportsEffort?: boolean, effortOptions?: string[],
 *   thinkingProtocol?: string, defaultEffort?: string, maxBudgetTokens?: number}} context
 */
export function getThinkingCapability(model, context = {}) {
  const modelId = parseModelRef(model).modelId.toLowerCase();
  const protocol = context.protocol || (
    context.thinkingProtocol?.startsWith('anthropic') ||
    MODEL_REGISTRY.get(modelId)?.adapter === 'anthropic' ||
    modelId.startsWith('claude') || modelId.includes('/claude') || modelId.includes('.claude')
      ? 'anthropic' : 'openai-responses'
  );
  const disabled = { supportsThinking: false, thinkingProtocol: 'none', defaultEffort: null, maxBudgetTokens: null, effortOptions: [] };
  if (context.supportsEffort === false || context.thinkingProtocol === 'none') return disabled;
  if (protocol !== 'anthropic' && protocol !== 'openai-responses') return disabled;
  const manual = protocol === 'anthropic' && context.thinkingProtocol === 'anthropic';
  const thinkingProtocol = protocol === 'openai-responses' ? 'openai-reasoning'
    : manual ? 'anthropic' : 'anthropic-adaptive';
  const apiOptions = protocol === 'openai-responses' ? OPENAI_REASONING_EFFORT_OPTIONS
    : manual ? ANTHROPIC_MANUAL_EFFORT_OPTIONS : ANTHROPIC_ADAPTIVE_EFFORT_OPTIONS;
  const overrides = normalizeEffortOptions(context.effortOptions);
  const effortOptions = overrides ? apiOptions.filter(value => overrides.includes(value)) : [...apiOptions];
  if (!effortOptions.length) return disabled;
  const defaultEffort = normalizeEffort(context.defaultEffort) || (thinkingProtocol === 'anthropic-adaptive' ? 'xhigh' : null);
  return {
    supportsThinking: true,
    thinkingProtocol,
    defaultEffort: effortOptions.includes(defaultEffort) ? defaultEffort : null,
    maxBudgetTokens: manual ? context.maxBudgetTokens ?? ANTHROPIC_THINKING_BUDGETS.max : null,
    effortOptions,
  };
}

export function getModelEffortOptions(model, context = {}) {
  return getThinkingCapability(model, context).effortOptions.slice();
}

export function modelSupportsEffort(model, context = {}) {
  return getModelEffortOptions(model, context).length > 0;
}

/**
 * Valid-effort guard. Unknown values → null (caller should treat as "no effort").
 *
 * @param {unknown} effort
 * @returns {Effort | null}
 */
export function normalizeEffort(effort) {
  // Read legacy selections without retaining retired tiers in new requests.
  if (effort === 'minimal' || effort === 'low') return 'medium';
  if (effort === 'high') return 'xhigh';
  if (effort === 'medium' || effort === 'xhigh' || effort === 'max' || effort === 'ultra') {
    return effort;
  }
  return null;
}

/**
 * Coerce a possibly-stringy numeric value to a positive integer, or
 * `undefined` if it's empty / zero / NaN / negative / non-finite.
 *
 * @param {*} v
 * @returns {number | undefined}
 */
function coercePositiveInt(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Normalize a provider's `models` field into an in-memory array of
 * `{ id, contextWindow?, maxOutput? }` objects.
 *
 * Accepts legacy `string[]` and new object form `{id, contextWindow, maxOutput}`.
 * Empty / 0 / NaN / negative context/max values are treated as unset (dropped).
 *
 * @param {{ models?: Array<string | object> } | null | undefined} provider
 * @returns {Array<{ id: string, contextWindow?: number, maxOutput?: number }>}
 */
export function normalizeProviderModels(provider) {
  if (!provider || !Array.isArray(provider.models)) return [];
  const out = [];
  for (const entry of provider.models) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id) out.push({ id });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
      const norm = { id: entry.id.trim() };
      if (entry.capabilities && typeof entry.capabilities === 'object') norm.capabilities = { ...entry.capabilities };
      if (Number.isFinite(entry.streamIdleTimeoutMs) && entry.streamIdleTimeoutMs >= 0) {
        norm.streamIdleTimeoutMs = Math.min(600_000, Math.floor(entry.streamIdleTimeoutMs));
      }
      const ctx = coercePositiveInt(entry.contextWindow);
      const max = coercePositiveInt(entry.maxOutput);
      if (ctx !== undefined) norm.contextWindow = ctx;
      if (max !== undefined) norm.maxOutput = max;
      if (typeof entry.protocol === 'string' && entry.protocol.trim()) {
        norm.protocol = entry.protocol.trim();
      }
      if (typeof entry.supportsEffort === 'boolean') norm.supportsEffort = entry.supportsEffort;
      if (typeof entry.thinkingProtocol === 'string' && entry.thinkingProtocol.trim()) {
        norm.thinkingProtocol = entry.thinkingProtocol.trim();
      }
      const effortOptions = normalizeEffortOptions(entry.effortOptions);
      if (effortOptions) norm.effortOptions = effortOptions;
      const maxBudget = coercePositiveInt(entry.maxBudgetTokens);
      if (maxBudget !== undefined) norm.maxBudgetTokens = maxBudget;
      out.push(norm);
    }
    // silently skip anything else (null / missing id / numbers)
  }
  return out;
}

/**
 * Serialize a normalized model entry back for persistence.
 * - id-only → plain string (back-compat with existing configs)
 * - with ctx or max → object with only the fields that are set
 *
 * @param {{ id: string, contextWindow?: number, maxOutput?: number }} entry
 * @returns {string | object}
 */
export function serializeModelForPersistence(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const ctx = coercePositiveInt(entry.contextWindow);
  const max = coercePositiveInt(entry.maxOutput);
  const proto = typeof entry.protocol === 'string' && entry.protocol.trim()
    ? entry.protocol.trim()
    : undefined;
  const capabilities = entry.capabilities && typeof entry.capabilities === 'object' ? { ...entry.capabilities } : undefined;
  const streamIdleTimeoutMs = Number.isFinite(entry.streamIdleTimeoutMs) && entry.streamIdleTimeoutMs >= 0
    ? Math.min(600_000, Math.floor(entry.streamIdleTimeoutMs)) : undefined;
  const effort = {};
  if (typeof entry.supportsEffort === 'boolean') effort.supportsEffort = entry.supportsEffort;
  if (typeof entry.thinkingProtocol === 'string' && entry.thinkingProtocol.trim()) effort.thinkingProtocol = entry.thinkingProtocol.trim();
  const effortOptions = normalizeEffortOptions(entry.effortOptions);
  if (effortOptions) effort.effortOptions = effortOptions;
  const maxBudget = coercePositiveInt(entry.maxBudgetTokens);
  if (maxBudget !== undefined) effort.maxBudgetTokens = maxBudget;
  if (ctx === undefined && max === undefined && proto === undefined && capabilities === undefined && streamIdleTimeoutMs === undefined && !Object.keys(effort).length) return entry.id;
  const obj = { id: entry.id, ...effort };
  if (capabilities !== undefined) obj.capabilities = capabilities;
  if (streamIdleTimeoutMs !== undefined) obj.streamIdleTimeoutMs = streamIdleTimeoutMs;
  if (ctx !== undefined) obj.contextWindow = ctx;
  if (max !== undefined) obj.maxOutput = max;
  if (proto !== undefined) obj.protocol = proto;
  return obj;
}

/**
 * Resolve model info with per-provider override.
 *
 * Lookup order:
 *   1. provider-config fields (contextWindow / maxOutput) — highest priority
 *   2. models.dev snapshot (`limit.{context,output}`) via the synchronous
 *      reader, hinted by the MODEL_REGISTRY provider when known so cross-
 *      provider id collisions resolve to the right entry.
 *   3. undefined if neither has any info
 *
 * Returns a normalized shape: `{ id, contextWindow?, maxOutput?, provider?, adapter?, baseUrl?, displayName? }`.
 *
 * Note: token limits are intentionally NOT read from MODEL_REGISTRY — those
 * fields were removed when models.dev became the source of truth.
 *
 * @param {string} model
 * @param {{ id?: string, contextWindow?: number, maxOutput?: number } | null} [providerConfig]
 * @returns {object | undefined}
 */
export function getModelInfo(model, providerConfig) {
  if (!model) return undefined;
  const reg = MODEL_REGISTRY.get(model);
  const overrideCtx = coercePositiveInt(providerConfig?.contextWindow);
  const overrideMax = coercePositiveInt(providerConfig?.maxOutput);

  // Pull the models.dev numbers as the second rung. Hint with the registry's
  // provider id when available — same alignment trick the resolveContext-
  // Window ladder uses.
  const limit = lookupRuntimeModelLimit(model);
  const ctx = overrideCtx ?? (limit && Number.isFinite(limit.context) && limit.context > 0 ? limit.context : undefined);
  const max = overrideMax ?? (limit && Number.isFinite(limit.output) && limit.output > 0 ? limit.output : undefined);

  // If we have literally no information, return undefined
  if (!reg && ctx === undefined && max === undefined) return undefined;

  const info = { id: model };
  if (reg) {
    if (reg.provider) info.provider = reg.provider;
    if (reg.adapter) info.adapter = reg.adapter;
    if (reg.baseUrl) info.baseUrl = reg.baseUrl;
    if (reg.displayName) info.displayName = reg.displayName;
  }
  if (ctx !== undefined) info.contextWindow = ctx;
  if (max !== undefined) info.maxOutput = max;
  return info;
}
