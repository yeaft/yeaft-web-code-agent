/**
 * config.js — Yeaft configuration management
 *
 * All configuration lives in ~/.yeaft/config.json:
 *
 * {
 *   "providers": [
 *     { "name": "my-proxy", "baseUrl": "http://localhost:6628/v1", "apiKey": "proxy",
 *       "models": ["claude-sonnet-4-20250514", "gpt-5", "deepseek-chat"] }
 *   ],
 *   "primaryModel": "my-proxy/claude-sonnet-4-20250514",
 *   "fastModel": "my-proxy/claude-haiku-3-20250414",
 *   "language": "en",
 *   "debug": false,
 *   "maxContextTokens": 200000,
 *   "messageTokenBudget": 32768
 * }
 *
 * Legacy: if config.json doesn't exist, falls back to old config.md + .env for migration.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { getModelEffortOptions, getThinkingCapability, modelSupportsEffort, resolveModel, parseModelRef, normalizeProviderModels, resolveContextWindow, resolveMaxOutputTokens } from './models.js';
import { inferProtocolFromModelId } from './llm/router.js';
import { normalizeKnownProviderForRuntime } from './llm/known-providers.js';

/** Default configuration values. */
const DEFAULTS = {
  language: 'en',
  debug: false,
  dir: DEFAULT_YEAFT_DIR,
  maxContextTokens: 200000,
  maxOutputTokens: 16384,
  messageTokenBudget: 32768,
  maxContinueTurns: 3,
  // task-318: Yeaft-specific runtime caps. `maxConcurrentThreads` gates
  // how many ThreadEngineRegistry instances may be live at once; dispatch
  // refuses new threads beyond this. The count INCLUDES the always-on
  // `main` thread, so the default 6 gives users 5 user-initiated threads
  // on top of main. `autoArchiveIdleDays` is consumed by ThreadStore's
  // idle-archive pass (task-317 will wire the pass itself; here we just
  // plumb the knob through so the UI can set it).
  yeaftMaxConcurrentThreads: 6,
  yeaftAutoArchiveIdleDays: 30,
  // Cold-start replay window: how many of the most recent turns
  // ConversationStore.loadRecentBySession / loadSessionHistoryForVp
  // bring back when no compact summary exists for the session. Raise
  // this if your sessions routinely outgrow the 20-turn window
  // before compaction fires. Range: 1–500.
  yeaftRecentTurnsLimit: 20,
  // CLAUDE.md / AGENTS.md project-doc cap, in bytes. Mirrors Codex's
  // `project_doc_max_bytes`. 0 disables the feature (no project-doc
  // block is injected). Hand-edited values are NOT clamped — we let
  // power users opt into larger docs at their own context-window risk.
  projectDocMaxBytes: 32 * 1024,
  // ─── LLM retry policy ──────────────────────────────────────
  // How the engine reacts when adapter.stream()/call() throws a
  // retryable error (429 / 529 / 5xx / transport failure). Each field
  // is overridable from ~/.yeaft/config.json under "llmRetry": {…}.
  //   • maxRetries: cap on CONSECUTIVE retryable failures per turn.
  //     0 disables retry entirely (caller falls straight through to
  //     fallbackModel / error). Default 3.
  //   • baseDelayMs / maxDelayMs: exponential backoff bounds used when
  //     the server didn't send a Retry-After header.
  //   • jitterRatio: ± random fraction applied to backoff; 0 disables.
  //   • streamIdleTimeoutMs: per-SSE-chunk silence budget. 0 disables the
  //     stalled-stream guard; every received chunk refreshes the budget.
  llmRetry: {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.25,
    streamIdleTimeoutMs: 20_000,
  },
};

// ─── llmRetry normalizer ────────────────────────────────────────

/**
 * Merge user-supplied retry overrides with DEFAULTS.llmRetry, clamping
 * each field to its safe range. The output is always a fully-populated
 * object so the engine never has to deal with `undefined`. Unknown keys
 * in the input are dropped.
 *
 * Precedence: overrides > fileConfig > DEFAULTS.
 *
 * @param {object | null | undefined} fileConfig
 * @param {object | null | undefined} overrides
 * @returns {{ maxRetries: number, baseDelayMs: number, maxDelayMs: number, jitterRatio: number, streamIdleTimeoutMs: number }}
 */
