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
import { homedir } from 'os';
import { openGroup, createGroup, loadGroupMeta } from './group-store.js';
import { seedSummaryIfMissingSync } from '../memory/store-v2.js';

export const DEFAULT_GROUP_ID = 'grp_default';

/**
 * Default memory root used when callers don't pass `options.memoryRoot`.
 * See `groups/group-crud.js` and `vp/vp-crud.js` for the same default;
 * production code threads `<yeaftDir>/memory` through to keep test/prod
 * isolation honest.
 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/**
 * Build the default-group seed summary body. Pulled into a helper so
 * tests can pin the exact format. Mirrors `buildGroupSeedSummary` in
 * `group-crud.js` shape, with the "Default group" wording reserved for
 * the bootstrap path.
 *
 * @param {{ name?: string, roster?: string[], defaultVpId?: string|null }} spec
 * @returns {string}
 */
export function buildDefaultGroupSeedSummary(spec) {
  const name = String(spec?.name || 'Default').trim();
  const roster = Array.isArray(spec?.roster) ? spec.roster : [];
  const defaultVpId = spec?.defaultVpId || null;
  const lines = [`# ${name}`, ''];
  lines.push(`Default group with ${roster.length} member${roster.length === 1 ? '' : 's'}.`);
  if (roster.length > 0) lines.push('', `**Members:** ${roster.join(', ')}`);
  if (defaultVpId) lines.push('', `**Default VP:** ${defaultVpId}`);
  return lines.join('\n').trim();
}

/**
 * @param {string} yeaftDir
 * @param {{ defaultVpId?: string|null, roster?: string[], name?: string, memoryRoot?: string }} [spec]
 * @returns {{ group: import('./group-store.js').GroupHandle, created: boolean }}
 */
export function seedDefaultGroup(yeaftDir, spec = {}) {
  const memoryRoot = spec.memoryRoot || DEFAULT_MEMORY_ROOT;
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
  const name = spec.name || 'Default';

  const group = createGroup(groupsRoot, {
    id: DEFAULT_GROUP_ID,
    name,
    roster,
    defaultVpId,
  });

  // Seed Layer-A resident summary so the very first session — even on a
  // brand-new install where only `grp_default` exists — renders a non-
  // empty memory section in the system prompt. No-op once Dream-v2 (or
  // createGroupFromSpec) has already written one. Best-effort: a memory-
  // root permission failure must NOT break the bootstrap flow.
  try {
    seedSummaryIfMissingSync(
      { kind: 'group', id: DEFAULT_GROUP_ID },
      buildDefaultGroupSeedSummary({ name, roster, defaultVpId }),
      { root: memoryRoot },
    );
  } catch (err) {
    console.warn(`[seed-default] failed to seed summary.md for ${DEFAULT_GROUP_ID}:`, err?.message || err);
  }

  return { group, created: true };
}
