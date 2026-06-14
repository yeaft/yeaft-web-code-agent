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
 *   defaultVpId = alphabetically first vpId. No-op when ≥1 session present.
 *
 * Hard constraints (PM):
 *   (a) We don't touch 334o storage primitives (storage/index.js) — we call
 *       group-store.openSession / saveMeta which already go through openLog.
 *   (b) We don't touch VP entity (vp-store.js / vp-loader.js) — only read
 *       via scanVpLibrary to know which VPs exist at seed time.
 *   (c) When `addMember` is called with an empty roster and no defaultVpId
 *       resolvable, callers surface `no_default_vp` via `createSessionFromSpec`;
 *       on `removeMember` we permit the empty state (UI nudges the user).
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
  accessSync,
  constants,
} from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import {
  openSession, createSession, listSessions, loadSessionMeta,
} from './session-store.js';
import { addVp as rosterAdd, removeVp as rosterRemove, setDefaultVp } from './roster.js';
import { seedDefaultSession, DEFAULT_SESSION_ID } from './seed-default.js';
import { nextSessionId, validateVpId, isReservedVpId } from './ids.js';
import { scanVpLibrary, DEFAULT_VP_LIB_DIR } from '../vp/vp-store.js';
import { seedSummaryIfMissingSync, removeScopeDirSync } from '../memory/store.js';
import { ensureSessionConfigFile, saveSessionConfig, loadSessionConfig } from './session-config.js';

/**
 * Default memory root used when callers don't pass `options.memoryRoot`.
 * See `vp/vp-crud.js` for the same default; production code threads
 * `<yeaftDir>/memory` through to keep test/prod isolation honest.
 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

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

export function sessionsRoot(yeaftDir) {
  return join(yeaftDir, 'sessions');
}

export function normalizeWorkDir(workDir) {
  const raw = String(workDir || '').trim();
  if (!raw) return '';
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function yeaftDirForWorkDir(workDir) {
  const normalized = normalizeWorkDir(workDir);
  return normalized ? join(normalized, '.yeaft') : '';
}

function registryPath(yeaftDir) {
  return join(yeaftDir, GROUP_WORKDIR_REGISTRY);
}

function assertWritableSessionsRoot(root) {
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
  } catch (err) {
    const code = err?.code || 'unknown';
    throw new SessionCrudError(
      'workdir_not_writable',
      null,
      `Cannot create Yeaft session under ${root}: ${code}. Check that the agent user can write this work directory's .yeaft folder.`
    );
  }
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

/**
 * Scan the `.yeaft/sessions/` directory under `workDir` and return every
 * session meta we can read. Read-only: never touches the registry.
 *
 * Each returned record carries `workDir` (the normalized path we scanned).
 * This utility deliberately does NOT decorate `alreadyRegistered` — that
 * cross-references the central workdir registry, which is a separate
 * concern owned by the handler / caller (see
 * `handleYeaftScanWorkdirSessions`). Keeping the utility layer-pure makes
 * it usable from contexts that don't have / don't care about the registry
 * (e.g. CLI tools, future per-workdir snapshots).
 *
 * Returns `[]` for missing dir / empty dir / unreadable dir — never throws.
 * Sort is `createdAt` descending (most-recent first) because the restore
 * UI typically cares about "the session I made yesterday".
 *
 * @param {string} workDir — the working directory to scan.
 * @returns {Array<object>}
 */
