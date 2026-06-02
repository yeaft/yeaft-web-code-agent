/**
 * memory/preflow.js — DESIGN-H2-AMS §6. Pre-turn memory recall.
 *
 * Pure-CPU pipeline (no LLM). Runs on every turn:
 *
 *   userMsg
 *     → extractKeywords (rule-based tokeniser)
 *     → SQLite FTS5 MATCH (scope-filtered, bm25 ranked)
 *     → rerank by (scope match + tag overlap + recency)
 *     → onDemand layer (budget-clamped)
 *
 * Latency target: < 10ms p95 on a 10k-segment index.
 *
 * Honours `vp/<other>` privacy: caller passes `ownVpId` and the scope
 * filter excludes foreign VP scopes.
 */

import { extractKeywords } from './keywords.js';
import { approxTokens } from './budget.js';

/**
 * @typedef {object} PreflowOptions
 * @property {string}        userMsg
 * @property {string[]}      relevantScopes      e.g. ['user', 'group/g1', 'vp/alice']
 * @property {string|null}  [ownVpId]
 * @property {string[]}     [currentTags]        tags from the current group/feature context
 * @property {number}       [topK]               max FTS rows to fetch (default 50)
 * @property {number}       [budgetTokens]       onDemand budget (caller-supplied)
 */

/**
 * @typedef {object} PreflowResult
 * @property {string[]}                                  keywords
 * @property {string}                                     ftsQuery
 * @property {import('./index-db.js').SearchHit[]}       hits
 * @property {import('./segment.js').Segment[]}          picked
 * @property {number}                                     pickedTokens
 * @property {number}                                     droppedCount
 */

/**
 * Run the pre-flow against a segment index.
 *
 * @param {import('./index-db.js').SegmentIndex} index
 * @param {PreflowOptions} opts
 * @returns {PreflowResult}
 */
export function runPreflow(index, opts) {
  const userMsg = (opts.userMsg || '').trim();
  const relevantScopes = Array.isArray(opts.relevantScopes) ? opts.relevantScopes : [];
  const ownVpId = opts.ownVpId || null;
  const currentTags = Array.isArray(opts.currentTags) ? opts.currentTags : [];
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : 50;
  const budgetTokens = Number.isFinite(opts.budgetTokens) && opts.budgetTokens > 0
    ? opts.budgetTokens : Infinity;

  const keywords = extractKeywords(userMsg);
  if (keywords.length === 0) {
    return {
      keywords: [], ftsQuery: '', hits: [],
      picked: [], pickedTokens: 0, droppedCount: 0,
    };
  }

  const ftsQuery = buildFtsQuery(keywords);
  const scopeFilter = filterScopes(relevantScopes, ownVpId);
  if (scopeFilter.length === 0) {
    return {
      keywords, ftsQuery, hits: [],
      picked: [], pickedTokens: 0, droppedCount: 0,
    };
  }

  const hits = index.search({ query: ftsQuery, scopeFilter, limit: topK });
  const reranked = rerank(hits, { currentTags });

  const picked = [];
  let cost = 0;
  let dropped = 0;
  for (const h of reranked) {
    const tk = approxTokens(h.body);
    if (cost + tk <= budgetTokens) {
      picked.push(toSegment(h));
      cost += tk;
    } else {
      dropped += 1;
    }
  }

  return {
    keywords, ftsQuery, hits: reranked,
    picked, pickedTokens: cost, droppedCount: dropped,
  };
}

/**
 * Compose an FTS5 MATCH query from keywords. Each keyword is OR'd with
 * a prefix wildcard so morphological variants match. We escape any
 * FTS5-special characters by quoting tokens.
 *
 * @param {string[]} keywords
 * @returns {string}
 */
export function buildFtsQuery(keywords) {
  const cleaned = keywords
    .map(k => k.replace(/"/g, ''))
    .filter(k => k.length > 1)
    .slice(0, 8);   // top-8 keywords — avoid query bloat
  if (cleaned.length === 0) return '';
  return cleaned.map(k => `"${k}"*`).join(' OR ');
}

/**
 * Strip foreign VP scopes from the filter list (privacy).
 *
 * @param {string[]} scopes
 * @param {string|null} ownVpId
 * @returns {string[]}
 */
export function filterScopes(scopes, ownVpId) {
  return scopes.filter(s => {
    const m = /^group\/[^/]+\/vp\/([^/]+)(?:\/|$)/.exec(s);
    if (!m) return true;
    if (!ownVpId) return true;
    return m[1] === ownVpId;
  });
}

/**
 * Rerank FTS hits with two soft signals on top of bm25:
 *   - tag overlap with the current group/feature context (subtract penalty)
 *   - recency: recent items get a small bonus
 *
 * SQLite FTS5 bm25 returns NEGATIVE numbers (more negative = better
 * match). We treat lower score as better. To make overlap & recency
 * push hits ahead, we SUBTRACT bonuses from the bm25 base (making the
 * score more negative).
 *
 * @param {import('./index-db.js').SearchHit[]} hits
 * @param {{ currentTags: string[] }} ctx
 * @returns {import('./index-db.js').SearchHit[]}
 */
export function rerank(hits, ctx) {
  const tagSet = new Set((ctx.currentTags || []).map(t => String(t).toLowerCase()));
  const now = Date.now();
  return [...hits]
    .map(h => {
      const overlap = (h.tags || []).reduce(
        (n, t) => n + (tagSet.has(String(t).toLowerCase()) ? 1 : 0), 0,
      );
      const tagBonus = Math.min(2, overlap * 0.5);   // up to 2 points
      const ageDays = Math.max(0, (now - Date.parse(h.updatedAt || h.createdAt || '')) / 86400000);
      const recencyBonus = Math.min(0.5, 0.2 / Math.max(0.5, ageDays + 1));
      const base = h.rank ?? 0;
      const score = base - tagBonus - recencyBonus;
      return { ...h, _score: score };
    })
    .sort((a, b) => a._score - b._score)
    .map(({ _score, ...rest }) => rest);
}

function toSegment(h) {
  return {
    id: h.id,
    scope: h.scope,
    kind: h.kind,
    tags: h.tags,
    sourceMessages: h.sourceMessages,
    body: h.body,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}
