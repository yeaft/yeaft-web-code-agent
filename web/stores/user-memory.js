/**
 * user-memory.js — task-334-ui-d Pinia store for user memory entries.
 *
 * Manages client-side state for the User Memory browser.
 * Receives events from chat store WS handlers:
 *   - user_memory_snapshot  → applySnapshot
 *   - user_memory_updated   → applyUpdate
 *   - user_memory_removed   → applyRemoval
 */

const { defineStore } = Pinia;

export const useUserMemoryStore = defineStore('userMemory', {
  state: () => ({
    /** @type {Record<string, object>} id → entry */
    entries: {},
    /** @type {string[]} ordered ids (newest first) */
    order: [],
    loading: false,
    lastSnapshotAt: null,
    /** @type {Record<string, { type: string, ts: number }>} requestId → pending op */
    pendingRequests: {},
  }),

  getters: {
    /** Flat ordered list */
    entryList(state) {
      return state.order
        .map(id => state.entries[id])
        .filter(Boolean);
    },
    /** Group by shard → { [shard]: entry[] } */
    byShard(state) {
      const groups = {};
      for (const id of state.order) {
        const e = state.entries[id];
        if (!e) continue;
        const s = e.shard || 'general';
        (groups[s] || (groups[s] = [])).push(e);
      }
      return groups;
    },
    /** Unique shard names */
    shardNames() {
      const set = new Set();
      for (const id of this.order) {
        const e = this.entries[id];
        if (e) set.add(e.shard || 'general');
      }
      return [...set].sort();
    },
    entryCount(state) {
      return state.order.length;
    },
  },

  actions: {
    /** Replace all entries (full snapshot from server) */
    applySnapshot(entries) {
      if (!Array.isArray(entries)) return;
      const map = {};
      const ids = [];
      for (const e of entries) {
        if (!e || !e.id) continue;
        map[e.id] = e;
        ids.push(e.id);
      }
      this.entries = map;
      this.order = ids;
      this.lastSnapshotAt = Date.now();
    },

    /** Upsert a single entry from user_memory_updated event */
    applyUpdate(event) {
      if (!event || !event.entryId) return;
      // Skip deferred / noop (334l stub compat)
      if (event.reason === 'deferred' || event.reason === 'noop') {
        this._clearPending(event.requestId);
        return;
      }
      // If pending flag is set, skip (still processing)
      if (event.pending) {
        this._clearPending(event.requestId);
        return;
      }
      const id = event.entryId;
      const existing = this.entries[id];
      const entry = {
        ...(existing || {}),
        id,
        body: event.text ?? event.body ?? existing?.body ?? '',
        shard: event.shard ?? existing?.shard ?? 'general',
        tags: event.tags ?? existing?.tags ?? [],
        pinned: event.pinned ?? existing?.pinned ?? false,
        kind: event.kind ?? existing?.kind ?? '',
        authoredBy: event.authoredBy ?? existing?.authoredBy ?? '',
        updatedAt: event.updatedAt ?? new Date().toISOString(),
      };
      this.entries[id] = entry;
      if (!this.order.includes(id)) {
        this.order.unshift(id);
      }
      this._clearPending(event.requestId);
    },

    /** Remove an entry (from user_memory_removed event or optimistic delete) */
    applyRemoval(event) {
      if (!event || !event.entryId) return;
      const id = event.entryId;
      delete this.entries[id];
      this.order = this.order.filter(oid => oid !== id);
      this._clearPending(event.requestId);
    },

    /** Toggle pinned state optimistically */
    togglePin(entryId) {
      const e = this.entries[entryId];
      if (e) e.pinned = !e.pinned;
    },

    /** Track a pending request */
    markPending(requestId, type) {
      if (requestId) {
        this.pendingRequests[requestId] = { type, ts: Date.now() };
      }
    },

    _clearPending(requestId) {
      if (requestId && this.pendingRequests[requestId]) {
        delete this.pendingRequests[requestId];
      }
    },
  },
});
