import { scheduledTaskUnavailable, taskResultError } from './ScheduledTaskSettings.js';

export default {
  name: 'ScheduledTaskBar',
  props: {
    session: { type: Object, required: true },
    agentId: { type: String, required: true },
  },
  emits: ['configure'],
  data() { return { busy: false, error: '' }; },
  computed: {
    chat() { try { return window.Pinia?.useChatStore?.() || null; } catch { return null; } },
    task() { return this.session.task; },
    unavailable() { return scheduledTaskUnavailable(this.chat, this.agentId, this.session.id, this.task); },
    lastRun() { return this.task.lastRun || this.task.runtime?.lastRun; },
    lastStatus() {
      const status = this.lastRun?.status || this.task.lastRunStatus;
      if (!status) return this.$t('scheduledTasks.never');
      const key = `scheduledTasks.status.${status}`;
      return this.$t(key) === key ? status : this.$t(key);
    },
    nextRunAt() { return this.task.nextRunAt ?? this.task.runtime?.nextRunAt; },
  },
  methods: {
    formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
    },
    async run() {
      if (this.busy || this.unavailable) return;
      this.busy = true;
      this.error = '';
      try {
        const result = await this.chat.runScheduledTask({ agentId: this.agentId, sessionId: this.session.id });
        const error = taskResultError(result);
        if (error !== null) this.error = error || this.$t('scheduledTasks.failed');
      } catch (error) { this.error = error?.message || this.$t('scheduledTasks.failed'); }
      finally { this.busy = false; }
    },
  },
  template: `
    <div class="scheduled-task-bar">
      <div class="scheduled-task-summary">
        <div class="scheduled-task-summary-heading">
          <strong>{{ $t('scheduledTasks.task') }}</strong>
          <span class="scheduled-task-state" :class="{ 'is-paused': !task.enabled }">{{ $t(unavailable === 'scheduledTasks.running' ? unavailable : task.enabled ? 'scheduledTasks.enabled' : 'scheduledTasks.paused') }}</span>
        </div>
        <p v-if="unavailable && unavailable !== 'scheduledTasks.running'" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
        <p v-else class="scheduled-task-help">
          <template v-if="task.enabled && nextRunAt">{{ $t('scheduledTasks.nextRun') }} <time>{{ formatTime(nextRunAt) }}</time></template>
          <template v-else>{{ $t(task.trigger?.type === 'manual' ? 'scheduledTasks.trigger.manual' : 'scheduledTasks.none') }}</template>
          <span aria-hidden="true"> · </span><span :title="formatTime(lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt)">{{ lastStatus }}</span>
        </p>
      </div>
      <div class="scheduled-task-bar-actions">
        <button type="button" class="btn btn-secondary" @click="$emit('configure')">{{ $t('scheduledTasks.configure') }}</button>
        <button type="button" class="btn btn-primary" :disabled="busy || !!unavailable" @click="run">{{ $t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.run') }}</button>
      </div>
      <p v-if="error || lastRun?.error || task.lastError" class="scheduled-task-error" role="alert">{{ error || lastRun?.error || task.lastError }}</p>
    </div>
  `,
};