export function normalizeLlmRetry(fileConfig, overrides) {
  const base = DEFAULTS.llmRetry;
  const out = { ...base };
  const apply = (src) => {
    if (!src || typeof src !== 'object') return;
    if (Number.isFinite(src.maxRetries) && src.maxRetries >= 0) {
      out.maxRetries = Math.min(20, Math.floor(src.maxRetries));
    }
    if (Number.isFinite(src.baseDelayMs) && src.baseDelayMs >= 0) {
      out.baseDelayMs = Math.min(60_000, Math.floor(src.baseDelayMs));
    }
    if (Number.isFinite(src.maxDelayMs) && src.maxDelayMs >= 0) {
      out.maxDelayMs = Math.min(600_000, Math.floor(src.maxDelayMs));
    }
    if (Number.isFinite(src.jitterRatio) && src.jitterRatio >= 0) {
      out.jitterRatio = Math.min(1, src.jitterRatio);
    }
    if (Number.isFinite(src.streamIdleTimeoutMs) && src.streamIdleTimeoutMs >= 0) {
      out.streamIdleTimeoutMs = Math.min(600_000, Math.floor(src.streamIdleTimeoutMs));
    }
  };
  apply(fileConfig);
  apply(overrides);
  if (out.maxDelayMs < out.baseDelayMs) out.maxDelayMs = out.baseDelayMs;
  return out;
}

// ─── config.json reader ─────────────────────────────────────────

/**
 * Read and parse ~/.yeaft/config.json.
 *
 * @param {string} dir
 * @returns {object|null} — Parsed JSON or null if not found/invalid
 */
