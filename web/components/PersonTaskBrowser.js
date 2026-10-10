import PersonInspectorList, { newestPersonRecords } from './PersonInspectorList.js';

/** Person-owned effects across episodes, not just the last conversation turn.
 * Logs and child reports are untrusted text; never rendered as HTML.
 */
export default {
  name: 'PersonTaskBrowser',
  components: { PersonInspectorList },
  props: { page: Object, log: Object, disabled: Boolean, identityKey: { default: '' } },
  emits: ['refresh', 'log', 'stop'],
  setup(props, { emit }) {
    const confirming = Vue.ref('');
    const terminal = status => ['succeeded', 'completed', 'failed', 'cancelled', 'orphaned', 'closed', 'abandoned'].includes(status);
    const entries = Vue.computed(() => newestPersonRecords([
      ...props.page.tasks.filter(task => task.kind !== 'sub_agent').map(task => ({ ...task, recordId: task.id, id: 'shell:' + task.id, recordKind: 'shell' })),
      ...props.page.agents.map(agent => ({ ...agent, recordId: agent.id, id: 'agent:' + agent.id, recordKind: 'agent', taskId: agent.taskId || props.page.tasks.find(task => task.agentId === agent.id)?.id })),
    ]));
    const estimate = () => 200;
    const logElement = Vue.ref(null);
    let trigger = null;
    function confirm(id, event) {
      confirming.value = id;
      trigger = event.currentTarget.closest('.person-task-actions');
      Vue.nextTick(() => trigger?.querySelector('.btn-secondary')?.focus());
    }
    function cancelConfirm() {
      confirming.value = '';
      Vue.nextTick(() => trigger?.querySelector('button:last-of-type')?.focus());
    }
    function viewLog(id) {
      emit('log', id);
      Vue.nextTick(() => {
        logElement.value?.scrollIntoView?.({ block: 'nearest' });
        logElement.value?.focus();
      });
    }
    Vue.watch(() => props.identityKey || props.page, () => { confirming.value = ''; trigger = null; });
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
      cancelConfirm();
      emit('stop', kind, id);
    }
    return { confirming, status, canStop, time, stop, entries, estimate, logElement, confirm, cancelConfirm, viewLog };
  },
  template: `
    <section class="person-task-browser person-journal" :aria-label="$t('person.tasks')" :aria-busy="page.loading">
      <div class="person-journal-toolbar">
        <span class="person-muted">{{ $t('person.tasksScope') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || page.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <PersonInspectorList :items="entries" :label="$t('person.tasks')" :reset-key="identityKey || page" :estimate-height="estimate" :loading="page.loading" :disabled="disabled">
        <template #before>
        <p v-if="page.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ page.error.message }}</p>
        <p v-if="page.stale" class="person-muted" role="status">{{ $t('person.tasksStale') }}</p>
        <p v-if="page.loading && !page.loaded" class="person-muted" role="status">{{ $t('person.loading') }}</p>
        <p v-else-if="page.loaded && !page.tasks.length && !page.agents.length" class="person-empty">{{ $t('person.tasksEmpty') }}</p>
        <p v-if="page.truncated" class="person-muted">{{ $t('person.tasksTruncated') }}</p>
        </template>
        <template #default="{ item }">
            <article class="person-task-item" :data-task-id="item.recordId">
              <p class="person-muted">{{ $t(item.recordKind === 'shell' ? 'person.backgroundTasks' : 'person.childThreads') }}</p>
              <div class="person-task-heading"><strong>{{ item.title || item.name || item.recordId }}</strong><span class="person-muted">{{ $t('person.taskStatus.' + status(item)) }}</span></div>
              <p v-if="item.executionPending" class="person-muted" role="status">{{ $t('person.taskExecutionPending') }}</p>
              <p v-if="item.mission" class="person-prose person-muted">{{ item.mission }}</p>
              <time class="person-muted">{{ time(item.updatedAt || item.createdAt) }}</time>
              <details v-if="item.result"><summary>{{ $t('person.taskResult') }}</summary><pre>{{ item.result }}</pre></details>
              <div class="person-task-actions">
                <button v-if="item.recordKind === 'shell' || item.taskId" type="button" class="btn-ghost" :disabled="disabled" @click="viewLog(item.taskId || item.recordId)">{{ $t('person.taskLog') }}</button>
                <button v-if="canStop(item) && confirming !== item.id" type="button" class="btn-ghost" :disabled="disabled || !!page.pending" @click="confirm(item.id, $event)">{{ $t('person.stopTask') }}</button>
                <template v-if="confirming === item.id && canStop(item)">
                  <span>{{ $t('person.stopTaskConfirm') }}</span>
                  <button type="button" class="btn-secondary" :disabled="disabled || !!page.pending" @click="stop(item.recordKind, item.recordId)">{{ $t('person.stopTask') }}</button>
                  <button type="button" class="btn-ghost" @click="cancelConfirm">{{ $t('common.cancel') }}</button>
                </template>
                <span v-if="page.pending === item.recordId" role="status" class="person-muted">{{ $t('person.cancelling') }}</span>
              </div>
            </article>
        </template>
        <template #after>
        <section v-if="log.taskId" class="person-task-log" :aria-label="$t('person.taskLog')" :aria-busy="log.loading">
          <h3>{{ $t('person.taskLog') }}</h3>
          <p v-if="log.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ log.error.message }}</p>
          <pre ref="logElement" tabindex="0">{{ log.text || $t(log.loading ? 'person.loading' : 'person.taskLogEmpty') }}</pre>
          <button type="button" class="btn-ghost" :disabled="disabled || log.loading" @click="$emit('log', log.taskId, true)">{{ $t('person.taskLogContinue') }}</button>
        </section>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
