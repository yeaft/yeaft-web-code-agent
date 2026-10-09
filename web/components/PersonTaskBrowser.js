/** Person-owned effects across episodes, not just the last conversation turn.
 * Logs and child reports are untrusted text; never rendered as HTML.
 */
export default {
  name: 'PersonTaskBrowser',
  props: { page: Object, log: Object, disabled: Boolean },
  emits: ['refresh', 'log', 'stop'],
  setup(props, { emit }) {
    const confirming = Vue.ref('');
    const terminal = status => ['succeeded', 'completed', 'failed', 'cancelled', 'orphaned', 'closed', 'abandoned'].includes(status);
    const groups = Vue.computed(() => [
      { kind: 'shell', label: 'person.backgroundTasks', items: props.page.tasks.filter(task => task.kind !== 'sub_agent') },
      { kind: 'agent', label: 'person.childThreads', items: props.page.agents.map(agent => ({ ...agent, taskId: props.page.tasks.find(task => task.agentId === agent.id)?.id })) },
    ]);
    const time = value => value ? new Date(value).toLocaleString() : '';
    const status = item => {
      if (item.recoveryStatus === 'orphaned') return 'orphaned';
      if (item.outcome?.reason === 'budget_exceeded') return 'budget_exceeded';
      if (item.outcome?.status === 'incomplete') return 'incomplete';
      return item.status;
    };
    const canStop = item => item.recoveryStatus !== 'orphaned' && item.status !== 'orphaned'
      && (item.executionPending || !terminal(item.status));
    function stop(kind, id) {
      if (props.disabled || props.page.pending) return;
      confirming.value = '';
      emit('stop', kind, id);
    }
    return { confirming, status, canStop, time, stop, groups };
  },
  template: `
    <section class="person-task-browser person-journal" :aria-label="$t('person.tasks')" :aria-busy="page.loading">
      <div class="person-journal-toolbar">
        <span class="person-muted">{{ $t('person.tasksScope') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || page.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <div class="person-journal-scroll" tabindex="0" role="region" :aria-label="$t('person.tasks')">
        <p v-if="page.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ page.error.message }}</p>
        <p v-if="page.stale" class="person-muted" role="status">{{ $t('person.tasksStale') }}</p>
        <p v-if="page.loading && !page.loaded" class="person-muted" role="status">{{ $t('person.loading') }}</p>
        <p v-else-if="page.loaded && !page.tasks.length && !page.agents.length" class="person-empty">{{ $t('person.tasksEmpty') }}</p>
        <p v-if="page.truncated" class="person-muted">{{ $t('person.tasksTruncated') }}</p>
        <template v-for="group in groups" :key="group.kind">
          <div v-if="group.items.length" class="person-task-group">
            <h3>{{ $t(group.label) }}</h3>
            <article v-for="item in group.items" :key="item.id" class="person-task-item" :data-task-id="item.id">
              <div class="person-task-heading"><strong>{{ item.title || item.name || item.id }}</strong><span class="person-muted">{{ $t('person.taskStatus.' + status(item)) }}</span></div>
              <p v-if="item.executionPending" class="person-muted" role="status">{{ $t('person.taskExecutionPending') }}</p>
              <p v-if="item.mission" class="person-prose person-muted">{{ item.mission }}</p>
              <time class="person-muted">{{ time(item.createdAt) }}</time>
              <details v-if="item.result"><summary>{{ $t('person.taskResult') }}</summary><pre>{{ item.result }}</pre></details>
              <div class="person-task-actions">
                <button v-if="group.kind === 'shell' || item.taskId" type="button" class="btn-ghost" :disabled="disabled" @click="$emit('log', item.taskId || item.id)">{{ $t('person.taskLog') }}</button>
                <button v-if="canStop(item) && confirming !== item.id" type="button" class="btn-ghost" :disabled="disabled || !!page.pending" @click="confirming = item.id">{{ $t('person.stopTask') }}</button>
                <template v-if="confirming === item.id && canStop(item)">
                  <span>{{ $t('person.stopTaskConfirm') }}</span>
                  <button type="button" class="btn-secondary" :disabled="disabled || !!page.pending" @click="stop(group.kind, item.id)">{{ $t('person.stopTask') }}</button>
                  <button type="button" class="btn-ghost" @click="confirming = ''">{{ $t('common.cancel') }}</button>
                </template>
                <span v-if="page.pending === item.id" role="status" class="person-muted">{{ $t('person.cancelling') }}</span>
              </div>
            </article>
          </div>
        </template>
        <section v-if="log.taskId" class="person-task-log" :aria-label="$t('person.taskLog')" :aria-busy="log.loading">
          <h3>{{ $t('person.taskLog') }}</h3>
          <p v-if="log.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ log.error.message }}</p>
          <pre tabindex="0">{{ log.text || $t(log.loading ? 'person.loading' : 'person.taskLogEmpty') }}</pre>
          <button type="button" class="btn-ghost" :disabled="disabled || log.loading" @click="$emit('log', log.taskId, true)">{{ $t('person.taskLogContinue') }}</button>
        </section>
      </div>
    </section>
  `,
};
