/**
 * dream.js — Dream pipeline debug store. DESIGN-v2 §19.1–19.4.
 *
 * Receives `dream_progress` events that the agent's dream-v2 runner emits
 * (agent/unify/dream-v2/runner.js → web-bridge.js installUnifyRuntimeBridge
 * → unify_output { event: { type: 'dream_progress', ...} }).
 *
 * State model:
 *
 *   - status: 'idle' | 'running' | 'cooling-down'
 *     'cooling-down' is a transient state immediately after a run finishes;
 *     the UI uses it to show a green flash before settling back to 'idle'.
 *
 *   - currentRun: live state of the in-flight dream pass (null when idle).
 *     {
 *       startedAt: ISO,
 *       manual: boolean,
 *       phase: 'start'|'load-diff'|'triage'|'merge'|'apply'|'done',
 *       groups: { [groupId]: { newCount, segments?, actions?, status, reason?, error? } },
 *       targets: { [target]: { kind, sources, status, error?, action? } },
 *     }
 *
 *   - history: ring of finished runs, last N first (DEFAULT_HISTORY_CAP=20).
 *
 *   - lastError: surfaced from any phase=*, status='error' event for the
 *     status bar.
 *
 * The runner emits these phase events (see runner.js for the source):
 *   { phase:'start', manual, ts }
 *   { phase:'load-diff', groupId }
 *   { phase:'triage', groupId, status:'running'|'done'|'error', segments?, actions?, error? }
 *   { phase:'merge', targets }
 *   { phase:'apply', target, status:'running'|'done'|'error', action?, error? }
 *   { phase:'done', durationMs, groups[], targets[], pruned }
 *
 * This store is read by `<DreamDebugPanel>` (web/components/DreamDebugPanel.js).
 * Tests live in test/web/dream-store.test.js.
 */

const { defineStore } = Pinia;

/** History ring size — last N completed runs kept in memory. */
export const DEFAULT_HISTORY_CAP = 20;

/** Auto-clear cooling-down → idle after this many ms. */
const COOLING_DOWN_MS = 2500;

