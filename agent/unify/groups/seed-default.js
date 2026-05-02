/**
 * seed-default.js — First-boot default group (architecture §10 D1).
 *
 * When multi-VP mode is first enabled for a user, seed a default group with
 * the provided roster (typically `[defaultVpId]`). Idempotent: if the group
 * already exists on disk, returns the existing handle without overwriting.
 *
 * Separation from group-store.createGroup:
 *   - createGroup throws on duplicate; seed returns the existing handle.
 *   - seed picks a stable id `grp_default` so UI can deep-link to it.
 *   - seed is the only place that writes the "default group exists" side
 *     effect during the bootstrap flow.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { openGroup, createGroup, loadGroupMeta } from './group-store.js';

export const DEFAULT_GROUP_ID = 'grp_default';

/**
 * Memory root used by store-v2 / engine.#loadLayerASummaries. Mirrors the
 * constant in `group-crud.js` and `vp/vp-crud.js`. Group seed lives at
 * `<root>/group/<id>/summary.md` (singular `group`, per `scopeDir`).
 */
const SEED_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/**
 * Best-effort sync seed of `<root>/group/<id>/summary.md` if absent. Lets
 * the very first session — even on a brand-new install where only
 * `grp_default` exists — render a non-empty Layer-A resident summary in
 * the system prompt. No-op once Dream-v2 (or createGroupFromSpec) has
 * already written one.
 */
function seedDefaultGroupSummaryIfMissing(groupId, name, roster, defaultVpId) {
  try {
    const dir = join(SEED_MEMORY_ROOT, 'group', groupId);
    const path = join(dir, 'summary.md');
    let existing = '';
    if (existsSync(path)) {
      try { existing = readFileSync(path, 'utf-8').trim(); } catch { /* read race — fall through */ }
    }
    if (existing) return;
    const lines = [`# ${name || 'Default'}`, ''];
    lines.push(`Default group with ${roster.length} member${roster.length === 1 ? '' : 's'}.`);
    if (roster.length > 0) lines.push('', `**Members:** ${roster.join(', ')}`);
    if (defaultVpId) lines.push('', `**Default VP:** ${defaultVpId}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, lines.join('\n').trim() + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[seed-default] failed to seed summary.md for ${groupId}:`, err?.message || err);
  }
}

/**
 * @param {string} yeaftDir
 * @param {{ defaultVpId?: string|null, roster?: string[], name?: string }} [spec]
 * @returns {{ group: import('./group-store.js').GroupHandle, created: boolean }}
 */
export function seedDefaultGroup(yeaftDir, spec = {}) {
  const groupsRoot = join(yeaftDir, 'groups');
  if (!existsSync(groupsRoot)) mkdirSync(groupsRoot, { recursive: true });

  const existingDir = join(groupsRoot, DEFAULT_GROUP_ID);
  if (existsSync(existingDir) && loadGroupMeta(existingDir)) {
    return { group: openGroup(groupsRoot, DEFAULT_GROUP_ID), created: false };
  }

  const roster = Array.isArray(spec.roster) && spec.roster.length
    ? spec.roster.slice()
    : (spec.defaultVpId ? [spec.defaultVpId] : []);
  const defaultVpId = spec.defaultVpId || roster[0] || null;

  const group = createGroup(groupsRoot, {
    id: DEFAULT_GROUP_ID,
    name: spec.name || 'Default',
    roster,
    defaultVpId,
  });
  seedDefaultGroupSummaryIfMissing(DEFAULT_GROUP_ID, spec.name || 'Default', roster, defaultVpId);
  return { group, created: true };
}
