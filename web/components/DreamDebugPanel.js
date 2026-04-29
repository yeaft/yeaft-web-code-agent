/**
 * DreamDebugPanel.js — DESIGN-v2 §19.1–19.3 dream pipeline debug view.
 *
 * Renders four sections, top-to-bottom:
 *   1. Status bar  — current state badge (idle/running/cooling-down),
 *                    last run timestamp, "Run dream now" button.
 *   2. Groups      — per-group rows (groupId / new count / status / actions).
 *   3. Targets     — per-merged-target rows (target / kind / sources / status).
 *   4. History     — last N completed runs (ring of 20).
 *
 * Data source: `useDreamStore()` (web/stores/dream.js). The store consumes
 * `dream_progress` events forwarded from agent/unify/dream-v2/runner.js
 * via web-bridge.
 *
 * Mounted from UnifyPage.js inside the unify-debug-panel container so it
 * sits alongside the existing per-turn debug view (toggleable).
 */

export default {
  name: 'DreamDebugPanel',
  setup() {
    const dreamStore = window.Pinia?.useDreamStore?.();
    return { dreamStore };
  },
  data() {
    return {
      expandedHistory: {},
    };
  },
  computed: {
    status() { return this.dreamStore?.status || 'idle'; },
    isRunning() { return this.dreamStore?.isRunning || false; },
    isCoolingDown() { return this.dreamStore?.isCoolingDown || false; },
    currentRun() { return this.dreamStore?.currentRun || null; },
    groupsList() { return this.dreamStore?.currentGroupsList || []; },
    targetsList() { return this.dreamStore?.currentTargetsList || []; },
    history() { return this.dreamStore?.history || []; },
    lastError() { return this.dreamStore?.lastError; },
    lastRunAt() { return this.dreamStore?.lastRunAt; },
  },
  methods: {
    triggerNow() {
      if (this.isRunning || !this.dreamStore) return;
      this.dreamStore.triggerDreamNow();
    },
    clearHistory() {
      if (!this.dreamStore) return;
      this.dreamStore.clearHistory();
      this.expandedHistory = {};
    },
    toggleHistory(idx) {
      this.expandedHistory = {
        ...this.expandedHistory,
        [idx]: !this.expandedHistory[idx],
      };
    },
    fmtTime(iso) {
      if (!iso) return '—';
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString();
      } catch { return '—'; }
    },
    fmtDuration(ms) {
      if (!Number.isFinite(ms)) return '';
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    },
    statusLabel(s) {
      // Translate phase/status enums into short human labels.
      switch (s) {
        case 'loading': return 'load';
        case 'triaging': return 'triage…';
        case 'triaged': return 'triaged';
        case 'applying': return 'apply…';
        case 'done': return 'done';
        case 'error': return 'error';
        default: return s || '';
      }
    },
    statusClass(s) {
      if (s === 'error') return 'is-error';
      if (s === 'done') return 'is-done';
      if (s === 'triaging' || s === 'applying' || s === 'loading') return 'is-running';
      return '';
    },
  },
  template: `
    <div class="dream-debug-panel">
      <div class="dream-debug-status-bar">
        <span class="dream-debug-state-badge" :class="'is-' + status">
          <span v-if="isRunning" class="dream-debug-spinner"></span>
          {{ status }}
        </span>
        <span class="dream-debug-state-meta">
          <span v-if="lastRunAt">Last: {{ fmtTime(lastRunAt) }}</span>
          <span v-else>Last: —</span>
        </span>
        <button class="dream-debug-trigger-btn"
                :disabled="isRunning"
                @click="triggerNow"
                :title="isRunning ? 'Already running' : 'Run dream now'">
          {{ isRunning ? 'Running…' : 'Run dream now' }}
        </button>
      </div>

      <div v-if="lastError" class="dream-debug-error">{{ lastError }}</div>

      <!-- Live: in-flight run -->
      <div v-if="currentRun" class="dream-debug-live">
        <div class="dream-debug-section-title">
          Current run
          <span class="dream-debug-phase">phase: {{ currentRun.phase }}</span>
          <span v-if="currentRun.manual" class="dream-debug-tag">manual</span>
        </div>

        <div v-if="groupsList.length > 0" class="dream-debug-table">
          <div class="dream-debug-table-head">
            <span>group</span><span>new</span><span>actions</span><span>status</span>
          </div>
          <div v-for="g in groupsList" :key="g.groupId" class="dream-debug-row">
            <span class="dream-debug-id">{{ g.groupId }}</span>
            <span>{{ g.newCount != null ? g.newCount : (g.new != null ? g.new : '—') }}</span>
            <span>{{ g.actions != null ? g.actions : '—' }}</span>
            <span class="dream-debug-status" :class="statusClass(g.status)">{{ statusLabel(g.status) }}</span>
          </div>
        </div>

        <div v-if="targetsList.length > 0" class="dream-debug-table">
          <div class="dream-debug-table-head">
            <span>target</span><span>kind</span><span>sources</span><span>status</span>
          </div>
          <div v-for="t in targetsList" :key="t.target" class="dream-debug-row">
            <span class="dream-debug-id">{{ t.target }}</span>
            <span>{{ t.kind || '—' }}</span>
            <span>{{ t.sources != null ? t.sources : '—' }}</span>
            <span class="dream-debug-status" :class="statusClass(t.status)">{{ statusLabel(t.status) }}</span>
          </div>
        </div>
      </div>

      <!-- History -->
      <div class="dream-debug-history">
        <div class="dream-debug-section-title">
          History
          <span class="dream-debug-count" v-if="history.length > 0">{{ history.length }}</span>
          <button v-if="history.length > 0" class="dream-debug-clear" @click="clearHistory">Clear</button>
        </div>
        <div v-if="history.length === 0" class="dream-debug-empty">No runs yet.</div>
        <div v-for="(run, idx) in history" :key="run.startedAt + '-' + idx" class="dream-debug-history-row">
          <div class="dream-debug-history-head" @click="toggleHistory(idx)">
            <svg class="dream-debug-chevron" :class="{ expanded: expandedHistory[idx] }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            <span>{{ fmtTime(run.startedAt) }}</span>
            <span class="dream-debug-tag" v-if="run.manual">manual</span>
            <span class="dream-debug-tag" v-if="run.hadError" style="color: var(--unify-error, #d32f2f)">err</span>
            <span class="dream-debug-history-stats">
              {{ run.groups?.length || 0 }} groups
              · {{ run.targets?.length || 0 }} targets
              · {{ fmtDuration(run.durationMs) }}
            </span>
          </div>
          <div v-if="expandedHistory[idx]" class="dream-debug-history-body">
            <div v-if="run.groups && run.groups.length > 0" class="dream-debug-table">
              <div class="dream-debug-table-head">
                <span>group</span><span>new</span><span>actions</span><span>status</span>
              </div>
              <div v-for="g in run.groups" :key="g.groupId" class="dream-debug-row">
                <span class="dream-debug-id">{{ g.groupId }}</span>
                <span>{{ g.new != null ? g.new : (g.newCount != null ? g.newCount : '—') }}</span>
                <span>{{ g.actions != null ? g.actions : '—' }}</span>
                <span class="dream-debug-status" :class="statusClass(g.status)">{{ statusLabel(g.status) }}</span>
              </div>
            </div>
            <div v-if="run.targets && run.targets.length > 0" class="dream-debug-table">
              <div class="dream-debug-table-head">
                <span>target</span><span>kind</span><span>sources</span><span>status</span>
              </div>
              <div v-for="t in run.targets" :key="t.target" class="dream-debug-row">
                <span class="dream-debug-id">{{ t.target }}</span>
                <span>{{ t.kind || '—' }}</span>
                <span>{{ t.sources != null ? t.sources : '—' }}</span>
                <span class="dream-debug-status" :class="statusClass(t.status)">{{ statusLabel(t.status) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
