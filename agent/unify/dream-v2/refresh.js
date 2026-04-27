/**
 * dream-v2/refresh.js — DESIGN.md §9.14 refresh hook (Phase 8 PR-J).
 *
 * The PR-F wire-up plumbed `runDreamTick` into the scheduler with a v1
 * no-op refresh placeholder. PR-J makes the refresh real but stays
 * within the §8 v1 charter — "Thin: skip pruning/demotion; refresh-only
 * in v1, no LLM".
 *
 * What "refresh" does today:
 *   1. Read the scope's `index.md` rows (the entry catalog).
 *   2. Select the top-N most recent rows by `updated` timestamp
 *      (default 12 — enough to surface the active context without
 *      exploding Layer A token cost).
 *   3. Render a deterministic markdown synopsis (one bullet per row:
 *      `- <title> [<kind>; tags] (<updated>)`).
 *   4. Write to the scope's `summary.md` via `writeSummary` (atomic
 *      rename — readers never see a partial write).
 *
 * If the index is empty (cold-start scope), we leave `summary.md`
 * alone. Overwriting with an empty file would erase any human-written
 * synopsis a future tool may have placed there.
 *
 * No LLM call. No pruning. No tombstones. The cursor is advanced by
 * `runDreamTick` after this hook resolves, so a clean run of refresh
 * counts as "scope handled" and we won't re-run until the diff-gate
 * sees new content.
 *
 * Errors are propagated — `runDreamTick` already catches per-scope
 * failures and records them under `errors[]` without aborting siblings.
 */

import { readIndex, writeSummary } from '../memory/scope-tree.js';

/** Default number of recent entries surfaced on the synopsis. */
export const DEFAULT_TOP_N = 12;

/**
 * Render a deterministic markdown synopsis for a scope from its index rows.
 * Pure function — exported for unit tests.
 *
 * @param {{ kind: string, id?: string, scopeDir: string }} scope
 * @param {Array<{ path: string, title?: string, tags?: string[]|string, kind?: string, updated?: string }>} rows
 * @param {number} [topN]
 * @returns {string}
 */
export function buildScopeSynopsis(scope, rows, topN = DEFAULT_TOP_N) {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  // Sort by `updated` desc, then by path asc as a stable tiebreaker.
  const sorted = [...rows].sort((a, b) => {
    const u = (b.updated || '').localeCompare(a.updated || '');
    return u !== 0 ? u : (a.path || '').localeCompare(b.path || '');
  });
  const top = sorted.slice(0, Math.max(1, topN | 0));

  const header = `# ${scope.scopeDir} — recent context`;
  const lines = top.map((r) => {
    const title = (r.title || r.path || 'entry').trim();
    const kind = r.kind ? `${r.kind}` : '';
    const tagsRaw = Array.isArray(r.tags) ? r.tags : (typeof r.tags === 'string' ? r.tags.split(',') : []);
    const tags = tagsRaw.map((t) => String(t).trim()).filter(Boolean);
    const meta = [kind, ...tags].filter(Boolean).join('; ');
    const metaPart = meta ? ` [${meta}]` : '';
    const updated = r.updated ? ` (${r.updated})` : '';
    return `- ${title}${metaPart}${updated}`;
  });
  return [header, '', ...lines, ''].join('\n');
}

/**
 * Translate a `runDreamTick` ScopeRef ({ kind, id?, scopeDir }) into a
 * `scope-tree.js` Scope ({ kind, id }). The two surfaces share the
 * `kind` enum but `runDreamTick` carries `scopeDir` as the canonical
 * identifier; scope-tree derives it from `kind`+`id`.
 *
 * @param {{ kind: string, id?: string, scopeDir: string }} ref
 * @returns {{ kind: string, id?: string }}
 */
export function refToScope(ref) {
  if (!ref || typeof ref !== 'object') {
    throw new Error('refToScope: ref required');
  }
  if (ref.kind === 'user') return { kind: 'user' };
  if (!ref.id) throw new Error(`refToScope: ${ref.kind} scope requires id`);
  return { kind: ref.kind, id: ref.id };
}

/**
 * Build a refresh hook bound to a specific memory root. The returned
 * function is the `refresh` arg `runDreamTick` expects.
 *
 * @param {{ root: string, topN?: number }} args
 * @returns {(scope: { kind: string, id?: string, scopeDir: string }) => Promise<void>}
 */
export function createScopeRefreshHook({ root, topN = DEFAULT_TOP_N } = {}) {
  if (!root || typeof root !== 'string') {
    throw new Error('createScopeRefreshHook: root required');
  }
  return async function refreshScopeSummary(scope) {
    const target = refToScope(scope);
    const rows = await readIndex(target, { root });
    const body = buildScopeSynopsis(scope, rows, topN);
    if (!body) {
      // Cold-start scope: leave summary.md alone (see header docs).
      return;
    }
    await writeSummary(target, body, { root });
  };
}
