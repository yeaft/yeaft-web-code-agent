/**
 * UnifyToolStatsDrawer — slide-in drawer showing tool-call usage stats.
 *
 * Reads `unifyToolStats` from the chat store (populated by
 * `fetchUnifyToolStats()` → `unify_tool_stats` WS round-trip). Two
 * views via tab toggle:
 *
 *   • "All tools" — table ranked by call count (desc), shows
 *     calls / errors / p50 / p95 / last-called.
 *   • "Unused"    — built-in tools that have NEVER been called.
 *
 * Pure data renderer — refresh action calls `chatStore.fetchUnifyToolStats()`
 * which pings the agent; the response lands in store state via the
 * unify_tool_stats case in chat.js.
 *
 * Designed as a controlled component: parent owns `modelValue` (open
 * state). Mount it inside UnifyPage and bind a toolbar button to it.
 *
 * Note on formatters: `formatMs / formatPct / formatLastCalled` are
 * intentionally duplicated from `agent/unify/stats/format.js`. The
 * no-build-step frontend can't share JS modules with `agent/`; keep the
 * two definitions byte-identical when tweaking either side.
 */
export default {
  name: 'UnifyToolStatsDrawer',
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
      return this.chatStore?.unifyToolStats || null;
    },
    loading() {
      return !!(this.chatStore?.unifyToolStatsLoading);
    },
    /**
     * Ranked rows for the "All tools" tab, sorted by callCount desc.
     */
    rankedRows() {
      const snap = this.stats?.snapshot || {};
      const rows = Object.entries(snap).map(([name, rec]) => ({ name, ...rec }));
      rows.sort((a, b) => (b.callCount || 0) - (a.callCount || 0));
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
      if (this.chatStore && typeof this.chatStore.fetchUnifyToolStats === 'function') {
        this.chatStore.fetchUnifyToolStats();
      }
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
      <div class="tool-stats-drawer" role="dialog" aria-label="Tool usage statistics">
        <div class="tool-stats-drawer-header">
          <h3>{{ $t ? $t('unify.toolStats.title') : 'Tool Usage Stats' }}</h3>
          <div class="tool-stats-drawer-actions">
            <button class="btn-icon" @click="refresh" :disabled="loading" :title="$t ? $t('unify.toolStats.refresh') : 'Refresh'">
              <span v-if="loading">⟳</span><span v-else>↻</span>
            </button>
            <button class="btn-icon" @click="close" :title="$t ? $t('unify.toolStats.close') : 'Close'">×</button>
          </div>
        </div>
        <div class="tool-stats-tabs">
          <button :class="['tool-stats-tab', activeTab === 'all' && 'active']" @click="activeTab = 'all'">
            {{ $t ? $t('unify.toolStats.tabAll') : 'All tools' }}
            <span class="tool-stats-tab-count" v-if="rankedRows.length">({{ rankedRows.length }})</span>
          </button>
          <button :class="['tool-stats-tab', activeTab === 'unused' && 'active']" @click="activeTab = 'unused'">
            {{ $t ? $t('unify.toolStats.tabUnused') : 'Unused' }}
            <span class="tool-stats-tab-count" v-if="unusedRows.length">({{ unusedRows.length }})</span>
          </button>
        </div>
        <div class="tool-stats-drawer-body">
          <div v-if="stats && stats.error" class="tool-stats-error">{{ stats.error }}</div>
          <div v-else-if="loading && !stats" class="tool-stats-loading">
            {{ $t ? $t('unify.toolStats.loading') : 'Loading…' }}
          </div>
          <div v-else-if="!stats" class="tool-stats-empty">
            {{ $t ? $t('unify.toolStats.notLoaded') : 'No data yet — click refresh.' }}
          </div>
          <template v-else>
            <table v-if="activeTab === 'all'" class="tool-stats-table">
              <thead>
                <tr>
                  <th>{{ $t ? $t('unify.toolStats.col.name') : 'Tool' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.calls') : 'Calls' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.errors') : 'Errors' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.errRate') : 'Err%' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.p50') : 'p50' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.p95') : 'p95' }}</th>
                  <th class="num">{{ $t ? $t('unify.toolStats.col.avg') : 'Avg' }}</th>
                  <th>{{ $t ? $t('unify.toolStats.col.last') : 'Last' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="rankedRows.length === 0">
                  <td colspan="8" class="tool-stats-empty-row">
                    {{ $t ? $t('unify.toolStats.empty') : '(no tool calls recorded yet)' }}
                  </td>
                </tr>
                <tr v-for="row in rankedRows" :key="row.name">
                  <td class="tool-stats-name">{{ row.name }}</td>
                  <td class="num">{{ row.callCount }}</td>
                  <td class="num">{{ row.errorCount }}</td>
                  <td class="num">{{ formatPct(row.errorRate) }}</td>
                  <td class="num">{{ formatMs(row.p50Ms) }}</td>
                  <td class="num">{{ formatMs(row.p95Ms) }}</td>
                  <td class="num">{{ formatMs(row.avgMs) }}</td>
                  <td class="tool-stats-last">{{ formatLastCalled(row.lastCalledAt) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="tool-stats-unused">
              <div v-if="unusedRows.length === 0" class="tool-stats-empty-row">
                {{ $t ? $t('unify.toolStats.noneUnused') : '(every registered tool has been called at least once)' }}
              </div>
              <ul v-else>
                <li v-for="name in unusedRows" :key="name" class="tool-stats-unused-row">{{ name }}</li>
              </ul>
            </div>
          </template>
        </div>
        <div v-if="stats && stats.fetchedAt" class="tool-stats-footer">
          {{ ($t ? $t('unify.toolStats.fetchedAt') : 'Fetched at') }} {{ fetchedAtLabel }}
        </div>
      </div>
    </div>
  `,
};
