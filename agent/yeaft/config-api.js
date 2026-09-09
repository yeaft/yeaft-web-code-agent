/**
 * config-api.js — Read/write Yeaft config.json for remote management
 *
 * Provides functions to get and update the LLM-related portion of
 * ~/.yeaft/config.json via WebSocket messages from the web UI.
 *
 * Only exposes provider/model configuration — not internal fields
 * like maxContinueTurns or debug that don't belong in the UI.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { getModelEffortOptions, normalizeEffort, normalizeProviderModels, parseModelRef, resolveMaxOutputTokens, serializeModelForPersistence } from './models.js';
import { inferProtocolFromModelId } from './llm/router.js';
import { clampYeaftField, normaliseTelemetrySection, normaliseYeaftSection } from './config.js';
import { normaliseBrowserRuntimeSection, validateBrowserRuntimeUpdate } from '../browser-runtime/config.js';
import { normalizePluginConfig } from './plugins.js';
import { mutateAgentConfig, readAgentConfigForWrite } from './config-store.js';
import { isGitHubCopilotProvider, normalizeKnownProviderForRuntime, serializeKnownProviderForPersistence } from './llm/known-providers.js';

/** Agent-owned model catalog, with the same protocol/capability resolution as runtime. */
function quickSendModels(config) {
  return (Array.isArray(config.providers) ? config.providers : []).flatMap(raw => {
    const provider = normalizeKnownProviderForRuntime(raw);
    return normalizeProviderModels(provider).map(model => ({
      id: model.id,
      ref: provider.name ? `${provider.name}/${model.id}` : model.id,
      provider: provider.name,
      label: model.id,
      effortOptions: getModelEffortOptions(model.id, {
        ...model,
        protocol: model.protocol || provider.protocol || inferProtocolFromModelId(model.id) || 'openai-responses',
      }),
      maxOutput: resolveMaxOutputTokens(model.id, { modelInfo: model }),
    }));
  });
}

/** Validate inside mutateAgentConfig's lock, against the resulting provider catalog. */
function validateQuickSends(value, config) {
  if (!Array.isArray(value) || value.length > 5) throw new Error('quickSends must be an array of at most 5 items');
  const models = quickSendModels(config);
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each quick send must be an object');
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id || id.length > 128 || ids.has(id)) throw new Error('Quick send id must be unique and 1–128 characters');
    if (!name || name.length > 80) throw new Error('Quick send name must be 1–80 characters');
    ids.add(id);
    const ref = typeof item.model === 'string' ? item.model.trim() : '';
    const matches = models.filter(model => model.ref === ref);
    const candidates = matches.length ? matches : models.filter(model => model.id === ref);
    if (candidates.length !== 1) throw new Error(`Quick send model must exist and be unambiguous: ${ref}`);
    const model = candidates[0];
    const effort = item.effort ?? null;
    if (effort !== null && (!normalizeEffort(effort) || !model.effortOptions.includes(effort))) {
      throw new Error(`Quick send effort is not available for ${model.ref}`);
    }
    const maxOutputTokens = item.maxOutputTokens ?? null;
    if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > model.maxOutput)) {
      throw new Error(`Quick send maxOutputTokens must be a positive integer no greater than ${model.maxOutput}`);
    }
    return { id, name, model: model.ref, effort, maxOutputTokens };
  });
}

/**
 * Read config.json before any public mutation. A missing file is a valid
 * first-run state, but an existing malformed file, non-object root, or invalid
 * Plugins schema must never be replaced by an unrelated Settings/MCP write.
 * Otherwise the runtime's fail-closed policy could silently become inheritance
 * (all capabilities enabled) on the next config reload.
 *
 * @param {string} configPath
 * @returns {Record<string, unknown>}
 * @throws {Error} when an existing config cannot be safely preserved
 */
function readConfigForWrite(configPath) {
  return readAgentConfigForWrite(configPath);
}

/**
 * Read the LLM-relevant portion of config.json.
 *
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ providers, primaryModel, fastModel, language } | { error: string }}
 */
function readLocalLlmConfig(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');

  if (!existsSync(configPath)) {
    return { providers: [], primaryModel: null, fastModel: null, language: 'en', quickSends: [], availableModels: [], needsSetup: true };
  }

  const raw = readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw);
  const providers = Array.isArray(json.providers) ? json.providers : [];
  return {
    providers,
    primaryModel: json.primaryModel || null,
    fastModel: json.fastModel || null,
    language: json.language || 'en',
    debug: json.debug === true,
    quickSends: Array.isArray(json.quickSends) ? json.quickSends : [],
    availableModels: quickSendModels(json),
    needsSetup: providers.length === 0 || providers.every(p => p.apiKey === 'proxy' || p.apiKey === '' || (!p.apiKey && !p.credentialProvider)),
  };
}