function readConfigJson(dir) {
  const configPath = join(dir, 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Legacy support (config.md + .env) ──────────────────────────

/**
 * Parse YAML frontmatter from a markdown file.
 * Simple parser — handles key: value pairs, no nested objects.
 * @deprecated Use config.json instead. Kept for migration.
 *
 * @param {string} content — File content
 * @returns {Record<string, string>} — Parsed frontmatter
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
    result[key] = value;
  }
  return result;
}

/**
 * Load legacy config.md.
 * @deprecated
 */
function loadLegacyConfigFile(dir) {
  const configPath = join(dir, 'config.md');
  if (!existsSync(configPath)) return {};
  try {
    return parseFrontmatter(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Load legacy .env file.
 * @deprecated
 */
function loadLegacyEnvFile(dir) {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7);
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore
  }
}

function isTruthy(val) {
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * Clamp and normalise the `yeaft` config section. Missing / non-numeric
 * inputs fall back to the DEFAULTS; numeric-but-out-of-range inputs are
 * *clamped* to the valid range rather than silently reverting to the
 * default. This keeps the read path aligned with `updateYeaftSettings`,
 * which rejects out-of-range writes up front — a hand-edited
 * `config.json` with `maxConcurrentThreads: 100` now loads as 50 (the
 * nearest valid value) instead of collapsing back to 5.
 *
 * Exported for tests and for `config-api.js` to share the same clamp
 * bounds via `clampYeaftField`.
 *
 * @param {any} raw — jsonConfig.yeaft (may be undefined / malformed)
 * @returns {{ maxConcurrentThreads: number, autoArchiveIdleDays: number }}
 */
export function normaliseYeaftSection(raw) {
  const out = {
    maxConcurrentThreads: DEFAULTS.yeaftMaxConcurrentThreads,
    autoArchiveIdleDays: DEFAULTS.yeaftAutoArchiveIdleDays,
    recentTurnsLimit: DEFAULTS.yeaftRecentTurnsLimit,
  };
  if (!raw || typeof raw !== 'object') return out;
  const mc = clampYeaftField(raw.maxConcurrentThreads, 'maxConcurrentThreads');
  if (mc !== null) out.maxConcurrentThreads = mc;
  const ad = clampYeaftField(raw.autoArchiveIdleDays, 'autoArchiveIdleDays');
  if (ad !== null) out.autoArchiveIdleDays = ad;
  const rt = clampYeaftField(raw.recentTurnsLimit, 'recentTurnsLimit');
  if (rt !== null) out.recentTurnsLimit = rt;
  return out;
}

/**
 * Clamp a single yeaft field to its valid range. Returns `null` if the
 * input is not a finite number (so callers can treat it as "not set" and
 * keep the previous value). Centralises the bounds used on both read
 * (`normaliseYeaftSection`) and write (`updateYeaftSettings` validation).
 *
 * @param {unknown} v
 * @param {'maxConcurrentThreads'|'autoArchiveIdleDays'|'recentTurnsLimit'} field
 * @returns {number | null}
 */
export function clampYeaftField(v, field) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  let lo;
  let hi;
  if (field === 'maxConcurrentThreads') { lo = 1; hi = 50; }
  else if (field === 'recentTurnsLimit') { lo = 1; hi = 500; }
  else { lo = 1; hi = 3650; } // autoArchiveIdleDays
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Build config from legacy config.md + .env + env vars.
 * @deprecated — used only when config.json doesn't exist.
 */
function loadLegacyConfig(dir, overrides) {
  const env = process.env;
  loadLegacyEnvFile(dir);
  const fileConfig = loadLegacyConfigFile(dir);

  const config = {
    model: overrides.model || env.YEAFT_MODEL || fileConfig.model || 'claude-sonnet-4-20250514',
    fallbackModel: overrides.fallbackModel || env.YEAFT_FALLBACK_MODEL || fileConfig.fallbackModel || null,
    llmRetry: normalizeLlmRetry(fileConfig.llmRetry, overrides.llmRetry),
    language: overrides.language || env.YEAFT_LANGUAGE || fileConfig.language || DEFAULTS.language,
    apiKey: overrides.apiKey || env.YEAFT_API_KEY || fileConfig.apiKey || null,
    openaiApiKey: overrides.openaiApiKey || env.YEAFT_OPENAI_API_KEY || fileConfig.openaiApiKey || null,
    proxyUrl: overrides.proxyUrl || env.YEAFT_PROXY_URL || fileConfig.proxyUrl || 'http://localhost:6628',
    baseUrl: overrides.baseUrl || env.YEAFT_BASE_URL || fileConfig.baseUrl || null,
    adapter: overrides.adapter || env.YEAFT_ADAPTER || fileConfig.adapter || null,
    debug: overrides.debug !== undefined ? overrides.debug
      : env.YEAFT_DEBUG !== undefined ? isTruthy(env.YEAFT_DEBUG)
        : fileConfig.debug !== undefined ? fileConfig.debug : DEFAULTS.debug,
    dir,
    maxContextTokens: overrides.maxContextTokens ?? (env.YEAFT_MAX_CONTEXT ? parseInt(env.YEAFT_MAX_CONTEXT, 10) : null) ?? fileConfig.maxContextTokens ?? DEFAULTS.maxContextTokens,
    maxOutputTokens: overrides.maxOutputTokens ?? fileConfig.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    messageTokenBudget: overrides.messageTokenBudget ?? (env.YEAFT_MESSAGE_TOKEN_BUDGET ? parseInt(env.YEAFT_MESSAGE_TOKEN_BUDGET, 10) : null) ?? fileConfig.messageTokenBudget ?? DEFAULTS.messageTokenBudget,
    maxContinueTurns: overrides.maxContinueTurns ?? fileConfig.maxContinueTurns ?? DEFAULTS.maxContinueTurns,
    // CLAUDE.md / AGENTS.md project-doc cap, in bytes. Legacy config
    // has no field for this, so it always lands on the default unless
    // explicitly overridden via CLI.
    projectDocMaxBytes: overrides.projectDocMaxBytes ?? fileConfig.projectDocMaxBytes ?? DEFAULTS.projectDocMaxBytes,
    // task-318: legacy path never had the `yeaft` section — defaults.
    yeaft: normaliseYeaftSection(null),
    providers: null,
    primaryModel: null,
    fastModel: null,
  };

  // Auto-detect adapter
  if (!config.adapter) {
    const modelInfo = resolveModel(config.model);
    if (modelInfo) {
      config.adapter = modelInfo.adapter === 'anthropic' ? 'anthropic' : 'openai';
      if (!config.baseUrl) config.baseUrl = modelInfo.baseUrl;
      // Resolve token limits via the resolver ladder (models.dev → config →
      // DEFAULT). Only fill in when the caller left the slot at the default
      // — explicit env / CLI overrides win.
      if (config.maxContextTokens === DEFAULTS.maxContextTokens) {
        config.maxContextTokens = resolveContextWindow(config.model, config);
      }
      if (config.maxOutputTokens === DEFAULTS.maxOutputTokens) {
        config.maxOutputTokens = resolveMaxOutputTokens(config.model, config);
      }
    } else {
      if (config.apiKey) config.adapter = 'anthropic';
      else if (config.openaiApiKey) config.adapter = 'openai';
      else if (config.proxyUrl) config.adapter = 'proxy';
    }
  }

  config.modelInfo = resolveModel(config.model) || null;
  return config;
}

// ─── Main: loadConfig ───────────────────────────────────────────

/**
 * Load full configuration.
 *
 * Reads ~/.yeaft/config.json first. If not found, falls back to legacy
 * config.md + .env for backward compatibility.
 *
 * @param {Record<string, unknown>} [overrides] — CLI overrides
 * @returns {object} — Merged configuration
 */
export function loadConfig(overrides = {}) {
  // Determine data directory
  const dir = overrides.dir || process.env.YEAFT_DIR || DEFAULTS.dir;

  // Try config.json first
  const jsonConfig = readConfigJson(dir);

  if (!jsonConfig) {
    // No config.json → legacy path
    return loadLegacyConfig(dir, overrides);
  }

  // ─── Build config from config.json ────────────────────────
  const providers = Array.isArray(jsonConfig.providers) ? jsonConfig.providers : [];

  // Resolve primary model
  let model = 'claude-sonnet-4-20250514';
  let modelIdForInfo = model;
  let primaryModel = jsonConfig.primaryModel || null;
  if (primaryModel) {
    const parsed = parseModelRef(primaryModel);
    // Global provider refs were removed. Old local config may still contain
    // `global:<provider>/<model>` from previous UI versions; strip the dead
    // namespace so runtime routing can match agent-local providers by model id.
    const isRemovedGlobalRef = parsed.providerName?.startsWith('global:');
    model = parsed.modelId;
    if (isRemovedGlobalRef) primaryModel = parsed.modelId;
    modelIdForInfo = parsed.modelId;
  }

  // Resolve fast model
  let fastModel = jsonConfig.fastModel || primaryModel || null;
  let fastModelId = null;
  if (fastModel) {
    const parsed = parseModelRef(fastModel);
    fastModel = parsed.providerName?.startsWith('global:') ? parsed.modelId : fastModel;
    fastModelId = parsed.modelId;
  }

  // Resolve model info for adapter/baseUrl/thinking metadata. Token limits
  // (contextWindow / maxOutputTokens) are NOT read from here — they live in
  // models.dev and are resolved via resolveContextWindow / resolveMaxOutputTokens
  // a few lines below so the live models.dev snapshot is the source of truth.
  const modelInfo = resolveModel(modelIdForInfo);

  // Pre-resolve token limits once so we can both write them onto config and
  // pass `config` to the resolver chain consistently below.
  const resolvedMaxContext = overrides.maxContextTokens ?? jsonConfig.maxContextTokens
    ?? resolveContextWindow(modelIdForInfo, { modelInfo });
  const resolvedMaxOutput = overrides.maxOutputTokens ?? jsonConfig.maxOutputTokens
    ?? resolveMaxOutputTokens(modelIdForInfo, { modelInfo });

  const config = {
    // Model
    model: overrides.model || model,
    primaryModel: overrides.primaryModel || primaryModel,
    fastModel: overrides.fastModel || fastModel,
    fastModelId: fastModelId,
    fallbackModel: jsonConfig.fallbackModel || null,
    llmRetry: normalizeLlmRetry(jsonConfig.llmRetry, overrides.llmRetry),
    modelInfo: modelInfo || null,

    // Providers
    providers: providers.length > 0 ? providers : null,

    // General settings
    language: overrides.language || jsonConfig.language || DEFAULTS.language,
    debug: overrides.debug !== undefined ? overrides.debug : (jsonConfig.debug ?? DEFAULTS.debug),
    dir,

    // Token limits. Resolution order:
    //   1. CLI override (overrides.*)
    //   2. ~/.yeaft/config.json explicit value
    //   3. resolveContextWindow / resolveMaxOutputTokens — which themselves
    //      walk: per-provider override → models.dev snapshot → DEFAULT.
    // Anything that needs the *live* number for a model the user picks at
    // runtime (mid-session model switch, e.g.) should call the resolvers
    // directly rather than read these fields.
    maxContextTokens: resolvedMaxContext,
    maxOutputTokens: resolvedMaxOutput,
    messageTokenBudget: overrides.messageTokenBudget ?? jsonConfig.messageTokenBudget ?? DEFAULTS.messageTokenBudget,
    maxContinueTurns: overrides.maxContinueTurns ?? jsonConfig.maxContinueTurns ?? DEFAULTS.maxContinueTurns,

    // CLAUDE.md / AGENTS.md project-doc cap, in bytes. Set to 0 to
    // disable the feature entirely. Read from `projectDocMaxBytes` in
    // ~/.yeaft/config.json or threaded through CLI overrides.
    projectDocMaxBytes: overrides.projectDocMaxBytes ?? jsonConfig.projectDocMaxBytes ?? DEFAULTS.projectDocMaxBytes,

    // task-318: Yeaft runtime caps. `yeaft` is a nested section so we
    // don't pollute the flat config namespace used by chat code.
    yeaft: normaliseYeaftSection(jsonConfig.yeaft),

    // Legacy fields (null when using config.json)
    apiKey: overrides.apiKey || null,
    openaiApiKey: null,
    proxyUrl: null,
    baseUrl: null,
    adapter: null,
  };

  // Aggregate all available models from providers.
  // Normalizes each provider's `models` into `{ id, contextWindow?, maxOutput? }`
  // so consumers never have to deal with raw string / object ambiguity.
  config.availableModels = [];
  if (providers) {
    for (const rawProvider of providers) {
      const p = normalizeKnownProviderForRuntime(rawProvider);
      const normalized = normalizeProviderModels(p);
      for (const m of normalized) {
        // Avoid duplicates (first provider wins)
        if (!config.availableModels.some(am => am.id === m.id)) {
          const entry = {
            id: m.id,
            ref: p.name ? `${p.name}/${m.id}` : m.id,
            provider: p.name,
            label: m.id,
          };
          if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow;
          if (m.maxOutput !== undefined) entry.maxOutput = m.maxOutput;
          const protocol = m.protocol || p.protocol || inferProtocolFromModelId(m.id) || 'openai-responses';
          const effortContext = {
            protocol,
            supportsEffort: m.supportsEffort,
            effortOptions: m.effortOptions,
            thinkingProtocol: m.thinkingProtocol,
            maxBudgetTokens: m.maxBudgetTokens,
          };
          const effortOptions = getModelEffortOptions(m.id, effortContext);
          if (effortOptions.length > 0) {
            const cap = getThinkingCapability(m.id, effortContext);
            entry.supportsEffort = modelSupportsEffort(m.id, effortContext);
            entry.effortOptions = effortOptions;
            entry.effortProtocol = cap.thinkingProtocol;
          }
          config.availableModels.push(entry);
        }
      }
    }
  }

  // Agent-level primaryModel is optional. When absent, use the first provider
  // model as the effective runtime/UI default without writing it back to
  // ~/.yeaft/config.json. New Sessions may copy this value into their own
  // config, but global config remains only a fallback source.
  if (!primaryModel && !overrides.model && config.availableModels.length > 0) {
    const first = config.availableModels[0];
    const firstRef = first.ref || (first.provider && first.id ? `${first.provider}/${first.id}` : first.id);
    if (firstRef) {
      const parsed = parseModelRef(firstRef);
      const fallbackModelInfo = resolveModel(parsed.modelId) || null;
      config.model = firstRef;
      config.modelInfo = fallbackModelInfo;
      if (overrides.maxContextTokens === undefined && jsonConfig.maxContextTokens === undefined) {
        config.maxContextTokens = resolveContextWindow(parsed.modelId, { modelInfo: fallbackModelInfo });
      }
      if (overrides.maxOutputTokens === undefined && jsonConfig.maxOutputTokens === undefined) {
        config.maxOutputTokens = resolveMaxOutputTokens(parsed.modelId, { modelInfo: fallbackModelInfo });
      }
    }
  }

  return config;
}

// ─── MCP config ─────────────────────────────────────────────────

/**
 * Load MCP server configuration.
 *
 * Merges compatibility tiers, in priority order (highest first):
 *   1. yeaft-global — ~/.yeaft authoritative config: config.json "mcpServers"
 *      array, else standalone ~/.yeaft/mcp.json ({ servers: [...] }).
 *   2. claude-user  — ~/.claude.json (Claude Code user-scope MCP config).
 *   3. codex-user   — ~/.codex/config.toml (Codex user-scope MCP config).
 *   4. project      — `<workDir>/.mcp.json` (Claude Code project location)
 *      plus `<workDir>/.codex/config.toml` (Codex project location).
 *
 * Higher tiers win. Borrowed Claude/Codex configs supplement Yeaft, but never
 * override explicit ~/.yeaft settings.
 *
 * @param {string} yeaftDir
 * @param {object} [jsonConfig] — Already-parsed config.json (optional, avoids re-read)
 * @param {string} [workDir] — optional project working directory (project tier root)
 * @returns {{ servers: object[], skipped: { name: string, reason: string, source: string }[] }}
 */
export function loadMCPConfig(yeaftDir, jsonConfig, workDir) {
  const yeaftGlobal = loadGlobalMCPServers(yeaftDir, jsonConfig);
  const externalUser = loadExternalUserMCPServers();
  const project = workDir
    ? loadProjectMCPServers(workDir)
    : { servers: [], skipped: [] };

  const servers = [];
  const seen = new Set();
  for (const tier of [yeaftGlobal, externalUser.servers, project.servers]) {
    for (const s of tier) {
      if (!s?.name || seen.has(s.name)) continue;
      seen.add(s.name);
      servers.push(s);
    }
  }

  return { servers, skipped: [...externalUser.skipped, ...project.skipped] };
}

/**
 * Load the global (~/.yeaft) MCP server list.
 *
 * Reads from config.json "mcpServers" field first, then falls back to
 * standalone ~/.yeaft/mcp.json for backward compatibility. Returns a plain
 * array (not wrapped) so `loadMCPConfig` can merge tiers.
 *
 * @param {string} yeaftDir
 * @param {object} [jsonConfig]
 * @returns {object[]}
 */
function loadGlobalMCPServers(yeaftDir, jsonConfig) {
  // Check config.json mcpServers field
  if (jsonConfig && Array.isArray(jsonConfig.mcpServers)) {
    const valid = jsonConfig.mcpServers.filter(s => s.name && s.command);
    if (valid.length > 0) return valid;
  }

  // Fallback: standalone mcp.json
  const mcpPath = join(yeaftDir, 'mcp.json');
  if (!existsSync(mcpPath)) return [];

  try {
    const raw = readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.servers || !Array.isArray(parsed.servers)) return [];
    return parsed.servers.filter(s => s.name && s.command);
  } catch {
    return [];
  }
}

function normaliseStdioMCPServer(name, raw, source) {
  if (!name || !raw || typeof raw !== 'object') return { server: null, skipped: null };
  if (typeof raw.command === 'string' && raw.command.length > 0) {
    const server = { name, command: raw.command };
    if (Array.isArray(raw.args)) server.args = raw.args;
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) server.env = raw.env;
    return { server, skipped: null };
  }
  if (typeof raw.url === 'string' || typeof raw.type === 'string') {
    return { server: null, skipped: { name, reason: 'unsupported-transport', source } };
  }
  return { server: null, skipped: { name, reason: 'invalid-config', source } };
}

function loadClaudeMCPJsonFile(filePath, source) {
  const empty = { servers: [], skipped: [] };
  if (!filePath || !existsSync(filePath)) return empty;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return empty;
  }

  const mcpServers = parsed && parsed.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return empty;
  }

  const servers = [];
  const skipped = [];
  for (const [name, raw] of Object.entries(mcpServers)) {
    const normalised = normaliseStdioMCPServer(name, raw, source);
    if (normalised.server) servers.push(normalised.server);
    if (normalised.skipped) skipped.push(normalised.skipped);
  }
  return { servers, skipped };
}

