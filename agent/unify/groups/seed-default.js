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

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { openGroup, createGroup, loadGroupMeta } from './group-store.js';

export const DEFAULT_GROUP_ID = 'grp_default';

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
  return { group, created: true };
}
