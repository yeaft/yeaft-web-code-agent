/**
 * memory/ams-registry.js — group-keyed AMS lifecycle.
 *
 * The Active Memory Set is conceptually session-scoped, but Yeaft's
 * unit of "session" is a group: a deactivated group can be reactivated
 * later and should resume with the AMS state it had on disconnect (the
 * onDemand segments it had pulled in, the recent LRU touches, whether
 * `adjust` already ran). Sessions come and go; the group's AMS persists.
 *
 * Persistence is identity-only:
 *
 *   ~/.yeaft/memory/groups/<groupId>/ams.json
 *   {
 *     "version": 1,
 *     "ownVpId": "alice"|null,
 *     "onDemandIds": ["seg_..."],
 *     "recentIds":   ["seg_..."],
 *     "adjustRanThisSession": true|false,
 *     "savedAt": "2026-04-29T..."
 *   }
 *
 * Bodies are NOT serialised — they're re-hydrated from the SegmentIndex
 * on load, so a body edited by Dream after save still surfaces correctly
 * the next time the group is opened. Resident layer is derived state
 * (rebuilt every turn from `<scope>/summary.md`) — never persisted.
 *
 * For the single-VP Unify path (no group), the registry uses the literal
 * key `"default"` so there's still a stable home for AMS state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { ActiveMemorySet } from './ams.js';
import { computeBudget } from './budget.js';

export const AMS_FILE_VERSION = 1;
export const DEFAULT_GROUP_KEY = 'default';

/**
 * @typedef {object} AmsRegistryDeps
 * @property {string}                                    yeaftDir
 * @property {import('./index-db.js').SegmentIndex|null} memoryIndex
 * @property {object}                                    config
 */

/**
 * @typedef {object} AmsCacheEntry
 * @property {ActiveMemorySet} ams
 * @property {string|null}     ownVpId
 */

/**
 * Group-keyed in-memory cache + disk persistence for AMS instances.
 *
 * Lifecycle:
 *   - getOrCreate(groupId, {ownVpId}) — returns the cached AMS or loads
 *     from disk; falls through to a fresh empty AMS on cold start.
 *   - persist(groupId) — writes the current cached AMS to disk.
 *   - persistAll() — convenience for shutdown.
 *
 * The registry is intentionally narrow: it does not mutate the AMS
 * itself (that's the engine's job). It only caches, loads, and saves.
 */
export class AmsRegistry {
  /** @param {AmsRegistryDeps} deps */
  constructor(deps) {
    this.yeaftDir = deps.yeaftDir;
    this.memoryIndex = deps.memoryIndex || null;
    this.config = deps.config || {};
    /** @type {Map<string, AmsCacheEntry>} */
    this._cache = new Map();
    /** @type {Set<string>} */
    this._dirty = new Set();
  }

  /**
   * Resolve the on-disk path for a group's ams.json.
   *
   * @param {string} groupId
   * @returns {string}
   */
  amsPath(groupId) {
    const safe = String(groupId || DEFAULT_GROUP_KEY).replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.yeaftDir, 'memory', 'groups', safe, 'ams.json');
  }

  /**
   * Compute the BudgetSplit for this session/model.
   *
   * @returns {import('./budget.js').BudgetSplit}
   */
  _budget() {
    const ctx = Number.isFinite(this.config?.maxContextTokens)
      ? this.config.maxContextTokens
      : 200_000;
    return computeBudget(ctx);
  }

  /**
   * Get the AMS for a group, creating it on first access.
   * Loads persisted state from disk if any; on cold start returns an
   * empty AMS keyed to the supplied ownVpId.
   *
   * @param {string|null|undefined} groupId
   * @param {{ ownVpId?: string|null }} [opts]
   * @returns {ActiveMemorySet}
   */
  getOrCreate(groupId, opts = {}) {
    const key = groupId || DEFAULT_GROUP_KEY;
    const cached = this._cache.get(key);
    if (cached) return cached.ams;

    const ownVpId = opts.ownVpId || null;
    const budget = this._budget();
    const ams = new ActiveMemorySet({ ownVpId, budget });
    // Best-effort hydrate from disk.
    this._hydrate(key, ams);
    this._cache.set(key, { ams, ownVpId });
    return ams;
  }

  /**
   * Mark a group's AMS as dirty so the next persist() actually writes.
   * The engine calls this after `runAdjust` mutates membership.
   *
   * @param {string|null|undefined} groupId
   */
  markDirty(groupId) {
    this._dirty.add(groupId || DEFAULT_GROUP_KEY);
  }

  /**
   * Persist a single group's AMS to disk. No-op when the cached entry
   * is missing or hasn't been marked dirty.
   *
   * @param {string|null|undefined} groupId
   * @param {{ force?: boolean, adjustRanThisSession?: boolean }} [opts]
   * @returns {boolean} true if the file was written
   */
  persist(groupId, opts = {}) {
    const key = groupId || DEFAULT_GROUP_KEY;
    const entry = this._cache.get(key);
    if (!entry) return false;
    if (!opts.force && !this._dirty.has(key)) return false;

    const path = this.amsPath(key);
    const payload = {
      version: AMS_FILE_VERSION,
      ownVpId: entry.ownVpId,
      onDemandIds: entry.ams.onDemandIds(),
      recentIds: entry.ams.recentIds(),
      adjustRanThisSession: Boolean(opts.adjustRanThisSession),
      savedAt: new Date().toISOString(),
    };

    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, path);
      this._dirty.delete(key);
      return true;
    } catch {
      // Persistence failure is non-fatal — AMS continues to live in memory.
      return false;
    }
  }

  /**
   * Persist every cached, dirty AMS. Called on session shutdown.
   *
   * @returns {number} number of files written
   */
  persistAll() {
    let n = 0;
    for (const key of this._dirty) {
      if (this.persist(key, { force: true })) n += 1;
    }
    return n;
  }

  /**
   * Best-effort hydrate: read ams.json, re-resolve segment ids via the
   * SegmentIndex (skipping ids that no longer exist), populate AMS.
   * Silent on every error — a corrupt or missing file is the cold-start
   * case, indistinguishable from "first use of this group".
   *
   * @private
   * @param {string} key
   * @param {ActiveMemorySet} ams
   */
  _hydrate(key, ams) {
    const path = this.amsPath(key);
    if (!existsSync(path)) return;
    let payload;
    try { payload = JSON.parse(readFileSync(path, 'utf8') || '{}'); }
    catch { return; }
    if (!payload || typeof payload !== 'object') return;

    if (!this.memoryIndex) return;

    const onDemandIds = Array.isArray(payload.onDemandIds) ? payload.onDemandIds : [];
    const recentIds   = Array.isArray(payload.recentIds)   ? payload.recentIds   : [];

    const onDemandSegs = [];
    for (const id of onDemandIds) {
      try {
        const seg = this.memoryIndex.get(id);
        if (seg) onDemandSegs.push(seg);
      } catch { /* skip unresolvable */ }
    }
    if (onDemandSegs.length > 0) ams.setOnDemand(onDemandSegs);

    for (const id of recentIds) {
      try {
        const seg = this.memoryIndex.get(id);
        if (seg) ams.touchRecent(seg);
      } catch { /* skip */ }
    }
  }
}

/**
 * Factory for the registry. Kept as a thin function so call sites can
 * stay symmetrical with the other store openers in session.js.
 *
 * @param {AmsRegistryDeps} deps
 * @returns {AmsRegistry}
 */
export function openAmsRegistry(deps) {
  return new AmsRegistry(deps);
}
