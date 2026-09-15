export default {
  name: 'SidebarWorkCenter',
  props: {
    agents: { type: Array, default: () => [] },
    activeAgentId: { type: String, default: null },
    collapsed: { type: Boolean, default: false },
  },
  emits: ['open'],
  methods: {
    tr(key, fallback) {
      const translated = this.$t ? this.$t(key) : key;
      return translated && translated !== key ? translated : fallback;
    },
    open() {
      const onlineAgents = this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
      const target = onlineAgents.find(agent => agent.id === this.activeAgentId) || onlineAgents[0];
      this.$emit('open', target?.id || null);
    },
  },
  template: `
    <button class="sidebar-work-center-trigger" type="button"
            :class="collapsed ? 'collapsed-icon-btn' : 'sidebar-icon-btn'"
            :title="tr('workCenter.title', 'Work Center')"
            :aria-label="tr('workCenter.title', 'Work Center')" @click="open">
      <svg class="sidebar-work-center-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 5v2h10V8H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z"/>
      </svg>
    </button>
  `,
};
