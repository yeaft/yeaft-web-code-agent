import NavigationIcon from './NavigationIcon.js';
import { workCenterActivityActions, workCenterActionTime, workCenterItemTime } from '../stores/helpers/work-center.js';
/** Work Center navigation owns no Session selection or detail cache. Activity
 * comes from summary snapshots/events, never background detail requests. */
export default {
  components: { NavigationIcon },
  name: 'WorkCenterSidebar',
  props: {
    agents: { type: Array, default: () => [] },
    agentId: { type: String, default: null },
    itemId: { type: String, default: null },
    actionId: { type: String, default: null },
    expanded: { type: Boolean, default: true },
  },
  emits: ['back', 'collapse', 'create', 'select-agent', 'select-item'],
  data() { return { activityExpanded: true, collapsedItems: {} }; },
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
    actions(item) { return workCenterActivityActions(item); },
    itemKey(item) { return JSON.stringify([this.agentId, item.id]); },
    itemExpanded(item) { return !this.collapsedItems[this.itemKey(item)]; },
    toggleItem(item) {
      const key = this.itemKey(item);
      this.collapsedItems = { ...this.collapsedItems, [key]: !this.collapsedItems[key] };
    },
    timeValue(row, item = false) { return item ? workCenterItemTime(row) : workCenterActionTime(row); },
    timeIso(row, item = false) { return new Date(this.timeValue(row, item)).toISOString(); },
    timeLabel(row, item = false) {
      return new Date(this.timeValue(row, item)).toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    },
    timeTitle(row, item = false) { return new Date(this.timeValue(row, item)).toLocaleString(); },
    actionLabel(item, action, index) {
      return action.contentSummary || action.objective
        || (item.currentAction?.id === action.id && item.currentAction.objective)
        || this.$t('workCenter.actionNumber', { number: action.sequence || index + 1 });
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
          <NavigationIcon name="back" :size="18" />
        </button>
        <strong v-if="expanded">{{ $t('workCenter.title') }}</strong>
        <button class="sidebar-icon-btn work-center-sidebar-collapse" type="button" @click="$emit('collapse')"
                :aria-expanded="expanded" :title="$t(expanded ? 'workCenter.hideNavigation' : 'workCenter.showNavigation')"
                :aria-label="$t(expanded ? 'workCenter.hideNavigation' : 'workCenter.showNavigation')">
          <NavigationIcon :name="expanded ? 'collapse' : 'menu'" :size="18" />
        </button>
      </div>
      <button class="btn-ghost new-chat-btn work-center-sidebar-create" type="button" :disabled="!agentId || !agents.some(agent => agent.online)"
              :title="$t('workCenter.newWorkItem')" :aria-label="$t('workCenter.newWorkItem')" @click="$emit('create')">
        <NavigationIcon name="add" :size="18" />
        <span v-if="expanded">{{ $t('workCenter.newWorkItem') }}</span>
      </button>
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
            <button class="work-center-activity-disclosure" type="button" :aria-expanded="activityExpanded"
                    aria-controls="work-center-activity-list" @click="activityExpanded = !activityExpanded">
              <NavigationIcon name="chevron" :size="12" :class="{ expanded: activityExpanded }" />
              <span>{{ $t('workCenter.activity') }}</span>
            </button>
            <button class="sidebar-icon-btn" type="button" :disabled="!online || loading" @click="refresh"
                    :title="$t('workCenter.refresh')" :aria-label="$t('workCenter.refresh')">
              <NavigationIcon name="refresh" :size="16" />
            </button>
          </div>
          <p v-if="!online" class="work-center-sidebar-notice" role="status">{{ $t('workCenter.activityOffline') }}</p>
          <p v-if="error" class="work-center-sidebar-notice" role="alert">{{ error }}</p>
          <p v-if="loading && !activity.length" class="work-center-sidebar-notice">{{ $t('workCenter.loading') }}</p>
          <p v-else-if="online && !error && !activity.length" class="work-center-sidebar-notice">{{ $t('workCenter.noActivity') }}</p>
          <ul v-show="activityExpanded" id="work-center-activity-list" class="work-center-activity-items">
            <li v-for="item in activity" :key="item.id">
              <div class="work-center-activity-item-row" :class="{ active: itemId === item.id }">
              <button v-if="actions(item).length" class="work-center-item-disclosure" type="button"
                      :aria-expanded="itemExpanded(item)" :aria-controls="'work-center-activity-' + item.id"
                      :aria-label="$t(itemExpanded(item) ? 'workCenter.collapseItemActivity' : 'workCenter.expandItemActivity', { title: item.title })"
                      @click="toggleItem(item)">
                <NavigationIcon name="chevron" :size="12" :class="{ expanded: itemExpanded(item) }" />
              </button>
              <span v-else class="work-center-item-disclosure-spacer" aria-hidden="true"></span>
              <button class="work-center-activity-item" :class="{ active: itemId === item.id }" type="button" :disabled="!online"
                      :aria-current="itemId === item.id && !actionId ? 'page' : undefined"
                      @click="$emit('select-item', { item })">
                <span class="work-center-activity-title" :title="item.title">{{ item.title }}</span>
                <span class="work-center-activity-meta">
                  <small class="work-center-status" :data-status="item.status"><span aria-hidden="true"></span>{{ status(item.status) }}</small>
                  <time v-if="timeValue(item, true)" :datetime="timeIso(item, true)" :title="timeTitle(item, true)">{{ timeLabel(item, true) }}</time>
                </span>
              </button>
              </div>
              <ul v-if="actions(item).length" v-show="itemExpanded(item)" :id="'work-center-activity-' + item.id" class="work-center-activity-actions">
                <li v-for="(action, index) in actions(item)" :key="action.id">
                  <button type="button" :disabled="!online" :class="{ active: itemId === item.id && actionId === action.id }"
                          :aria-current="itemId === item.id && actionId === action.id ? 'page' : undefined"
                          @click="$emit('select-item', { item, actionId: action.id })">
                    <span class="work-center-status" :data-status="action.status" :title="status(action.status)"><span aria-hidden="true"></span><span class="work-center-activity-action-status">{{ status(action.status) }}</span></span>
                    <span class="work-center-activity-action-copy"><span :title="actionLabel(item, action, index)">{{ actionLabel(item, action, index) }}</span><span class="work-center-activity-meta"><small v-if="action.assignedVp">{{ action.assignedVp.name || action.assignedVp.id }}</small><time v-if="timeValue(action)" :datetime="timeIso(action)" :title="timeTitle(action)">{{ timeLabel(action) }}</time></span></span>
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
