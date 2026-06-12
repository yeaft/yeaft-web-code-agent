/**
 * session-config.js — Per-session selected model override state.
 *
 * Each session may carry its header-selected model override in `config.json` at
 *   ~/.yeaft/sessions/<sessionId>/config.json
 *
 * v1 schema (intentionally tiny — extend via additive keys only):
 *   {
 *     "model": "my-proxy/claude-sonnet-4-20250514"   // optional
 *   }
 *
 * Missing file or `{}` → no session-level override. Missing field → fall back to user-level
 * config (`~/.yeaft/config.json` via loadConfig()). Resolution is a
 * shallow overlay for send-time effective config.
 *
 * Storage layer only — no engine wiring, no validation of model strings
 * against the provider registry (that's done lazily at resolve time by
 * the engine when it tries to dispatch to AdapterRouter).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeAtomic } from '../storage/index.js';
import { sessionsRoot, resolveSessionYeaftDir } from './session-crud.js';

const CONFIG_FILE = 'config.json';

/** Whitelist of persisted session model-override fields. Reject everything else. */
const ALLOWED_KEYS = new Set(['model']);

export class SessionConfigError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SessionConfigError';
    this.code = code;
  }
}

/**
 * Resolve the on-disk path for a session's config.json. Honours the
 * per-session workDir registry so sessions bound to a project directory
 * keep their config alongside the session metadata.
 */
export function sessionConfigPath(yeaftDir, sessionId) {
  if (!yeaftDir) return null;
  const sessionYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
  return join(sessionsRoot(sessionYeaftDir), sessionId, CONFIG_FILE);
}

/**
 * Read a session's config.json. Returns `{}` when the file is missing or
 * corrupt — callers fall back to user-level defaults via
 * `resolveSessionConfig`. We never auto-write on read.
 *
 * @param {string} yeaftDir
 * @param {string} sessionId
 * @returns {object}
 */
export function loadSessionConfig(yeaftDir, sessionId) {
  if (!sessionId || !yeaftDir) return {};
  const path = sessionConfigPath(yeaftDir, sessionId);
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Strip unknown keys at read time too — defensive against
    // hand-edited files that predate a key removal.
    const out = {};
    for (const k of Object.keys(parsed)) {
      if (ALLOWED_KEYS.has(k)) out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Validate a partial group-config object. Throws SessionConfigError on
 * any unknown key or malformed value. Empty / null values for known
 * keys are allowed — they signal "fall back to user default".
 *
 * @param {object} cfg
 */
export function validateSessionConfig(cfg) {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new SessionConfigError('invalid_shape', 'config must be an object');
  }
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new SessionConfigError('unknown_key', `unknown config key: ${k}`);
    }
  }
  if ('model' in cfg && cfg.model !== null && cfg.model !== undefined && cfg.model !== '') {
    if (typeof cfg.model !== 'string' || !cfg.model.trim()) {
      throw new SessionConfigError('invalid_model', 'model must be a non-empty string');
    }
  }
}

/**
 * Shallow-merge `partial` into the group's existing config.json and
 * persist atomically. Returns the resulting object. Passing `null` or
 * empty string for a known key removes that key (so the group falls
 * back to the user default).
 *
 * @param {string} yeaftDir
 * @param {string} sessionId
 * @param {object} partial
 * @returns {object}
 */
export function saveSessionConfig(yeaftDir, sessionId, partial) {
  if (!sessionId) throw new SessionConfigError('missing_group_id', 'sessionId required');
  validateSessionConfig(partial);
  const current = loadSessionConfig(yeaftDir, sessionId);
  const next = { ...current };
  for (const [k, v] of Object.entries(partial || {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === '') {
      delete next[k];
    } else {
      next[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  const path = sessionConfigPath(yeaftDir, sessionId);
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Initialise an empty config.json next to a brand-new group. Idempotent —
 * leaves an existing file untouched. Called by `createSessionFromSpec`.
 */
export function ensureSessionConfigFile(yeaftDir, sessionId) {
  const path = sessionConfigPath(yeaftDir, sessionId);
  if (!path || existsSync(path)) return;
  try {
    writeAtomic(path, `${JSON.stringify({}, null, 2)}\n`);
  } catch {
    // Best-effort — a permission failure here should never break group
    // create. Read path returns {} on missing file anyway.
  }
}

/**
 * Resolve the effective config for a group by overlaying group-level
 * overrides on top of the user-level config.
 *
 * Only fields that the per-group schema knows about are overlaid;
 * everything else (providers, language, token budgets, ...) is taken
 * verbatim from the user config.
 *
 * @param {object} userConfig — loadConfig() result
 * @param {object} sessionConfig — loadSessionConfig() result
 * @returns {object} — A new config object safe to hand to the engine.
 */
export function resolveSessionConfig(userConfig, sessionConfig) {
  const base = userConfig ? { ...userConfig } : {};
  const overrides = sessionConfig && typeof sessionConfig === 'object' ? sessionConfig : {};
  if (overrides.model && typeof overrides.model === 'string' && overrides.model.trim()) {
    const model = overrides.model.trim();
    base.model = model;
    base.primaryModel = model;
  }
  return base;
}
