import { useAuthStore } from '../stores/auth.js';

const PAGE_SIZE = 20;

export default {
  name: 'DashboardTab',
  template: `
    <div class="db-container">
      <!-- Loading state -->
      <div v-if="loading && !loaded" class="db-loading">{{ $t('settings.dashboard.loading') }}</div>

      <!-- Error state -->
      <div v-else-if="error" class="db-empty">{{ $t('settings.dashboard.error') }}</div>

      <!-- Data loaded -->
      <template v-else>
        <!-- Overview stat cards -->
        <div class="db-stats-row">
          <div class="db-stat-card">
            <div class="db-stat-value">{{ overview.totalUsers }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.totalUsers') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value" :class="{ 'is-active': overview.todayActiveUsers > 0 }">{{ overview.todayActiveUsers }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.todayActive') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value" :class="{ 'is-active': overview.onlineAgents > 0 }">{{ overview.onlineAgents }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.onlineAgents') }}</div>
          </div>
          <div class="db-stat-card">
            <div class="db-stat-value">{{ formatNumber(overview.todayMessages) }}</div>
            <div class="db-stat-label">{{ $t('settings.dashboard.todayUserTurns') }}</div>
          </div>
        </div>

        <!-- User usage section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.userUsage') }}</div>
            <button class="db-refresh-btn" :class="{ 'is-loading': loading }" @click="refreshAll" :disabled="loading" :title="$t('settings.dashboard.refresh')">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </div>

          <!-- Period tabs -->
          <div class="db-period-tabs">
            <button v-for="p in periods" :key="p.value"
                    class="db-period-tab" :class="{ 'is-active': statsPeriod === p.value }"
                    @click="switchPeriod(p.value)">
              {{ p.label }}
            </button>
          </div>

          <!-- Desktop table -->
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
                  <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'sessionCount')">
                    {{ $t('settings.dashboard.sessions') }}
                    <span class="db-sort-arrow" v-if="userSort.field === 'sessionCount'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                  </th>
                  <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'requestCount')">
                    {{ $t('settings.dashboard.requests') }}
                    <span class="db-sort-arrow" v-if="userSort.field === 'requestCount'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                  </th>
                  <th class="db-cell-num db-th-sort" @click="toggleSort('user', 'traffic')">
                    {{ $t('settings.dashboard.traffic') }}
                    <span class="db-sort-arrow" v-if="userSort.field === 'traffic'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                  </th>
                  <th class="db-th-sort" @click="toggleSort('user', 'lastLoginAt')">
                    {{ $t('settings.dashboard.lastLogin') }}
                    <span class="db-sort-arrow" v-if="userSort.field === 'lastLoginAt'">{{ userSort.order === 'asc' ? '▲' : '▼' }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="user in pagedUserStats" :key="user.username">
                  <td class="db-cell-name">{{ user.username }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.messageCount) }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.sessionCount) }}</td>
                  <td class="db-cell-num">{{ formatNumber(user.requestCount) }}</td>
                  <td class="db-cell-num">{{ formatBytes(user.bytesSent + user.bytesReceived) }}</td>
                  <td class="db-cell-time">{{ formatRelativeTime(user.lastLoginAt) }}</td>
                </tr>
              </tbody>
            </table>
            <button v-if="userVisibleCount < sortedUserStats.length" class="db-load-more" @click="userVisibleCount += ${PAGE_SIZE}">
              {{ $t('settings.dashboard.loadMore', { remaining: sortedUserStats.length - userVisibleCount }) }}
            </button>
          </div>

          <!-- Mobile cards -->
          <div class="db-card-list">
            <div class="db-user-card" v-for="user in pagedUserStats" :key="'m-' + user.username">
              <div class="db-user-card-name">{{ user.username }}</div>
              <div class="db-user-card-stats">
                <span>{{ $t('settings.dashboard.userTurns') }} {{ formatNumber(user.messageCount) }}</span>
                <span>·</span>
                <span>{{ $t('settings.dashboard.sessions') }} {{ formatNumber(user.sessionCount) }}</span>
              </div>
              <div class="db-user-card-stats">
                <span>{{ $t('settings.dashboard.requests') }} {{ formatNumber(user.requestCount) }}</span>
                <span>·</span>
                <span>{{ formatBytes(user.bytesSent + user.bytesReceived) }}</span>
              </div>
              <div class="db-user-card-meta">{{ $t('settings.dashboard.lastLogin') }}: {{ formatRelativeTime(user.lastLoginAt) }}</div>
            </div>
            <div v-if="userStats.length === 0" class="db-empty">{{ $t('settings.dashboard.noUserData') }}</div>
            <button v-if="userVisibleCount < sortedUserStats.length" class="db-load-more" @click="userVisibleCount += ${PAGE_SIZE}">
              {{ $t('settings.dashboard.loadMore', { remaining: sortedUserStats.length - userVisibleCount }) }}
            </button>
          </div>
        </div>

        <!-- Agent list section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.agentList') }}</div>
          </div>

          <template v-if="agents.length > 0">
            <!-- Desktop table -->
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
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="agent in pagedAgents" :key="agent.name">
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
                    <td>{{ agent.owner || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <button v-if="agentVisibleCount < sortedAgents.length" class="db-load-more" @click="agentVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedAgents.length - agentVisibleCount }) }}
              </button>
            </div>

            <!-- Mobile cards -->
            <div class="db-card-list">
              <div class="db-agent-card" v-for="agent in pagedAgents" :key="'m-' + agent.name">
                <div class="db-agent-card-name">
                  <span class="db-status-dot" :class="agent.online ? 'online' : 'offline'"></span>
                  {{ agent.name }}
                </div>
                <div class="db-agent-card-stats" v-if="agent.online">
                  <span>{{ $t('settings.dashboard.latency') }} <span :class="latencyClass(agent.latency)">{{ agent.latency }}ms</span></span>
                  <span>·</span>
                  <span>v{{ agent.version || '?' }}</span>
                </div>
                <div class="db-agent-card-meta">{{ $t('settings.dashboard.owner') }}: {{ agent.owner || '—' }}</div>
              </div>
              <button v-if="agentVisibleCount < sortedAgents.length" class="db-load-more" @click="agentVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedAgents.length - agentVisibleCount }) }}
              </button>
            </div>
          </template>
          <div v-else class="db-empty">{{ $t('settings.dashboard.noAgents') }}</div>
        </div>

        <!-- Online users section -->
        <div class="db-section">
          <div class="db-section-header">
            <div class="db-section-title">{{ $t('settings.dashboard.onlineUserList') }}</div>
          </div>

          <template v-if="onlineUsers.length > 0">
            <!-- Desktop table -->
            <div class="db-table-wrap">
              <table class="db-table">
                <thead>
                  <tr>
                    <th class="db-th-sort" @click="toggleSort('online', 'username')">
                      {{ $t('settings.dashboard.name') }}
                      <span class="db-sort-arrow" v-if="onlineSort.field === 'username'">{{ onlineSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('online', 'role')">
                      {{ $t('settings.dashboard.role') }}
                      <span class="db-sort-arrow" v-if="onlineSort.field === 'role'">{{ onlineSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                    <th class="db-th-sort" @click="toggleSort('online', 'agentName')">
                      {{ $t('settings.dashboard.agent') }}
                      <span class="db-sort-arrow" v-if="onlineSort.field === 'agentName'">{{ onlineSort.order === 'asc' ? '▲' : '▼' }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="user in pagedOnlineUsers" :key="user.username">
                    <td class="db-cell-name">{{ user.username }}</td>
                    <td>
                      <span class="sp-badge" :class="'sp-role-' + (user.role || 'pro')">{{ user.role || 'pro' }}</span>
                    </td>
                    <td>{{ user.agentName || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <button v-if="onlineVisibleCount < sortedOnlineUsers.length" class="db-load-more" @click="onlineVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedOnlineUsers.length - onlineVisibleCount }) }}
              </button>
            </div>

            <!-- Mobile cards -->
            <div class="db-card-list">
              <div class="db-online-card" v-for="user in pagedOnlineUsers" :key="'m-' + user.username">
                <div class="db-online-card-name">
                  {{ user.username }}
                  <span class="sp-badge" :class="'sp-role-' + (user.role || 'pro')">{{ user.role || 'pro' }}</span>
                </div>
                <div class="db-agent-card-meta" v-if="user.agentName">{{ $t('settings.dashboard.agent') }}: {{ user.agentName }}</div>
              </div>
              <button v-if="onlineVisibleCount < sortedOnlineUsers.length" class="db-load-more" @click="onlineVisibleCount += ${PAGE_SIZE}">
                {{ $t('settings.dashboard.loadMore', { remaining: sortedOnlineUsers.length - onlineVisibleCount }) }}
              </button>
            </div>
          </template>
          <div v-else class="db-empty">{{ $t('settings.dashboard.noOnlineUsers') }}</div>
        </div>
      </template>
    </div>
  `,
  data() {
    return {
      loading: false,
      loaded: false,
      error: false,
      overview: { totalUsers: 0, todayActiveUsers: 0, onlineAgents: 0, todayMessages: 0 },
      statsPeriod: 'all',
      userStats: [],
      agents: [],
      onlineUsers: [],
      // Sort state per table
      userSort: { field: null, order: 'asc' },
      agentSort: { field: null, order: 'asc' },
      onlineSort: { field: null, order: 'asc' },
      // Pagination visible counts
      userVisibleCount: PAGE_SIZE,
      agentVisibleCount: PAGE_SIZE,
      onlineVisibleCount: PAGE_SIZE
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
    sortedUserStats() {
      if (!this.userSort.field) return this.userStats;
      return this.sortArray(this.userStats, this.userSort.field, this.userSort.order, 'user');
    },
    pagedUserStats() {
      return this.sortedUserStats.slice(0, this.userVisibleCount);
    },
    sortedAgents() {
      if (!this.agentSort.field) return this.agents;
      return this.sortArray(this.agents, this.agentSort.field, this.agentSort.order, 'agent');
    },
    pagedAgents() {
      return this.sortedAgents.slice(0, this.agentVisibleCount);
    },
    sortedOnlineUsers() {
      if (!this.onlineSort.field) return this.onlineUsers;
      return this.sortArray(this.onlineUsers, this.onlineSort.field, this.onlineSort.order, 'online');
    },
    pagedOnlineUsers() {
      return this.sortedOnlineUsers.slice(0, this.onlineVisibleCount);
    }
  },
  methods: {
    getHeaders() {
      const authStore = useAuthStore();
      const h = { 'Content-Type': 'application/json' };
      if (authStore.token) {
        h['Authorization'] = `Bearer ${authStore.token}`;
      }
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
        let va, vb;
        if (table === 'user' && field === 'traffic') {
          va = (a.bytesSent || 0) + (a.bytesReceived || 0);
          vb = (b.bytesSent || 0) + (b.bytesReceived || 0);
        } else if (table === 'agent' && field === 'online') {
          va = a.online ? 1 : 0;
          vb = b.online ? 1 : 0;
        } else {
          va = a[field];
          vb = b[field];
        }

        // Null/undefined sort to end
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;

        let cmp;
        if (typeof va === 'string') {
          cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' });
        } else if (typeof va === 'boolean') {
          cmp = (va === vb) ? 0 : (va ? -1 : 1);
        } else {
          cmp = va - vb;
        }
        return order === 'desc' ? -cmp : cmp;
      });
      return sorted;
    },

    async fetchAll() {
      this.loading = true;
      this.error = false;
      try {
        const headers = this.getHeaders();
        const [dashboardRes, userStatsRes, agentsRes, onlineUsersRes] = await Promise.all([
          fetch('/api/admin/dashboard', { headers }),
          fetch(`/api/admin/user-stats?period=${this.statsPeriod}`, { headers }),
          fetch('/api/admin/agents', { headers }),
          fetch('/api/admin/online-users', { headers })
        ]);

        if (!dashboardRes.ok || !userStatsRes.ok || !agentsRes.ok || !onlineUsersRes.ok) {
          this.error = true;
          return;
        }

        const [dashboard, userStats, agents, onlineUsers] = await Promise.all([
          dashboardRes.json(),
          userStatsRes.json(),
          agentsRes.json(),
          onlineUsersRes.json()
        ]);

        this.overview = {
          totalUsers: dashboard.totalUsers ?? 0,
          todayActiveUsers: dashboard.todayActiveUsers ?? 0,
          onlineAgents: dashboard.onlineAgents ?? 0,
          todayMessages: dashboard.todayMessages ?? 0
        };
        this.userStats = Array.isArray(userStats) ? userStats : [];
        this.agents = Array.isArray(agents) ? agents : [];
        this.onlineUsers = Array.isArray(onlineUsers) ? onlineUsers : [];
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

    async fetchUserStats() {
      try {
        const headers = this.getHeaders();
        const res = await fetch(`/api/admin/user-stats?period=${this.statsPeriod}`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        this.userStats = Array.isArray(data) ? data : [];
      } catch {
        // Silently fail — user can retry via refresh
      }
    },

    latencyClass(latency) {
      if (latency < 100) return 'db-latency-good';
      if (latency <= 500) return 'db-latency-warn';
      return 'db-latency-bad';
    },

    formatNumber(n) {
      if (n == null) return '0';
      return n.toLocaleString();
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
      const now = Date.now();
      const diff = now - new Date(ts).getTime();
      if (diff < 0) return '—';

      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return this.$t('settings.dashboard.ago', { time: `${seconds}s` });

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return this.$t('settings.dashboard.ago', { time: `${minutes}m` });

      const hours = Math.floor(minutes / 60);
      if (hours < 24) return this.$t('settings.dashboard.ago', { time: `${hours}h` });

      const days = Math.floor(hours / 24);
      return this.$t('settings.dashboard.ago', { time: `${days}d` });
    }
  }
};