function stripTomlInlineComment(raw) {
  const text = String(raw || '');
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if ((ch === ']' || ch === '}') && depth > 0) {
      depth--;
      continue;
    }
    if (ch === '#' && depth === 0) return text.slice(0, i).trim();
  }
  return text.trim();
}

function parseTomlValue(raw) {
  const value = stripTomlInlineComment(raw);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    try { return JSON.parse(value.replace(/'/g, '"')); } catch { return undefined; }
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const obj = {};
    const inner = value.slice(1, -1).trim();
    if (!inner) return obj;
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) return undefined;
      const key = part.slice(0, eq).trim().replace(/^['"]|['"]$/g, '');
      const parsed = parseTomlValue(part.slice(eq + 1));
      if (!key || parsed === undefined) return undefined;
      obj[key] = parsed;
    }
    return obj;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseCodexMCPServersToml(content, source) {
  const rawServers = {};
  let current = null;
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const section = trimmed.match(/^\[mcp_servers\.("[^"]+"|'[^']+'|[^\].]+)(?:\.(env))?\]$/);
    if (section) {
      const name = section[1].replace(/^['"]|['"]$/g, '');
      rawServers[name] ||= {};
      current = { name, env: section[2] === 'env' };
      continue;
    }
    if (!current) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseTomlValue(trimmed.slice(eq + 1));
    if (value === undefined) continue;
    if (current.env) {
      rawServers[current.name].env ||= {};
      rawServers[current.name].env[key] = String(value);
    } else if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
      rawServers[current.name].env = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
    } else {
      rawServers[current.name][key] = value;
    }
  }

  const servers = [];
  const skipped = [];
  for (const [name, raw] of Object.entries(rawServers)) {
    const normalised = normaliseStdioMCPServer(name, raw, source);
    if (normalised.server) servers.push(normalised.server);
    if (normalised.skipped) skipped.push(normalised.skipped);
  }
  return { servers, skipped };
}

function loadCodexMCPConfigFile(filePath, source) {
  const empty = { servers: [], skipped: [] };
  if (!filePath || !existsSync(filePath)) return empty;
  try {
    return parseCodexMCPServersToml(readFileSync(filePath, 'utf8'), source);
  } catch {
    return empty;
  }
}

function mergeMCPConfigResults(results) {
  const servers = [];
  const skipped = [];
  const seen = new Set();
  for (const result of results) {
    for (const s of result.servers || []) {
      if (!s?.name || seen.has(s.name)) continue;
      seen.add(s.name);
      servers.push(s);
    }
    skipped.push(...(result.skipped || []));
  }
  return { servers, skipped };
}

function loadExternalUserMCPServers() {
  const home = homedir();
  if (!home) return { servers: [], skipped: [] };
  return mergeMCPConfigResults([
    loadClaudeMCPJsonFile(join(home, '.claude.json'), '~/.claude.json'),
    loadCodexMCPConfigFile(join(home, '.codex', 'config.toml'), '~/.codex/config.toml'),
  ]);
}

/**
 * Parse project-level borrowed MCP configs from `<workDir>/.mcp.json` (Claude
 * Code) and `<workDir>/.codex/config.toml` (Codex).
 *
 * Claude Code format:
 *   { "mcpServers": { "<name>": { command, args?, env?, url?, type? } } }
 *
 * Codex format subset:
 *   [mcp_servers.<name>]
 *   command = "..."
 *   args = ["..."]
 *
 * Only stdio servers (those with a `command`) are adapted into yeaft's
 * { name, command, args?, env? } shape. SSE/HTTP servers (url/type, no
 * command) cannot be spawned by the current MCPManager, so they're reported
 * in `skipped` with reason 'unsupported-transport' rather than silently
 * dropped or surfaced later as spawn failures.
 *
 * Robust by design: missing files, malformed JSON/TOML, or non-object
 * `mcpServers` fields all return gracefully with empty arrays — broken borrowed
 * configs must never fail session creation.
 *
 * @param {string} workDir — project working directory
 * @returns {{ servers: object[], skipped: { name: string, reason: string, source: string }[] }}
 */
export function loadProjectMCPServers(workDir) {
  const empty = { servers: [], skipped: [] };
  if (!workDir || typeof workDir !== 'string') return empty;

  return mergeMCPConfigResults([
    loadClaudeMCPJsonFile(join(workDir, '.mcp.json'), '.mcp.json'),
    loadCodexMCPConfigFile(join(workDir, '.codex', 'config.toml'), '.codex/config.toml'),
  ]);
}
