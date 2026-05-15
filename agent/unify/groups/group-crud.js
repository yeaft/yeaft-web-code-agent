/**
 * group-crud.js — High-level Group CRUD API (task-334m).
 *
 * Wraps the primitives from group-store.js + roster.js into the 5 operations
 * wired to WS events (§Δ10 334m + R6 §Δ31.2):
 *   createGroupFromSpec  — wizard "create new group" (empty or user-picked roster)
 *   renameGroup          — update meta.name; preserves roster / defaultVpId
 *   archiveGroup         — rename dir to `.archived-<ts>-<id>` (soft delete)
 *   addMember            — roster.addVp + save; sets defaultVpId if first
 *   removeMember         — roster.removeVp + save; clears/rotates defaultVpId
 *
 * Plus the D1 bootstrap helper:
 *   ensureDefaultGroupIfEmpty(yeaftDir, {libDir}) — if NO group exists on
 *   disk, seed `grp_default` with roster = every VP in the library, and
 *   defaultVpId = alphabetically first vpId. No-op when ≥1 group present.
 *
 * Hard constraints (PM):
 *   (a) We don't touch 334o storage primitives (storage/index.js) — we call
 *       group-store.openGroup / saveMeta which already go through openLog.
 *   (b) We don't touch VP entity (vp-store.js / vp-loader.js) — only read
 *       via scanVpLibrary to know which VPs exist at seed time.
 *   (c) When `addMember` is called with an empty roster and no defaultVpId
 *       resolvable, callers surface `no_default_vp` via `createGroupFromSpec`;
 *       on `removeMember` we permit the empty state (UI nudges the user).
 *
 * Error shape — every throw is a `GroupCrudError` with a stable `.code`:
 *   'not_found'        — group id has no dir / meta
 *   'duplicate'        — createGroup collided with an existing id
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
} from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import {
  openGroup, createGroup, listGroups, loadGroupMeta,
} from './group-store.js';
import { addVp as rosterAdd, removeVp as rosterRemove, setDefaultVp } from './roster.js';
import { seedDefaultGroup, DEFAULT_GROUP_ID } from './seed-default.js';
import { nextGroupId, validateVpId, isReservedVpId } from './ids.js';
import { scanVpLibrary, DEFAULT_VP_LIB_DIR } from '../vp/vp-store.js';
import { seedSummaryIfMissingSync, removeScopeDirSync } from '../memory/store-v2.js';

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
export function buildGroupSeedSummary(spec) {
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

export class GroupCrudError extends Error {
  constructor(code, groupId, message) {
    super(message || `${code}: ${groupId}`);
    this.name = 'GroupCrudError';
    this.code = code;
    this.groupId = groupId;
  }
}

const GROUP_WORKDIR_REGISTRY = 'group-workdirs.json';

export function groupsRoot(yeaftDir) {
  return join(yeaftDir, 'groups');
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

export function registerGroupWorkDir(defaultYeaftDir, groupId, workDir) {
  const normalized = normalizeWorkDir(workDir);
  if (!defaultYeaftDir || !groupId || !normalized) return;
  const registry = readWorkDirRegistry(defaultYeaftDir);
  registry[groupId] = normalized;
  writeWorkDirRegistry(defaultYeaftDir, registry);
}

export function unregisterGroupWorkDir(defaultYeaftDir, groupId) {
  if (!defaultYeaftDir || !groupId) return;
  const registry = readWorkDirRegistry(defaultYeaftDir);
  if (!Object.prototype.hasOwnProperty.call(registry, groupId)) return;
  delete registry[groupId];
  writeWorkDirRegistry(defaultYeaftDir, registry);
}

export function resolveGroupYeaftDir(defaultYeaftDir, groupId) {
  if (!defaultYeaftDir || !groupId) return defaultYeaftDir;
  const defaultGroupDir = join(groupsRoot(defaultYeaftDir), groupId);
  if (existsSync(defaultGroupDir) && loadGroupMeta(defaultGroupDir)) return defaultYeaftDir;

  const registry = readWorkDirRegistry(defaultYeaftDir);
  const workDir = normalizeWorkDir(registry[groupId]);
  if (workDir) {
    const candidate = yeaftDirForWorkDir(workDir);
    const candidateDir = join(groupsRoot(candidate), groupId);
    if (existsSync(candidateDir) && loadGroupMeta(candidateDir)) return candidate;
  }

  return defaultYeaftDir;
}

/** Build a safe group id from a display name (slug + ulid-lite suffix). */
export function makeGroupId(name) {
  const slug = String(name || 'group')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'group';
  return nextGroupId(slug);
}

/**
 * (B) D1 seed — called at boot (or when multi-VP is first enabled). Idempotent:
 * returns `{seeded:false}` if any group already exists on disk (including
 * `grp_default`). When empty, seeds with roster = full VP library, sorted
 * alphabetically; defaultVpId = roster[0].
 *
 * When the VP library is also empty, we still seed an empty-roster group so
 * the UI has somewhere to land — but defaultVpId is null and downstream
 * message send will return `no_default_vp` until the user adds a VP.
 */
