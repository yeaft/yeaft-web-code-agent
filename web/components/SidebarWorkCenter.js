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
        <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h6M8 17h4"/></g>
      </svg>
    </button>
  `,
};
