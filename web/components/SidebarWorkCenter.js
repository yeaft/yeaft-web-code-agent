export default {
  name: 'SidebarWorkCenter',
  props: {
    agents: { type: Array, default: () => [] },
    activeAgentId: { type: String, default: null },
    collapsed: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    defaultExpanded: { type: Boolean, default: false },
  },
  emits: ['open'],
  data() {
    return { expanded: this.defaultExpanded };
  },
  computed: {
    onlineAgents() {
      return this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
    },
  },
  watch: {
    defaultExpanded(value) {
      if (value) this.expanded = true;
    },
  },
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    toggle() {
      const target = this.onlineAgents.find(agent => agent.id === this.activeAgentId) || this.onlineAgents[0];
      this.$emit('open', target?.id || null);
      if (!this.collapsed) this.expanded = !this.expanded;
    },
  },
  template: `
    <section class="sidebar-work-center" :class="{ collapsed, active }">
      <div class="session-tab-bar sidebar-work-center-tab-bar">
        <button class="session-tab session-tab-solo sidebar-work-center-trigger" type="button" @click="toggle"
                :class="{ active }" :aria-expanded="expanded ? 'true' : 'false'">
          <svg class="session-tab-icon sidebar-work-center-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z"/>
          </svg>
          <span v-if="!collapsed" class="sidebar-work-center-label">{{ tr('workCenter.title', 'Work Center') }}</span>
          <span v-if="!collapsed && onlineAgents.length" class="session-tab-count">{{ onlineAgents.length }}</span>
          <svg v-if="!collapsed" class="sidebar-work-center-chevron" :class="{ expanded }"
               viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="m9 18 6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6L9 18Z"/>
          </svg>
        </button>
      </div>
      <div v-if="expanded && !collapsed" class="session-panels sidebar-work-center-agents">
        <div class="session-panel-list sidebar-work-center-agent-list">
          <button v-for="agent in onlineAgents" :key="agent.id" type="button"
                  class="session-item sidebar-work-center-agent"
                  :class="{ active: activeAgentId === agent.id }"
                  @click="$emit('open', agent.id)">
            <span class="session-item-header">
              <span class="sidebar-work-center-agent-status" aria-hidden="true"></span>
              <span class="title sidebar-work-center-agent-name">{{ agent.name || agent.id }}</span>
            </span>
          </button>
          <p v-if="onlineAgents.length === 0" class="sidebar-work-center-empty">
            {{ tr('workCenter.noAvailableAgents', 'No compatible online Agents') }}
          </p>
        </div>
      </div>
    </section>
  `,
};
