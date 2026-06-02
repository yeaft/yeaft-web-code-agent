/**
 * memory/seed-backfill.js — Run-once backfill of `summary.md` for VPs and
 * groups that were created BEFORE the create-time seed was added (PR
 * "fix-yeaft-context-and-memory"). Without backfill, an existing user's
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

/**
 * Marker stamped into every VP summary written by this module.
 *
 * Two consumers care about it:
 *   1. `engine.#prepareAms` uses `isVpSeedBackfillStub` to skip the
 *      `vp/<ownVpId>` Resident entry when its summary is just our stub —
 *      the real persona is already rendered as Section 1 of the system
 *      prompt by `renderVpPersona`. Without the skip, AMS Resident dups
 *      Section 1 with redundant `name + role` labels.
 *   2. `migrateLegacyVpSummaries` uses absence-of-marker + presence of
 *      `**Persona:**` to identify pre-fix summary.md files (which copied
 *      up to 800 chars of `role.md` body) and rewrite them as stubs.
 *
 * Bump the version suffix when the stub format changes meaningfully so
 * old stamps can be re-migrated if needed.
 */
export const VP_STUB_MARKER = '<!-- seed-backfill:vp-stub v1 -->';

/**
 * True iff the given summary text was produced by this module's VP stub
 * writer (i.e. carries the marker comment). Whitespace-tolerant.
 *
 * Used by `engine.#prepareAms` to decide whether to surface the
 * `vp/<ownVpId>` summary as a Resident AMS entry. Stubs are skipped so
 * Section 1 (`renderVpPersona`) is the sole rendering of own-VP identity;
 * Dream-v2's eventual real summary will lack the marker and be surfaced
 * normally.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isVpSeedBackfillStub(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return text.includes(VP_STUB_MARKER);
}

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
 * IMPORTANT — this is a STUB that lives until Dream-v2 writes a real
 * per-scope summary. Earlier versions copied up to 800 chars of the
 * `role.md` body into `summary.md`. That body is *also* rendered as
 * Section 1 of the system prompt (`renderVpPersona` in `prompts.js`),
 * so the same persona text reappeared in `## Active Memory Set →
 * Resident → vp/<id>` — the user-visible "Why is the persona defined
 * twice?" bug.
 *
 * The summary.md placeholder is therefore deliberately minimal: just
 * the VP's display name + role label. Layer-A AMS still sees a
 * non-empty `vp/<id>` resident entry (so adjust/recall scope wiring
 * stays unchanged), but the persona body is rendered exactly once,
 * by Section 1.
 *
 * Once Dream-v2 produces a real summary for this scope it overwrites
 * this stub — see `idempotency` note at the top of the file.
 *
 * Delegates frontmatter parsing to `vp-store.js#parseRoleMd` so the
 * backfill stays in sync with the production loader.
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

  const { meta } = parseRoleMd(raw);
  const name = String(meta.name || vpId).trim() || vpId;
  const role = typeof meta.role === 'string' ? meta.role.trim() : '';

  const lines = [VP_STUB_MARKER, '', `# ${name}`];
  if (role) lines.push('', `**Role:** ${role}`);
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
 * Detect the *legacy* (pre-stamp) VP summary shape: a body that lacks
 * `VP_STUB_MARKER` AND contains the `**Persona:**` block written by the
 * older stub. Tight signature on purpose — we don't want to clobber
 * hand-edited or Dream-v2-produced summaries that happen to be missing
 * the marker for unrelated reasons.
 *
 * @param {string} body
 * @returns {boolean}
 */
function isLegacyVpSummary(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  if (body.includes(VP_STUB_MARKER)) return false;
  return body.includes('**Persona:**');
}

/**
 * One-shot migration: walk `<root>/vp/<id>/summary.md` and rewrite any
 * file matching the legacy shape (`isLegacyVpSummary`) into the current
 * stamped stub. Idempotent — a stamped or Dream-v2-produced file is left
 * untouched. Safe to run on every session boot.
 *
 * Existing users whose `summary.md` was written by the pre-stamp stub
 * carry the persona body forever, because `backfillVpSummaries` only
 * writes when the file is empty/missing. This pass closes that gap.
 *
 * @param {{ libDir: string, root?: string }} opts
 * @returns {{ scanned: number, migrated: number }}
 */
export function migrateLegacyVpSummaries({ libDir, root = DEFAULT_MEMORY_ROOT }) {
  let scanned = 0;
  let migrated = 0;
  const vpRoot = join(root, 'vp');
  if (!existsSync(vpRoot)) return { scanned, migrated };
  let entries;
  try { entries = readdirSync(vpRoot); } catch { return { scanned, migrated }; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const summaryPath = join(vpRoot, name, 'summary.md');
    let body = '';
    try {
      if (!existsSync(summaryPath)) continue;
      body = readFileSync(summaryPath, 'utf-8');
    } catch { continue; }
    scanned++;
    if (!isLegacyVpSummary(body)) continue;
    const stub = readVpRoleSummary(libDir, name);
    if (!stub) continue;
    try {
      writeAtomicSync(summaryPath, stub);
      migrated++;
    } catch (err) {
      console.warn(`[seed-backfill] migrate vp ${name}: ${err?.message || err}`);
    }
  }
  return { scanned, migrated };
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
 * Order:
 *   1. Migrate legacy VP summaries (rewrite pre-stamp persona-body stubs
 *      to current-format stamped stubs). Runs FIRST so that
 *      `backfillVpSummaries` sees consistent on-disk state and any
 *      future logic that distinguishes "stamped" vs "free-form" works
 *      uniformly downstream.
 *   2. Backfill missing VP summaries.
 *   3. Backfill missing group summaries.
 *
 * @param {{ yeaftDir: string, libDir: string, root?: string }} opts
 * @returns {{ migrate: {scanned:number, migrated:number}, vp: {scanned:number, seeded:number}, group: {scanned:number, seeded:number} }}
 */
export function runSummaryBackfill({ yeaftDir, libDir, root = DEFAULT_MEMORY_ROOT }) {
  let migrate = { scanned: 0, migrated: 0 };
  let vp = { scanned: 0, seeded: 0 };
  let group = { scanned: 0, seeded: 0 };
  try { migrate = migrateLegacyVpSummaries({ libDir, root }); } catch (err) {
    console.warn('[seed-backfill] vp migrate failed:', err?.message || err);
  }
  try { vp = backfillVpSummaries({ libDir, root }); } catch (err) {
    console.warn('[seed-backfill] vp pass failed:', err?.message || err);
  }
  try { group = backfillGroupSummaries({ yeaftDir, root }); } catch (err) {
    console.warn('[seed-backfill] group pass failed:', err?.message || err);
  }
  return { migrate, vp, group };
}
