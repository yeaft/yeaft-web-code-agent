import { scheduledTaskUnavailable, taskResultError } from './ScheduledTaskSettings.js';

// One inline Task region shared by the desktop and mobile Session status pane.
export default {
  name: 'ScheduledTaskBar',
  props: {
    session: { type: Object, required: true },
    agentId: { type: String, required: true },
  },
  emits: ['configure'],
  data() { return { busy: false, stopping: false, error: '' }; },
  computed: {
    chat() { try { return window.Pinia?.useChatStore?.() || null; } catch { return null; } },
    task() { return this.session.task; },
    unavailable() { return scheduledTaskUnavailable(this.chat, this.agentId, this.session.id, this.task); },
    stopUnavailable() { return scheduledTaskUnavailable(this.chat, this.agentId, this.session.id, this.task, { allowRunning: true }); },
    lastRun() { return this.task.lastRun || this.task.runtime?.lastRun; },
    lastStatus() {
      const status = this.running ? 'running' : this.lastRun?.status || this.task.lastRunStatus;
      if (!status) return this.$t('scheduledTasks.never');
      const key = `scheduledTasks.status.${status}`;
      return this.$t(key) === key ? status : this.$t(key);
    },
    nextRunAt() { return this.task.nextRunAt ?? this.task.runtime?.nextRunAt; },
    running() { return this.unavailable === 'scheduledTasks.running' || this.task.running || this.task.status === 'running' || this.task.runtime?.status === 'running' || this.lastRun?.status === 'running'; },
    taskError() { return this.error || this.lastRun?.error || this.task.lastError || ''; },
  },
  watch: {
    running(value) { if (!value) this.stopping = false; },
    stopUnavailable(value) { if (value) this.stopping = false; },
  },
  methods: {
    formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
    },
    async run() {
      if (this.busy || this.stopping || this.unavailable) return;
      this.busy = true;
      this.error = '';
      try {
        const result = await this.chat.runScheduledTask({ agentId: this.agentId, sessionId: this.session.id });
        const error = taskResultError(result);
        if (error !== null) this.error = error || this.$t('scheduledTasks.failed');
      } catch (error) { this.error = error?.message || this.$t('scheduledTasks.failed'); }
      finally { this.busy = false; }
    },
    stop() {
      if (this.stopping || !this.running || this.stopUnavailable) return;
      this.stopping = true;
      this.error = '';
      try {
        // Reuse the Session-scoped stop path; never pause or rewrite the schedule.
        const sent = this.chat.cancelYeaftSession(this.session.id, { agentId: this.agentId });
        if (sent === false) throw new Error(this.$t('scheduledTasks.failed'));
      } catch (error) {
        this.error = error?.message || this.$t('scheduledTasks.failed');
        this.stopping = false;
      }
    },
  },
  template: `
    <section class="yeaft-session-status-section yeaft-session-status-scheduled-task scheduled-task-bar" :aria-label="$t('scheduledTasks.task')">
      <header class="yeaft-session-status-section-header">
        <span>{{ $t('scheduledTasks.task') }}</span>
        <div class="scheduled-task-bar-actions" role="group" :aria-label="$t('scheduledTasks.task')">
          <button type="button" class="btn-ghost scheduled-task-run" :disabled="busy || stopping || !!unavailable" :aria-label="$t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.runOnce')" :aria-description="$t('scheduledTasks.runOnceHelp')" :title="$t(unavailable || (busy ? 'scheduledTasks.starting' : 'scheduledTasks.runOnceHelp'))" :aria-busy="busy" @click="run">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>
          </button>
          <button type="button" class="btn-ghost scheduled-task-stop" :disabled="stopping || !running || !!stopUnavailable" :aria-label="$t(stopping ? 'scheduledTasks.stopping' : 'scheduledTasks.stop')" :aria-description="$t('scheduledTasks.stopHelp')" :title="$t(stopUnavailable || (stopping ? 'scheduledTasks.stopping' : 'scheduledTasks.stopHelp'))" :aria-busy="stopping" @click="stop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
          </button>
          <button type="button" class="btn-ghost scheduled-task-configure" :aria-label="$t('scheduledTasks.configure')" :title="$t('scheduledTasks.configure')" @click="$emit('configure')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2.5 4.3 1.5 1.7v2.3l-1.5 1.6 2.5 4.3 2.1-.5 2 .9.7 2.2h5l.7-2.2 2-.9 2.1.5 2.5-4.3-1.5-1.6v-2.3l1.5-1.7-2.5-4.3-2.1.5-2-.9-.7-2.2Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </header>
      <div class="scheduled-task-summary">
        <dl class="scheduled-task-runtime">
          <div>
            <dt>{{ $t('scheduledTasks.lastRun') }}</dt>
            <dd><span role="status">{{ lastStatus }}</span><time v-if="lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt">{{ formatTime(lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt) }}</time></dd>
          </div>
          <div>
            <dt>{{ $t('scheduledTasks.nextRun') }}</dt>
            <dd><time v-if="task.enabled && nextRunAt">{{ formatTime(nextRunAt) }}</time><span v-else>{{ $t(task.trigger?.type === 'manual' ? 'scheduledTasks.trigger.manual' : !task.enabled ? 'scheduledTasks.paused' : 'scheduledTasks.none') }}</span></dd>
          </div>
        </dl>
        <p v-if="unavailable && unavailable !== 'scheduledTasks.running'" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
        <p v-if="taskError" class="scheduled-task-error" role="alert">{{ taskError }}</p>
      </div>
    </section>
  `,
};
