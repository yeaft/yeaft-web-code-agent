/**
 * YeaftToolStatsDrawer — slide-in drawer showing tool-call usage stats.
 *
 * Reads `yeaftToolStats` from the chat store (populated by
 * `fetchYeaftToolStats()` → `yeaft_tool_stats` WS round-trip). Two
 * views via tab toggle:
 *
 *   • "All tools" — ranked by lifetime call count (desc), compares
 *     lifetime/recent errors with expandable latency and recent reasons.
 *   • "Unused"    — built-in tools that have NEVER been called.
 *
 * Pure data renderer — refresh action calls `chatStore.fetchYeaftToolStats()`
 * which pings the agent; the response lands in store state via the
 * yeaft_tool_stats case in chat.js.
 *
 * Designed as a controlled component: parent owns `modelValue` (open
 * state). Mount it inside YeaftPage and bind a toolbar button to it.
 *
 * Note on formatters: `formatMs / formatPct / formatLastCalled` are
 * intentionally duplicated from `agent/yeaft/stats/format.js`. The
 * no-build-step frontend can't share JS modules with `agent/`; keep the
 * two definitions byte-identical when tweaking either side.
 */
export default {
  name: 'YeaftToolStatsDrawer',
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return {
      activeTab: 'all', // 'all' | 'unused'
    };
  },
  computed: {
    chatStore() {
      const useChat = window.Pinia?.useChatStore;
      return useChat ? useChat() : null;
    },
    stats() {
      return this.chatStore?.yeaftToolStats || null;
    },
    loading() {
      return !!(this.chatStore?.yeaftToolStatsLoading);
    },
    /**
     * Ranked rows for the "All tools" tab, sorted by callCount desc.
     *
     * 2026-05-16: when the snapshot is empty (fresh install / no
     * recorded calls yet) but the agent has reported its registered
     * tool list, fall back to rendering every registered tool with
     * zero counters. This matches user intent — "show me the tools,
     * with zeroes if needed" — instead of the previous behaviour
     * which rendered just an "(no tool calls recorded yet)" placeholder
     * row and made the panel feel broken.
     *
     * Tools that DO have snapshot rows take precedence over the
     * registered fallback (we don't double-render a name).
     */
    rankedRows() {
      const snap = this.stats?.snapshot || {};
      const rows = Object.entries(snap).map(([name, rec]) => ({ name, ...rec }));
      const seen = new Set(rows.map(r => r.name));
      const registered = Array.isArray(this.stats?.registered) ? this.stats.registered : [];
      for (const name of registered) {
        if (typeof name !== 'string' || !name || seen.has(name)) continue;
        rows.push({
          name,
          callCount: 0,
          errorCount: 0,
          errorRate: 0,
          avgMs: 0,
          p50Ms: 0,
          p95Ms: 0,
          lastCalledAt: null,
          lastError: null,
        });
        seen.add(name);
      }
      rows.sort((a, b) => {
        const diff = (b.callCount || 0) - (a.callCount || 0);
        if (diff !== 0) return diff;
        // Stable tie-break on name so the registered-only rows have
        // a deterministic order.
        return a.name.localeCompare(b.name);
      });
      return rows;
    },
    unusedRows() {
      return Array.isArray(this.stats?.unused) ? this.stats.unused : [];
    },
    fetchedAtLabel() {
      const t = this.stats?.fetchedAt;
      if (!t) return '';
      const d = new Date(t);
      return d.toLocaleTimeString();
    },
  },
  methods: {
    close() {
      this.$emit('update:modelValue', false);
    },
    refresh() {
      if (this.chatStore && typeof this.chatStore.fetchYeaftToolStats === 'function') {
        this.chatStore.fetchYeaftToolStats();
      }
    },
    recentReasons(row) {
      return Object.entries(row.recent?.errorReasons || {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    reasonLabel(reason) {
      const key = `yeaft.toolStats.reason.${reason}`;
      const label = this.$t?.(key);
      return label && label !== key ? label : reason;
    },
    formatMs(ms) {
      if (!Number.isFinite(ms)) return '-';
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    },
    formatPct(rate) {
      if (!Number.isFinite(rate) || rate === 0) return '0%';
      return `${(rate * 100).toFixed(1)}%`;
    },
    formatLastCalled(iso) {
      if (typeof iso !== 'string' || !iso) return 'never';
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return iso;
      const ageMs = Date.now() - t;
      if (ageMs < 60_000) return 'just now';
      if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
      if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
      return `${Math.floor(ageMs / 86_400_000)}d ago`;
    },
  },
  watch: {
    modelValue(now, prev) {
      // First open with no data → auto-fetch.
      if (now && !prev && !this.stats && !this.loading) {
        this.refresh();
      }
    },
  },
  template: `
    <div v-if="modelValue" class="tool-stats-drawer-backdrop" @click.self="close">
      <div class="tool-stats-drawer" role="dialog" :aria-label="$t ? $t('yeaft.toolStats.title') : 'Tool Usage Stats'">
        <div class="tool-stats-drawer-header">
          <h3>{{ $t ? $t('yeaft.toolStats.title') : 'Tool Usage Stats' }}</h3>
          <div class="tool-stats-drawer-actions">
            <button class="btn-icon" @click="refresh" :disabled="loading" :title="$t ? $t('yeaft.toolStats.refresh') : 'Refresh'">
              <span v-if="loading">⟳</span><span v-else>↻</span>
            </button>
            <button class="btn-icon" @click="close" :title="$t ? $t('yeaft.toolStats.close') : 'Close'">×</button>
          </div>
        </div>
        <div class="tool-stats-tabs">
          <button :class="['tool-stats-tab', activeTab === 'all' && 'active']" @click="activeTab = 'all'">
            {{ $t ? $t('yeaft.toolStats.tabAll') : 'All tools' }}
            <span class="tool-stats-tab-count" v-if="rankedRows.length">({{ rankedRows.length }})</span>
          </button>
          <button :class="['tool-stats-tab', activeTab === 'unused' && 'active']" @click="activeTab = 'unused'">
            {{ $t ? $t('yeaft.toolStats.tabUnused') : 'Unused' }}
            <span class="tool-stats-tab-count" v-if="unusedRows.length">({{ unusedRows.length }})</span>
          </button>
        </div>
        <div class="tool-stats-drawer-body">
          <div v-if="stats && stats.error" class="tool-stats-error">{{ stats.error }}</div>
          <div v-else-if="loading && !stats" class="tool-stats-loading">
            {{ $t ? $t('yeaft.toolStats.loading') : 'Loading…' }}
          </div>
          <div v-else-if="!stats" class="tool-stats-empty">
            {{ $t ? $t('yeaft.toolStats.notLoaded') : 'No data yet — click refresh.' }}
          </div>
          <template v-else>
            <!--
              2026-05-16: notice (e.g. "Agent is offline.") is shown as
              a top banner instead of replacing the entire body. This
              keeps the registered-tool fallback rows visible underneath
              so the panel still conveys "here is the catalog" even when
              the live snapshot fetch failed. Lives inside the v-else so
              the error / loading / no-data paths still own the whole
              body and don't double-render the banner + table.
            -->
            <div v-if="stats.notice" class="tool-stats-banner">{{ stats.notice }}</div>
            <div v-if="activeTab === 'all'" class="tool-stats-list">
              <p class="tool-stats-window-note">{{ $t ? $t('yeaft.toolStats.windowNote') : 'Recent: up to the last 100 calls per tool collected since this feature was enabled; not a time window. Historical totals are unchanged.' }}</p>
              <div v-if="rankedRows.length === 0" class="tool-stats-empty-row">
                {{ $t ? $t('yeaft.toolStats.empty') : '(no tool calls recorded yet)' }}
              </div>
              <details v-for="row in rankedRows" :key="row.name" class="tool-stats-entry">
                <summary>
                  <span class="tool-stats-name">{{ row.name }}</span>
                  <span class="tool-stats-comparison">
                    <span class="tool-stats-lifetime">
                      <span class="tool-stats-period">{{ $t ? $t('yeaft.toolStats.lifetime') : 'Lifetime' }}</span>
                      <strong>{{ formatPct(row.errorRate) }}</strong>
                      <span>{{ row.errorCount }} / {{ row.callCount }} {{ $t ? $t('yeaft.toolStats.errorsCalls') : 'errors / calls' }}</span>
                    </span>
                    <span class="tool-stats-recent">
                      <span class="tool-stats-period">{{ $t ? $t('yeaft.toolStats.recent') : 'Recent' }}</span>
                      <template v-if="row.recent && row.recent.callCount > 0">
                        <strong>{{ formatPct(row.recent.errorRate) }}</strong>
                        <span>{{ row.recent.errorCount }} / {{ row.recent.callCount }} {{ $t ? $t('yeaft.toolStats.errorsCalls') : 'errors / calls' }}</span>
                      </template>
                      <span v-else>{{ $t ? $t('yeaft.toolStats.noRecent') : 'No recent samples' }}</span>
                    </span>
                  </span>
                </summary>
                <div class="tool-stats-detail">
                  <div class="tool-stats-latency">
                    <span>p50 {{ formatMs(row.p50Ms) }}</span>
                    <span>p95 {{ formatMs(row.p95Ms) }}</span>
                    <span>{{ $t ? $t('yeaft.toolStats.col.avg') : 'Avg' }} {{ formatMs(row.avgMs) }}</span>
                    <span>{{ $t ? $t('yeaft.toolStats.col.last') : 'Last' }} {{ formatLastCalled(row.lastCalledAt) }}</span>
                  </div>
                  <div class="tool-stats-period">{{ $t ? $t('yeaft.toolStats.recentReasons') : 'Recent error reasons / codes' }}</div>
                  <ul v-if="recentReasons(row).length" class="tool-stats-reasons">
                    <li v-for="[reason, count] in recentReasons(row)" :key="reason"><span>{{ reasonLabel(reason) }}</span><strong>{{ count }}</strong></li>
                  </ul>
                  <p v-else class="tool-stats-reasons-empty">{{ $t ? $t(row.recent && row.recent.callCount > 0 ? 'yeaft.toolStats.noRecentErrors' : 'yeaft.toolStats.noRecent') : 'No recent error samples' }}</p>
                </div>
              </details>
            </div>
            <div v-else class="tool-stats-unused">
              <div v-if="unusedRows.length === 0" class="tool-stats-empty-row">
                {{ $t ? $t('yeaft.toolStats.noneUnused') : '(every registered tool has been called at least once)' }}
              </div>
              <ul v-else>
                <li v-for="name in unusedRows" :key="name" class="tool-stats-unused-row">{{ name }}</li>
              </ul>
            </div>
          </template>
        </div>
        <div v-if="stats && stats.fetchedAt" class="tool-stats-footer">
          {{ ($t ? $t('yeaft.toolStats.fetchedAt') : 'Fetched at') }} {{ fetchedAtLabel }}
        </div>
      </div>
    </div>
  `,
};
