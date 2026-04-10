/**
 * config.js — Yeaft configuration management
 *
 * Priority (high → low): CLI overrides > ENV vars > config.md frontmatter > defaults
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { resolveModel } from './models.js';

/** Default configuration values. */
const DEFAULTS = {
  model: 'claude-sonnet-4-20250514',
  fallbackModel: null,
  apiKey: null,
  openaiApiKey: null,
  proxyUrl: 'http://localhost:6628',
  baseUrl: null,
  adapter: null, // auto-detect: 'anthropic' | 'openai' | 'proxy'
  debug: false,
  dir: DEFAULT_YEAFT_DIR,
  maxContextTokens: 200000,
  maxOutputTokens: 16384,
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

  // Determine data directory first (needed to load config.md)
  const dir = overrides.dir || env.YEAFT_DIR || DEFAULTS.dir;

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
      overrides.maxContextTokens ||
      (env.YEAFT_MAX_CONTEXT ? parseInt(env.YEAFT_MAX_CONTEXT, 10) : null) ||
      fileConfig.maxContextTokens ||
      DEFAULTS.maxContextTokens,

    maxOutputTokens:
      overrides.maxOutputTokens ||
      fileConfig.maxOutputTokens ||
      DEFAULTS.maxOutputTokens,
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
