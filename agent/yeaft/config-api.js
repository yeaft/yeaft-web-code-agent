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
import { normaliseYeaftSection } from './config.js';

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
    return { providers: [], primaryModel: null, fastModel: null, language: 'en', needsSetup: true };
  }

  const raw = readFileSync(configPath, 'utf8');
  const json = JSON.parse(raw);
  const providers = Array.isArray(json.providers) ? json.providers : [];
  return {
    providers,
    primaryModel: json.primaryModel || null,
    fastModel: json.fastModel || null,
    language: json.language || 'en',
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

  const agentConfig = {
    providers: Array.isArray(existing.providers) ? existing.providers : [],
    primaryModel: existing.primaryModel || null,
    fastModel: existing.fastModel || null,
    language: existing.language || 'en',
  };
  return {
    ...agentConfig,
    agentConfig,
    effectiveConfig: agentConfig,
  };
}

// ─── Yeaft runtime settings (task-318) ────────────────────────────

/**
 * Read the Yeaft-section of config.json. Returns defaults when the file
 * or section is absent. Callers (UI, registry, ThreadStore) rely on a
 * stable shape — `normaliseYeaftSection` guarantees that.
 *
 * @param {string} [dir] — Yeaft data directory
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number, recentTurnsLimit: number } | { error: string }}
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
 * 1..3650, `recentTurnsLimit` must be 1..500. Invalid values are rejected
 * outright so the UI sees an error rather than silently reverting — a
 * silent revert would make "I set it to 100 and nothing happened"
 * impossible to debug.
 *
 * @param {{ maxConcurrentThreads?: number, autoArchiveIdleDays?: number, recentTurnsLimit?: number }} update
 * @param {string} [dir]
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number, recentTurnsLimit: number } | { error: string }}
 */
export function updateYeaftSettings(update, dir) {
  const root = dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const configPath = join(root, 'config.json');

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

  // Read existing config (preserve LLM and other top-level fields).
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

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
  };
  existing.yeaft = merged;

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
 * Read existing config.json (silently start fresh on missing / corrupt).
 * Internal helper used by the MCP CRUD trio to share one parse path.
 *
 * @param {string} configPath
 * @returns {object}
 */
function readConfigJson(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    return (json && typeof json === 'object') ? json : {};
  } catch {
    return {};
  }
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
    const json = readConfigJson(configPath);
    const raw = Array.isArray(json.mcpServers) ? json.mcpServers : [];
    const servers = raw.map(normaliseMcpServer).filter(Boolean);
    return { servers };
  } catch (e) {
    return { error: `Failed to read config.json: ${e.message}` };
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
  const configPath = join(root, 'config.json');
  const existing = readConfigJson(configPath);
  const list = Array.isArray(existing.mcpServers) ? existing.mcpServers.slice() : [];

  const normalised = normaliseMcpServer(server);
  if (!normalised) return { error: 'invalid server payload' };

  const idx = list.findIndex(s => s && typeof s === 'object' && s.name === normalised.name);
  if (idx >= 0) {
    list[idx] = normalised;
  } else {
    list.push(normalised);
  }
  existing.mcpServers = list;

  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { error: `Failed to write config.json: ${e.message}` };
  }

  return { servers: list.map(normaliseMcpServer).filter(Boolean), server: normalised };
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
  const configPath = join(root, 'config.json');
  const existing = readConfigJson(configPath);
  const list = Array.isArray(existing.mcpServers) ? existing.mcpServers.slice() : [];
  const next = list.filter(s => !(s && typeof s === 'object' && s.name === target));
  const removed = next.length !== list.length;
  existing.mcpServers = next;

  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { error: `Failed to write config.json: ${e.message}` };
  }

  return { servers: next.map(normaliseMcpServer).filter(Boolean), removed };
}