export function getLlmConfig(dir) {
  try {
    const agentConfig = readLocalLlmConfig(dir);
    return {
      ...agentConfig,
      agentConfig,
      effectiveConfig: agentConfig,
    };
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
}

function providerModelIds(provider) {
  return new Set(normalizeProviderModels(provider).map(model => model.id));
}

function bareModelOwners(providers, modelId) {
  const owners = new Set();
  for (const provider of providers) {
    if (provider?.name && providerModelIds(provider).has(modelId)) owners.add(provider.name);
  }
  return owners;
}

function modelSelectionIsValid(selection, providers, authoritativeManagedNames) {
  if (!selection) return false;
  const parsed = parseModelRef(selection);
  if (!parsed.modelId) return false;
  if (!parsed.providerName) return bareModelOwners(providers, parsed.modelId).size === 1;
  if (!authoritativeManagedNames.has(parsed.providerName)) return true;
  const provider = providers.find(item => item?.name === parsed.providerName);
  return !!provider && providerModelIds(provider).has(parsed.modelId);
}

function normalizeManagedModelDefaults(config) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const authoritativeManagedProviders = providers.filter(provider =>
    isGitHubCopilotProvider(provider)
      && Array.isArray(provider.models)
      && provider.models.length > 0);
  if (authoritativeManagedProviders.length === 0) return;

  const authoritativeManagedNames = new Set(authoritativeManagedProviders.map(provider => provider.name));
  const fallbackProvider = authoritativeManagedProviders.find(provider => providerModelIds(provider).size > 0);
  const fallbackModelId = fallbackProvider
    ? providerModelIds(fallbackProvider).values().next().value
    : null;
  const managedFallback = fallbackProvider && fallbackModelId
    ? `${fallbackProvider.name}/${fallbackModelId}`
    : null;

  if (config.primaryModel
    && !modelSelectionIsValid(config.primaryModel, providers, authoritativeManagedNames)) {
    config.primaryModel = managedFallback;
  }
  const validPrimary = modelSelectionIsValid(config.primaryModel, providers, authoritativeManagedNames)
    ? config.primaryModel
    : managedFallback;
  if (config.fastModel
    && !modelSelectionIsValid(config.fastModel, providers, authoritativeManagedNames)) {
    config.fastModel = validPrimary;
  }
}

/**
 * Update the LLM-relevant portion of config.json.
 * Merges into existing config — preserves fields like debug, maxContextTokens, etc.
 *
 * @param {object} update — { providers?, primaryModel?, fastModel?, language? }
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ providers, primaryModel, fastModel, language } | { error: string }}
 */
