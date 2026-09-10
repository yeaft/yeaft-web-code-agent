/**
 * session-crud.js — High-level Session CRUD API (task-334m).
 *
 * Wraps the primitives from session-store.js + roster.js into the 5 operations
 * wired to WS events (§Δ10 334m + R6 §Δ31.2):
 *   createSessionFromSpec  — wizard "create new session" (empty or user-picked roster)
 *   renameSession          — update meta.name; preserves roster / defaultVpId
 *   archiveSession         — rename dir to `.archived-<ts>-<id>` (soft delete)
 *   addMember            — roster.addVp + save; sets defaultVpId if first
 *   removeMember         — roster.removeVp + save; clears/rotates defaultVpId
 *
 * Plus the D1 bootstrap helper:
 *   ensureDefaultSessionIfEmpty(yeaftDir, {libDir}) — if NO session exists on
 *   disk, seed `session_default` with roster = every VP in the library, and
 *   defaultVpId = `omni` when present, otherwise the alphabetically first vpId.
 *   No-op when ≥1 session present.
 *
 * Hard constraints (PM):
 *   (a) We don't touch 334o storage primitives (storage/index.js) — we call
 *       group-store.openSession / saveMeta which already go through openLog.
 *   (b) We don't touch VP entity (vp-store.js / vp-loader.js) — only read
 *       via scanVpLibrary to know which VPs exist at seed time.
 *   (c) `createSessionFromSpec` seeds omitted/empty rosters with the default
 *       generalist VP when the library has one; truly empty VP libraries can
 *       still create empty sessions and surface `no_default_vp` on first send.
 *       On `removeMember` we permit the empty state (UI nudges the user).
 *
 * Error shape — every throw is a `SessionCrudError` with a stable `.code`:
 *   'not_found'        — group id has no dir / meta
 *   'duplicate'        — createSession collided with an existing id
 *   'invalid_name'     — display name empty after trim
 *   'no_default_vp'    — seed with empty VP library OR roster empties to []
 *                        and the caller asked for a defaultVpId. (D1 spec)
 *   'reserved'/'invalid_vp_id'/... — bubbled from ids.js validators
 */

