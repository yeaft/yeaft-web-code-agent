/**
 * config.js — Yeaft configuration management
 *
 * Priority (high → low): CLI overrides > ENV vars > .env file > config.md frontmatter > defaults
 *
 * Note: "model" in Yeaft always means a model ID (e.g. "gpt-5", "claude-sonnet-4-20250514").
 * Yeaft does not provide its own models — it routes to external LLM providers via adapters.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { resolveModel } from './models.js';

/** Default configuration values. */
const DEFAULTS = {
  model: 'claude-sonnet-4-20250514',
  fallbackModel: null,
  language: 'en', // 'en' | 'zh'
  apiKey: null,
  openaiApiKey: null,
  proxyUrl: 'http://localhost:6628',
  baseUrl: null,
  adapter: null, // auto-detect: 'anthropic' | 'openai' | 'proxy'
  debug: false,
  dir: DEFAULT_YEAFT_DIR,
  maxContextTokens: 200000,
  maxOutputTokens: 16384,
  messageTokenBudget: 8192, // Phase 2: context * 4%, triggers consolidation
  maxContinueTurns: 3,      // Phase 2: auto-continue on max_tokens
};

/**
 * Parse YAML frontmatter from a markdown file.
 * Simple parser — handles key: value pairs, no nested objects.
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
    // Parse booleans and numbers
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
    result[key] = value;
  }
  return result;
}

/**
 * Load configuration from config.md file.
 *
 * @param {string} dir — Yeaft data directory
 * @returns {Record<string, unknown>} — Config from file
 */
function loadConfigFile(dir) {
  const configPath = join(dir, 'config.md');
  if (!existsSync(configPath)) return {};

  try {
    const content = readFileSync(configPath, 'utf8');
    return parseFrontmatter(content);
  } catch {
    return {};
  }
}

/**
 * Load .env file from a directory. Sets process.env for any keys
 * not already defined (env vars take precedence over .env file).
 *
 * ⚠️ Side-effect: mutates process.env globally. Values set by a previous
 * call persist across subsequent loadConfig() calls within the same process.
 * This is by design (matches dotenv behavior), but callers that need isolation
 * (e.g. tests) must manually delete keys from process.env between calls.
 *
 * @param {string} dir — Directory containing .env file
 */
function loadEnvFile(dir) {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      let trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Strip optional 'export ' prefix (common in .env files)
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7);
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Only set if not already defined (shell env takes precedence)
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore .env read errors
  }
}

/**
 * Helper: check if an env var is truthy.
 * @param {string|undefined} val
 * @returns {boolean}
 */
