import { useAuthStore } from '../stores/auth.js';

const PAGE_SIZE = 20;

export default {
  name: 'DashboardTab',
  template: `
    <div class="db-container">
      <div v-if="loading && !loaded" class="db-loading">{{ $t('settings.dashboard.loading') }}</div>
      <div v-else-if="error" class="db-empty">{{ $t('settings.dashboard.error') }}</div>

      <template v-else>
        <!-- General -->
        <section class="db-section db-general-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.general') }}</div>
            <button class="db-refresh-btn" :class="{ 'is-loading': loading }" @click="refreshAll" :disabled="loading" :title="$t('settings.dashboard.refresh')">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 7.99 7.99 7.99c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </div>
          <div class="db-general-row">
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.totalUsers') }}</span>
              <strong>{{ overview.totalUsers }}</strong>
            </div>
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.activeUsers') }}</span>
              <strong :class="{ 'is-active': overview.onlineUsers > 0 }">{{ overview.onlineUsers }}</strong>
            </div>
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.onlineAgents') }}</span>
              <strong :class="{ 'is-active': overview.onlineAgents > 0 }">{{ overview.onlineAgents }}</strong>
            </div>
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.todayUserTurns') }}</span>
              <strong>{{ formatNumber(overview.todayMessages) }}</strong>
            </div>
            <div class="db-general-item" :title="$t('settings.dashboard.tokenAccuracy')">
              <span class="db-general-label">{{ $t('settings.dashboard.totalTokens') }}</span>
              <strong>{{ formatCompactNumber(overview.totalTokens) }}</strong>
            </div>
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.agentTurns') }}</span>
              <strong>{{ formatNumber(agentMetricTotals.totalTurns) }}</strong>
            </div>
            <div class="db-general-item">
              <span class="db-general-label">{{ $t('settings.dashboard.agentSessions') }}</span>
              <strong>{{ formatNumber(agentMetricTotals.sessionsCreated) }}</strong>
            </div>
          </div>
        </section>

        <!-- Detailed -->
        <section class="db-section db-detail-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.detailed') }}</div>
          </div>
          <div class="db-detail-tabs" role="tablist" :aria-label="$t('settings.dashboard.detailed')">
            <button type="button" class="db-detail-tab" id="dashboard-detail-tab-users" aria-controls="dashboard-detail-panel-users" :class="{ 'is-active': detailDimension === 'users' }" role="tab" :aria-selected="detailDimension === 'users'" @click="detailDimension = 'users'">
              {{ $t('settings.dashboard.users') }}
            </button>
            <button type="button" class="db-detail-tab" id="dashboard-detail-tab-agents" aria-controls="dashboard-detail-panel-agents" :class="{ 'is-active': detailDimension === 'agents' }" role="tab" :aria-selected="detailDimension === 'agents'" @click="detailDimension = 'agents'">
              {{ $t('settings.dashboard.agents') }}
            </button>
          </div>

          <!-- Users -->
          <div v-if="detailDimension === 'users'" id="dashboard-detail-panel-users" class="db-detail-panel" role="tabpanel" aria-labelledby="dashboard-detail-tab-users">
            <div class="db-filter-header">
              <div class="db-filter-group">
                <span class="db-filter-label">{{ $t('settings.dashboard.time') }}</span>
                <button v-for="p in periods" :key="p.value" type="button" class="db-period-tab" :class="{ 'is-active': statsPeriod === p.value }" @click="switchPeriod(p.value)">
                  {{ p.label }}
                </button>
              </div>
              <label class="db-filter-select">
                <span class="db-filter-label">{{ $t('settings.dashboard.active') }}</span>
                <select v-model="userActivityFilter" @change="userVisibleCount = PAGE_SIZE">
                  <option value="all">{{ $t('settings.dashboard.all') }}</option>
                  <option value="active">{{ $t('settings.dashboard.activeOnly') }}</option>
                  <option value="inactive">{{ $t('settings.dashboard.inactiveOnly') }}</option>
                </select>
              </label>
            </div>

            <div class="db-table-wrap">
              <table class="db-table">
                <thead>
                  <tr>
                    <th class="db-th-sort" @click="toggleSort('user', 'username')">
                      {{ $t('settings.dashboard.name') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'username'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'messageCount')">
                      {{ $t('settings.dashboard.userTurns') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'messageCount'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('user', 'active')">
                      {{ $t('settings.dashboard.active') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'active'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'requestCount')">
                      {{ $t('settings.dashboard.requests') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'requestCount'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" :title="$t('settings.dashboard.tokenAccuracy')" @click="toggleSort('user', 'totalTokens')">
                      {{ $t('settings.dashboard.tokens') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'totalTokens'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'traffic')">
                      {{ $t('settings.dashboard.traffic') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'traffic'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('user', 'lastTurnCompletedAt')">
                      {{ $t('settings.dashboard.lastTurnCompleted') }}
                      <span class="db-sort-arrow" v-if="userSort.field === 'lastTurnCompletedAt'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="user in pagedUserStats" :key="user.userId || user.username">
                    <td class="db-cell-name">{{ user.username }}</td>
                    <td class="db-cell-num">{{ formatNumber(user.messageCount) }}</td>
                    <td>
                      <span class="db-status-dot" :class="user.active ? 'online' : 'offline'"></span>
                      {{ user.active ? $t('settings.dashboard.active') : $t('settings.dashboard.inactive') }}
                    </td>
                    <td class="db-cell-num">{{ formatNumber(user.requestCount) }}</td>
                    <td class="db-cell-num" :title="userTokenTitle(user)">{{ formatCompactNumber(user.totalTokens) }}</td>
                    <td class="db-cell-num">{{ formatBytes(user.bytesSent + user.bytesReceived) }}</td>
                    <td class="db-cell-time">{{ formatRelativeTime(user.lastTurnCompletedAt) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="filteredUserStats.length === 0" class="db-empty">{{ $t('settings.dashboard.noUserData') }}</div>
              <button v-if="userVisibleCount < sortedUserStats.length" class="db-load-more" @click="userVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedUserStats.length - userVisibleCount }) }}
              </button>
            </div>

            <div class="db-card-list">
              <div class="db-user-card" v-for="user in pagedUserStats" :key="'m-' + (user.userId || user.username)">
                <div class="db-user-card-name">
                  <span class="db-status-dot" :class="user.active ? 'online' : 'offline'"></span>
                  {{ user.username }}
                  <span class="db-user-active-label">{{ user.active ? $t('settings.dashboard.active') : $t('settings.dashboard.inactive') }}</span>
                </div>
                <div class="db-user-card-stats">
                  <span>{{ $t('settings.dashboard.userTurns') }} {{ formatNumber(user.messageCount) }}</span>
                  <span>·</span>
                  <span>{{ $t('settings.dashboard.requests') }} {{ formatNumber(user.requestCount) }}</span>
                  <span>·</span>
                  <span :title="userTokenTitle(user)">{{ $t('settings.dashboard.tokens') }} {{ formatCompactNumber(user.totalTokens) }}</span>
                  <span>·</span>
                  <span>{{ formatBytes(user.bytesSent + user.bytesReceived) }}</span>
                </div>
                <div class="db-user-card-meta">{{ $t('settings.dashboard.lastTurnCompleted') }}: {{ formatRelativeTime(user.lastTurnCompletedAt) }}</div>
              </div>
              <div v-if="filteredUserStats.length === 0" class="db-empty">{{ $t('settings.dashboard.noUserData') }}</div>
              <button v-if="userVisibleCount < sortedUserStats.length" class="db-load-more" @click="userVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedUserStats.length - userVisibleCount }) }}
              </button>
            </div>
          </div>

          <!-- Agents -->
          <div v-else id="dashboard-detail-panel-agents" class="db-detail-panel" role="tabpanel" aria-labelledby="dashboard-detail-tab-agents">
            <div class="db-filter-header">
              <div class="db-filter-group">
                <span class="db-filter-label">{{ $t('settings.dashboard.time') }}</span>
                <button v-for="p in agentPeriods" :key="p.value" type="button" class="db-period-tab" :class="{ 'is-active': agentTimeFilter === p.value }" @click="switchAgentTime(p.value)">
                  {{ p.label }}
                </button>
              </div>
              <label class="db-filter-select">
                <span class="db-filter-label">{{ $t('settings.dashboard.active') }}</span>
                <select v-model="agentActivityFilter" @change="agentVisibleCount = PAGE_SIZE">
                  <option value="all">{{ $t('settings.dashboard.all') }}</option>
                  <option value="active">{{ $t('settings.dashboard.activeOnly') }}</option>
                  <option value="inactive">{{ $t('settings.dashboard.inactiveOnly') }}</option>
                </select>
              </label>
            </div>

            <div class="db-table-wrap">
              <table class="db-table">
                <thead>
                  <tr>
                    <th class="db-th-sort" @click="toggleSort('agent', 'name')">
                      {{ $t('settings.dashboard.name') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'name'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('agent', 'online')">
                      {{ $t('settings.dashboard.status') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'online'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('agent', 'latency')">
                      {{ $t('settings.dashboard.latency') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'latency'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('agent', 'version')">
                      {{ $t('settings.dashboard.version') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'version'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('agent', 'owner')">
                      {{ $t('settings.dashboard.owner') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'owner'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('agent', 'totalTurns')">
                      {{ $t('settings.dashboard.turns') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'totalTurns'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-cell-num db-th-sort" @click="toggleSort('agent', 'totalTokens')">
                      {{ $t('settings.dashboard.tokens') }}
                      <span class="db-sort-arrow" v-if="agentSort.field === 'totalTokens'">{{ agentSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="agent in pagedAgents" :key="agent.id || agent.name">
                    <td class="db-cell-name">{{ agent.name }}</td>
                    <td>
                      <span class="db-status-dot" :class="agent.online ? 'online' : 'offline'"></span>
                      {{ agent.online ? $t('settings.dashboard.online') : $t('settings.dashboard.offline') }}
                    </td>
                    <td class="db-cell-num">
                      <span v-if="agent.online" :class="latencyClass(agent.latency)">{{ agent.latency }}ms</span>
                      <span v-else class="db-cell-time">—</span>
                    </td>
                    <td>{{ agent.version || '—' }}</td>
                    <td>{{ agent.ownerUsername || agent.owner || '—' }}</td>
                    <td class="db-cell-num">{{ formatNumber(agent.metrics?.totalTurns || 0) }}</td>
                    <td class="db-cell-num" :title="agentTokenTitle(agent)">{{ formatCompactNumber(agent.metrics?.totalTokens || 0) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="filteredAgents.length === 0" class="db-empty">{{ $t('settings.dashboard.noAgents') }}</div>
              <button v-if="agentVisibleCount < sortedAgents.length" class="db-load-more" @click="agentVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedAgents.length - agentVisibleCount }) }}
              </button>
            </div>

            <div class="db-card-list">
              <div class="db-agent-card" v-for="agent in pagedAgents" :key="'m-' + (agent.id || agent.name)">
                <div class="db-agent-card-name">
                  <span class="db-status-dot" :class="agent.online ? 'online' : 'offline'"></span>
                  {{ agent.name }}
                </div>
                <div class="db-agent-card-stats" v-if="agent.online">
                  <span>{{ $t('settings.dashboard.latency') }} <span :class="latencyClass(agent.latency)">{{ agent.latency }}ms</span></span>
                  <span>·</span>
                  <span>v{{ agent.version || '?' }}</span>
                </div>
                <div class="db-agent-card-stats">
                  <span>{{ $t('settings.dashboard.turns') }} {{ formatNumber(agent.metrics?.totalTurns || 0) }}</span>
                  <span>·</span>
                  <span>{{ $t('settings.dashboard.tokens') }} {{ formatCompactNumber(agent.metrics?.totalTokens || 0) }}</span>
                </div>
                <div class="db-agent-card-meta">{{ $t('settings.dashboard.owner') }}: {{ agent.ownerUsername || agent.owner || '—' }}</div>
              </div>
              <div v-if="filteredAgents.length === 0" class="db-empty">{{ $t('settings.dashboard.noAgents') }}</div>
              <button v-if="agentVisibleCount < sortedAgents.length" class="db-load-more" @click="agentVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedAgents.length - agentVisibleCount }) }}
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>
  `,
  data() {
    return {
      loading: false,
      loaded: false,
      error: false,
      overview: { totalUsers: 0, onlineUsers: 0, onlineAgents: 0, todayMessages: 0, totalTokens: 0, agentMetrics: null },
      detailDimension: 'users',
      statsPeriod: 'today',
      userActivityFilter: 'all',
      agentTimeFilter: 'today',
      agentActivityFilter: 'all',
      userStats: [],
      agents: [],
      userSort: { field: null, order: 'asc' },
      agentSort: { field: null, order: 'asc' },
      userVisibleCount: PAGE_SIZE,
      agentVisibleCount: PAGE_SIZE
    };
  },
  mounted() {
    this.fetchAll();
  },
  computed: {
    periods() {
      return [
        { value: 'today', label: this.$t('settings.dashboard.today') },
        { value: 'week', label: this.$t('settings.dashboard.thisWeek') },
        { value: 'month', label: this.$t('settings.dashboard.thisMonth') },
        { value: 'all', label: this.$t('settings.dashboard.all') }
      ];
    },
    agentPeriods() {
      return this.periods;
    },
    filteredUserStats() {
      if (this.userActivityFilter === 'active') return this.userStats.filter(user => user.active);
      if (this.userActivityFilter === 'inactive') return this.userStats.filter(user => !user.active);
      return this.userStats;
    },
    sortedUserStats() {
      if (!this.userSort.field) return this.filteredUserStats;
      return this.sortArray(this.filteredUserStats, this.userSort.field, this.userSort.order, 'user');
    },
    pagedUserStats() {
      return this.sortedUserStats.slice(0, this.userVisibleCount);
    },
    agentMetricTotals() {
      return this.normalizeMetrics(this.overview.agentMetrics || {});
    },
    filteredAgents() {
      return this.agents.filter(agent => {
        if (this.agentActivityFilter === 'active' && !agent.online) return false;
        if (this.agentActivityFilter === 'inactive' && agent.online) return false;
        return this.isWithinPeriod(agent.lastSeenAt, this.agentTimeFilter);
      });
    },
    sortedAgents() {
      if (!this.agentSort.field) return this.filteredAgents;
      return this.sortArray(this.filteredAgents, this.agentSort.field, this.agentSort.order, 'agent');
    },
    pagedAgents() {
      return this.sortedAgents.slice(0, this.agentVisibleCount);
    }
  },
  methods: {
    getHeaders() {
      const authStore = useAuthStore();
      const h = { 'Content-Type': 'application/json' };
      if (authStore.token) h.Authorization = `Bearer ${authStore.token}`;
      return h;
    },

    toggleSort(table, field) {
      const key = table + 'Sort';
      if (this[key].field === field) {
        this[key].order = this[key].order === 'asc' ? 'desc' : 'asc';
      } else {
        this[key].field = field;
        this[key].order = 'asc';
      }
    },

    sortArray(arr, field, order, table) {
      const sorted = [...arr];
      sorted.sort((a, b) => {
        let va;
        let vb;
        if (table === 'user' && field === 'traffic') {
          va = (a.bytesSent || 0) + (a.bytesReceived || 0);
          vb = (b.bytesSent || 0) + (b.bytesReceived || 0);
        } else if (table === 'agent' && field === 'online') {
          va = a.online ? 1 : 0;
          vb = b.online ? 1 : 0;
        } else if (table === 'agent' && (field === 'totalTokens' || field === 'totalTurns')) {
          va = a.metrics?.[field] || 0;
          vb = b.metrics?.[field] || 0;
        } else {
          va = a[field];
          vb = b[field];
        }
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        let cmp;
        if (typeof va === 'string') cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' });
        else if (typeof va === 'boolean') cmp = va === vb ? 0 : (va ? -1 : 1);
        else cmp = va - vb;
        return order === 'desc' ? -cmp : cmp;
      });
      return sorted;
    },

    isWithinPeriod(timestamp, period) {
      if (period === 'all') return true;
      const value = new Date(timestamp || 0).getTime();
      if (!Number.isFinite(value) || value <= 0) return false;
      const days = period === 'today' ? 1 : (period === 'week' ? 7 : 30);
      return value >= Date.now() - days * 24 * 60 * 60 * 1000;
    },

    async fetchAll() {
      this.loading = true;
      this.error = false;
      try {
        const headers = this.getHeaders();
        const [dashboardRes, userStatsRes, agentsRes] = await Promise.all([
          fetch('/api/admin/dashboard', { headers }),
          fetch(`/api/admin/user-stats?period=${this.statsPeriod}`, { headers }),
          fetch('/api/admin/agents', { headers })
        ]);
        if (!dashboardRes.ok || !userStatsRes.ok || !agentsRes.ok) {
          this.error = true;
          return;
        }
        const [dashboard, userStats, agents] = await Promise.all([
          dashboardRes.json(), userStatsRes.json(), agentsRes.json()
        ]);
        this.overview = {
          totalUsers: dashboard.totalUsers ?? 0,
          onlineUsers: dashboard.onlineUsers ?? 0,
          onlineAgents: dashboard.onlineAgents ?? 0,
          todayMessages: dashboard.todayMessages ?? 0,
          totalTokens: dashboard.totalTokens ?? 0,
          agentMetrics: this.normalizeMetrics(dashboard.agentMetrics || {})
        };
        this.userStats = Array.isArray(userStats) ? userStats : [];
        this.agents = Array.isArray(agents) ? agents.map(agent => ({
          ...agent,
          metrics: this.normalizeMetrics(agent.metrics || {})
        })) : [];
        this.loaded = true;
      } catch {
        this.error = true;
      } finally {
        this.loading = false;
      }
    },

    async refreshAll() {
      await this.fetchAll();
    },

    async switchPeriod(period) {
      if (period === this.statsPeriod) return;
      this.statsPeriod = period;
      this.userVisibleCount = PAGE_SIZE;
      await this.fetchUserStats();
    },

    switchAgentTime(period) {
      this.agentTimeFilter = period;
      this.agentVisibleCount = PAGE_SIZE;
    },

    async fetchUserStats() {
      try {
        const res = await fetch(`/api/admin/user-stats?period=${this.statsPeriod}`, { headers: this.getHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        this.userStats = Array.isArray(data) ? data : [];
      } catch {
        // Silently fail — user can retry via refresh.
      }
    },

    latencyClass(latency) {
      if (latency < 100) return 'db-latency-good';
      if (latency <= 500) return 'db-latency-warn';
      return 'db-latency-bad';
    },

    normalizeMetrics(metrics = {}) {
      const num = value => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const chatTurns = num(metrics.chatTurns);
      const yeaftTurns = num(metrics.yeaftTurns);
      const inputTokens = num(metrics.inputTokens);
      const outputTokens = num(metrics.outputTokens);
      const cacheReadTokens = num(metrics.cacheReadTokens);
      const cacheWriteTokens = num(metrics.cacheWriteTokens);
      return {
        chatTurns,
        yeaftTurns,
        totalTurns: num(metrics.totalTurns) || chatTurns + yeaftTurns,
        sessionsCreated: num(metrics.sessionsCreated),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: num(metrics.totalTokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        lastUpdatedAt: metrics.lastUpdatedAt || null
      };
    },

    agentTokenTitle(agent) {
      return this.tokenTitle(this.normalizeMetrics(agent?.metrics || {}));
    },

    userTokenTitle(user) {
      return this.tokenTitle(user || {});
    },

    tokenTitle(usage) {
      return [
        `${this.$t('settings.dashboard.inputTokens')}: ${this.formatNumber(Number(usage.inputTokens) || 0)}`,
        `${this.$t('settings.dashboard.outputTokens')}: ${this.formatNumber(Number(usage.outputTokens) || 0)}`,
        `${this.$t('settings.dashboard.cacheTokens')}: ${this.formatNumber((Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0))}`
      ].join(' · ');
    },

    formatNumber(n) {
      if (n == null) return '0';
      return Number(n).toLocaleString();
    },

    formatCompactNumber(n) {
      const value = Number(n) || 0;
      if (value < 1000) return this.formatNumber(value);
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`;
      if (value < 1000000000) return `${(value / 1000000).toFixed(value < 10000000 ? 1 : 0)}M`;
      return `${(value / 1000000000).toFixed(1)}B`;
    },

    formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let size = bytes;
      while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
      }
      return `${size < 10 && i > 0 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
    },

    formatRelativeTime(ts) {
      if (!ts) return '—';
      const diff = Date.now() - new Date(ts).getTime();
      if (diff < 0) return '—';
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return this.$t('settings.dashboard.ago', { time: `${seconds}s` });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return this.$t('settings.dashboard.ago', { time: `${minutes}m` });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return this.$t('settings.dashboard.ago', { time: `${hours}h` });
      return this.$t('settings.dashboard.ago', { time: `${Math.floor(hours / 24)}d` });
    }
  }
};
