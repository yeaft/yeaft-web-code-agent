/**
 * core-memory-recall.js — single-dimension VP memory recall.
 *
 * Per R3 §Δ2.3: recall is scoped to the CURRENT VP only. The `scope`
 * dimension from R2 was deleted; VP memory is a single store per VP and
 * the recall filter is `{ vp: currentVpId, ... }` — no $or across local /
 * global.
 *
 * This module is a thin shim over whatever memory store RoleInstance has
 * (334f wraps 334o's shard-store). It duck-types the store so 334c does
 * not hard-depend on 334f's final shape:
 *
 *   store.query({ vp, shard?, kind?, tags?, limit?, recency? })
 *   store.search({ vp, query, limit? })    // optional
 *
 * Return shape: array of entries with at minimum `{ body, shard }`.
 * Additional fields are passed through.
 */

const DEFAULT_LIMIT = 7;

/**
 * Recall top-K core memory for a VP.
 *
 * @param {object|null} store  — memoryStore (may be null)
 * @param {{ vp: string, limit?: number, shard?: string, kind?: string,
 *           tags?: string[] }} opts
 * @returns {Promise<Array<{body:string, shard?:string, [k:string]:any}>>}
 */
export async function recallCoreMemory(store, opts = {}) {
  if (!store || typeof store.query !== 'function') return [];
  if (!opts.vp || typeof opts.vp !== 'string') {
    throw new Error('recallCoreMemory: opts.vp (vpId) is required');
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0
    ? opts.limit
    : DEFAULT_LIMIT;

  const filter = { vp: opts.vp, limit };
  if (opts.shard) filter.shard = opts.shard;
  if (opts.kind) filter.kind = opts.kind;
  if (opts.tags && opts.tags.length) filter.tags = opts.tags;

  // Support both sync and async stores.
  const out = await Promise.resolve(store.query(filter));
  if (!Array.isArray(out)) return [];
  return out.slice(0, limit);
}

/**
 * Optional keyword-search variant — used by the `memory_search` tool in
 * 334d. Also VP-scoped.
 *
 * @param {object|null} store
 * @param {{ vp: string, query: string, limit?: number }} opts
 */
export async function searchCoreMemory(store, opts = {}) {
  if (!store) return [];
  if (!opts.vp || !opts.query) return [];
  const limit = opts.limit || DEFAULT_LIMIT;
  if (typeof store.search === 'function') {
    const out = await Promise.resolve(store.search({ vp: opts.vp, query: opts.query, limit }));
    return Array.isArray(out) ? out.slice(0, limit) : [];
  }
  // Fallback: query + naive substring filter.
  if (typeof store.query === 'function') {
    const all = await Promise.resolve(store.query({ vp: opts.vp, limit: 200 }));
    if (!Array.isArray(all)) return [];
    const needle = opts.query.toLowerCase();
    return all
      .filter((e) => (e.body || '').toLowerCase().includes(needle))
      .slice(0, limit);
  }
  return [];
}
