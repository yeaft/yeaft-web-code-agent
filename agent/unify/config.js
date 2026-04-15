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
 *   "messageTokenBudget": 8192
 * }
 *
 * Legacy: if config.json doesn't exist, falls back to old config.md + .env for migration.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { resolveModel, parseModelRef } from './models.js';

/** Default configuration values. */
const DEFAULTS = {
  language: 'en',
  debug: false,
  dir: DEFAULT_YEAFT_DIR,
  maxContextTokens: 200000,
  maxOutputTokens: 16384,
  messageTokenBudget: 8192,
  maxContinueTurns: 3,
};

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
      if (config.maxContextTokens === DEFAULTS.maxContextTokens) config.maxContextTokens = modelInfo.contextWindow;
      if (config.maxOutputTokens === DEFAULTS.maxOutputTokens) config.maxOutputTokens = modelInfo.maxOutputTokens;
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
  const providers = Array.isArray(jsonConfig.providers) ? jsonConfig.providers : null;

  // Resolve primary model
  let model = 'claude-sonnet-4-20250514';
  let primaryModel = jsonConfig.primaryModel || null;
  if (primaryModel) {
    const parsed = parseModelRef(primaryModel);
    model = parsed.modelId;
  }

  // Resolve fast model
  let fastModel = jsonConfig.fastModel || primaryModel || null;
  let fastModelId = null;
  if (fastModel) {
    const parsed = parseModelRef(fastModel);
    fastModelId = parsed.modelId;
  }

  // Resolve model info for context window / output limits
  const modelInfo = resolveModel(model);

  const config = {
    // Model
    model: overrides.model || model,
    primaryModel: overrides.primaryModel || primaryModel,
    fastModel: overrides.fastModel || fastModel,
    fastModelId: fastModelId,
    fallbackModel: jsonConfig.fallbackModel || null,
    modelInfo: modelInfo || null,

    // Providers
    providers: providers,

    // General settings
    language: overrides.language || jsonConfig.language || DEFAULTS.language,
    debug: overrides.debug !== undefined ? overrides.debug : (jsonConfig.debug ?? DEFAULTS.debug),
    dir,

    // Token limits
    maxContextTokens: overrides.maxContextTokens ?? jsonConfig.maxContextTokens ?? modelInfo?.contextWindow ?? DEFAULTS.maxContextTokens,
    maxOutputTokens: overrides.maxOutputTokens ?? jsonConfig.maxOutputTokens ?? modelInfo?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    messageTokenBudget: overrides.messageTokenBudget ?? jsonConfig.messageTokenBudget ?? DEFAULTS.messageTokenBudget,
    maxContinueTurns: overrides.maxContinueTurns ?? jsonConfig.maxContinueTurns ?? DEFAULTS.maxContinueTurns,

    // Legacy fields (null when using config.json)
    apiKey: overrides.apiKey || null,
    openaiApiKey: null,
    proxyUrl: null,
    baseUrl: null,
    adapter: null,
  };

  // Aggregate all available models from providers
  config.availableModels = [];
  if (providers) {
    for (const p of providers) {
      if (!Array.isArray(p.models)) continue;
      for (const m of p.models) {
        // Avoid duplicates (first provider wins)
        if (!config.availableModels.some(am => am.id === m)) {
          config.availableModels.push({
            id: m,
            provider: p.name,
            label: m,
          });
        }
      }
    }
  }

  return config;
}

// ─── MCP config ─────────────────────────────────────────────────

/**
 * Load MCP server configuration.
 *
 * Reads from config.json "mcpServers" field first, then falls back to
 * standalone ~/.yeaft/mcp.json for backward compatibility.
 *
 * @param {string} yeaftDir
 * @param {object} [jsonConfig] — Already-parsed config.json (optional, avoids re-read)
 * @returns {{ servers: object[] }}
 */
export function loadMCPConfig(yeaftDir, jsonConfig) {
  // Check config.json mcpServers field
  if (jsonConfig && Array.isArray(jsonConfig.mcpServers)) {
    const valid = jsonConfig.mcpServers.filter(s => s.name && s.command);
    if (valid.length > 0) return { servers: valid };
  }

  // Fallback: standalone mcp.json
  const mcpPath = join(yeaftDir, 'mcp.json');
  if (!existsSync(mcpPath)) return { servers: [] };

  try {
    const raw = readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.servers || !Array.isArray(parsed.servers)) return { servers: [] };
    const valid = parsed.servers.filter(s => s.name && s.command);
    return { servers: valid };
  } catch {
    return { servers: [] };
  }
}
