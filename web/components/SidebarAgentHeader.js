/**
 * SidebarAgentHeader — shared Agent list and settings entry used by both
 * Session sidebars so their Agent controls cannot drift apart.
 */
export default {
  name: 'SidebarAgentHeader',
  props: {
    onlineAgents: { type: Array, required: true },
    onlineAgentCount: { type: Number, required: true },
    restartingAgents: { type: Object, default: () => ({}) },
    upgradingAgents: { type: Object, default: () => ({}) },
    showAgentActions: { type: Boolean, default: false },
    canUpgradeAll: { type: Boolean, default: false },
    upgradingAll: { type: Boolean, default: false },
  },
  emits: ['open-agent-settings', 'restart-agent', 'upgrade-agent', 'upgrade-all-agents'],
  data() {
    return { open: false };
  },
  created() {
    this._onDocClick = (event) => {
      if (!this.open) return;
      const target = event.target;
      if (target?.closest?.('.agent-header-controls')) return;
      this.open = false;
    };
    if (typeof document !== 'undefined') document.addEventListener('click', this._onDocClick, true);
  },
  beforeUnmount() {
    if (this._onDocClick && typeof document !== 'undefined') {
      document.removeEventListener('click', this._onDocClick, true);
    }
  },
  methods: {
    tr(key, fallback, params) {
      try {
        const value = this.$t ? this.$t(key, params) : key;
        return (value && value !== key) ? value : (fallback || key);
      } catch (_) { return fallback || key; }
    },
  },
  computed: {
    availableUpdateCount() {
      return this.onlineAgents.filter(agent => agent?.upgradeAvailable).length;
    },
  },
  template: `
    <div class="agent-header-controls">
      <button
        type="button"
        class="sidebar-brand agent-dropdown-trigger"
        @click.stop="open = !open"
        :title="tr('chat.agent.manage', 'Manage agents')"
        :aria-expanded="open ? 'true' : 'false'"
        aria-haspopup="menu"
      >
        <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
        <span class="brand-label">{{ tr('chat.agent.count', onlineAgentCount + ' agents', { count: onlineAgentCount }) }}</span>
        <span
          v-if="availableUpdateCount > 0"
          class="agent-update-notification"
          :title="tr('chat.agent.updatesAvailable', availableUpdateCount + ' updates available', { count: availableUpdateCount })"
          :aria-label="tr('chat.agent.updatesAvailable', availableUpdateCount + ' updates available', { count: availableUpdateCount })"
          role="status"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3 1.4 1.42-4 4a1 1 0 0 1-1.4 0l-4-4 1.4-1.42 2.3 2.3V4a1 1 0 0 1 1-1ZM5 19h14v2H5v-2Z"/></svg>
          <span class="agent-update-notification-count">{{ availableUpdateCount }}</span>
        </span>
        <svg class="dropdown-chevron" :class="{ open }" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>
      <div class="agent-dropdown" v-if="open" role="menu" @click.stop>
        <div class="agent-dropdown-list">
          <div v-for="agent in onlineAgents" :key="agent.id" class="agent-dropdown-item">
            <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
            <span class="agent-dropdown-name" :title="agent.name">{{ agent.name }}</span>
            <span class="agent-dropdown-meta">
              <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ tr('chat.agent.restarting', 'Restarting…') }}</span>
              <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ tr('chat.agent.upgrading', 'Upgrading…') }}</span>
              <span class="agent-dropdown-version agent-dropdown-update-version" v-else-if="agent.upgradeAvailable">v{{ agent.upgradeAvailable }}</span>
              <span class="agent-dropdown-version" v-else-if="agent.version">v{{ agent.version }}</span>
            </span>
            <span v-if="showAgentActions" class="agent-dropdown-actions">
              <button
                type="button"
                class="agent-dropdown-action-btn agent-dropdown-upgrade-btn"
                :class="{ 'update-available': agent.upgradeAvailable }"
                @click.stop="$emit('upgrade-agent', agent.id)"
                :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                :title="agent.upgradeAvailable ? tr('chat.agent.updateAvailable', 'Update available: v' + agent.upgradeAvailable, { version: agent.upgradeAvailable }) : tr('chat.agent.upgrade', 'Upgrade')"
                :aria-label="agent.upgradeAvailable ? tr('chat.agent.updateAvailable', 'Update available: v' + agent.upgradeAvailable, { version: agent.upgradeAvailable }) : tr('chat.agent.upgrade', 'Upgrade')"
              >
                <span v-if="upgradingAgents[agent.id]" class="spinner-mini"></span>
                <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>
              </button>
              <button
                type="button"
                class="agent-dropdown-action-btn agent-dropdown-restart-btn"
                @click.stop="$emit('restart-agent', agent.id)"
                :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                :title="tr('chat.agent.restart', 'Restart')"
                :aria-label="tr('chat.agent.restart', 'Restart')"
              >
                <span v-if="restartingAgents[agent.id]" class="spinner-mini"></span>
                <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
            </span>
          </div>
          <div v-if="onlineAgents.length === 0" class="agent-dropdown-empty">{{ tr('chat.agent.none', 'No agents online') }}</div>
        </div>
        <div class="agent-dropdown-footer">
          <button
            type="button"
            class="agent-dropdown-settings-option"
            @click.stop="open = false; $emit('open-agent-settings')"
          >
            {{ tr('agentSettings.open', 'Agent settings') }}
          </button>
          <button
            type="button"
            class="agent-dropdown-settings-option agent-dropdown-upgrade-all-option"
            @click.stop="$emit('upgrade-all-agents')"
            :disabled="!canUpgradeAll || upgradingAll"
          >
            <span v-if="upgradingAll" class="agent-dropdown-upgrade-all-spinner" aria-hidden="true"></span>
            <span>{{ upgradingAll ? tr('chat.agent.upgradingAll', 'Upgrading all…') : tr('chat.agent.upgradeAll', 'Upgrade all') }}</span>
          </button>
        </div>
      </div>
    </div>
  `,
};
