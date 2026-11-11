/**
 * session-config.js — Per-session selected model override state.
 *
 * Each session carries its header-selected model override in `config.json` at
 *   ~/.yeaft/sessions/<sessionId>/config.json
 *
 * Session config is user-level state. Project `.yeaft` directories may provide
 * project assets such as skills/MCP config, but must not own Session config.
 *
 * Public v1 schema:
 *   {
 *     "model": "my-proxy/claude-sonnet-4-20250514",  // optional
 *     "modelEffort": "xhigh"                          // optional
 *   }
 *
 * Missing file or `{}` means no Session-level override. Managed provider
 * catalogs are authoritative: an override removed from such a catalog cannot
 * reach the adapter and falls back to the current Agent default.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeAtomic } from '../storage/index.js';
import { isGitHubCopilotProvider } from '../llm/known-providers.js';
import { normalizeEffort } from '../models.js';
import { sessionsRoot } from './session-crud.js';

const CONFIG_FILE = 'config.json';
const MODEL_SOURCE_EXPLICIT = 'explicit';
const WRITABLE_KEYS = new Set(['model', 'modelEffort']);
const STORED_KEYS = new Set([...WRITABLE_KEYS, 'modelSource']);

export class SessionConfigError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SessionConfigError';
    this.code = code;
  }
}

/** Resolve the agent-local path for a Session's config.json. */
export function sessionConfigPath(yeaftDir, sessionId) {
  if (!yeaftDir) return null;
  return join(sessionsRoot(yeaftDir), sessionId, CONFIG_FILE);
}

function publicConfig(stored) {
  const out = {};
  for (const key of WRITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stored || {}, key)) out[key] = key === 'modelEffort' ? normalizeEffort(stored[key]) : stored[key];
  }
  return out;
}

function loadStoredSessionConfig(yeaftDir, sessionId) {
  if (!sessionId || !yeaftDir) return {};
  const path = sessionConfigPath(yeaftDir, sessionId);
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of Object.keys(parsed)) {
      if (STORED_KEYS.has(key)) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}

function persistStoredSessionConfig(yeaftDir, sessionId, stored) {
  const path = sessionConfigPath(yeaftDir, sessionId);
  writeAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);
}

/**
 * Read public Session config. Internal provenance never crosses this boundary.
 */
export function loadSessionConfig(yeaftDir, sessionId) {
  return publicConfig(loadStoredSessionConfig(yeaftDir, sessionId));
}

/** Validate a user/wire supplied partial Session config. */
export function validateSessionConfig(cfg) {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new SessionConfigError('invalid_shape', 'config must be an object');
  }
  for (const key of Object.keys(cfg)) {
    if (!WRITABLE_KEYS.has(key)) {
      throw new SessionConfigError('unknown_key', `unknown config key: ${key}`);
    }
  }
  if ('model' in cfg && cfg.model !== null && cfg.model !== undefined && cfg.model !== '') {
    if (typeof cfg.model !== 'string' || !cfg.model.trim()) {
      throw new SessionConfigError('invalid_model', 'model must be a non-empty string');
    }
  }
  if ('modelEffort' in cfg && cfg.modelEffort !== null && cfg.modelEffort !== undefined && cfg.modelEffort !== '') {
    if (typeof cfg.modelEffort !== 'string' || !normalizeEffort(cfg.modelEffort.trim())) {
      throw new SessionConfigError('invalid_model_effort', 'modelEffort must be medium, xhigh, max, or ultra');
    }
  }
}

/**
 * Persist an explicit Session config change. `modelSource` is internal and is
 * set here rather than accepted from clients, so future migrations can
 * distinguish a user choice from the retired automatic default seed.
 */
export function saveSessionConfig(yeaftDir, sessionId, partial) {
  if (!sessionId) throw new SessionConfigError('missing_group_id', 'sessionId required');
  validateSessionConfig(partial);
  const next = { ...loadStoredSessionConfig(yeaftDir, sessionId) };
  for (const [key, value] of Object.entries(partial || {})) {
    if (!WRITABLE_KEYS.has(key)) continue;
    if (value === null || value === undefined || value === '') {
      delete next[key];
      if (key === 'model') delete next.modelSource;
      continue;
    }
    next[key] = key === 'modelEffort' ? normalizeEffort(value.trim()) : typeof value === 'string' ? value.trim() : value;
    if (key === 'model') next.modelSource = MODEL_SOURCE_EXPLICIT;
  }
  persistStoredSessionConfig(yeaftDir, sessionId, next);
  return publicConfig(next);
}

/** Create an empty Session config file without inventing an override. */
export function ensureSessionConfigFile(yeaftDir, sessionId) {
  const path = sessionConfigPath(yeaftDir, sessionId);
  if (!path || existsSync(path)) return;
  try {
    persistStoredSessionConfig(yeaftDir, sessionId, {});
  } catch {
    // Best-effort — a permission failure must not break Session creation.
  }
}

