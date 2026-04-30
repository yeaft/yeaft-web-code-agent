/**
 * config-api.js — Read/write Yeaft config.json for remote management
 *
 * Provides functions to get and update the LLM-related portion of
 * ~/.yeaft/config.json via WebSocket messages from the web UI.
 *
 * Only exposes provider/model configuration — not internal fields
 * like maxContinueTurns or debug that don't belong in the UI.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { normalizeProviderModels, serializeModelForPersistence } from './models.js';
import { normaliseUnifySection } from './config.js';

/**
 * Read the LLM-relevant portion of config.json.
 *
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ providers, primaryModel, fastModel, language } | { error: string }}
 */
export function getLlmConfig(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');

  if (!existsSync(configPath)) {
    return { providers: [], primaryModel: null, fastModel: null, language: 'en', needsSetup: true };
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    const providers = Array.isArray(json.providers) ? json.providers : [];

    // Detect if config still has default/placeholder values (first-time setup needed)
    const needsSetup = providers.length === 0 || providers.every(p =>
      p.apiKey === 'proxy' || p.apiKey === '' || !p.apiKey
    );

    return {
      providers,
      primaryModel: json.primaryModel || null,
      fastModel: json.fastModel || null,
      language: json.language || 'en',
      needsSetup,
    };
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
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
  const configPath = join(root, 'config.json');

  // Read existing config (preserve non-LLM fields)
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      // Start fresh if corrupt
      existing = {};
    }
  }

  // Validate providers structure
  if (update.providers !== undefined) {
    if (!Array.isArray(update.providers)) {
      return { error: 'providers must be an array' };
    }
    for (const p of update.providers) {
      if (!p.name || typeof p.name !== 'string') {
        return { error: 'Each provider must have a name' };
      }
      if (!p.baseUrl || typeof p.baseUrl !== 'string') {
        return { error: `Provider "${p.name}" must have a baseUrl` };
      }
      if (!Array.isArray(p.models) || p.models.length === 0) {
        return { error: `Provider "${p.name}" must have at least one model` };
      }
    }
    // Normalize + re-serialize each provider's models so that:
    //   - id-only entries are persisted as plain strings (back-compat)
    //   - entries with ctx / maxOutput are persisted as objects
    //   - empty / 0 / NaN values get stripped
    existing.providers = update.providers.map(p => {
      const normalized = normalizeProviderModels(p);
      return {
        ...p,
        models: normalized.map(serializeModelForPersistence),
      };
    });
  }

  // Update model selections
  if (update.primaryModel !== undefined) {
    existing.primaryModel = update.primaryModel || null;
  }
  if (update.fastModel !== undefined) {
    existing.fastModel = update.fastModel || null;
  }
  if (update.language !== undefined) {
    existing.language = update.language;
  }

  // Write back
  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { error: `Failed to write config.json: ${e.message}` };
  }

  return {
    providers: Array.isArray(existing.providers) ? existing.providers : [],
    primaryModel: existing.primaryModel || null,
    fastModel: existing.fastModel || null,
    language: existing.language || 'en',
  };
}

// ─── Unify runtime settings (task-318) ────────────────────────────

/**
 * Read the Unify-section of config.json. Returns defaults when the file
 * or section is absent. Callers (UI, registry, ThreadStore) rely on a
 * stable shape — `normaliseUnifySection` guarantees that.
 *
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number } | { error: string }}
 */
export function getUnifySettings(dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');
  if (!existsSync(configPath)) return normaliseUnifySection(null);
  try {
    const raw = readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    return normaliseUnifySection(json.unify);
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
  }
}

/**
 * Update the Unify-section of config.json. Merges into existing config
 * (LLM provider / model fields are untouched) and validates each field:
 * `maxConcurrentThreads` must be 1..50, `autoArchiveIdleDays` must be
 * 1..3650. Invalid values are rejected outright so the UI sees an error
 * rather than silently reverting — a silent revert would make "I set it
 * to 100 and nothing happened" impossible to debug.
 *
 * @param {{ maxConcurrentThreads?: number, autoArchiveIdleDays?: number }} update
 * @param {string} [dir]
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number } | { error: string }}
 */
export function updateUnifySettings(update, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');

  if (!update || typeof update !== 'object') {
    return { error: 'update payload required' };
  }

  // Validate before touching the file. We enforce the same clamp bounds
  // that `normaliseUnifySection` uses for reads so round-trip is stable.
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

  // Read existing config (preserve LLM and other top-level fields).
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const prev = normaliseUnifySection(existing.unify);
  const merged = {
    maxConcurrentThreads: update.maxConcurrentThreads !== undefined
      ? Math.floor(Number(update.maxConcurrentThreads))
      : prev.maxConcurrentThreads,
    autoArchiveIdleDays: update.autoArchiveIdleDays !== undefined
      ? Math.floor(Number(update.autoArchiveIdleDays))
      : prev.autoArchiveIdleDays,
  };
  existing.unify = merged;

  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { error: `Failed to write config.json: ${e.message}` };
  }

  return merged;
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
  const configPath = join(root, 'config.json');

  if (!update || typeof update !== 'object') {
    return { error: 'update payload required' };
  }
  if (update.backend !== undefined && !VALID_BACKENDS.includes(update.backend)) {
    return { error: `backend must be one of: ${VALID_BACKENDS.join(', ')}` };
  }
  if (update.tavilyApiKey !== undefined && typeof update.tavilyApiKey !== 'string') {
    return { error: 'tavilyApiKey must be a string' };
  }

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const prev = (existing && typeof existing.search === 'object' && existing.search) || {};
  const merged = { ...prev };
  if (update.backend !== undefined) merged.backend = update.backend;
  if (update.tavilyApiKey !== undefined) merged.tavilyApiKey = update.tavilyApiKey;
  if (update.disableHtmlFallback !== undefined) merged.disableHtmlFallback = !!update.disableHtmlFallback;
  existing.search = merged;

  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { error: `Failed to write config.json: ${e.message}` };
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