export function scanWorkdirSessions(workDir) {
  const normalized = normalizeWorkDir(workDir);
  if (!normalized) return [];
  const groupYeaftDir = yeaftDirForWorkDir(normalized);
  const root = sessionsRoot(groupYeaftDir);
  if (!existsSync(root)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue; // skip .archived-* and dotfiles
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const meta = loadSessionMeta(dir);
    if (!meta) continue;
    out.push({
      ...meta,
      workDir: normalized,
    });
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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
  const groupYeaftDir = yeaftDirForWorkDir(normalized);
  const dir = join(sessionsRoot(groupYeaftDir), sessionId);
  if (!existsSync(dir)) throw new SessionCrudError('not_found', sessionId);
  const meta = loadSessionMeta(dir);
  if (!meta) throw new SessionCrudError('corrupt_meta', sessionId, `session metadata missing or unreadable at ${dir} (expected session.json or legacy group.json)`);
  registerSessionWorkDir(defaultYeaftDir, sessionId, normalized);
  return { ...meta, workDir: normalized };
}

export function resolveSessionYeaftDir(defaultYeaftDir, sessionId) {
  if (!defaultYeaftDir || !sessionId) return defaultYeaftDir;
  const defaultGroupDir = join(sessionsRoot(defaultYeaftDir), sessionId);
  if (existsSync(defaultGroupDir) && loadSessionMeta(defaultGroupDir)) return defaultYeaftDir;

  const registry = readWorkDirRegistry(defaultYeaftDir);
  const workDir = normalizeWorkDir(registry[sessionId]);
  if (workDir) {
    const candidate = yeaftDirForWorkDir(workDir);
    const candidateDir = join(sessionsRoot(candidate), sessionId);
    if (existsSync(candidateDir) && loadSessionMeta(candidateDir)) return candidate;
  }

  return defaultYeaftDir;
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

/**
 * (B) D1 seed — called at boot (or when multi-VP is first enabled). Idempotent:
 * returns `{seeded:false}` if any session already exists on disk (including
 * `session_default`). When empty, seeds with roster = full VP library, sorted
 * alphabetically; defaultVpId = roster[0].
 *
 * When the VP library is also empty, we still seed an empty-roster session so
 * the UI has somewhere to land — but defaultVpId is null and downstream
 * message send will return `no_default_vp` until the user adds a VP.
 */
export function ensureDefaultSessionIfEmpty(yeaftDir, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const memoryRoot = options.memoryRoot || DEFAULT_MEMORY_ROOT;
  const existing = listSessions(sessionsRoot(yeaftDir));
  if (existing.length > 0) {
    return { seeded: false, sessionId: existing[0].id };
  }

  // Sort VP ids alphabetically (stable for tests / deterministic UI).
  // NB: vp-store returns records with `.id` (not `.vpId`) — keep this in sync.
  const vps = scanVpLibrary({ dir: libDir })
    .map(v => v && v.id)
    .filter(v => typeof v === 'string' && v.length > 0);
  vps.sort((a, b) => a.localeCompare(b));

  const defaultVpId = vps[0] || null;
  const { group, created } = seedDefaultSession(yeaftDir, {
    name: options.name || 'Default',
    roster: vps,
    defaultVpId,
    memoryRoot,
  });
  return {
    seeded: created,
    sessionId: group.id,
    defaultVpId,
    rosterSize: vps.length,
  };
}

/**
 * (A.1) Create group from a wizard spec. `spec.roster` is authoritative —
 * we do NOT auto-expand to the full VP library here. That's D1's job only.
 *
 * @param {string} yeaftDir
 * @param {{name:string, roster?:string[], defaultVpId?:string|null, workDir?:string}} spec
 * @returns {{id:string, name:string, roster:string[], defaultVpId:string|null, workDir?:string}}
 */
export function createSessionFromSpec(yeaftDir, spec, options = {}) {
  const normalizedWorkDir = normalizeWorkDir(spec && spec.workDir);
  const groupYeaftDir = normalizedWorkDir ? yeaftDirForWorkDir(normalizedWorkDir) : yeaftDir;
  const memoryRoot = options.memoryRoot || (groupYeaftDir ? join(groupYeaftDir, 'memory') : DEFAULT_MEMORY_ROOT);
  const name = String(spec && spec.name || '').trim();
  if (!name) throw new SessionCrudError('invalid_name', null, 'group name required');

  const roster = Array.isArray(spec.roster) ? spec.roster.slice() : [];
  // Validate every member up-front so we fail before touching fs.
  for (const vpId of roster) {
    if (isReservedVpId(vpId)) {
      throw new SessionCrudError('reserved', null, `reserved vpId: ${vpId}`);
    }
    const v = validateVpId(vpId);
    if (!v.ok) throw new SessionCrudError(v.reason, null, `invalid vpId: ${vpId}`);
  }

  // defaultVpId resolution: explicit > roster[0] > null. Null is allowed at
  // create time (empty roster) — the wizard modal warns the user downstream
  // (task-334m spec: `no_default_vp` surfaced on first send, not on create).
  let defaultVpId = spec.defaultVpId || null;
  if (defaultVpId && !roster.includes(defaultVpId)) {
    throw new SessionCrudError('default_not_in_roster', null, `${defaultVpId} not in roster`);
  }
  if (!defaultVpId) defaultVpId = roster[0] || null;

  const id = makeSessionId(name);
  const root = sessionsRoot(groupYeaftDir);
  assertWritableSessionsRoot(root);
  if (existsSync(join(root, id))) {
    // Extremely unlikely (ulid suffix), but surface deterministically.
    throw new SessionCrudError('duplicate', id);
  }

  const handle = createSession(root, { id, name, roster, defaultVpId, workDir: normalizedWorkDir });
  const meta = handle.getMeta();
  handle.close();
  if (normalizedWorkDir) registerSessionWorkDir(yeaftDir, id, normalizedWorkDir);

  // Per-session config (v1: model only). We always create an empty
  // config.json so hand-editing tools can find a session-level override
  // stub. An empty object means "no session override; use global config".
  // Initial overrides from the wizard spec (currently just `config.model`)
  // are persisted here so the engine cache picks them up on the very first
  // turn.
  try {
    ensureSessionConfigFile(groupYeaftDir, id);
    if (spec && spec.config && typeof spec.config === 'object') {
      saveSessionConfig(groupYeaftDir, id, spec.config);
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
 * (A.2) Rename — updates meta.name; preserves everything else.
 */
export function renameSession(yeaftDir, sessionId, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new SessionCrudError('invalid_name', sessionId);
  const handle = requireSession(yeaftDir, sessionId);
  const meta = handle.getMeta();
  handle.saveMeta({ ...meta, name });
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
  handle.saveMeta({ ...meta, announcement });
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
  const groupYeaftDir = resolveSessionYeaftDir(yeaftDir, sessionId);
  const handle = requireSession(yeaftDir, sessionId);
  try {
    return saveSessionConfig(groupYeaftDir, sessionId, partial || {});
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
  // Idempotent — nothing on disk, nothing to archive. Workdir-registry is
  // still cleared in case it points at a stale row.
  if (!existsSync(srcDir) || !loadSessionMeta(srcDir)) {
    unregisterSessionWorkDir(yeaftDir, sessionId);
    return { sessionId, archivedAs: null, alreadyGone: true };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Append 4 hex chars to disambiguate same-millisecond archives (nit #5).
  const suffix = randomBytes(2).toString('hex');
  const dstDir = join(root, `.archived-${ts}-${suffix}-${sessionId}`);
  renameSync(srcDir, dstDir);
  unregisterSessionWorkDir(yeaftDir, sessionId);
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

  unregisterSessionWorkDir(yeaftDir, sessionId);
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
    handle.saveMeta(next);
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
    handle.saveMeta(next);
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
    handle.saveMeta(next);
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
  const byId = new Map();
  const rootById = new Map();
  for (const group of listSessions(sessionsRoot(yeaftDir))) {
    byId.set(group.id, group);
    rootById.set(group.id, yeaftDir);
  }
  const registry = readWorkDirRegistry(yeaftDir);
  for (const [sessionId, workDir] of Object.entries(registry)) {
    const groupYeaftDir = yeaftDirForWorkDir(workDir);
    const dir = join(sessionsRoot(groupYeaftDir), sessionId);
    const meta = existsSync(dir) ? loadSessionMeta(dir) : null;
    if (meta) {
      byId.set(meta.id, meta);
      rootById.set(meta.id, groupYeaftDir);
    }
  }
  // Attach per-group config overrides (v1: just `model`). Frontend can
  // render the effective model without re-querying.
  for (const meta of byId.values()) {
    meta.config = loadSessionConfig(rootById.get(meta.id) || yeaftDir, meta.id);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export { DEFAULT_SESSION_ID };
