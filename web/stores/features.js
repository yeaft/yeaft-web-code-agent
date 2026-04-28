/**
 * features.js — R6 G1a Pinia store for feature affiliation actions + summary
 * timeline cache.
 *
 * Per ruling §5 (TASTE-2 / TASTE-5): features themselves are created by VPs
 * autonomously via the `feature_create` tool — there is NO manual "Create
 * Feature" button in the UI. This store therefore exposes only the
 * affiliation / housekeeping actions:
 *
 *   - featureCrudRequest(op, payload) — relate / unrelate / kick / abort
 *   - fetchSummaryHistory(featureId, includeArchived)
 *   - applySummaryHistory(event)
 *
 * Feature list / tree state lives on chatStore (`unifyFeatures`,
 * `unifyActiveFeatureId`) — this store only owns the *outgoing-action* +
 * *summary cache* surface so VpDetailView / UnifyFeatureDetailView /
 * UnifySidebarV2 can issue the new R6 verbs without each component
 * re-implementing the WS plumbing.
 *
 * Cache keys:
 *   - summariesByFeature[featureId] = { revisions: [...], archived: [...]?, at, error }
 */

const { defineStore } = Pinia;

export const useFeaturesStore = defineStore('features', {
  state: () => ({
    /** @type {Record<string, { revisions: object[], archived: object[]|null, at: number, error: string|null }>} */
    summariesByFeature: {},
    /** Pending summary-history request set, keyed by featureId. */
    pendingSummaryFetch: {},
    /** Last completed CRUD result, surfaced as a toast hook. */
    lastCrudResult: null,
  }),

  getters: {
    summaryFor: (state) => (featureId) => {
      if (!featureId) return null;
      return state.summariesByFeature[featureId] || null;
    },
    isSummaryLoading: (state) => (featureId) => {
      return !!state.pendingSummaryFetch[featureId];
    },
  },

  actions: {
    /**
     * Issue a feature affiliation / housekeeping request over WS.
     *
     * Supported ops:
     *   - 'relate'    — link two features via relatedFeatureIds (Δ27)
     *   - 'unrelate'  — drop a relatedFeatureIds link
     *   - 'kick_vp'   — remove a VP from a feature's members (featureStore.removeMember)
     *   - 'abort_vp'  — abort a VP's in-flight engine inside a feature
     *
     * @param {string} op
     * @param {object} payload — op-specific shape; passed through to the agent.
     */
    featureCrudRequest(op, payload = {}) {
      if (!op) return;
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (!chat || typeof chat.sendWsMessage !== 'function') return;
      chat.sendWsMessage({
        type: 'unify_feature_crud',
        op,
        ...payload,
      });
    },

    /**
     * Pull the §Δ31.5 revision chain (current 10 + optional archived) for
     * a feature. Default `includeArchived: false` matches the "Show archived"
     * two-step UI affordance.
     *
     * @param {string} featureId
     * @param {boolean} [includeArchived=false]
     */
    fetchSummaryHistory(featureId, includeArchived = false) {
      if (!featureId) return;
      if (this.pendingSummaryFetch[featureId]) return;
      this.pendingSummaryFetch = { ...this.pendingSummaryFetch, [featureId]: Date.now() };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (chat && typeof chat.sendWsMessage === 'function') {
        chat.sendWsMessage({
          type: 'unify_fetch_summary_history',
          featureId,
          includeArchived: !!includeArchived,
        });
      }
    },

    /** Apply a `unify_summary_history` event from the agent. */
    applySummaryHistory(event) {
      if (!event || !event.featureId) return;
      const id = event.featureId;
      const next = { ...this.pendingSummaryFetch };
      delete next[id];
      this.pendingSummaryFetch = next;
      this.summariesByFeature = {
        ...this.summariesByFeature,
        [id]: {
          revisions: Array.isArray(event.revisions) ? event.revisions.slice() : [],
          archived: Array.isArray(event.archived) ? event.archived.slice() : null,
          at: Date.now(),
          error: event.error || null,
        },
      };
    },

    /** Apply a `unify_feature_crud_result` event from the agent. */
    applyCrudResult(event) {
      if (!event) return;
      this.lastCrudResult = {
        op: event.op || null,
        ok: !!event.ok,
        featureId: event.featureId || null,
        vpId: event.vpId || null,
        error: event.error || null,
        at: Date.now(),
      };
    },
  },
});