export function ensureDefaultGroupIfEmpty(yeaftDir, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const memoryRoot = options.memoryRoot || DEFAULT_MEMORY_ROOT;
  const existing = listGroups(groupsRoot(yeaftDir));
  if (existing.length > 0) {
    return { seeded: false, groupId: existing[0].id };
  }

  // Sort VP ids alphabetically (stable for tests / deterministic UI).
  // NB: vp-store returns records with `.id` (not `.vpId`) — keep this in sync.
  const vps = scanVpLibrary({ dir: libDir })
    .map(v => v && v.id)
    .filter(v => typeof v === 'string' && v.length > 0);
  vps.sort((a, b) => a.localeCompare(b));

  const defaultVpId = vps[0] || null;
  const { group, created } = seedDefaultGroup(yeaftDir, {
    name: options.name || 'Default',
    roster: vps,
    defaultVpId,
    memoryRoot,
  });
  return {
    seeded: created,
    groupId: group.id,
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
export function createGroupFromSpec(yeaftDir, spec, options = {}) {
  const normalizedWorkDir = normalizeWorkDir(spec && spec.workDir);
  const groupYeaftDir = normalizedWorkDir ? yeaftDirForWorkDir(normalizedWorkDir) : yeaftDir;
  const memoryRoot = options.memoryRoot || (groupYeaftDir ? join(groupYeaftDir, 'memory') : DEFAULT_MEMORY_ROOT);
  const name = String(spec && spec.name || '').trim();
  if (!name) throw new GroupCrudError('invalid_name', null, 'group name required');

  const roster = Array.isArray(spec.roster) ? spec.roster.slice() : [];
  // Validate every member up-front so we fail before touching fs.
  for (const vpId of roster) {
    if (isReservedVpId(vpId)) {
      throw new GroupCrudError('reserved', null, `reserved vpId: ${vpId}`);
    }
    const v = validateVpId(vpId);
    if (!v.ok) throw new GroupCrudError(v.reason, null, `invalid vpId: ${vpId}`);
  }

  // defaultVpId resolution: explicit > roster[0] > null. Null is allowed at
  // create time (empty roster) — the wizard modal warns the user downstream
  // (task-334m spec: `no_default_vp` surfaced on first send, not on create).
  let defaultVpId = spec.defaultVpId || null;
  if (defaultVpId && !roster.includes(defaultVpId)) {
    throw new GroupCrudError('default_not_in_roster', null, `${defaultVpId} not in roster`);
  }
  if (!defaultVpId) defaultVpId = roster[0] || null;

  const id = makeGroupId(name);
  const root = groupsRoot(groupYeaftDir);
  if (existsSync(join(root, id))) {
    // Extremely unlikely (ulid suffix), but surface deterministically.
    throw new GroupCrudError('duplicate', id);
  }

  const handle = createGroup(root, { id, name, roster, defaultVpId, workDir: normalizedWorkDir });
  const meta = handle.getMeta();
  handle.close();
  if (normalizedWorkDir) registerGroupWorkDir(yeaftDir, id, normalizedWorkDir);

  // Seed Layer-A resident summary so the first session has memory content
  // even before Dream-v2 has run. No-op if a summary.md already exists.
  // Best-effort: a memory-root permission failure must NOT break group create.
  try {
    seedSummaryIfMissingSync(
      { kind: 'group', id },
      buildGroupSeedSummary({ name, roster, defaultVpId }),
      { root: memoryRoot },
    );
  } catch (err) {
    console.warn(`[group-crud] failed to seed summary.md for ${id}:`, err?.message || err);
  }

  return meta;
}

/**
 * (A.2) Rename — updates meta.name; preserves everything else.
 */
export function renameGroup(yeaftDir, groupId, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new GroupCrudError('invalid_name', groupId);
  const handle = requireGroup(yeaftDir, groupId);
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
export function updateGroupAnnouncement(yeaftDir, groupId, text) {
  if (typeof text !== 'string') {
    throw new GroupCrudError('invalid_announcement', groupId);
  }
  const announcement = text.trim();
  const handle = requireGroup(yeaftDir, groupId);
  const meta = handle.getMeta();
  handle.saveMeta({ ...meta, announcement });
  const next = handle.getMeta();
  handle.close();
  return next;
}

/**
 * (A.3) Archive — renames the dir to `.archived-<ts>-<id>`. Directory
 * prefix `.` keeps `listGroups` from picking it up (readdirSync filter in
 * the caller). Reversible: user can rename back manually for recovery.
 *
 * We do NOT support hard-delete here — that's an upstream UI flow with its
 * own second-confirm modal (acceptance #4 in task-334-slice-specs.md 334m).
 */
export function archiveGroup(yeaftDir, groupId) {
  const groupYeaftDir = resolveGroupYeaftDir(yeaftDir, groupId);
  const root = groupsRoot(groupYeaftDir);
  const srcDir = join(root, groupId);
  if (!existsSync(srcDir) || !loadGroupMeta(srcDir)) {
    throw new GroupCrudError('not_found', groupId);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Append 4 hex chars to disambiguate same-millisecond archives (nit #5).
  const suffix = randomBytes(2).toString('hex');
  const dstDir = join(root, `.archived-${ts}-${suffix}-${groupId}`);
  renameSync(srcDir, dstDir);
  unregisterGroupWorkDir(yeaftDir, groupId);
  return { groupId, archivedAs: dstDir };
}

/**
 * (A.3.b) Delete — physically remove the group directory and all its
 * contents (group.json, messages/, tasks/, vps/). Irreversible.
 *
 * Bug 8 fix: replaces the soft-archive flow that left `.archived-*` dirs
 * lying around in `~/.yeaft/groups/`. Per user request, "delete" means
 * physical deletion, not rename.
 *
 * Also sweeps any sibling `.archived-*-<groupId>` dirs that were left
 * behind by the previous soft-archive implementation, so a single
 * delete cleans up legacy state too.
 */
export function deleteGroup(yeaftDir, groupId, options = {}) {
  const groupYeaftDir = resolveGroupYeaftDir(yeaftDir, groupId);
  const memoryRoot = options.memoryRoot || (groupYeaftDir ? join(groupYeaftDir, 'memory') : DEFAULT_MEMORY_ROOT);
  const root = groupsRoot(groupYeaftDir);
  const srcDir = join(root, groupId);
  const liveExists = existsSync(srcDir) && !!loadGroupMeta(srcDir);

  // Collect any leftover soft-archive directories matching this groupId.
  const legacyDirs = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.archived-')) continue;
      // Soft-archive format: .archived-<ts>-<suffix>-<groupId>
      if (!name.endsWith(`-${groupId}`)) continue;
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) legacyDirs.push(p);
      } catch { /* skip */ }
    }
  }

  if (!liveExists && legacyDirs.length === 0) {
    throw new GroupCrudError('not_found', groupId);
  }

  if (liveExists) {
    rmSync(srcDir, { recursive: true, force: true });
  }
  for (const dir of legacyDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  // Cascade: drop the group's memory scope so a recreate with the same id
  // starts clean. Best-effort — never let memory cleanup fail the CRUD op.
  try {
    removeScopeDirSync({ kind: 'group', id: groupId }, { root: memoryRoot });
  } catch (err) {
    console.warn(`[group-crud] failed to remove memory dir for ${groupId}:`, err?.message || err);
  }

  unregisterGroupWorkDir(yeaftDir, groupId);
  return { groupId, deleted: true, legacyCleanedUp: legacyDirs.length };
}

/**
 * Sweep any leftover `.archived-*` directories under groups/ that are
 * orphans of the old soft-archive flow. Used at boot so users don't see
 * ghost groups in subsequent loads. Returns the list of removed paths.
 */
export function purgeArchivedGroups(yeaftDir) {
  const root = groupsRoot(yeaftDir);
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
export function addMember(yeaftDir, groupId, vpId) {
  const handle = requireGroup(yeaftDir, groupId);
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
export function removeMember(yeaftDir, groupId, vpId) {
  const handle = requireGroup(yeaftDir, groupId);
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
export function setGroupDefaultVp(yeaftDir, groupId, vpId) {
  const handle = requireGroup(yeaftDir, groupId);
  try {
    const meta = handle.getMeta();
    const next = setDefaultVp(meta, vpId);
    handle.saveMeta(next);
    return handle.getMeta();
  } finally {
    handle.close();
  }
}

export function requireGroup(yeaftDir, groupId) {
  const groupYeaftDir = resolveGroupYeaftDir(yeaftDir, groupId);
  const root = groupsRoot(groupYeaftDir);
  const dir = join(root, groupId);
  if (!existsSync(dir) || !loadGroupMeta(dir)) {
    throw new GroupCrudError('not_found', groupId);
  }
  return openGroup(root, groupId);
}

/** Convenience: snapshot all non-archived groups for WS broadcast. */
export function snapshotGroups(yeaftDir) {
  const byId = new Map();
  for (const group of listGroups(groupsRoot(yeaftDir))) {
    byId.set(group.id, group);
  }
  const registry = readWorkDirRegistry(yeaftDir);
  for (const [groupId, workDir] of Object.entries(registry)) {
    const groupYeaftDir = yeaftDirForWorkDir(workDir);
    const dir = join(groupsRoot(groupYeaftDir), groupId);
    const meta = existsSync(dir) ? loadGroupMeta(dir) : null;
    if (meta) byId.set(meta.id, meta);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export { DEFAULT_GROUP_ID };
