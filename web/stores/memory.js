/**
 * memory.js — R6 G2 Pinia store for VP/task memory browsing.
 *
 * Per ruling §5 (TASTE-5): the system prompt's memory composition is
 * assembled in the AGENT process via recall-r6.js / shard-store.js — this
 * store is purely a UI cache for the read-only memory browser surface.
 * It does NOT feed back into prompt assembly.
 *
 * Data flow:
 *   ChatStore receives unify_memory_query_result + unify_memory_trace_result
 *   over the WS, forwards the events to applyQueryResult / applyTraceResult.
 *   Components (VpDetailView Memory tab, UnifyFeatureDetailView Feature Memory
 *   section) read entriesFor / traceFor.
 *
 * Cache key:
 *   - VP scope:    `vp:<vpId>`
 *   - Task scope:  `task:<featureId>`
 *   - Combined:    `vp:<vpId>|task:<featureId>` (rare; both filters set)
 */

const { defineStore } = Pinia;

function scopeKey(scope) {
  if (!scope) return '';
  const parts = [];
  if (scope.vpId) parts.push('vp:' + scope.vpId);
  if (scope.featureId) parts.push('task:' + scope.featureId);
  return parts.join('|');
}

export const useMemoryStore = defineStore('memory', {
  state: () => ({
    /** @type {Record<string, { entries: object[], at: number, error: string|null }>} */
    byScope: {},
    /** @type {Record<string, { entry: object|null, sourceRef: object|null, at: number, error: string|null }>} */
    traces: {},
    /** Pending request bookkeeping so a duplicate dispatch doesn't fan out. */
    pendingScopes: {},
    pendingTraces: {},
  }),

  getters: {
    entriesFor: (state) => (scope) => {
      const k = scopeKey(scope);
      const row = state.byScope[k];
      return row ? row.entries : [];
    },
    isLoading: (state) => (scope) => {
      const k = scopeKey(scope);
      return !!state.pendingScopes[k];
    },
    errorFor: (state) => (scope) => {
      const k = scopeKey(scope);
      return state.byScope[k]?.error || null;
    },
    traceFor: (state) => (entryId) => {
      return state.traces[entryId] || null;
    },
  },

  actions: {
    /**
     * Issue a unify_memory_query for the given scope. No-op if a request
     * is already in flight for the same scope.
     *
     * @param {{ vpId?: string, featureId?: string, limit?: number }} scope
     */
    queryScope(scope) {
      if (!scope || (!scope.vpId && !scope.featureId)) return;
      const k = scopeKey(scope);
      if (this.pendingScopes[k]) return;
      this.pendingScopes = { ...this.pendingScopes, [k]: Date.now() };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (chat && typeof chat.sendWsMessage === 'function') {
        chat.sendWsMessage({
          type: 'unify_memory_query',
          vpId: scope.vpId || null,
          featureId: scope.featureId || null,
          limit: scope.limit || 50,
        });
      }
    },

    /** Apply an unify_memory_query_result event. */
    applyQueryResult(event) {
      if (!event) return;
      const k = scopeKey(event.scope || {});
      const next = { ...this.pendingScopes };
      delete next[k];
      this.pendingScopes = next;
      this.byScope = {
        ...this.byScope,
        [k]: {
          entries: Array.isArray(event.entries) ? event.entries.slice() : [],
          at: Date.now(),
          error: event.error || null,
        },
      };
    },

    /**
     * Issue a unify_memory_trace for an entryId.
     * @param {string} entryId
     */
    requestTrace(entryId) {
      if (!entryId) return;
      if (this.pendingTraces[entryId]) return;
      this.pendingTraces = { ...this.pendingTraces, [entryId]: Date.now() };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (chat && typeof chat.sendWsMessage === 'function') {
        chat.sendWsMessage({ type: 'unify_memory_trace', entryId });
      }
    },

    /** Apply an unify_memory_trace_result event. */
    applyTraceResult(event) {
      if (!event || !event.entryId) return;
      const id = event.entryId;
      const next = { ...this.pendingTraces };
      delete next[id];
      this.pendingTraces = next;
      this.traces = {
        ...this.traces,
        [id]: {
          entry: event.entry || null,
          sourceRef: event.sourceRef || null,
          at: Date.now(),
          error: event.error || null,
        },
      };
    },

    /** Drop a cached scope (e.g. when the user closes the panel). */
    invalidateScope(scope) {
      const k = scopeKey(scope || {});
      if (!k) return;
      const next = { ...this.byScope };
      delete next[k];
      this.byScope = next;
    },
  },
});
