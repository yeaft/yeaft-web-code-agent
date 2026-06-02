/**
 * memory/ams.js — DESIGN-H2-AMS §5. Active Memory Set.
 *
 * Per-group session state. Three layers:
 *
 *   resident   summaries of all relevant scopes — always-on, high precision
 *   recent     LRU of segments touched in last N turns — warm cache
 *   onDemand   segments the pre-flow FTS pulled in this turn — hot recall
 *
 * AMS is in-memory; it's rebuilt at session start. The disk source of
 * truth is `<scope>/memory.md` + `<scope>/summary.md`. AMS itself
 * doesn't write to disk — that's Dream's job.
 *
 * Privacy: `vp/<other>` scopes are ALWAYS filtered out
 * for any worker that isn't `<other>`. The owning code passes its own
 * vpId at construction.
 */

import { approxTokens, packWithinBudget } from './budget.js';

const RECENT_DEFAULT_CAPACITY = 64;

/**
 * @typedef {object} AmsLayers
 * @property {Map<string, string>}                resident
 * @property {Array<{ id: string, seg: import('./segment.js').Segment, ts: number }>} recent
 * @property {Map<string, import('./segment.js').Segment>} onDemand
 */

/**
 * @typedef {object} AmsSnapshot
 * @property {Array<{ scope: string, summary: string }>} resident
 * @property {import('./segment.js').Segment[]} recent
 * @property {import('./segment.js').Segment[]} onDemand
 * @property {{ resident: number, recent: number, onDemand: number, total: number }} usage
 */

export class ActiveMemorySet {
  /**
   * @param {{
   *   ownVpId?: string | null,
   *   budget: import('./budget.js').BudgetSplit,
   *   recentCapacity?: number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.budget) throw new Error('ActiveMemorySet: budget required');
    this.ownVpId = opts.ownVpId || null;
    this.budget = opts.budget;
    this.recentCapacity = opts.recentCapacity || RECENT_DEFAULT_CAPACITY;
    /** @type {Map<string, string>} */
    this._resident = new Map();          // scope → summaryText
    /** @type {Map<string, { seg: import('./segment.js').Segment, ts: number }>} */
    this._recent = new Map();            // segId → entry (insertion-order is LRU order)
    /** @type {Map<string, import('./segment.js').Segment>} */
    this._onDemand = new Map();          // segId → segment
  }

  // ────────────────────────── resident ──────────────────────────

  /**
   * Replace the resident layer with a fresh set of scope→summary
   * pairs. Foreign VP scopes are silently dropped.
   *
   * @param {Array<{ scope: string, summary: string }>} entries
   */
  setResident(entries) {
    this._resident.clear();
    for (const e of entries) {
      if (this._isForeignVp(e.scope)) continue;
      if (!e.summary) continue;
      this._resident.set(e.scope, e.summary);
    }
  }

  // ────────────────────────── recent ──────────────────────────

  /**
   * Touch a segment as "used this turn". LRU semantics: most-recent at
   * the end. Trims to capacity automatically.
   *
   * @param {import('./segment.js').Segment} seg
   */
  touchRecent(seg) {
    if (!seg || !seg.id) return;
    if (this._isForeignVp(seg.scope)) return;
    if (this._recent.has(seg.id)) this._recent.delete(seg.id);
    this._recent.set(seg.id, { seg, ts: Date.now() });
    while (this._recent.size > this.recentCapacity) {
      const firstKey = this._recent.keys().next().value;
      this._recent.delete(firstKey);
    }
  }

  // ────────────────────────── onDemand ──────────────────────────

  /**
   * Replace the onDemand layer with this turn's FTS hits.
   *
   * @param {import('./segment.js').Segment[]} segments
   */
  setOnDemand(segments) {
    this._onDemand.clear();
    for (const seg of segments) {
      if (this._isForeignVp(seg.scope)) continue;
      this._onDemand.set(seg.id, seg);
    }
  }

  /**
   * Add segments to onDemand without clearing (used by adjustMemory).
   *
   * @param {import('./segment.js').Segment[]} segments
   */
  addOnDemand(segments) {
    for (const seg of segments) {
      if (this._isForeignVp(seg.scope)) continue;
      this._onDemand.set(seg.id, seg);
    }
  }

  /**
   * Remove segment ids from onDemand (used by adjustMemory eviction).
   *
   * @param {string[]} ids
   */
  removeOnDemand(ids) {
    for (const id of ids) this._onDemand.delete(id);
  }

  // ────────────────────────── snapshot ──────────────────────────

  /**
   * Produce a budget-aware snapshot that can be injected into the
   * system prompt. Each layer is greedily packed within its budget;
   * overflow is dropped from this turn but not from disk.
   *
   * @returns {AmsSnapshot}
   */
  snapshot() {
    // Resident: pack scopes by priority order (caller provides via insert
    // order — current group's own vp first, then user, etc.).
    const resEntries = [...this._resident.entries()].map(([scope, summary]) => ({
      scope, summary,
    }));
    const { picked: resPicked, cost: resCost } = packWithinBudget(
      resEntries, this.budget.resident,
      e => approxTokens(e.summary),
    );

    // Recent: insertion order is oldest-first; we want newest first.
    const recentArr = [...this._recent.values()]
      .reverse()
      .map(e => e.seg);
    const { picked: recPicked, cost: recCost } = packWithinBudget(
      recentArr, this.budget.recent,
      seg => approxTokens(seg.body),
    );

    // OnDemand: insertion order from caller (already FTS-ranked).
    const odArr = [...this._onDemand.values()];
    const { picked: odPicked, cost: odCost } = packWithinBudget(
      odArr, this.budget.onDemand,
      seg => approxTokens(seg.body),
    );

    return {
      resident: resPicked,
      recent: recPicked,
      onDemand: odPicked,
      usage: {
        resident: resCost,
        recent: recCost,
        onDemand: odCost,
        total: resCost + recCost + odCost,
      },
    };
  }

  /**
   * Read-only inspectors (for tests / observability / adjustMemory input).
   */
  residentScopes() { return [...this._resident.keys()]; }
  recentIds()      { return [...this._recent.keys()]; }
  onDemandIds()    { return [...this._onDemand.keys()]; }
  onDemandSegments() { return [...this._onDemand.values()]; }
  size() { return this._resident.size + this._recent.size + this._onDemand.size; }

  // ────────────────────────── privacy ──────────────────────────

  _isForeignVp(scope) {
    if (!scope || !scope.startsWith('vp/')) return false;
    if (!this.ownVpId) return false;        // no own id → no filtering
    const other = scope.slice(3).split('/')[0];
    return other !== this.ownVpId;
  }
}