export const useDreamStore = defineStore('dream', {
  state: () => ({
    /** @type {'idle'|'running'|'cooling-down'} */
    status: 'idle',
    /** @type {null | {
     *   startedAt: string,
     *   manual: boolean,
     *   phase: string,
     *   groups: Record<string, object>,
     *   targets: Record<string, object>,
     * }} */
    currentRun: null,
    /** @type {Array<object>} most-recent first */
    history: [],
    /** @type {null | string} */
    lastError: null,
    /** @type {null | string} ISO timestamp of last successful run */
    lastRunAt: null,
    /** @type {null | string} ISO timestamp of next scheduled run (set by schedule_tick events; optional) */
    nextRunAt: null,
    /** Internal: cooling-down timer id (number from setTimeout). */
    _coolingTimerId: null,
  }),

  getters: {
    isRunning: (s) => s.status === 'running',
    isCoolingDown: (s) => s.status === 'cooling-down',

    /** Groups list for the live run, sorted by groupId. */
    currentGroupsList: (s) => {
      if (!s.currentRun) return [];
      return Object.entries(s.currentRun.groups)
        .map(([groupId, g]) => ({ groupId, ...g }))
        .sort((a, b) => a.groupId.localeCompare(b.groupId));
    },

    /** Targets list for the live run, sorted by target. */
    currentTargetsList: (s) => {
      if (!s.currentRun) return [];
      return Object.entries(s.currentRun.targets)
        .map(([target, t]) => ({ target, ...t }))
        .sort((a, b) => a.target.localeCompare(b.target));
    },
  },

  actions: {
    /**
     * Apply one `dream_progress` event from the agent. Pure dispatcher;
     * branches by `phase`. Always safe — unknown phases become no-ops so
     * the agent can add new event kinds without breaking the UI.
     *
     * @param {object} evt
     */
    applyProgress(evt) {
      if (!evt || typeof evt !== 'object') return;
      const phase = evt.phase;
      switch (phase) {
        case 'start': return this._onStart(evt);
        case 'load-diff': return this._onLoadDiff(evt);
        case 'triage': return this._onTriage(evt);
        case 'merge': return this._onMerge(evt);
        case 'apply': return this._onApply(evt);
        case 'done': return this._onDone(evt);
        default: return; // unknown — ignore
      }
    },

    _onStart(evt) {
      // Cancel any pending cooling-down → idle transition.
      if (this._coolingTimerId) {
        clearTimeout(this._coolingTimerId);
        this._coolingTimerId = null;
      }
      this.status = 'running';
      this.lastError = null;
      this.currentRun = {
        startedAt: evt.ts || new Date().toISOString(),
        manual: !!evt.manual,
        phase: 'start',
        groups: {},
        targets: {},
      };
    },

    _onLoadDiff(evt) {
      if (!this.currentRun || !evt.groupId) return;
      this.currentRun.phase = 'load-diff';
      const prev = this.currentRun.groups[evt.groupId] || {};
      this.currentRun.groups = {
        ...this.currentRun.groups,
        [evt.groupId]: { ...prev, status: 'loading' },
      };
    },

    _onTriage(evt) {
      if (!this.currentRun || !evt.groupId) return;
      this.currentRun.phase = 'triage';
      const prev = this.currentRun.groups[evt.groupId] || {};
      const next = { ...prev };
      if (evt.status === 'running') {
        next.status = 'triaging';
        if (Number.isFinite(evt.segments)) next.segments = evt.segments;
      } else if (evt.status === 'done') {
        next.status = 'triaged';
        if (Number.isFinite(evt.actions)) next.actions = evt.actions;
      } else if (evt.status === 'error') {
        next.status = 'error';
        next.error = evt.error || 'triage failed';
        this.lastError = `triage[${evt.groupId}]: ${next.error}`;
      }
      this.currentRun.groups = {
        ...this.currentRun.groups,
        [evt.groupId]: next,
      };
    },

    _onMerge(evt) {
      if (!this.currentRun) return;
      this.currentRun.phase = 'merge';
      // evt.targets is the count, not the list — list comes via apply events.
    },

    _onApply(evt) {
      if (!this.currentRun || !evt.target) return;
      this.currentRun.phase = 'apply';
      const prev = this.currentRun.targets[evt.target] || {};
      const next = { ...prev };
      if (evt.kind) next.kind = evt.kind;
      if (Number.isFinite(evt.sources)) next.sources = evt.sources;
      if (evt.status === 'running') next.status = 'applying';
      else if (evt.status === 'done') {
        next.status = 'done';
        if (evt.action) next.action = evt.action;
      } else if (evt.status === 'error') {
        next.status = 'error';
        next.error = evt.error || 'apply failed';
        this.lastError = `apply[${evt.target}]: ${next.error}`;
      }
      this.currentRun.targets = {
        ...this.currentRun.targets,
        [evt.target]: next,
      };
    },

    _onDone(evt) {
      if (!this.currentRun) {
        // Defensive — runner emitted 'done' without 'start'. Synthesise a stub.
        this.currentRun = {
          startedAt: new Date().toISOString(),
          manual: false,
          phase: 'done',
          groups: {},
          targets: {},
        };
      }
      this.currentRun.phase = 'done';
      const finalRun = {
        startedAt: this.currentRun.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Number.isFinite(evt.durationMs) ? evt.durationMs : null,
        manual: this.currentRun.manual,
        groups: Array.isArray(evt.groups) ? evt.groups
          : Object.entries(this.currentRun.groups).map(([gid, g]) => ({ groupId: gid, ...g })),
        targets: Array.isArray(evt.targets) ? evt.targets
          : Object.entries(this.currentRun.targets).map(([t, tv]) => ({ target: t, ...tv })),
        pruned: Number.isFinite(evt.pruned) ? evt.pruned : 0,
        hadError: !!this.lastError,
      };
      this.history = [finalRun, ...this.history].slice(0, DEFAULT_HISTORY_CAP);
      this.lastRunAt = finalRun.finishedAt;
      this.currentRun = null;

      // Brief cooling-down flash, then idle.
      this.status = 'cooling-down';
      if (this._coolingTimerId) clearTimeout(this._coolingTimerId);
      this._coolingTimerId = setTimeout(() => {
        // Guard: don't overwrite if a new run started in the meantime.
        if (this.status === 'cooling-down') this.status = 'idle';
        this._coolingTimerId = null;
      }, COOLING_DOWN_MS);
      // Allow Node test runners to exit. Browser timers ignore unref().
      if (typeof this._coolingTimerId === 'object' && this._coolingTimerId
          && typeof this._coolingTimerId.unref === 'function') {
        this._coolingTimerId.unref();
      }
    },

    /**
     * Manually trigger a dream pass via WebSocket.
     * Mirrors the existing per-VP `triggerDream()` in vp.js but for the
     * runner-level "Run dream now" button in the debug panel.
     */
    triggerDreamNow() {
      const chat = window.Pinia?.useChatStore?.();
      if (!chat || typeof chat.sendWsMessage !== 'function') return;
      chat.sendWsMessage({ type: 'unify_dream_trigger' });
    },

    /**
     * Reset history (debug panel "Clear history" button).
     */
    clearHistory() {
      this.history = [];
    },

    /**
     * Test seam: clear cooling-down timer so test runners aren't blocked.
     */
    _clearCoolingTimer() {
      if (this._coolingTimerId) {
        clearTimeout(this._coolingTimerId);
        this._coolingTimerId = null;
      }
      if (this.status === 'cooling-down') this.status = 'idle';
    },
  },
});
