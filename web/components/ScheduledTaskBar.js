import { scheduledTaskUnavailable, taskResultError } from './ScheduledTaskSettings.js';

// One inline Task region shared by the desktop and mobile Session status pane.
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
    running() { return this.unavailable === 'scheduledTasks.running' || this.task.running || this.task.status === 'running' || this.task.runtime?.status === 'running' || this.lastRun?.status === 'running'; },
    stateLabel() { return this.$t(this.running ? 'scheduledTasks.running' : this.task.enabled ? 'scheduledTasks.enabled' : 'scheduledTasks.paused'); },
    taskError() { return this.error || this.lastRun?.error || this.task.lastError || ''; },
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
    <section class="yeaft-session-status-section yeaft-session-status-scheduled-task scheduled-task-bar" :aria-label="$t('scheduledTasks.task')">
      <header class="yeaft-session-status-section-header">
        <span>{{ $t('scheduledTasks.task') }}</span>
        <span class="scheduled-task-state" :class="{ 'is-paused': !task.enabled && !running }" role="status">{{ stateLabel }}</span>
      </header>
      <div class="scheduled-task-summary">
        <dl class="scheduled-task-runtime">
          <div>
            <dt>{{ $t('scheduledTasks.lastRun') }}</dt>
            <dd><span>{{ lastStatus }}</span><time v-if="lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt">{{ formatTime(lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt) }}</time></dd>
          </div>
          <div>
            <dt>{{ $t('scheduledTasks.nextRun') }}</dt>
            <dd><time v-if="task.enabled && nextRunAt">{{ formatTime(nextRunAt) }}</time><span v-else>{{ $t(task.trigger?.type === 'manual' ? 'scheduledTasks.trigger.manual' : 'scheduledTasks.none') }}</span></dd>
          </div>
        </dl>
        <p v-if="unavailable && unavailable !== 'scheduledTasks.running'" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
        <div class="scheduled-task-bar-actions">
          <button type="button" class="btn btn-secondary" @click="$emit('configure')">{{ $t('scheduledTasks.configure') }}</button>
          <button type="button" class="btn btn-primary scheduled-task-run" :disabled="busy || !!unavailable" :aria-label="$t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.runOnce')" :title="$t(unavailable || (busy ? 'scheduledTasks.starting' : 'scheduledTasks.runOnce'))" :aria-busy="busy" @click="run">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>
            <span>{{ $t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.runOnce') }}</span>
          </button>
        </div>
        <p class="scheduled-task-help">{{ $t('scheduledTasks.runOnceHelp') }}</p>
        <p v-if="taskError" class="scheduled-task-error" role="alert">{{ taskError }}</p>
      </div>
    </section>
  `,
};
