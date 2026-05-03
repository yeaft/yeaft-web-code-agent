/**
 * memory/seed-backfill.js — Run-once backfill of `summary.md` for VPs and
 * groups that were created BEFORE the create-time seed was added (PR
 * "fix-unify-context-and-memory"). Without backfill, an existing user's
 * `grp_claude` group and `steve` VP never get a Layer-A resident summary —
 * `engine.#prepareAms` then renders an empty memory section every turn,
 * which is the user-visible Bug #2.
 *
 * Idempotency:
 *   - Reads `<root>/<scopeDir>/summary.md`. If it already has any non-
 *     empty content, the backfill is a no-op for that scope.
 *   - Only seeds when the file is missing OR empty.
 *
 * This runs sync at session boot. Failures are logged and swallowed —
 * a permission error must NEVER prevent the session from loading.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseRoleMd } from '../vp/vp-store.js';

const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

function readIfPresent(path) {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

function writeAtomicSync(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, (body || '').trim() + '\n', 'utf-8');
}

/**
 * Build a synthetic VP summary from the on-disk role.md.
 *
 * Delegates frontmatter parsing to `vp-store.js#parseRoleMd` so the
 * backfill stays in sync with the production loader. The earlier hand-
 * rolled regex parser silently dropped quoted multi-line scalars and
 * list-shaped fields — `parseRoleMd` covers both.
 *
 * @param {string} libDir
 * @param {string} vpId
 * @returns {string|null}
 */
function readVpRoleSummary(libDir, vpId) {
  const rolePath = join(libDir, vpId, 'role.md');
  if (!existsSync(rolePath)) return null;
  let raw = '';
  try { raw = readFileSync(rolePath, 'utf-8'); } catch { return null; }

  const { meta, body } = parseRoleMd(raw);
  const name = String(meta.name || vpId).trim() || vpId;
  const role = typeof meta.role === 'string' ? meta.role.trim() : '';

  const persona = typeof body === 'string' ? body.trim() : '';
  const lines = [`# ${name}`];
  if (role) lines.push('', `**Role:** ${role}`);
  if (persona) {
    const truncated = persona.length > 800 ? persona.slice(0, 800).trim() + '…' : persona;
    lines.push('', '**Persona:**', '', truncated);
  }
  return lines.join('\n').trim();
}

/**
 * Walk the VP library and seed `summary.md` for every VP without one.
 *
 * @param {{ libDir: string, root?: string }} opts
 * @returns {{seeded: number, scanned: number}}
 */
export function backfillVpSummaries({ libDir, root = DEFAULT_MEMORY_ROOT }) {
  let scanned = 0;
  let seeded = 0;
  if (!existsSync(libDir)) return { scanned, seeded };
  let entries;
  try { entries = readdirSync(libDir); } catch { return { scanned, seeded }; }
  for (const name of entries) {
    const vpDir = join(libDir, name);
    let isDir = false;
    try { isDir = statSync(vpDir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    if (name.startsWith('.')) continue;
    scanned++;
    const summaryPath = join(root, 'vp', name, 'summary.md');
    if (readIfPresent(summaryPath)) continue;
    const body = readVpRoleSummary(libDir, name);
    if (!body) continue;
    try {
      writeAtomicSync(summaryPath, body);
      seeded++;
    } catch (err) {
      console.warn(`[seed-backfill] vp ${name}: ${err?.message || err}`);
    }
  }
  return { scanned, seeded };
}

/**
 * Build a synthetic group summary from group.json on disk.
 *
 * @param {string} groupDir
 * @returns {string|null}
 */
function readGroupSummaryBody(groupDir) {
  const metaPath = join(groupDir, 'group.json');
  if (!existsSync(metaPath)) return null;
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { return null; }
  const name = (meta?.name || '').trim();
  const roster = Array.isArray(meta?.roster) ? meta.roster : [];
  const defaultVpId = meta?.defaultVpId || null;
  const lines = [];
  if (name) lines.push(`# ${name}`);
  lines.push('', `Group with ${roster.length} member${roster.length === 1 ? '' : 's'}.`);
  if (roster.length > 0) lines.push('', `**Members:** ${roster.join(', ')}`);
  if (defaultVpId) lines.push('', `**Default VP:** ${defaultVpId}`);
  return lines.join('\n').trim();
}

/**
 * Walk groups/ and seed `summary.md` for every group without one.
 *
 * @param {{ yeaftDir: string, root?: string }} opts
 * @returns {{seeded: number, scanned: number}}
 */
export function backfillGroupSummaries({ yeaftDir, root = DEFAULT_MEMORY_ROOT }) {
  let scanned = 0;
  let seeded = 0;
  const groupsRoot = join(yeaftDir, 'groups');
  if (!existsSync(groupsRoot)) return { scanned, seeded };
  let entries;
  try { entries = readdirSync(groupsRoot); } catch { return { scanned, seeded }; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const groupDir = join(groupsRoot, name);
    let isDir = false;
    try { isDir = statSync(groupDir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    scanned++;
    const summaryPath = join(root, 'group', name, 'summary.md');
    if (readIfPresent(summaryPath)) continue;
    const body = readGroupSummaryBody(groupDir);
    if (!body) continue;
    try {
      writeAtomicSync(summaryPath, body);
      seeded++;
    } catch (err) {
      console.warn(`[seed-backfill] group ${name}: ${err?.message || err}`);
    }
  }
  return { scanned, seeded };
}

/**
 * Run all backfills sequentially. Best-effort — any per-step error is
 * logged and the next step still runs.
 *
 * @param {{ yeaftDir: string, libDir: string, root?: string }} opts
 * @returns {{ vp: {scanned:number, seeded:number}, group: {scanned:number, seeded:number} }}
 */
export function runSummaryBackfill({ yeaftDir, libDir, root = DEFAULT_MEMORY_ROOT }) {
  let vp = { scanned: 0, seeded: 0 };
  let group = { scanned: 0, seeded: 0 };
  try { vp = backfillVpSummaries({ libDir, root }); } catch (err) {
    console.warn('[seed-backfill] vp pass failed:', err?.message || err);
  }
  try { group = backfillGroupSummaries({ yeaftDir, root }); } catch (err) {
    console.warn('[seed-backfill] group pass failed:', err?.message || err);
  }
  return { vp, group };
}
