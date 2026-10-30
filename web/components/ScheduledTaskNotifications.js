export default {
  name: 'ScheduledTaskNotifications',
  props: { store: { type: Object, required: true } },
  data() { return { error: '', expanded: false, opening: null }; },
  computed: {
    items() { return this.store.scheduledTaskNotifications || []; },
    visibleItems() { return this.expanded ? [...this.items].reverse() : this.items.slice(-1); },
  },
  methods: {
    statusLabel(status) {
      const key = `scheduledTasks.status.${status}`;
      return this.$t(key) === key ? status : this.$t(key);
    },
    async open(item) {
      if (this.opening) return;
      this.opening = item.id;
      this.error = '';
      try {
        const result = await this.store.openScheduledTaskNotification(item);
        if (result === false || result?.ok === false) this.error = this.$t('scheduledTasks.openFailed');
      } catch (error) { this.error = error?.message || this.$t('scheduledTasks.openFailed'); }
      finally { this.opening = null; }
    },
  },
  template: `
    <aside v-if="items.length" class="scheduled-task-notifications" :aria-label="$t('scheduledTasks.notifications')" aria-live="polite">
      <div v-for="item in visibleItems" :key="item.id" class="scheduled-task-notification">
        <button type="button" class="scheduled-task-notification-open" :disabled="!!opening" @click="open(item)">
          <strong>{{ item.taskName || $t('scheduledTasks.task') }}</strong>
          <span>{{ statusLabel(item.status) }}</span>
          <span v-if="item.error" class="scheduled-task-error">{{ item.error }}</span>
        </button>
        <button type="button" class="btn-ghost scheduled-task-dismiss" :aria-label="$t('scheduledTasks.dismiss')" @click="store.dismissScheduledTaskNotification(item.id)">×</button>
      </div>
      <button v-if="items.length > 1" type="button" class="scheduled-task-notifications-more" :aria-expanded="expanded" @click="expanded = !expanded">{{ $t(expanded ? 'scheduledTasks.collapseNotifications' : 'scheduledTasks.moreNotifications', { count: items.length - 1 }) }}</button>
      <p v-if="error" class="scheduled-task-error" role="alert">{{ error }}</p>
    </aside>
  `,
};
