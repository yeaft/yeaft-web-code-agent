/**
 * Crew — Role State Store (task-330d, Fowler Final Spec §D)
 *
 * Replaces the legacy "standby task" pattern (where PM idle was modelled
 * as a synthetic task in `.crew/context/features/standby.md`). Role idle/
 * busy/pending state is now first-class and persisted to a single file:
 *
 *     <sharedDir>/context/role-states.json
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "states": {
 *       "<roleName>": { role, status, since, reason }
 *     }
 *   }
 *
 * Status values:
 *   - 'standby' : role has no active task and is waiting for routing
 *   - 'busy'    : role is currently executing a turn
 *   - 'pending' : role finished a turn but did not emit a ROUTE
 *
 * Public API (consumed by the `role_standby` tool added in task-330a):
 *   - getRoleState(sharedDir, role)        → state | null
 *   - setRoleState(sharedDir, role, patch) → state
 *   - listRoleStates(sharedDir)            → Record<role, state>
 *
 * Atomicity: writes go to `role-states.json.tmp` then rename, matching the
 * convention in persistence.js. A per-process write lock (Promise chain)
 * serialises concurrent setRoleState calls so the file never tears.
 *
 * Backward compatibility: a session that was created before role-states.json
 * existed simply has no file; getRoleState returns null and setRoleState
 * creates the file lazily. No migration step is required.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const FILE_NAME = 'role-states.json';
const VERSION = 1;
const VALID_STATUSES = new Set(['standby', 'busy', 'pending']);

// Per-sharedDir write lock. Keyed by absolute path so multiple sessions in
// one process don't serialise against each other.
const _writeLocks = new Map();

function _lockKey(sharedDir) {
  return sharedDir;
}

function _filePath(sharedDir) {
  return join(sharedDir, 'context', FILE_NAME);
}

async function _readAll(sharedDir) {
  try {
    const raw = await fs.readFile(_filePath(sharedDir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.states || typeof parsed.states !== 'object') {
      return { version: VERSION, states: {} };
    }
    return { version: parsed.version || VERSION, states: parsed.states };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: VERSION, states: {} };
    // Corrupt JSON → start fresh rather than crash. This matches the
    // "legacy session replay compatibility" red line: a broken file must
    // not block resume.
    return { version: VERSION, states: {} };
  }
}

async function _writeAtomic(sharedDir, payload) {
  const dir = join(sharedDir, 'context');
  await fs.mkdir(dir, { recursive: true });
  const target = _filePath(sharedDir);
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Read the current state for a single role.
 * @param {string} sharedDir — session shared directory (`.crew` root)
 * @param {string} role — role name
 * @returns {Promise<null | {role:string, status:string, since:number, reason?:string}>}
 */
export async function getRoleState(sharedDir, role) {
  if (!sharedDir || !role) return null;
  const all = await _readAll(sharedDir);
  return all.states[role] || null;
}

/**
 * Read every role's state at once. Returns a plain object keyed by role
 * name (empty when the file is missing).
 */
export async function listRoleStates(sharedDir) {
  if (!sharedDir) return {};
  const all = await _readAll(sharedDir);
  return { ...all.states };
}

/**
 * Patch a single role's state. Unspecified fields are preserved from the
 * existing record. `since` defaults to Date.now() when status changes (or
 * when no prior record exists). Throws on invalid status — callers are
 * expected to pass one of standby|busy|pending.
 *
 * @param {string} sharedDir
 * @param {string} role
 * @param {Partial<{status:string, reason:string, since:number}>} patch
 * @returns {Promise<{role:string, status:string, since:number, reason?:string}>}
 */
export async function setRoleState(sharedDir, role, patch = {}) {
  if (!sharedDir) throw new Error('setRoleState: sharedDir required');
  if (!role) throw new Error('setRoleState: role required');
  if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`setRoleState: invalid status '${patch.status}'`);
  }

  const key = _lockKey(sharedDir);
  const prev = _writeLocks.get(key) || Promise.resolve();

  const next = prev.then(async () => {
    const all = await _readAll(sharedDir);
    const existing = all.states[role] || null;
    const statusChanged = patch.status !== undefined && (!existing || existing.status !== patch.status);
    const merged = {
      role,
      status: patch.status !== undefined ? patch.status : (existing ? existing.status : 'standby'),
      since: patch.since !== undefined
        ? patch.since
        : (statusChanged || !existing ? Date.now() : existing.since),
    };
    if (patch.reason !== undefined) {
      merged.reason = patch.reason;
    } else if (existing && existing.reason !== undefined && !statusChanged) {
      merged.reason = existing.reason;
    }
    all.states[role] = merged;
    all.version = VERSION;
    await _writeAtomic(sharedDir, all);
    return merged;
  }, async () => {
    // If a prior write rejected we still want to attempt this one rather
    // than poisoning the chain forever.
    const all = await _readAll(sharedDir);
    const merged = {
      role,
      status: patch.status || 'standby',
      since: patch.since !== undefined ? patch.since : Date.now(),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    };
    all.states[role] = merged;
    await _writeAtomic(sharedDir, all);
    return merged;
  });

  // Hold onto the chain so the next caller waits on this write.
  _writeLocks.set(key, next.catch(() => {}));
  return next;
}

/**
 * Test/diagnostic helper — clear in-process write lock for a sharedDir.
 * Production callers should never need this; tests use it between runs to
 * avoid bleeding lock state across describe blocks.
 */
export function __resetWriteLockForTests(sharedDir) {
  if (sharedDir) _writeLocks.delete(sharedDir);
  else _writeLocks.clear();
}

/**
 * Constants exported for tests + downstream consumers (the `role_standby`
 * tool in task-330a).
 */
export const ROLE_STATE_FILE_NAME = FILE_NAME;
export const ROLE_STATE_STATUSES = ['standby', 'busy', 'pending'];
