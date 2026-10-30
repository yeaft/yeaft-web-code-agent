import ScheduledTaskEditor from './ScheduledTaskEditor.js';

export function scheduledTaskUnavailable(chat, agentId, sessionId, task, { allowRunning = false } = {}) {
  if (chat?.scheduledTaskProtocolSupported !== true) return 'scheduledTasks.serverUpgrade';
  const agent = chat?.agents?.find(item => item.id === agentId);
  if (!agent?.online || (chat.connectionState && chat.connectionState !== 'connected')) return 'scheduledTasks.offline';
  if (!agent.capabilities?.includes('scheduled_tasks')) return 'scheduledTasks.upgrade';
  if (!allowRunning && (task?.lastRun?.status === 'running' || task?.running || task?.status === 'running' || task?.runtime?.status === 'running'
      || chat.isYeaftSessionProcessing?.(sessionId, agentId))) return 'scheduledTasks.running';
  return '';
}

export function taskResultError(result) {
  if (result === false || result?.ok === false || result?.error) {
    return typeof result?.error === 'string' ? result.error : (result?.error?.message || result?.error?.code || '');
  }
  return null;
}

// Keep runtime changes out of both the edit payload and the dirty/stale fence.
function taskConfig(task) {
  return JSON.parse(JSON.stringify({ prompt: task.prompt, trigger: task.trigger, enabled: task.enabled, notify: task.notify !== false }));
}
function configKey(value) {
  return JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
  });
}

export default {
  name: 'ScheduledTaskSettings',
  emits: ['busy'],
  components: { ScheduledTaskEditor },
  props: {
    task: { type: Object, required: true },
    agentId: { type: String, required: true },
    sessionId: { type: String, required: true },
  },
  data() {
    const draft = taskConfig(this.task);
    return { draft, baseKey: configKey(draft), baseRevision: this.task.revision, editorVersion: 0, stale: false, valid: false, busy: false, error: '', saved: false };
  },
  computed: {
    chat() { try { return window.Pinia?.useChatStore?.() || null; } catch { return null; } },
    monthDaysSupported() { return this.chat?.agents?.find(item => item.id === this.agentId)?.capabilities?.includes('scheduled_task_month_days') === true; },
    unavailable() { return scheduledTaskUnavailable(this.chat, this.agentId, this.sessionId, this.task, { allowRunning: true })
      || (this.draft.trigger?.recurrence?.daysOfMonth && !this.monthDaysSupported ? 'scheduledTasks.monthDaysUpgrade' : ''); },
    dirty() { return configKey(this.draft) !== this.baseKey; },
    snapshotKey() { return configKey({ config: taskConfig(this.task), revision: this.task.revision }); },
    canSave() { return !this.busy && this.valid && this.dirty && !this.stale && !this.unavailable; },
  },
  watch: {
    snapshotKey() { if (!this.busy) this.reconcileSnapshot(); },
    dirty(value) { if (value) this.saved = false; },
  },
  methods: {
    reload() {
      this.draft = taskConfig(this.task);
      this.baseKey = configKey(this.draft);
      this.baseRevision = this.task.revision;
      this.stale = false;
      this.error = '';
      this.saved = false;
      // Reset the shared schedule editor's local calendar draft as well.
      this.editorVersion++;
    },
    reconcileSnapshot() {
      if (configKey(taskConfig(this.task)) === this.baseKey && this.task.revision === this.baseRevision) return;
      if (!this.dirty && !this.stale) this.reload();
      else this.stale = true;
    },
    async save() {
      if (!this.canSave) return;
      const snapshotAtStart = this.snapshotKey;
      const submitted = taskConfig({ ...this.draft, prompt: this.draft.prompt.trim() });
      this.busy = true;
      this.$emit('busy', true);
      this.error = '';
      this.saved = false;
      try {
        const result = await this.chat.updateScheduledTask({
          agentId: this.agentId, sessionId: this.sessionId,
          task: submitted, expectedRevision: this.baseRevision,
        });
        const error = taskResultError(result);
        if (error !== null) {
          this.error = result?.error?.code === 'task_conflict' ? this.$t('scheduledTasks.conflict') : (error || this.$t('scheduledTasks.failed'));
          if (result?.error?.code === 'task_conflict') this.stale = true;
        } else {
          const acknowledged = result?.session?.task || result?.task;
          const config = acknowledged ? taskConfig(acknowledged) : submitted;
          this.draft = config;
          this.baseKey = configKey(config);
          this.baseRevision = acknowledged?.revision ?? (configKey(taskConfig(this.task)) === this.baseKey ? this.task.revision : this.baseRevision);
          this.stale = false;
          this.saved = true;
          this.editorVersion++;
        }
      } catch (error) { this.error = error?.message || this.$t('scheduledTasks.failed'); }
      finally {
        this.busy = false;
        this.$emit('busy', false);
        // A broadcast can precede its own ACK. Reconcile only a new snapshot;
        // the unchanged pre-save prop is not evidence of an external edit.
        if (this.snapshotKey !== snapshotAtStart) this.reconcileSnapshot();
      }
    },
  },
  template: `
    <div class="scheduled-task-settings" :aria-busy="busy">
      <div class="scheduled-task-settings-scroll">
        <p v-if="unavailable" class="scheduled-task-help" role="status">{{ $t(unavailable) }}</p>
        <div v-if="stale" class="scheduled-task-stale" role="status">
          <p>{{ $t('scheduledTasks.stale') }}</p>
          <button type="button" class="btn btn-secondary" :disabled="busy" @click="reload">{{ $t('scheduledTasks.reload') }}</button>
        </div>
        <ScheduledTaskEditor :key="editorVersion" v-model="draft" :monthly-multiple-supported="monthDaysSupported" :disabled="busy || !!unavailable" @valid="valid = $event" />
      </div>
      <footer class="scheduled-task-settings-footer">
        <p v-if="error" class="scheduled-task-error" role="alert">{{ error }}</p>
        <div class="scheduled-task-save-row">
          <span class="scheduled-task-help" role="status">{{ $t(saved ? 'scheduledTasks.saved' : dirty ? 'scheduledTasks.unsaved' : 'scheduledTasks.upToDate') }}</span>
          <button type="button" class="btn btn-primary" :disabled="!canSave" @click="save">{{ $t(busy ? 'scheduledTasks.saving' : 'scheduledTasks.save') }}</button>
        </div>
      </footer>
    </div>
  `,
};