function isTruthy(val) {
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * Load full configuration.
 *
 * @param {Record<string, unknown>} [overrides] — CLI overrides
 * @returns {object} — Merged configuration
 */
export function loadConfig(overrides = {}) {
  const env = process.env;

  // Determine data directory first (needed to load .env and config.md)
  const dir = overrides.dir || env.YEAFT_DIR || DEFAULTS.dir;

  // Load .env file (sets process.env for undefined keys — shell env takes precedence)
  loadEnvFile(dir);

  // Load from config.md
  const fileConfig = loadConfigFile(dir);

  // Build merged config: defaults < file < env < overrides
  const config = {
    model:
      overrides.model ||
      env.YEAFT_MODEL ||
      fileConfig.model ||
      DEFAULTS.model,

    fallbackModel:
      overrides.fallbackModel ||
      env.YEAFT_FALLBACK_MODEL ||
      fileConfig.fallbackModel ||
      DEFAULTS.fallbackModel,

    language:
      overrides.language ||
      env.YEAFT_LANGUAGE ||
      fileConfig.language ||
      DEFAULTS.language,

    apiKey:
      overrides.apiKey ||
      env.YEAFT_API_KEY ||
      fileConfig.apiKey ||
      DEFAULTS.apiKey,

    openaiApiKey:
      overrides.openaiApiKey ||
      env.YEAFT_OPENAI_API_KEY ||
      fileConfig.openaiApiKey ||
      DEFAULTS.openaiApiKey,

    proxyUrl:
      overrides.proxyUrl ||
      env.YEAFT_PROXY_URL ||
      fileConfig.proxyUrl ||
      DEFAULTS.proxyUrl,

    baseUrl:
      overrides.baseUrl ||
      env.YEAFT_BASE_URL ||
      fileConfig.baseUrl ||
      DEFAULTS.baseUrl,

    adapter:
      overrides.adapter ||
      env.YEAFT_ADAPTER ||
      fileConfig.adapter ||
      DEFAULTS.adapter,

    debug:
      overrides.debug !== undefined
        ? overrides.debug
        : env.YEAFT_DEBUG !== undefined
          ? isTruthy(env.YEAFT_DEBUG)
          : fileConfig.debug !== undefined
            ? fileConfig.debug
            : DEFAULTS.debug,

    dir,

    maxContextTokens:
      overrides.maxContextTokens ??
      (env.YEAFT_MAX_CONTEXT ? parseInt(env.YEAFT_MAX_CONTEXT, 10) : null) ??
      fileConfig.maxContextTokens ??
      DEFAULTS.maxContextTokens,

    maxOutputTokens:
      overrides.maxOutputTokens ??
      fileConfig.maxOutputTokens ??
      DEFAULTS.maxOutputTokens,

    messageTokenBudget:
      overrides.messageTokenBudget ??
      (env.YEAFT_MESSAGE_TOKEN_BUDGET ? parseInt(env.YEAFT_MESSAGE_TOKEN_BUDGET, 10) : null) ??
      fileConfig.messageTokenBudget ??
      DEFAULTS.messageTokenBudget,

    maxContinueTurns:
      overrides.maxContinueTurns ??
      fileConfig.maxContinueTurns ??
      DEFAULTS.maxContinueTurns,
  };

  // Auto-detect adapter using model registry + credential fallback
  if (!config.adapter) {
    const modelInfo = resolveModel(config.model);
    if (modelInfo) {
      // Known model → set adapter from registry
      config.adapter = modelInfo.adapter === 'anthropic' ? 'anthropic' : 'openai';
      // Use registry baseUrl if not explicitly overridden
      if (!config.baseUrl) {
        config.baseUrl = modelInfo.baseUrl;
      }
      // Use registry contextWindow if still at default
      if (config.maxContextTokens === DEFAULTS.maxContextTokens) {
        config.maxContextTokens = modelInfo.contextWindow;
      }
      // Use registry maxOutputTokens if still at default
      if (config.maxOutputTokens === DEFAULTS.maxOutputTokens) {
        config.maxOutputTokens = modelInfo.maxOutputTokens;
      }
    } else {
      // Unknown model → fallback to credential-based detection
      if (config.apiKey) {
        config.adapter = 'anthropic';
      } else if (config.openaiApiKey) {
        config.adapter = 'openai';
      } else if (config.proxyUrl) {
        config.adapter = 'proxy';
      }
    }
  }

  // Store resolved model info for reference
  config.modelInfo = resolveModel(config.model) || null;

  return config;
}

/**
 * Load MCP server configuration from ~/.yeaft/mcp.json.
 *
 * JSON format (frontmatter parser can't handle nested objects):
 * {
 *   "servers": [
 *     {
 *       "name": "github",
 *       "command": "npx",
 *       "args": ["@mcp/github"],
 *       "env": { "GITHUB_TOKEN": "ghp_..." }
 *     }
 *   ]
 * }
 *
 * @param {string} yeaftDir — e.g. ~/.yeaft
 * @returns {{ servers: object[] }}
 */
export function loadMCPConfig(yeaftDir) {
  const mcpPath = join(yeaftDir, 'mcp.json');
  if (!existsSync(mcpPath)) return { servers: [] };

  try {
    const raw = readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      return { servers: [] };
    }
    // Each server must have at least name + command
    const valid = parsed.servers.filter(s => s.name && s.command);
    return { servers: valid };
  } catch {
    return { servers: [] };
  }
}