function modelRefIdentity(value) {
  const text = String(value || '');
  const slash = text.indexOf('/');
  return slash < 0
    ? { provider: '', modelId: text }
    : { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

function modelRefsEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const a = modelRefIdentity(left);
  const b = modelRefIdentity(right);
  if (a.modelId !== b.modelId) return false;
  return !a.provider || !b.provider || a.provider === b.provider;
}

function hasAuthoritativeCatalog(provider) {
  if (!provider || typeof provider !== 'object') return false;
  if (provider.managed === true) return true;
  if (typeof provider.managed === 'string' && provider.managed.trim()) return true;
  return isGitHubCopilotProvider(provider);
}

function resolveAllowedModelRef(config, modelRef) {
  const identity = modelRefIdentity(modelRef);
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const availableModels = Array.isArray(config?.availableModels) ? config.availableModels : [];

  if (identity.provider) {
    const provider = providers.find(item => item?.name === identity.provider);
    if (!hasAuthoritativeCatalog(provider)) return modelRef;
    const match = availableModels.find(model => model?.ref === modelRef
      || (model?.provider === identity.provider && model?.id === identity.modelId));
    return match?.ref || (match ? `${identity.provider}/${identity.modelId}` : null);
  }

  const authoritativeProviderNames = new Set(providers
    .filter(hasAuthoritativeCatalog)
    .map(provider => provider.name)
    .filter(Boolean));
  if (authoritativeProviderNames.size === 0) return modelRef;

  const candidates = new Map();
  for (const model of availableModels) {
    const candidateIdentity = modelRefIdentity(model?.ref || '');
    const candidateId = model?.id || candidateIdentity.modelId;
    const providerName = model?.provider || candidateIdentity.provider;
    if (candidateId !== identity.modelId || !providerName) continue;
    candidates.set(model?.ref || `${providerName}/${candidateId}`, providerName);
  }
  if (candidates.size !== 1) return null;
  const [[ref]] = candidates;
  return ref;
}

/**
 * Normalize persisted config at the Agent/Session boundary.
 *
 * - Managed catalog misses are always removed: they are no longer valid.
 * - Legacy rows have no source bit. An unmarked value equal to the Agent's
 *   previous default is the retired automatic seed and becomes inheritance.
 * - Values written through the explicit update path carry `modelSource` and
 *   are preserved while they remain in the authoritative catalog.
 */
export function normalizeSessionConfig(
  yeaftDir,
  sessionId,
  userConfig,
  { previousDefaultModel = null } = {},
) {
  const stored = loadStoredSessionConfig(yeaftDir, sessionId);
  if (!stored.model || typeof stored.model !== 'string') return publicConfig(stored);

  const allowedModel = resolveAllowedModelRef(userConfig, stored.model);
  // The retired create path wrote the then-current Agent default without a
  // source bit. New explicit writes always carry modelSource, so this is the
  // only deterministic compatibility rule available for legacy rows.
  const legacyAutoSeed = stored.modelSource !== MODEL_SOURCE_EXPLICIT
    && modelRefsEquivalent(stored.model, previousDefaultModel);
  if (allowedModel && !legacyAutoSeed) {
    const next = { ...stored };
    let changed = false;
    if (next.model !== allowedModel) {
      next.model = allowedModel;
      changed = true;
    }
    // Resolve every legacy row once while the old Agent default is known. A
    // different value could only have come from an explicit Session choice;
    // backfill provenance so a later default change cannot misclassify it.
    if (previousDefaultModel && next.modelSource !== MODEL_SOURCE_EXPLICIT) {
      next.modelSource = MODEL_SOURCE_EXPLICIT;
      changed = true;
    }
    if (changed) persistStoredSessionConfig(yeaftDir, sessionId, next);
    return publicConfig(next);
  }

  const next = { ...stored };
  delete next.model;
  delete next.modelSource;
  persistStoredSessionConfig(yeaftDir, sessionId, next);
  return publicConfig(next);
}

/** Overlay a valid Session override on the Agent config. */
export function resolveSessionConfig(userConfig, sessionConfig) {
  const base = userConfig ? { ...userConfig } : {};
  const overrides = sessionConfig && typeof sessionConfig === 'object' ? sessionConfig : {};
  if (overrides.model && typeof overrides.model === 'string' && overrides.model.trim()) {
    const model = resolveAllowedModelRef(base, overrides.model.trim());
    if (model) {
      base.model = model;
      base.primaryModel = model;
    }
  }
  const effort = normalizeEffort(overrides.modelEffort) || normalizeEffort(base.modelEffort);
  if (effort) base.modelEffort = effort;
  return base;
}
