/** Work Center navigation owns no Session selection or detail cache. Activity
 * comes from summary snapshots/events, never background detail requests. */
export default {
  name: 'WorkCenterSidebar',
  props: {
    agents: { type: Array, default: () => [] },
    agentId: { type: String, default: null },
    itemId: { type: String, default: null },
    actionId: { type: String, default: null },
    expanded: { type: Boolean, default: true },
  },
  emits: ['back', 'collapse', 'select-agent', 'select-item'],
  computed: {
    store() { return Pinia.useChatStore(); },
    activity() { return this.store.workCenterActivityByAgent?.[this.agentId] || []; },
    loading() { return !!this.store.workCenterActivityLoadingByAgent?.[this.agentId]; },
    error() { return this.store.workCenterActivityErrorByAgent?.[this.agentId]; },
    online() {
      return this.store.connectionState === 'connected'
        && this.store.workCenterActivityConnectionGeneration === Number(this.store.chatHistoryConnectionGeneration || 0)
        && this.agents.some(agent => agent.id === this.agentId && agent.online);
    },
    connectionKey() {
      return this.online ? `${this.agentId}:${this.store.workCenterActivityConnectionGeneration}` : '';
    },
  },
  watch: {
    connectionKey: { immediate: true, handler(id) { if (id) this.refresh(); } },
  },
  methods: {
    refresh() { return this.store.loadWorkCenterActivity?.(this.agentId).catch(() => {}); },
    focusReturn() { this.$refs.back?.focus({ preventScroll: true }); },
    actions(item) {
      const actions = Array.isArray(item.actionStats) ? item.actionStats : [];
      return actions.length ? actions : item.currentAction?.id ? [item.currentAction] : [];
    },
    actionLabel(item, action, index) {
      return action.contentSummary || action.objective
        || (item.currentAction?.id === action.id && item.currentAction.objective)
        || this.$t('workCenter.actionNumber', { number: index + 1 });
    },
    status(status) {
      const key = `workCenter.status.${status}`;
      const label = this.$t(key);
      return label === key ? status : label;
    },
    onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); this.$emit('collapse'); }
      if (event.key !== 'Tab' || !this.expanded || window.innerWidth > 1100) return;
      const buttons = [...this.$el.querySelectorAll('button:not(:disabled)')]
        .filter(element => element.getClientRects().length);
      const target = event.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1)
        : !event.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : null;
      if (target) { event.preventDefault(); target.focus(); }
    },
  },
  template: `
    <aside id="work-center-sidebar" class="work-center-sidebar" :class="{ collapsed: !expanded }"
           :aria-label="$t('workCenter.navigation')" @keydown="onKeydown">
      <div class="work-center-sidebar-header">
        <button ref="back" class="sidebar-icon-btn work-center-return" type="button" @click="$emit('back')"
                :title="$t('workCenter.returnToSession')" :aria-label="$t('workCenter.returnToSession')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m9 5-7 7 7 7M2 12h14m-4-8h9v16h-9"/></svg>
        </button>
        <strong v-if="expanded">{{ $t('workCenter.title') }}</strong>
        <button class="sidebar-icon-btn work-center-sidebar-collapse" type="button" @click="$emit('collapse')"
                :aria-expanded="expanded" :title="$t(expanded ? 'workCenter.hideNavigation' : 'workCenter.showNavigation')"
                :aria-label="$t(expanded ? 'workCenter.hideNavigation' : 'workCenter.showNavigation')">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M3 4h18v16H3zM9 4v16"/></svg>
        </button>
      </div>
      <div v-if="expanded" class="work-center-sidebar-scroll">
        <nav class="work-center-agent-list" :aria-label="$t('workCenter.selectAgent')">
          <h2>{{ $t('workCenter.agents') }}</h2>
          <button v-for="agent in agents" :key="agent.id" class="session-tab work-center-agent-row" type="button"
                  :class="{ active: agent.id === agentId }" :aria-current="agent.id === agentId ? 'true' : undefined"
                  :disabled="!agent.online" @click="$emit('select-agent', agent.id)">
            <span class="work-center-agent-dot" :class="{ offline: !agent.online }" aria-hidden="true"></span>
            <span>{{ agent.name || agent.id }}</span>
            <small>{{ $t(agent.online ? 'workCenter.online' : 'workCenter.offline') }}</small>
          </button>
        </nav>
        <section class="work-center-activity" :aria-label="$t('workCenter.activity')" :aria-busy="loading">
          <div class="work-center-activity-heading">
            <h2>{{ $t('workCenter.activity') }}</h2>
            <button class="sidebar-icon-btn" type="button" :disabled="!online || loading" @click="refresh"
                    :title="$t('workCenter.refresh')" :aria-label="$t('workCenter.refresh')">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14 0m0 10a8 8 0 0 1-14 0"/></svg>
            </button>
          </div>
          <p v-if="!online" class="work-center-sidebar-notice" role="status">{{ $t('workCenter.activityOffline') }}</p>
          <p v-if="error" class="work-center-sidebar-notice" role="alert">{{ error }}</p>
          <p v-if="loading && !activity.length" class="work-center-sidebar-notice">{{ $t('workCenter.loading') }}</p>
          <p v-else-if="online && !error && !activity.length" class="work-center-sidebar-notice">{{ $t('workCenter.noActivity') }}</p>
          <ul class="work-center-activity-items">
            <li v-for="item in activity" :key="item.id">
              <button class="work-center-activity-item" :class="{ active: itemId === item.id }" type="button" :disabled="!online"
                      :aria-current="itemId === item.id && !actionId ? 'page' : undefined"
                      @click="$emit('select-item', { item })">
                <span class="work-center-activity-title" :title="item.title">{{ item.title }}</span>
                <small class="work-center-status" :data-status="item.status"><span aria-hidden="true"></span>{{ status(item.status) }}</small>
              </button>
              <ul class="work-center-activity-actions">
                <li v-for="(action, index) in actions(item)" :key="action.id">
                  <button type="button" :disabled="!online" :class="{ active: itemId === item.id && actionId === action.id }"
                          :aria-current="itemId === item.id && actionId === action.id ? 'page' : undefined"
                          @click="$emit('select-item', { item, actionId: action.id })">
                    <span class="work-center-status" :data-status="action.status" :title="status(action.status)"><span aria-hidden="true"></span><span class="work-center-activity-action-status">{{ status(action.status) }}</span></span>
                    <span class="work-center-activity-action-copy"><span :title="actionLabel(item, action, index)">{{ actionLabel(item, action, index) }}</span><small v-if="action.assignedVp">{{ action.assignedVp.name || action.assignedVp.id }}</small></span>
                  </button>
                </li>
              </ul>
            </li>
          </ul>
        </section>
      </div>
    </aside>
  `,
};
