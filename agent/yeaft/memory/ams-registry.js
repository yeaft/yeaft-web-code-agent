/**
 * memory/ams-registry.js — Session + VP keyed AMS lifecycle.
 *
 * A Session can run multiple VPs concurrently. Each VP needs an isolated
 * prompt snapshot because `ownVpId` is part of the memory ACL. Historical
 * onDemand/recent ids stay in the version-1 payload for disk compatibility,
 * but prompt state is rebuilt from query-selected canonical content each turn.
 *
 * Persistence is identity-only:
 *
 *   ~/.yeaft/memory/sessions/<sessionId>/ams.json
 *   {
 *     "version": 1,
 *     "ownVpId": "alice"|null,
 *     "onDemandIds": ["seg_..."],
 *     "recentIds":   ["seg_..."],
 *     "adjustRanThisSession": true|false,
 *     "savedAt": "2026-04-29T..."
 *   }
 *
 * Bodies are never serialised. Resident is derived state rebuilt every turn
 * from selected content.md files and is never persisted.
 *
 * For the single-VP Yeaft path (no session id supplied), the registry uses
 * the literal key `"default"` so there's still a stable home for AMS state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { ActiveMemorySet } from './ams.js';
import { computeBudget } from './budget.js';

export const AMS_FILE_VERSION = 1;
export const DEFAULT_SESSION_KEY = 'default';

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
 * @property {string}          sessionKey
 * @property {boolean}         adjustRanThisSession
 */

/**
 * Session + VP keyed in-memory cache with Session-level disk compatibility.
 *
 * Lifecycle:
 *   - getOrCreate(sessionId, {ownVpId}) — returns the cached AMS or loads
 *     from disk; falls through to a fresh empty AMS on cold start.
 *   - persist(sessionId) — writes the current cached AMS to disk.
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
   * Resolve the on-disk path for a Session's ams.json.
   *
   * `sessionId` is trusted: `nextSessionId()` (sessions/ids.js) emits ids matching
   * `grp_[a-z0-9_-]+_[0-9A-HJKMNP-TV-Z]{8}` (slug + 8-char crockford suffix),
   * and the single-VP path uses the literal `DEFAULT_SESSION_KEY`. No defensive
   * escaping is needed.
   *
   * @param {string} sessionId
   * @returns {string}
   */
  amsPath(sessionId) {
    const key = String(sessionId || DEFAULT_SESSION_KEY);
    return join(this.yeaftDir, 'memory', 'sessions', key, 'ams.json');
  }

  /**
   * Compute the BudgetSplit for this session/model.
   *
   * @returns {import('./budget.js').BudgetSplit}
   */
  _budget() {
    return computeBudget(this.config?.maxContextTokens);
  }

  /**
   * Get the AMS for a Session, creating it on first access.
   * Loads persisted state from disk if any; on cold start returns an
   * empty AMS keyed to the supplied ownVpId.
   *
   * @param {string|null|undefined} sessionId
   * @param {{ ownVpId?: string|null }} [opts]
   * @returns {ActiveMemorySet}
   */
  getOrCreate(sessionId, opts = {}) {
    const sessionKey = sessionId || DEFAULT_SESSION_KEY;
    const ownVpId = opts.ownVpId || null;
    const key = this._cacheKey(sessionKey, ownVpId);
    const cached = this._cache.get(key);
    if (cached) return cached.ams;

    const budget = this._budget();
    const ams = new ActiveMemorySet({ ownVpId, budget });
    const entry = { ams, ownVpId, adjustRanThisSession: false, sessionKey };
    // Best-effort hydrate Session-level compatibility metadata only.
    this._hydrate(sessionKey, entry);
    this._cache.set(key, entry);
    return ams;
  }

  _cacheKey(sessionId, ownVpId) {
    return `${sessionId || DEFAULT_SESSION_KEY}\u0000${ownVpId || ''}`;
  }

  /**
   * Read the persisted-and-rehydrated `adjustRanThisSession` flag for a
   * Session. Kept only for version-1 payload compatibility.
   *
   * @param {string|null|undefined} sessionId
   * @returns {boolean}
   */
  adjustRanThisSession(sessionId) {
    const sessionKey = sessionId || DEFAULT_SESSION_KEY;
    return [...this._cache.values()].some(entry => (
      entry.sessionKey === sessionKey && entry.adjustRanThisSession === true
    ));
  }

  /**
   * Update the cached `adjustRanThisSession` flag (does not persist on its
   * own — call `persist()` to flush). Kept for old callers and payloads.
   *
   * @param {string|null|undefined} sessionId
   * @param {boolean} value
   */
  setAdjustRanThisSession(sessionId, value) {
    const sessionKey = sessionId || DEFAULT_SESSION_KEY;
    for (const entry of this._cache.values()) {
      if (entry.sessionKey === sessionKey) entry.adjustRanThisSession = Boolean(value);
    }
  }

  /**
   * Mark a Session's AMS metadata as dirty so the next persist() writes.
   *
   * @param {string|null|undefined} sessionId
   */
  markDirty(sessionId) {
    this._dirty.add(sessionId || DEFAULT_SESSION_KEY);
  }

  /**
   * Persist a single Session's AMS metadata to disk. No-op when the cached entry
   * is missing or hasn't been marked dirty.
   *
   * `opts.adjustRanThisSession`, when supplied, also updates the cached
   * entry so subsequent `adjustRanThisSession()` reads see the latest flag
   * without a round-trip through disk.
   *
   * @param {string|null|undefined} sessionId
   * @param {{ force?: boolean, adjustRanThisSession?: boolean }} [opts]
   * @returns {boolean} true if the file was written
   */
  persist(sessionId, opts = {}) {
    const key = sessionId || DEFAULT_SESSION_KEY;
    const entry = [...this._cache.values()].find(item => item.sessionKey === key);
    if (!entry) return false;
    if (!opts.force && !this._dirty.has(key)) return false;

    if (typeof opts.adjustRanThisSession === 'boolean') {
      entry.adjustRanThisSession = opts.adjustRanThisSession;
    }

    const path = this.amsPath(key);
    const payload = {
      version: AMS_FILE_VERSION,
      ownVpId: entry.ownVpId,
      onDemandIds: entry.ams.onDemandIds(),
      recentIds: entry.ams.recentIds(),
      adjustRanThisSession: Boolean(entry.adjustRanThisSession),
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
   * Best-effort hydrate of version-1 metadata. Persisted segment ids are
   * intentionally ignored because Engine rebuilds prompt state from selected
   * canonical content on every query. Silent on every error; corrupt or
   * missing metadata is equivalent to a cold start.
   *
   * @private
   * @param {string} key
   * @param {AmsCacheEntry} entry
   */
  _hydrate(key, _entry) {
    const path = this.amsPath(key);
    if (!existsSync(path)) return;
    let payload;
    try { payload = JSON.parse(readFileSync(path, 'utf8') || '{}'); }
    catch { return; }
    if (!payload || typeof payload !== 'object') return;
    // Segment ids in older snapshots are evidence-only now. Engine rebuilds
    // query-selected canonical content every turn, so hydrating these ids would
    // reintroduce raw segment bodies into prompt state.
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
