/**
 * memory/seed-backfill.js — stub-marker contract + one-shot legacy archive.
 *
 * Earlier versions of this module shipped `backfillVpSummaries` /
 * `migrateLegacyVpSummaries` / `backfillGroupSummaries` / `runSummaryBackfill`
 * that wrote files into BARE `<root>/vp/<id>/summary.md` and
 * `<root>/group/<id>/summary.md` paths. Those paths are not the layout the
 * Engine actually reads: `engine.#loadLayerASummaries` looks under
 * `group/<sessionId>/vp/<id>/summary.md` (kind: 'group-vp'). The backfill
 * helpers were therefore writing **orphan files** that nothing ever read.
 *
 * Per user directive (2026-06-09 — "VP per-session isolation + clean up the
 * dead backfill code"), the orphan writers have been deleted. What remains:
 *
 *   - `VP_STUB_MARKER` / `isVpSeedBackfillStub`: still used by `engine.js`
 *     and `engine.#prepareAms` to skip the own-VP Resident entry when its
 *     summary is just the stub. Section 1 (`renderVpPersona`) is the source
 *     of truth for own-VP identity; surfacing the stub in Section 6 would
 *     dup the same `# Name / Role` text. New seed paths (vp-crud.js,
 *     group-crud.js, seed-default.js) use `seedSummaryIfMissingSync` from
 *     store-v2.js to write directly to the correct scope dir.
 *
 *   - `archiveLegacyScopes(root)`: one-shot migration that moves the truly
 *     dead top-level `vp/`, `feature/`, `topic/` dirs to `.legacy/`. Per
 *     user directive "硬切，老的就不要了" — we do NOT migrate per-record,
 *     just move once. They're never read again; forensics-only.
 *
 * Anything that *looks* like a backfill function and lived here before is
 * gone. If you need to seed a missing summary today, call
 * `seedSummaryIfMissingSync` directly from the CRUD entry point — that's
 * the only path that writes to the correct (group-scoped) location.
 */

import { existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

/**
 * Marker stamped into every VP summary written by `seedSummaryIfMissingSync`
 * for the VP scope. Consumed by `isVpSeedBackfillStub` (below) so
 * `engine.#prepareAms` can skip the `vp/<ownVpId>` Resident entry when the
 * file is just the stub. Real Dream-v2 summaries lack the marker and ARE
 * surfaced in Section 6 normally.
 *
 * Bump the version suffix when the stub format changes meaningfully so
 * old stamps can be re-detected if needed.
 */
export const VP_STUB_MARKER = '<!-- seed-backfill:vp-stub v1 -->';

/**
 * True iff the given summary text was produced by a VP stub writer
 * (i.e. carries the marker comment). Whitespace-tolerant.
 *
 * Used by `engine.#prepareAms` (via `buildResidentEntries`) to decide
 * whether to surface the `group/<sessionId>/vp/<ownVpId>` summary as a
 * Resident AMS entry. Stubs are skipped so Section 1 (`renderVpPersona`)
 * is the sole rendering of own-VP identity; Dream-v2's eventual real
 * summary will lack the marker and be surfaced normally.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isVpSeedBackfillStub(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return text.includes(VP_STUB_MARKER);
}

/**
 * archiveLegacyScopes(root) — one-shot migration for the group-isolated
 * memory refactor. The legacy flat layout had `vp/<id>/`, `feature/<id>/`,
 * and `topic/<l1>[/<l2>]/` directories at the memory root; the current
 * layout tucks each into `group/<g>/{vp,feature,topic}/...`. Per user
 * directive "硬切，老的就不要了" — we do NOT migrate per-record, we just
 * move the top-level dirs to `<root>/.legacy/<kind>/` once. They are never
 * read again; this is forensics-only.
 *
 * Idempotent: a second invocation is a no-op when no legacy dirs remain at
 * the root. If `.legacy/<kind>/` already exists, the new move is suffixed
 * with a timestamp so re-attempts after a partial first run don't clobber.
 *
 * @param {string} root  memory root (typically <yeaftDir>/memory)
 * @returns {{moved: string[]}}
 */
export function archiveLegacyScopes(root) {
  const moved = [];
  if (!root || !existsSync(root)) return { moved };
  const legacyRoot = join(root, '.legacy');
  for (const kind of ['vp', 'feature', 'topic']) {
    const src = join(root, kind);
    if (!existsSync(src)) continue;
    try {
      mkdirSync(legacyRoot, { recursive: true });
      let dst = join(legacyRoot, kind);
      if (existsSync(dst)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        dst = `${dst}.${ts}`;
      }
      renameSync(src, dst);
      moved.push(kind);
    } catch (err) {
      console.warn(`[seed-backfill] archiveLegacyScopes(${kind}) failed:`, err?.message || err);
    }
  }
  return { moved };
}