export function updateLlmConfig(update, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;

  if (update.providers !== undefined) {
    if (!Array.isArray(update.providers)) return { error: 'providers must be an array' };
    for (const provider of update.providers) {
      if (!provider.name || typeof provider.name !== 'string') {
        return { error: 'Each provider must have a name' };
      }
      if (isGitHubCopilotProvider(provider)) continue;
      if (!provider.baseUrl || typeof provider.baseUrl !== 'string') {
        return { error: `Provider "${provider.name}" must have a baseUrl` };
      }
      if (!Array.isArray(provider.models) || provider.models.length === 0) {
        return { error: `Provider "${provider.name}" must have at least one model` };
      }
    }
  }

  try {
    return mutateAgentConfig(root, existing => {
      if (update.providers !== undefined) {
        existing.providers = update.providers.map(provider => {
          const managed = serializeKnownProviderForPersistence(provider);
          if (managed) return managed;
          return {
            ...provider,
            models: normalizeProviderModels(provider).map(serializeModelForPersistence),
          };
        });
      }
      if (update.primaryModel !== undefined) existing.primaryModel = update.primaryModel || null;
      if (update.fastModel !== undefined) existing.fastModel = update.fastModel || null;
      if (update.providers !== undefined) normalizeManagedModelDefaults(existing);
      if (update.language !== undefined) existing.language = update.language;
      if (update.debug !== undefined) existing.debug = update.debug === true;
      if (update.quickSends !== undefined) existing.quickSends = validateQuickSends(update.quickSends, existing);

      const agentConfig = {
        providers: Array.isArray(existing.providers) ? existing.providers : [],
        primaryModel: existing.primaryModel || null,
        fastModel: existing.fastModel || null,
        language: existing.language || 'en',
        debug: existing.debug === true,
        quickSends: Array.isArray(existing.quickSends) ? existing.quickSends : [],
        availableModels: quickSendModels(existing),
      };
      return {
        ...agentConfig,
        agentConfig,
        effectiveConfig: agentConfig,
      };
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

// ─── Yeaft runtime settings (task-318) ────────────────────────────

/**
 * Read the Yeaft-section of config.json. Returns defaults when the file
 * or section is absent. Callers (UI, registry, ThreadStore) rely on a
 * stable shape — `normaliseYeaftSection` guarantees that.
 *
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number, recentTurnsLimit: number, relatedTurnsLimit: number, dream: object } | { error: string }}
 */
export function getYeaftSettings(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  if (!existsSync(configPath)) return normaliseYeaftSection(null);
  try {
    const raw = readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    return normaliseYeaftSection(json.yeaft);
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
}

/**
 * Update the Yeaft-section of config.json. Merges into existing config
 * (LLM provider / model fields are untouched) and validates each field:
 * `maxConcurrentThreads` must be 1..50, `autoArchiveIdleDays` must be
 * 1..3650, `recentTurnsLimit` must be 1..500, `relatedTurnsLimit` must be
 * 0..10 (0 disables related recall). Dream limits are read-only
 * runtime defaults here; invalid values are rejected
 * outright so the UI sees an error rather than silently reverting — a
 * silent revert would make "I set it to 100 and nothing happened"
 * impossible to debug.
 *
 * @param {{ maxConcurrentThreads?: number, autoArchiveIdleDays?: number, recentTurnsLimit?: number, relatedTurnsLimit?: number }} update
 * @param {string} [dir]
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number, recentTurnsLimit: number, relatedTurnsLimit: number, dream: object } | { error: string }}
 */
export function updateYeaftSettings(update, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;

  if (!update || typeof update !== 'object') {
    return { error: 'update payload required' };
  }

  // Validate before touching the file. We enforce the same clamp bounds
  // that `normaliseYeaftSection` uses for reads so round-trip is stable.
  if (update.maxConcurrentThreads !== undefined) {
    const n = Number(update.maxConcurrentThreads);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      return { error: 'maxConcurrentThreads must be between 1 and 50' };
    }
  }
  if (update.autoArchiveIdleDays !== undefined) {
    const n = Number(update.autoArchiveIdleDays);
    if (!Number.isFinite(n) || n < 1 || n > 3650) {
      return { error: 'autoArchiveIdleDays must be between 1 and 3650' };
    }
  }
  if (update.recentTurnsLimit !== undefined) {
    const n = Number(update.recentTurnsLimit);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return { error: 'recentTurnsLimit must be between 1 and 500' };
    }
  }
  if (update.relatedTurnsLimit !== undefined) {
    const value = clampYeaftField(update.relatedTurnsLimit, 'relatedTurnsLimit');
    const n = Number(update.relatedTurnsLimit);
    if (value === null || n < 0 || n > 10) {
      return { error: 'relatedTurnsLimit must be between 0 and 10' };
    }
  }

  try {
    return mutateAgentConfig(root, existing => {
      const prev = normaliseYeaftSection(existing.yeaft);
      const merged = {
        maxConcurrentThreads: update.maxConcurrentThreads !== undefined
          ? Math.floor(Number(update.maxConcurrentThreads))
          : prev.maxConcurrentThreads,
        autoArchiveIdleDays: update.autoArchiveIdleDays !== undefined
          ? Math.floor(Number(update.autoArchiveIdleDays))
          : prev.autoArchiveIdleDays,
        recentTurnsLimit: update.recentTurnsLimit !== undefined
          ? Math.floor(Number(update.recentTurnsLimit))
          : prev.recentTurnsLimit,
        relatedTurnsLimit: update.relatedTurnsLimit !== undefined
          ? clampYeaftField(update.relatedTurnsLimit, 'relatedTurnsLimit')
          : prev.relatedTurnsLimit,
      };
      if (existing.yeaft?.dream && typeof existing.yeaft.dream === 'object') {
        merged.dream = existing.yeaft.dream;
      }
      existing.yeaft = merged;
      return merged;
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

/**
 * Read the bounded local telemetry settings.
 *
 * Raw provider exchanges are kept only for the debug trace and are bounded by
 * bytes. This endpoint never returns secrets or trace payloads.
 *
 * @param {string} [dir]
 * @returns {object | { error: string }}
 */
export function getTelemetrySettings(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  if (!existsSync(configPath)) return normaliseTelemetrySection(null);
  try {
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    return normaliseTelemetrySection(json.telemetry);
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
}

/**
 * Update only the telemetry section of config.json.
 *
 * @param {object} update
 * @param {string} [dir]
 * @returns {object | { error: string }}
 */
export function updateTelemetrySettings(update, dir) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return { error: 'update payload required' };
  }
  const allowed = new Set(['enabled', 'retentionDays', 'flushIntervalMs', 'maxQueueSize', 'rawExchangeMaxBytes', 'traceTextMaxBytes']);
  if (Object.keys(update).some(key => !allowed.has(key))) {
    return { error: 'unknown telemetry setting' };
  }
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  try {
    return mutateAgentConfig(root, existing => {
      const merged = normaliseTelemetrySection({
        ...(existing.telemetry && typeof existing.telemetry === 'object' ? existing.telemetry : {}),
        ...update,
      });
      existing.telemetry = merged;
      return merged;
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

// ─── Browser Runtime settings ───────────────────────────────────────

export function getBrowserRuntimeSettings(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  if (!existsSync(configPath)) return normaliseBrowserRuntimeSection(null);
  try {
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    return normaliseBrowserRuntimeSection(json.browserRuntime);
  } catch (error) {
    return { error: `Failed to read config.json: ${error.message}` };
  }
}

export function updateBrowserRuntimeSettings(update, dir) {
  const validationError = validateBrowserRuntimeUpdate(update);
  if (validationError) return { error: validationError };
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  try {
    return mutateAgentConfig(root, existing => {
      const previous = existing.browserRuntime && typeof existing.browserRuntime === 'object'
        ? existing.browserRuntime
        : {};
      existing.browserRuntime = normaliseBrowserRuntimeSection({ ...previous, ...update });
      return existing.browserRuntime;
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

// ─── Search settings (web-search backend selection + Tavily key) ────

/**
 * Valid backend values. `playwright` is reserved for the upcoming
 * playwright-service tool — its UI option is currently disabled, but we
 * accept the literal so a hand-edited config doesn't trip validation.
 * Anything else is rejected on write and normalized to `tavily` on read.
 */
const VALID_BACKENDS = ['tavily', 'playwright'];

function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * Read the `search` section of config.json. Tavily key is returned in
 * masked form (`tvly-d...j3dgV`) — the raw key never leaves the agent.
 * UI uses `tavilyKeyConfigured` to decide whether the input shows a
 * "(unchanged)" placeholder vs an empty box.
 *
 * @param {string} [dir]
 * @returns {{ backend: string, tavilyKeyConfigured: boolean, tavilyKeyMasked: string|null, disableHtmlFallback: boolean } | { error: string }}
 */
export function getSearchSettings(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  const defaults = {
    backend: 'tavily',
    tavilyKeyConfigured: false,
    tavilyKeyMasked: null,
    disableHtmlFallback: false,
  };
  if (!existsSync(configPath)) return defaults;
  try {
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    const s = (json && typeof json.search === 'object' && json.search) || {};
    const backend = VALID_BACKENDS.includes(s.backend) ? s.backend : 'tavily';
    const key = typeof s.tavilyApiKey === 'string' ? s.tavilyApiKey : '';
    return {
      backend,
      tavilyKeyConfigured: !!key,
      tavilyKeyMasked: key ? maskKey(key) : null,
      disableHtmlFallback: !!s.disableHtmlFallback,
    };
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
}

/**
 * Update the `search` section of config.json. Update is shallow-merged:
 * any field omitted from `update` keeps its previous value. Pass
 * `tavilyApiKey: ''` explicitly to clear the key; pass `undefined` (or
 * omit) to keep it unchanged — this is what the UI relies on so the
 * "(unchanged)" placeholder doesn't accidentally wipe a saved key when
 * the user only touches the backend radio.
 *
 * @param {{ backend?: string, tavilyApiKey?: string, disableHtmlFallback?: boolean }} update
 * @param {string} [dir]
 * @returns {ReturnType<typeof getSearchSettings>}
 */
export function updateSearchSettings(update, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;

  if (!update || typeof update !== 'object') {
    return { error: 'update payload required' };
  }
  if (update.backend !== undefined && !VALID_BACKENDS.includes(update.backend)) {
    return { error: `backend must be one of: ${VALID_BACKENDS.join(', ')}` };
  }
  if (update.tavilyApiKey !== undefined && typeof update.tavilyApiKey !== 'string') {
    return { error: 'tavilyApiKey must be a string' };
  }

  try {
    mutateAgentConfig(root, existing => {
      const prev = (existing && typeof existing.search === 'object' && existing.search) || {};
      const merged = { ...prev };
      if (update.backend !== undefined) merged.backend = update.backend;
      if (update.tavilyApiKey !== undefined) merged.tavilyApiKey = update.tavilyApiKey;
      if (update.disableHtmlFallback !== undefined) merged.disableHtmlFallback = !!update.disableHtmlFallback;
      existing.search = merged;
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
  return getSearchSettings(root);
}

/**
 * Probe Tavily's `/usage` endpoint with the currently-saved key. Returns
 * the plan + usage fields the UI shows, or `{ error }` for any of:
 *   - no key configured
 *   - HTTP error from Tavily (401 = bad key, etc.)
 *   - network failure
 *
 * Called only when the user opens the Search settings tab (the user
 * explicitly asked for "open settings → live read, don't poll"). No
 * caching here — a stale display is more confusing than a fresh probe.
 *
 * @param {string} [dir]
 * @returns {Promise<{ plan: string, used: number, limit: number|null, paygoUsed: number, paygoLimit: number|null } | { error: string }>}
 */
export async function fetchTavilyUsage(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  if (!existsSync(configPath)) return { error: 'config.json not found' };
  let key;
  try {
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    key = json?.search?.tavilyApiKey;
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
  if (!key) return { error: 'Tavily API key not configured' };

  try {
    const res = await fetch('https://api.tavily.com/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `${res.status} ${res.statusText} ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    const account = data?.account || {};
    return {
      plan: account.current_plan || 'unknown',
      used: Number(account.plan_usage) || 0,
      limit: account.plan_limit ?? null,
      paygoUsed: Number(account.paygo_usage) || 0,
      paygoLimit: account.paygo_limit ?? null,
    };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ─── Agent plugin selection ────────────────────────────────────

/**
 * Read the Agent-local plugin allowlists. Missing category fields mean
 * inheritance (all discovered capabilities remain available).
 */
export function getPluginConfig(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  try {
    const json = readConfigForWrite(configPath);
    return { plugins: normalizePluginConfig(json.plugins) };
  } catch (err) {
    return { error: `Failed to read plugin config: ${err?.message || err}` };
  }
}

/**
 * Persist Agent-local plugin allowlists without touching providers, MCP server
 * definitions, or any other config.json field.
 */
export function updatePluginConfig(plugins, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  let normalized;
  try {
    normalized = normalizePluginConfig(plugins);
    return mutateAgentConfig(root, existing => {
      if (Object.keys(normalized).length === 0) delete existing.plugins;
      else existing.plugins = normalized;
      return { plugins: normalized };
    });
  } catch (error) {
    return { error: `Failed to read plugin config or persist update: ${error?.message || error}` };
  }
}

// ─── MCP server config (mcpServers array in config.json) ──

/**
 * Server-name regex: lowercase letters, digits, underscore, dash. Matches
 * what Claude Code accepts so config files are portable. Single source of
 * truth for both add/update/remove validation.
 */
const MCP_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Normalise one MCP server entry on read. The on-disk shape that the
 * MCPManager understands is `{ name, command, args?, env? }`. This pass
 * strips unknown / non-string keys, coerces args to an array of strings,
 * and forces env to a plain {string→string} object so the UI doesn't
 * crash on a malformed handwritten config.
 *
 * @param {unknown} entry
 * @returns {{ name: string, command: string, args: string[], env: Record<string,string> } | null}
 */
function normaliseMcpServer(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const e = /** @type {any} */ (entry);
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const command = typeof e.command === 'string' ? e.command.trim() : '';
  if (!name || !command) return null;
  const args = Array.isArray(e.args)
    ? e.args.filter(a => typeof a === 'string')
    : [];
  /** @type {Record<string,string>} */
  // Use a null-prototype object so a malicious config entry can't poison
  // future lookups via `__proto__` / `constructor` / `prototype` keys. Even
  // with the explicit skip list below, the null-prototype is the right
  // baseline: env maps are plain key/value bags, they have no business
  // owning prototype methods.
  const env = Object.create(null);
  if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
    for (const [k, v] of Object.entries(e.env)) {
      // Skip dangerous keys that would let attacker-controlled config
      // pollute Object.prototype if env were ever spread / merged
      // somewhere that doesn't expect a null-proto map.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (typeof k === 'string' && typeof v === 'string') env[k] = v;
    }
  }
  return { name, command, args, env };
}

/**
 * Validate a server config for add/update. Returns null on success or a
 * string error suitable for forwarding to the UI.
 *
 * @param {unknown} entry
 * @returns {string|null}
 */
function validateMcpServer(entry) {
  if (!entry || typeof entry !== 'object') return 'server payload required';
  const e = /** @type {any} */ (entry);
  if (typeof e.name !== 'string' || !MCP_NAME_RE.test(e.name)) {
    return 'server name must match /^[a-z0-9_-]+$/';
  }
  if (typeof e.command !== 'string' || !e.command.trim()) {
    return 'server command is required';
  }
  if (e.args !== undefined && (!Array.isArray(e.args) || !e.args.every(a => typeof a === 'string'))) {
    return 'server args must be an array of strings';
  }
  if (e.env !== undefined && (typeof e.env !== 'object' || e.env === null || Array.isArray(e.env))) {
    return 'server env must be an object of string→string';
  }
  if (e.env && typeof e.env === 'object') {
    for (const [k, v] of Object.entries(e.env)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return 'server env entries must all be strings';
      }
    }
  }
  return null;
}

/**
 * List MCP servers currently saved in config.json. Returns an array — empty
 * when none configured. Each entry is the normalised on-disk shape, NOT
 * the runtime status (which lives on `mcpManager.status()`).
 *
 * @param {string} [dir]
 * @returns {{ servers: Array<{ name: string, command: string, args: string[], env: Record<string,string> }> } | { error: string }}
 */
export function listMcpServers(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  try {
    const json = readConfigForWrite(configPath);
    const raw = Array.isArray(json.mcpServers) ? json.mcpServers : [];
    const servers = raw.map(normaliseMcpServer).filter(Boolean);
    return { servers };
  } catch (err) {
    return { error: `Failed to read config.json: ${err?.message || err}` };
  }
}

/**
 * Add or update an MCP server config entry. Match is by `name`. Returns
 * the post-update list of servers (same shape as `listMcpServers`) plus
 * the entry that was just written, so callers can pass it directly into
 * `mcpManager.connect()` without re-reading the file.
 *
 * @param {{ name: string, command: string, args?: string[], env?: Record<string,string> }} server
 * @param {string} [dir]
 * @returns {{ servers: Array<object>, server: object } | { error: string }}
 */
export function upsertMcpServer(server, dir) {
  const err = validateMcpServer(server);
  if (err) return { error: err };

  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const normalised = normaliseMcpServer(server);
  if (!normalised) return { error: 'invalid server payload' };

  try {
    return mutateAgentConfig(root, existing => {
      const list = Array.isArray(existing.mcpServers) ? existing.mcpServers.slice() : [];
      const index = list.findIndex(entry => entry && typeof entry === 'object' && entry.name === normalised.name);
      if (index >= 0) list[index] = normalised;
      else list.push(normalised);
      existing.mcpServers = list;
      return { servers: list.map(normaliseMcpServer).filter(Boolean), server: normalised };
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

/**
 * Remove the MCP server config entry with the given name. Idempotent —
 * removing a non-existent name returns the unchanged list with
 * `removed: false`. This lets the UI safely call delete after a
 * concurrent change without surfacing a spurious error.
 *
 * @param {string} name
 * @param {string} [dir]
 * @returns {{ servers: Array<object>, removed: boolean } | { error: string }}
 */
export function removeMcpServer(name, dir) {
  if (typeof name !== 'string' || !name.trim()) {
    return { error: 'name required' };
  }
  // Trim once for the comparison too — without this, "  github  " from the
  // wire would silently fail to delete "github" on disk because we'd be
  // matching against the padded string.
  const target = name.trim();
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  try {
    return mutateAgentConfig(root, existing => {
      const list = Array.isArray(existing.mcpServers) ? existing.mcpServers.slice() : [];
      const next = list.filter(entry => !(entry && typeof entry === 'object' && entry.name === target));
      existing.mcpServers = next;
      return {
        servers: next.map(normaliseMcpServer).filter(Boolean),
        removed: next.length !== list.length,
      };
    });
  } catch (error) {
    return { error: `Failed to read config.json or persist update: ${error?.message || error}` };
  }
}

