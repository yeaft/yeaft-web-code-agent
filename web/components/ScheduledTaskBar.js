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
    stateLabel() { return this.$t(this.unavailable === 'scheduledTasks.running' ? this.unavailable : this.task.enabled ? 'scheduledTasks.enabled' : 'scheduledTasks.paused'); },
    taskError() { return this.error || this.lastRun?.error || this.task.lastError || ''; },
    detailsLabel() { return `${this.$t('scheduledTasks.task')}: ${this.stateLabel}${this.taskError ? ' · ' + this.$t('scheduledTasks.status.failed') : ''}`; },
  },
  watch: {
    error(value) { if (value && this.$refs.details) this.$refs.details.open = true; },
  },
  mounted() {
    document.addEventListener('pointerdown', this.closeOutside);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.closeOutside);
  },
  methods: {
    closeOutside(event) {
      if (!this.$el.contains(event.target) && this.$refs.details) this.$refs.details.open = false;
    },
    closeDetails() {
      if (this.$refs.details) this.$refs.details.open = false;
    },
    onEscape() {
      if (!this.$refs.details?.open) return;
      this.closeDetails();
      this.$refs.summary?.focus();
    },
    configure() {
      if (this.$refs.details?.open) {
        this.closeDetails();
        this.$refs.summary?.focus();
      }
      this.$emit('configure');
    },
    formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
    },
    async run() {
      if (this.busy || this.unavailable) return;
      this.closeDetails();
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
    <div class="scheduled-task-bar" @keydown.esc="onEscape">
      <details ref="details" class="scheduled-task-mobile-details">
        <summary ref="summary" class="scheduled-task-mobile-toggle" :class="{ 'is-paused': !task.enabled, 'has-error': !!taskError }" :aria-label="detailsLabel" :title="detailsLabel">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-14 5 3 3 6-6"/></svg>
          <span class="scheduled-task-mobile-state" aria-hidden="true"></span>
        </summary>
        <div class="scheduled-task-mobile-panel">
          <strong>{{ $t('scheduledTasks.task') }} · {{ stateLabel }}</strong>
          <p v-if="unavailable && unavailable !== 'scheduledTasks.running'" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
          <p v-else class="scheduled-task-help">
            <template v-if="task.enabled && nextRunAt">{{ $t('scheduledTasks.nextRun') }} <time>{{ formatTime(nextRunAt) }}</time></template>
            <template v-else>{{ $t(task.trigger?.type === 'manual' ? 'scheduledTasks.trigger.manual' : 'scheduledTasks.none') }}</template>
            <span aria-hidden="true"> · </span><span>{{ lastStatus }}</span>
          </p>
          <p v-if="taskError" class="scheduled-task-error" role="alert">{{ taskError }}</p>
          <button type="button" class="btn btn-secondary" @click="configure">{{ $t('scheduledTasks.configure') }}</button>
        </div>
      </details>
      <div class="scheduled-task-summary">
        <div class="scheduled-task-summary-heading">
          <strong>{{ $t('scheduledTasks.task') }}</strong>
          <span class="scheduled-task-state" :class="{ 'is-paused': !task.enabled }">{{ stateLabel }}</span>
        </div>
        <p v-if="unavailable && unavailable !== 'scheduledTasks.running'" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
        <p v-else class="scheduled-task-help">
          <template v-if="task.enabled && nextRunAt">{{ $t('scheduledTasks.nextRun') }} <time>{{ formatTime(nextRunAt) }}</time></template>
          <template v-else>{{ $t(task.trigger?.type === 'manual' ? 'scheduledTasks.trigger.manual' : 'scheduledTasks.none') }}</template>
          <span aria-hidden="true"> · </span><span :title="formatTime(lastRun?.finishedAt || lastRun?.startedAt || task.lastRunAt)">{{ lastStatus }}</span>
        </p>
      </div>
      <div class="scheduled-task-bar-actions">
        <button type="button" class="btn btn-secondary scheduled-task-desktop-configure" @click="configure">{{ $t('scheduledTasks.configure') }}</button>
        <button type="button" class="btn btn-primary scheduled-task-run" :disabled="busy || !!unavailable" :aria-label="$t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.run')" :title="$t(unavailable || (busy ? 'scheduledTasks.starting' : 'scheduledTasks.run'))" :aria-busy="busy" @click="run">
          <svg class="scheduled-task-run-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>
          <span class="scheduled-task-run-label">{{ $t(busy ? 'scheduledTasks.starting' : 'scheduledTasks.run') }}</span>
        </button>
      </div>
      <p v-if="taskError" class="scheduled-task-error scheduled-task-desktop-error" role="alert">{{ taskError }}</p>
    </div>
  `,
};