import {
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  realpathSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import {
  openSession, createSession, loadSessionMeta,
} from './session-store.js';
import { addVp as rosterAdd, removeVp as rosterRemove, setDefaultVp } from './roster.js';
import { seedDefaultSession, DEFAULT_SESSION_ID } from './seed-default.js';
import { nextSessionId, validateVpId, isReservedVpId } from './ids.js';
import { scanVpLibrary, DEFAULT_VP_LIB_DIR } from '../vp/vp-store.js';
import { seedSummaryIfMissingSync, removeScopeDirSync } from '../memory/store.js';
import {
  markConversationDirty,
  removeConversationIndexScope,
} from '../conversation/history-index-state.js';
import { retireConversationHistoryIndex } from '../conversation/history-index.js';
import { ensureSessionConfigFile, saveSessionConfig, loadSessionConfig } from './session-config.js';
import { ConversationStore } from '../conversation/persist.js';
import { repairSessionStore } from './recovery.js';
import {
  addOrUpdateManifestSession,
  ensureSessionsManifest,
  hasSessionManifest,
  listManifestSessions,
  removeManifestSession,
  resolveManifestSessionDir,
} from './session-manifest.js';

/**
 * Default memory root used when callers don't pass `options.memoryRoot`.
 * See `vp/vp-crud.js` for the same default; production code threads
 * `<yeaftDir>/memory` through to keep test/prod isolation honest.
 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

function markSessionConversationDirty(ownerRoot, sessionId, reason, paths = {}) {
  try {
    markConversationDirty({
      ownerRoot,
      scopeKind: 'session',
      scopeId: sessionId,
      reason,
      ...paths,
    });
  } catch (error) {
    console.warn(`[session-crud] failed to mark conversation index dirty for ${sessionId}:`, error?.message || error);
  }
}

function invalidateSessionConversationIndex(ownerRoots, sessionId, reason, paths = {}) {
  for (const ownerRoot of new Set((ownerRoots || []).filter(Boolean))) {
    retireConversationHistoryIndex(ownerRoot, sessionId).catch(error => {
      console.warn(
        `[session-crud] failed to retire conversation index for ${sessionId}:`,
        error?.message || error,
      );
    });
    try {
      removeConversationIndexScope(ownerRoot, sessionId);
    } catch (error) {
      console.warn(
        `[session-crud] failed to remove conversation index for ${sessionId}:`,
        error?.message || error,
      );
    }
    markSessionConversationDirty(ownerRoot, sessionId, reason, paths);
  }
}

/**
 * Build the group seed summary body. Uses the group display name + roster
 * so even an empty conversation has SOMETHING for engine.#prepareAms to
 * pull into the Layer-A resident summary on the very first turn.
 *
 * Format is intentionally short: Dream-v2 will rewrite it in full once
 * meaningful diffs accumulate.
 *
 * @param {{name:string, roster?:string[], defaultVpId?:string|null}} spec
 * @returns {string}
 */
export function buildSessionSeedSummary(spec) {
  const name = String(spec?.name || '').trim();
  const roster = Array.isArray(spec?.roster) ? spec.roster : [];
  const lines = [];
  if (name) lines.push(`# ${name}`);
  lines.push('', `Group with ${roster.length} member${roster.length === 1 ? '' : 's'}.`);
  if (roster.length > 0) {
    lines.push('', `**Members:** ${roster.join(', ')}`);
  }
  if (spec?.defaultVpId) {
    lines.push('', `**Default VP:** ${spec.defaultVpId}`);
  }
  return lines.join('\n').trim();
}

export class SessionCrudError extends Error {
  constructor(code, sessionId, message) {
    super(message || `${code}: ${sessionId}`);
    this.name = 'SessionCrudError';
    this.code = code;
    this.sessionId = sessionId;
  }
}

const GROUP_WORKDIR_REGISTRY = 'group-workdirs.json';
const DEFAULT_VP_ID = 'omni';

export function sessionsRoot(yeaftDir) {
  return join(yeaftDir, 'sessions');
}

export function normalizeWorkDir(workDir) {
  const raw = String(workDir || '').trim();
  if (!raw) return '';
  return isAbsolute(raw) ? raw : resolve(raw);
}

function canonicalWorkspaceKey(workDir) {
  const normalized = normalizeWorkDir(workDir);
  if (!normalized) return '';
  try { return realpathSync(normalized); } catch { return ''; }
}

export function yeaftDirForWorkDir(workDir) {
  const normalized = normalizeWorkDir(workDir);
  return normalized ? join(normalized, '.yeaft') : '';
}

function registryPath(yeaftDir) {
  return join(yeaftDir, GROUP_WORKDIR_REGISTRY);
}

export function readWorkDirRegistry(yeaftDir) {
  if (!yeaftDir) return {};
  const file = registryPath(yeaftDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeWorkDirRegistry(yeaftDir, registry) {
  if (!yeaftDir) return;
  mkdirSync(yeaftDir, { recursive: true });
  writeFileSync(registryPath(yeaftDir), `${JSON.stringify(registry, null, 2)}\n`);
}

export function registerSessionWorkDir(defaultYeaftDir, sessionId, workDir) {
  const normalized = normalizeWorkDir(workDir);
  if (!defaultYeaftDir || !sessionId || !normalized) return;
  const registry = readWorkDirRegistry(defaultYeaftDir);
  registry[sessionId] = normalized;
  writeWorkDirRegistry(defaultYeaftDir, registry);
}

export function unregisterSessionWorkDir(defaultYeaftDir, sessionId) {
  if (!defaultYeaftDir || !sessionId) return;
  const registry = readWorkDirRegistry(defaultYeaftDir);
  if (!Object.prototype.hasOwnProperty.call(registry, sessionId)) return;
  delete registry[sessionId];
  writeWorkDirRegistry(defaultYeaftDir, registry);
}

function ensureSessionManifestReady(yeaftDir) {
  const result = ensureSessionsManifest(yeaftDir, {
    sessionsRoot: sessionsRoot(yeaftDir),
    registry: readWorkDirRegistry(yeaftDir),
    yeaftDirForWorkDir,
    sessionsRootForYeaftDir: sessionsRoot,
    copySessionExtras: (projectYeaftDir, sessionId) => copySessionExtras(projectYeaftDir, yeaftDir, sessionId),
    unregisterSessionWorkDir: (sessionId) => unregisterSessionWorkDir(yeaftDir, sessionId),
  });
  for (const row of listManifestSessions(yeaftDir)) {
    const normalized = normalizeWorkDir(row.meta.workDir);
    const workspaceKey = canonicalWorkspaceKey(normalized);
    if (row.meta.workspaceKey || !workspaceKey || workspaceKey !== normalized) continue;
    const handle = openSession(sessionsRoot(yeaftDir), row.meta.id);
    try {
      const updated = { ...row.meta, workspaceKey };
      handle.saveMeta(updated);
      addOrUpdateManifestSession(yeaftDir, updated, row.dir);
    } finally {
      handle.close();
    }
  }
  return result;
}

function copySessionExtras(sourceYeaftDir, destYeaftDir, sessionId) {
  for (const family of ['session', 'sessions', 'group']) {
    const src = join(sourceYeaftDir, 'memory', family, sessionId);
    const dst = join(destYeaftDir, 'memory', family, sessionId);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst, { recursive: true, errorOnExist: false });
  }
}

function repairSessionStoreAndManifest(yeaftDir, options = {}) {
  const repaired = repairSessionStore(yeaftDir, options);
  ensureSessionManifestReady(yeaftDir);
  for (const row of repaired.sessions || []) {
    const dir = join(sessionsRoot(yeaftDir), row.sessionId);
    const meta = loadSessionMeta(dir);
    if (meta) addOrUpdateManifestSession(yeaftDir, meta, dir);
  }
  return repaired;
}

/**
 * One-way compatibility migration for sessions previously stored under a
 * project `.yeaft/sessions` tree. New steady-state discovery uses
 * `sessions-manifest.json`; this helper bootstraps that manifest once and
 * reports what happened for boot logs/tests.
 *
 * @param {string} yeaftDir user-level Yeaft root
 * @returns {{migrated:string[], skipped:string[], errors:Array<{sessionId:string,error:string}>}}
 */
export function migrateRegisteredWorkDirSessions(yeaftDir) {
  const result = { migrated: [], skipped: [], errors: [] };
  if (!yeaftDir || hasSessionManifest(yeaftDir)) return result;

  const invalidTargets = new Set();
  const registry = readWorkDirRegistry(yeaftDir);
  for (const [sessionId, workDir] of Object.entries(registry)) {
    const normalized = normalizeWorkDir(workDir);
    if (!sessionId || !normalized) continue;
    const targetDir = join(sessionsRoot(yeaftDir), sessionId);
    if (existsSync(targetDir) && !loadSessionMeta(targetDir)) {
      invalidTargets.add(sessionId);
      result.errors.push({ sessionId, error: 'target session directory exists but session metadata is invalid' });
    }
  }

  const bootstrap = ensureSessionManifestReady(yeaftDir);
  result.migrated = Array.isArray(bootstrap.migratedIds) ? bootstrap.migratedIds.slice() : [];
  result.skipped = (Array.isArray(bootstrap.skippedIds) ? bootstrap.skippedIds : [])
    .filter(sessionId => !invalidTargets.has(sessionId));
  return result;
}

/**
 * List every Session owned by `yeaftDir` whose normalized workDir matches.
 * Workdir-local `.yeaft/sessions` is also read as a legacy import fallback;
 * those rows are marked `legacyImport` and never replace a current row with
 * the same Session id. The normal Session snapshot may repair its own manifest;
 * this query never writes the legacy workdir registry.
 *
 * @param {string} workDir working directory to match
 * @param {string|null} yeaftDir Agent-owned data root; omit for legacy scans
 * @returns {Array<object>}
 */
export function scanWorkdirSessions(workDir, yeaftDir = null) {
  const normalized = normalizeWorkDir(workDir);
  if (!normalized) return [];

  // Session storage is Agent-owned. The workDir-local `.yeaft/sessions`
  // location below is only a legacy import source; querying a folder must
  // start from the Agent manifest so sidebar UI metadata cannot hide an
  // otherwise valid Session from the create/resume picker.
  const currentSessions = yeaftDir
    ? snapshotSessions(yeaftDir).filter(meta => normalizeWorkDir(meta.workDir) === normalized)
    : [];
  const seen = new Set(currentSessions.map(meta => meta.id));
  const groupYeaftDir = yeaftDirForWorkDir(normalized);
  const root = sessionsRoot(groupYeaftDir);
  const legacySessions = [];
  let entries = [];
  try {
    if (existsSync(root)) entries = readdirSync(root);
  } catch { /* treat an unreadable legacy root as empty */ }
  for (const name of entries) {
    if (name.startsWith('.') || seen.has(name)) continue;
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const meta = loadSessionMeta(dir);
    if (!meta || seen.has(meta.id)) continue;
    legacySessions.push({
      ...meta,
      workDir: normalized,
      legacyImport: true,
    });
  }
  return [...currentSessions, ...legacySessions]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * Register `(sessionId, workDir)` in the central registry so the next
 * `snapshotSessions()` includes this session.
 *
 * Validates that `<workDir>/.yeaft/sessions/<sessionId>/session.json`
 * exists and is parseable, with legacy `group.json` as a read fallback.
 * Throws:
 *  - `not_found`   — the session dir is not on disk at this workdir
 *  - `corrupt_meta` — the dir exists but session metadata is missing /
 *                    unreadable / can't be parsed. Surfaced as a distinct
 *                    code so the UI can tell the user "the file is broken"
 *                    instead of "you picked the wrong workdir" (review
 *                    finding I1).
 *
 * Idempotent: if the same `(sessionId, workDir)` is already registered,
 * we still rewrite the entry (with the normalized path) and return the
 * fresh meta — no error.
 *
 * @param {string} defaultYeaftDir
 * @param {string} sessionId
 * @param {string} workDir
 * @returns {object} the session meta, with `workDir` set to the normalized path.
 */
export function restoreSessionToRegistry(defaultYeaftDir, sessionId, workDir) {
  if (!sessionId) throw new SessionCrudError('invalid_session_id', null);
  const normalized = normalizeWorkDir(workDir);
  if (!normalized) throw new SessionCrudError('invalid_workdir', sessionId);
  const projectYeaftDir = yeaftDirForWorkDir(normalized);
  const sourceDir = join(sessionsRoot(projectYeaftDir), sessionId);
  if (!existsSync(sourceDir)) throw new SessionCrudError('not_found', sessionId);
  const meta = loadSessionMeta(sourceDir);
  if (!meta) throw new SessionCrudError('corrupt_meta', sessionId, `session metadata missing or unreadable at ${sourceDir} (expected session.json or legacy group.json)`);

  ensureSessionManifestReady(defaultYeaftDir);
  const root = sessionsRoot(defaultYeaftDir);
  const destDir = join(root, sessionId);
  const manifestDir = resolveManifestSessionDir(defaultYeaftDir, sessionId);
  if (existsSync(destDir)) {
    const existing = loadSessionMeta(destDir);
    if (existing && manifestDir === destDir) return { ...existing, workDir: existing.workDir || normalized };
    throw new SessionCrudError('duplicate', sessionId, `session already exists at ${destDir}`);
  }

  mkdirSync(root, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true, errorOnExist: true });
  const importedMeta = {
    ...meta,
    workDir: normalized,
    workspaceKey: canonicalWorkspaceKey(normalized),
  };
  const handle = openSession(root, sessionId);
  try {
    handle.saveMeta(importedMeta);
  } finally {
    handle.close();
  }
  copySessionExtras(projectYeaftDir, defaultYeaftDir, sessionId);
  invalidateSessionConversationIndex(
    [defaultYeaftDir],
    sessionId,
    'restore-session',
    { oldPath: sourceDir, newPath: destDir },
  );
  addOrUpdateManifestSession(defaultYeaftDir, importedMeta, destDir);
  unregisterSessionWorkDir(defaultYeaftDir, sessionId);
  return importedMeta;
}

/**
 * Resolve an already-existing Session owner without bootstrapping or migrating
 * Session storage. Read-only callers must use this instead of
 * resolveSessionYeaftDir(): the latter intentionally repairs the manifest for
 * runtime/CRUD entry points.
 */
export function findExistingSessionYeaftDir(defaultYeaftDir, sessionId) {
  if (!defaultYeaftDir || !sessionId) return defaultYeaftDir;

  const manifestDir = resolveManifestSessionDir(defaultYeaftDir, sessionId);
  if (manifestDir) return join(manifestDir, '..', '..');

  const registry = readWorkDirRegistry(defaultYeaftDir);
  const workDir = normalizeWorkDir(registry[sessionId]);
  if (workDir) {
    const candidate = yeaftDirForWorkDir(workDir);
    const candidateDir = join(sessionsRoot(candidate), sessionId);
    if (existsSync(candidateDir) && loadSessionMeta(candidateDir)) return candidate;
  }

  const defaultSessionDir = join(sessionsRoot(defaultYeaftDir), sessionId);
  if (existsSync(defaultSessionDir) && loadSessionMeta(defaultSessionDir)) return defaultYeaftDir;

  return defaultYeaftDir;
}

export function resolveSessionYeaftDir(defaultYeaftDir, sessionId) {
  if (!defaultYeaftDir || !sessionId) return defaultYeaftDir;

  const manifestReady = hasSessionManifest(defaultYeaftDir);
  ensureSessionManifestReady(defaultYeaftDir);
  const manifestDir = resolveManifestSessionDir(defaultYeaftDir, sessionId);
  if (manifestDir) return join(manifestDir, '..', '..');
  if (manifestReady) return defaultYeaftDir;

  return findExistingSessionYeaftDir(defaultYeaftDir, sessionId);
}

/** Build a safe group id from a display name (slug + ulid-lite suffix). */
export function makeSessionId(name) {
  const slug = String(name || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'session';
  return nextSessionId(slug);
}

function preferDefaultVp(vpIds) {
  if (!Array.isArray(vpIds) || vpIds.length === 0) return null;
  return vpIds.includes(DEFAULT_VP_ID) ? DEFAULT_VP_ID : vpIds[0];
}

function scanSortedVpIds(libDir) {
  const vpIds = scanVpLibrary({ dir: libDir })
    .map(v => v && v.id)
    .filter(v => typeof v === 'string' && v.length > 0);
  vpIds.sort((a, b) => a.localeCompare(b));
  return vpIds;
}

/**
 * (B) D1 seed — called at boot (or when multi-VP is first enabled). Idempotent:
 * returns `{seeded:false}` if any session already exists on disk (including
 * `session_default`). When empty, seeds with roster = full VP library, sorted
 * alphabetically; defaultVpId = `omni` when present, otherwise roster[0].
 *
 * When the VP library is also empty, we still seed an empty-roster session so
 * the UI has somewhere to land — but defaultVpId is null and downstream
 * message send will return `no_default_vp` until the user adds a VP.
 */
export function ensureDefaultSessionIfEmpty(yeaftDir, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const memoryRoot = options.memoryRoot || DEFAULT_MEMORY_ROOT;
  repairSessionStoreAndManifest(yeaftDir, {
    defaultRoster: scanSortedVpIds(libDir),
  });
  const existing = listManifestSessions(yeaftDir).map(row => row.meta);
  if (existing.length > 0) {
    return { seeded: false, sessionId: existing[0].id };
  }

  // Sort VP ids alphabetically (stable for tests / deterministic UI), but
  // prefer the generalist Omni VP as the default when present so first-run
  // sessions land on a useful assistant instead of an arbitrary first id.
  const vps = scanSortedVpIds(libDir);

  const defaultVpId = preferDefaultVp(vps);
  const { group, created } = seedDefaultSession(yeaftDir, {
    name: options.name || 'Default',
    roster: vps,
    defaultVpId,
    memoryRoot,
  });
  const meta = group.getMeta();
  if (meta) addOrUpdateManifestSession(yeaftDir, meta, join(sessionsRoot(yeaftDir), meta.id));
  return {
    seeded: created,
    sessionId: group.id,
    defaultVpId,
    rosterSize: vps.length,
  };
}

/**
 * (A.1) Create session from a wizard spec. `spec.roster` is authoritative
 * when non-empty. If the caller omits a roster, seed the session with the
 * default generalist VP (`omni`) when it exists so a new Session is usable
 * immediately instead of opening with an empty roster.
 *
 * @param {string} yeaftDir
 * @param {{name:string, roster?:string[], defaultVpId?:string|null, workDir?:string}} spec
 * @returns {{id:string, name:string, roster:string[], defaultVpId:string|null, workDir?:string}}
 */
export function createSessionFromSpec(yeaftDir, spec, options = {}) {
  const input = spec || {};
  const normalizedWorkDir = normalizeWorkDir(input.workDir);
  const workspaceKey = canonicalWorkspaceKey(normalizedWorkDir);
  ensureSessionManifestReady(yeaftDir);
  const groupYeaftDir = yeaftDir;
  const memoryRoot = options.memoryRoot || (groupYeaftDir ? join(groupYeaftDir, 'memory') : DEFAULT_MEMORY_ROOT);
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const name = String(input.name || '').trim();
  if (!name) throw new SessionCrudError('invalid_name', null, 'group name required');

  const callerRoster = Array.isArray(input.roster) ? input.roster.slice() : [];
  const preserveEmptyRoster = options.preserveEmptyRoster === true && Array.isArray(input.roster);
  const fallbackVpId = callerRoster.length > 0 || preserveEmptyRoster
    ? null
    : preferDefaultVp(scanSortedVpIds(libDir));
  const roster = callerRoster.length > 0 || preserveEmptyRoster
    ? callerRoster
    : (fallbackVpId ? [fallbackVpId] : []);
  // Validate every member up-front so we fail before touching fs.
  for (const vpId of roster) {
    if (isReservedVpId(vpId)) {
      throw new SessionCrudError('reserved', null, `reserved vpId: ${vpId}`);
    }
    const v = validateVpId(vpId);
    if (!v.ok) throw new SessionCrudError(v.reason, null, `invalid vpId: ${vpId}`);
  }

  // defaultVpId resolution: explicit > roster[0] > null. Null is only
  // possible when both caller roster and VP library are empty.
  let defaultVpId = input.defaultVpId || null;
  if (defaultVpId && !roster.includes(defaultVpId)) {
    throw new SessionCrudError('default_not_in_roster', null, `${defaultVpId} not in roster`);
  }
  if (!defaultVpId) defaultVpId = roster[0] || null;

  const id = makeSessionId(name);
  const root = sessionsRoot(groupYeaftDir);
  if (existsSync(join(root, id))) {
    // Extremely unlikely (ulid suffix), but surface deterministically.
    throw new SessionCrudError('duplicate', id);
  }

  const handle = createSession(root, {
    id, name, roster, defaultVpId, workDir: normalizedWorkDir, workspaceKey,
  });
  const meta = handle.getMeta();
  handle.close();
  addOrUpdateManifestSession(yeaftDir, meta, join(root, id));

  // Per-session config (v1: model only). We always create an empty
  // config.json so hand-editing tools can find a session-level override
  // stub. An empty object means "no session override; use global config".
  // Initial overrides from the wizard spec (currently just `config.model`)
  // are persisted here so the engine cache picks them up on the very first
  // turn.
  try {
    ensureSessionConfigFile(yeaftDir, id);
    if (input.config && typeof input.config === 'object') {
      saveSessionConfig(yeaftDir, id, input.config);
    }
  } catch (err) {
    console.warn(`[session-crud] failed to seed config.json for ${id}:`, err?.message || err);
  }

  // Seed Layer-A resident summary so the first session has memory content
  // even before Dream-v2 has run. No-op if a summary.md already exists.
  // Best-effort: a memory-root permission failure must NOT break group create.
  try {
    seedSummaryIfMissingSync(
      { kind: 'session', id },
      buildSessionSeedSummary({ name, roster, defaultVpId }),
      { root: memoryRoot },
    );
  } catch (err) {
    console.warn(`[session-crud] failed to seed summary.md for ${id}:`, err?.message || err);
  }

  return meta;
}

/**
 * Create an independent Session from an existing Session's durable state.
 * Project membership and server-owned asset storage intentionally remain with
 * their existing owners; message payloads and their references are preserved.
 */
export function copySession(yeaftDir, sourceSessionId, options = {}) {
  const sourceYeaftDir = resolveSessionYeaftDir(yeaftDir, sourceSessionId);
  const source = requireSession(sourceYeaftDir, sourceSessionId);
  let sourceMeta;
  try {
    sourceMeta = source.getMeta();
  } finally {
    source.close();
  }

  const requestedName = String(options.name || '').trim();
  const name = requestedName || `${sourceMeta.name} copy`;
  const sourceConfig = loadSessionConfig(sourceYeaftDir, sourceSessionId);
  const copied = createSessionFromSpec(sourceYeaftDir, {
    name,
    roster: Array.isArray(sourceMeta.roster) ? sourceMeta.roster : [],
    defaultVpId: sourceMeta.defaultVpId || null,
    workDir: sourceMeta.workDir || '',
  }, { ...options, preserveEmptyRoster: true });

  try {
    // Unlike ordinary Session creation, cloning is transactional: silently
    // dropping a source override would make the copy behave differently.
    saveSessionConfig(sourceYeaftDir, copied.id, sourceConfig);
    const target = requireSession(sourceYeaftDir, copied.id);
    try {
      const targetMeta = target.getMeta();
      target.saveMeta({
        ...targetMeta,
        announcement: sourceMeta.announcement || '',
        metadataUpdatedAt: new Date().toISOString(),
      });
    } finally {
      target.close();
    }

    const transcript = new ConversationStore(sourceYeaftDir);
    const { copiedCount } = transcript.copySession(sourceSessionId, copied.id);
    return { ...requireSessionMeta(sourceYeaftDir, copied.id), copiedMessageCount: copiedCount };
  } catch (error) {
    // A partial clone must never appear as a successful copy.
    deleteSession(sourceYeaftDir, copied.id, options);
    throw error;
  }
}

function requireSessionMeta(yeaftDir, sessionId) {
  const handle = requireSession(yeaftDir, sessionId);
  try { return handle.getMeta(); } finally { handle.close(); }
}

/**
 * (A.2) Rename — updates meta.name; preserves everything else.
 */
export function renameSession(yeaftDir, sessionId, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new SessionCrudError('invalid_name', sessionId);
  const handle = requireSession(yeaftDir, sessionId);
  const meta = handle.getMeta();
  handle.saveMeta({ ...meta, name, metadataUpdatedAt: new Date().toISOString() });
  const next = handle.getMeta();
  handle.close();
  return next;
}

/**
 * (A.2.b) Update announcement — group-wide system-prompt prefix shared by
 * every VP in the group (CLAUDE.md-style). Empty/whitespace clears it.
 *
 * `text` must be a string. Trimmed before persist so leading/trailing
 * whitespace doesn't pollute the prompt.
 */
export function updateSessionAnnouncement(yeaftDir, sessionId, text) {
  if (typeof text !== 'string') {
    throw new SessionCrudError('invalid_announcement', sessionId);
  }
  const announcement = text.trim();
  const handle = requireSession(yeaftDir, sessionId);
  const meta = handle.getMeta();
  handle.saveMeta({ ...meta, announcement, metadataUpdatedAt: new Date().toISOString() });
  const next = handle.getMeta();
  handle.close();
  return next;
}

/**
 * (A.2.c) Persist the model selected in the group conversation header.
 * Returns the persisted config object so the caller can broadcast it.
 *
 * Throws SessionConfigError on validation failure (unknown key, bad type).
 * Group must exist (we call requireSession to assert).
 */
export function updateSessionConfig(yeaftDir, sessionId, partial) {
  const handle = requireSession(yeaftDir, sessionId);
  try {
    const saved = saveSessionConfig(yeaftDir, sessionId, partial || {});
    const meta = handle.getMeta();
    handle.saveMeta({ ...meta, metadataUpdatedAt: new Date().toISOString() });
    return saved;
  } finally {
    handle.close();
  }
}

/**
 * (A.3) Archive — renames the dir to `.archived-<ts>-<id>`. Directory
 * prefix `.` keeps `listSessions` from picking it up (readdirSync filter in
 * the caller). Reversible: user can rename back manually for recovery.
 *
 * We do NOT support hard-delete here — that's an upstream UI flow with its
 * own second-confirm modal (acceptance #4 in task-334-slice-specs.md 334m).
 */
export function archiveSession(yeaftDir, sessionId) {
  const groupYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
  const root = sessionsRoot(groupYeaftDir);
  const srcDir = join(root, sessionId);
  // Idempotent source deletion must still invalidate every derived generation:
  // an active query worker may otherwise serve history after the directory is gone.
  if (!existsSync(srcDir) || !loadSessionMeta(srcDir)) {
    invalidateSessionConversationIndex(
      [groupYeaftDir, yeaftDir],
      sessionId,
      'archive-session',
      { oldPath: srcDir },
    );
    unregisterSessionWorkDir(yeaftDir, sessionId);
    removeManifestSession(yeaftDir, sessionId);
    return { sessionId, archivedAs: null, alreadyGone: true };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Append 4 hex chars to disambiguate same-millisecond archives (nit #5).
  const suffix = randomBytes(2).toString('hex');
  const dstDir = join(root, `.archived-${ts}-${suffix}-${sessionId}`);
  renameSync(srcDir, dstDir);
  invalidateSessionConversationIndex(
    [groupYeaftDir, yeaftDir],
    sessionId,
    'archive-session',
    { oldPath: srcDir, newPath: dstDir },
  );
  unregisterSessionWorkDir(yeaftDir, sessionId);
  removeManifestSession(yeaftDir, sessionId);
  return { sessionId, archivedAs: dstDir, alreadyGone: false };
}

/**
 * (A.3.b) Delete — physically remove the group directory and all its
 * contents (group.json, messages/, tasks/, vps/). Irreversible.
 *
 * Bug 8 fix: replaces the soft-archive flow that left `.archived-*` dirs
 * lying around in `~/.yeaft/sessions/`. Per user request, "delete" means
 * physical deletion, not rename.
 *
 * Also sweeps any sibling `.archived-*-<sessionId>` dirs that were left
 * behind by the previous soft-archive implementation, so a single
 * delete cleans up legacy state too.
 */
export function deleteSession(yeaftDir, sessionId, options = {}) {
  const groupYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
  const memoryRoot = options.memoryRoot || (groupYeaftDir ? join(groupYeaftDir, 'memory') : DEFAULT_MEMORY_ROOT);
  const root = sessionsRoot(groupYeaftDir);
  const srcDir = join(root, sessionId);
  const liveExists = existsSync(srcDir) && !!loadSessionMeta(srcDir);

  // Collect any leftover soft-archive directories matching this sessionId.
  const legacyDirs = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.archived-')) continue;
      // Soft-archive format: .archived-<ts>-<suffix>-<sessionId>
      if (!name.endsWith(`-${sessionId}`)) continue;
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) legacyDirs.push(p);
      } catch { /* skip */ }
    }
  }

  // Idempotent — POSIX `rm -f` / HTTP DELETE semantics. If nothing is on
  // disk, treat as a successful no-op so callers (and any shadow / cache
  // they maintain) can converge to "gone". We still cascade the memory
  // scope and workdir-registry teardown below: a stale `summary.md` left
  // over from a previous incarnation would otherwise contaminate a future
  // recreate of the same id.
  if (liveExists) {
    rmSync(srcDir, { recursive: true, force: true });
  }
  for (const dir of legacyDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  // Cascade: drop the session memory scope so a recreate with the same id
  // starts clean. Best-effort — never let memory cleanup fail the CRUD op.
  try {
    removeScopeDirSync({ kind: 'session', id: sessionId }, { root: memoryRoot });
  } catch (err) {
    console.warn(`[session-crud] failed to remove memory dir for ${sessionId}:`, err?.message || err);
  }

  invalidateSessionConversationIndex(
    [groupYeaftDir, yeaftDir],
    sessionId,
    'delete-session',
    { oldPath: srcDir },
  );
  unregisterSessionWorkDir(yeaftDir, sessionId);
  removeManifestSession(yeaftDir, sessionId);
  return {
    sessionId,
    deleted: liveExists,
    legacyCleanedUp: legacyDirs.length,
    alreadyGone: !liveExists && legacyDirs.length === 0,
  };
}

/**
 * Sweep any leftover `.archived-*` directories under sessions/ that are
 * orphans of the old soft-archive flow. Used at boot so users don't see
 * ghost sessions in subsequent loads. Returns the list of removed paths.
 */
export function purgeArchivedSessions(yeaftDir) {
  const root = sessionsRoot(yeaftDir);
  if (!existsSync(root)) return [];
  const removed = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.archived-')) continue;
    const p = join(root, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch { continue; }
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch { /* skip */ }
  }
  return removed;
}

/**
 * (A.4) Add a VP to the group roster. Idempotent — no-op if already present.
 * Returns the new meta.
 */
export function addMember(yeaftDir, sessionId, vpId) {
  const handle = requireSession(yeaftDir, sessionId);
  try {
    const meta = handle.getMeta();
    const next = rosterAdd(meta, vpId);
    handle.saveMeta({ ...next, metadataUpdatedAt: new Date().toISOString() });
    return handle.getMeta();
  } finally {
    handle.close();
  }
}

/**
 * (A.5) Remove a VP from the group roster. If the removed id was default,
 * roster.removeVp rotates to the next member (or null).
 */
export function removeMember(yeaftDir, sessionId, vpId) {
  const handle = requireSession(yeaftDir, sessionId);
  try {
    const meta = handle.getMeta();
    if (!meta.roster.includes(vpId)) {
      // Treat as idempotent no-op — UI wants the post-state.
      return meta;
    }
    const next = rosterRemove(meta, vpId);
    handle.saveMeta({ ...next, metadataUpdatedAt: new Date().toISOString() });
    return handle.getMeta();
  } finally {
    handle.close();
  }
}

/** Expose default-VP setter for UI "set as default" affordance. */
export function setSessionDefaultVp(yeaftDir, sessionId, vpId) {
  const handle = requireSession(yeaftDir, sessionId);
  try {
    const meta = handle.getMeta();
    const next = setDefaultVp(meta, vpId);
    handle.saveMeta({ ...next, metadataUpdatedAt: new Date().toISOString() });
    return handle.getMeta();
  } finally {
    handle.close();
  }
}

export function requireSession(yeaftDir, sessionId) {
  const groupYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
  const root = sessionsRoot(groupYeaftDir);
  const dir = join(root, sessionId);
  if (!existsSync(dir) || !loadSessionMeta(dir)) {
    throw new SessionCrudError('not_found', sessionId);
  }
  return openSession(root, sessionId);
}

/** Convenience: snapshot all non-archived groups for WS broadcast. */
export function snapshotSessions(yeaftDir) {
  repairSessionStoreAndManifest(yeaftDir);
  const byId = new Map();
  for (const row of listManifestSessions(yeaftDir)) {
    byId.set(row.meta.id, row.meta);
  }
  // Attach per-group config overrides (v1: just `model`). Frontend can
  // render the effective model without re-querying.
  for (const meta of byId.values()) {
    meta.config = loadSessionConfig(yeaftDir, meta.id);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export { DEFAULT_SESSION_ID };
