/**
 * SidebarAgentHeader — shared agent-dropdown trigger + menu used by both
 * ChatPage and YeaftSidebar so the two sidebars cannot drift apart.
 *
 * Renders only the left-hand brand block (status dot, "N Agent" label,
 * chevron, dropdown menu). The right-hand actions slot (mode toggle,
 * collapse, workbench) is kept in each parent because the actions differ
 * per page.
 */
export default {
  name: 'SidebarAgentHeader',
  props: {
    onlineAgents: { type: Array, required: true },
    onlineAgentCount: { type: Number, required: true },
    restartingAgents: { type: Object, default: () => ({}) },
    upgradingAgents: { type: Object, default: () => ({}) },
    // Per-agent action buttons are optional.
    showAgentActions: { type: Boolean, default: false },
  },
  emits: ['restart-agent', 'upgrade-agent'],
  data() {
    return { open: false };
  },
  created() {
    this._onDocClick = (e) => {
      if (!this.open) return;
      const t = e.target;
      if (t && t.closest && (
        t.closest('.agent-dropdown-trigger') ||
        t.closest('.agent-dropdown')
      )) return;
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
    tr(key, fallback) {
      try {
        const v = this.$t ? this.$t(key) : key;
        return (v && v !== key) ? v : (fallback || key);
      } catch (_) { return fallback || key; }
    },
    canUseAgentAction(agent) {
      return !!(agent && agent.online && !this.restartingAgents[agent.id] && !this.upgradingAgents[agent.id]);
    },
  },
  template: `
    <div class="sidebar-brand agent-dropdown-trigger" @click.stop="open = !open" :title="tr('chat.agent.manage', 'Manage agents')">
      <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
      <span class="brand-label">{{ onlineAgentCount }} Agent</span>
      <svg class="dropdown-chevron" :class="{ open: open }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      <div class="agent-dropdown" v-if="open" @click.stop>
        <div v-for="agent in onlineAgents" :key="agent.id" class="agent-dropdown-item">
          <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
          <span class="agent-dropdown-name">{{ agent.name }}</span>
          <span class="agent-dropdown-version" v-if="agent.version">v{{ agent.version }}</span>
          <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ tr('chat.agent.restarting', 'Restarting…') }}</span>
          <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ tr('chat.agent.upgrading', 'Upgrading…') }}</span>
          <template v-if="showAgentActions">
            <button
              class="agent-dropdown-upgrade-btn"
              @click.stop="$emit('upgrade-agent', agent.id)"
              :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
              :title="tr('chat.agent.upgrade', 'Upgrade')"
            >
              <span v-if="upgradingAgents[agent.id]" class="spinner-mini"></span>
              <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>
            </button>
            <button
              class="agent-dropdown-restart-btn"
              @click.stop="$emit('restart-agent', agent.id)"
              :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
              :title="tr('chat.agent.restart', 'Restart')"
            >
              <span v-if="restartingAgents[agent.id]" class="spinner-mini"></span>
              <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </template>
        </div>
        <div v-if="onlineAgents.length === 0" class="agent-dropdown-empty">{{ tr('chat.agent.none', 'No agents online') }}</div>
      </div>
    </div>
  `,
};
