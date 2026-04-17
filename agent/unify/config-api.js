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
