/**
 * tasks.js — R6 G1a Pinia store for task affiliation actions + summary
 * timeline cache.
 *
 * Per ruling §5 (TASTE-2 / TASTE-5): tasks themselves are created by VPs
 * autonomously via the `task_create` tool — there is NO manual "Create
 * Task" button in the UI. This store therefore exposes only the
 * affiliation / housekeeping actions:
 *
 *   - taskCrudRequest(op, payload) — relate / unrelate / kick / abort
 *   - fetchSummaryHistory(taskId, includeArchived)
 *   - applySummaryHistory(event)
 *
 * Task list / tree state lives on chatStore (`unifyTasks`,
 * `unifyActiveTaskId`) — this store only owns the *outgoing-action* +
 * *summary cache* surface so VpDetailView / UnifyTaskDetailView /
 * UnifySidebarV2 can issue the new R6 verbs without each component
 * re-implementing the WS plumbing.
 *
 * Cache keys:
 *   - summariesByTask[taskId] = { revisions: [...], archived: [...]?, at, error }
 */

const { defineStore } = Pinia;

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    /** @type {Record<string, { revisions: object[], archived: object[]|null, at: number, error: string|null }>} */
    summariesByTask: {},
    /** Pending summary-history request set, keyed by taskId. */
    pendingSummaryFetch: {},
    /** Last completed CRUD result, surfaced as a toast hook. */
    lastCrudResult: null,
  }),

  getters: {
    summaryFor: (state) => (taskId) => {
      if (!taskId) return null;
      return state.summariesByTask[taskId] || null;
    },
    isSummaryLoading: (state) => (taskId) => {
      return !!state.pendingSummaryFetch[taskId];
    },
  },

  actions: {
    /**
     * Issue a task affiliation / housekeeping request over WS.
     *
     * Supported ops:
     *   - 'relate'    — link two tasks via relatedTaskIds (Δ27)
     *   - 'unrelate'  — drop a relatedTaskIds link
     *   - 'kick_vp'   — remove a VP from a task's members (taskStore.removeMember)
     *   - 'abort_vp'  — abort a VP's in-flight engine inside a task
     *
     * @param {string} op
     * @param {object} payload — op-specific shape; passed through to the agent.
     */
    taskCrudRequest(op, payload = {}) {
      if (!op) return;
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (!chat || typeof chat.sendWsMessage !== 'function') return;
      chat.sendWsMessage({
        type: 'unify_task_crud',
        op,
        ...payload,
      });
    },

    /**
     * Pull the §Δ31.5 revision chain (current 10 + optional archived) for
     * a task. Default `includeArchived: false` matches the "Show archived"
     * two-step UI affordance.
     *
     * @param {string} taskId
     * @param {boolean} [includeArchived=false]
     */
    fetchSummaryHistory(taskId, includeArchived = false) {
      if (!taskId) return;
      if (this.pendingSummaryFetch[taskId]) return;
      this.pendingSummaryFetch = { ...this.pendingSummaryFetch, [taskId]: Date.now() };
      const chat = (window.Pinia && window.Pinia.useChatStore)
        ? window.Pinia.useChatStore()
        : null;
      if (chat && typeof chat.sendWsMessage === 'function') {
        chat.sendWsMessage({
          type: 'unify_fetch_summary_history',
          taskId,
          includeArchived: !!includeArchived,
        });
      }
    },

    /** Apply a `unify_summary_history` event from the agent. */
    applySummaryHistory(event) {
      if (!event || !event.taskId) return;
      const id = event.taskId;
      const next = { ...this.pendingSummaryFetch };
      delete next[id];
      this.pendingSummaryFetch = next;
      this.summariesByTask = {
        ...this.summariesByTask,
        [id]: {
          revisions: Array.isArray(event.revisions) ? event.revisions.slice() : [],
          archived: Array.isArray(event.archived) ? event.archived.slice() : null,
          at: Date.now(),
          error: event.error || null,
        },
      };
    },

    /** Apply a `unify_task_crud_result` event from the agent. */
    applyCrudResult(event) {
      if (!event) return;
      this.lastCrudResult = {
        op: event.op || null,
        ok: !!event.ok,
        taskId: event.taskId || null,
        vpId: event.vpId || null,
        error: event.error || null,
        at: Date.now(),
      };
    },
  },
});
