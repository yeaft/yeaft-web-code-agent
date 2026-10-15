import PersonTaskBrowser from './PersonTaskBrowser.js';
import { usageKnown, usageNumber, usageInput, usageExtras, usageDuration } from './PersonTurnUsage.js';

/** Live main-thread metadata and independently owned background work. Never renders
 * trace text, request content, or pause controls for an operating-system process.
 */
export default {
  name: 'PersonManagement',
  components: { PersonTaskBrowser },
  props: { execution: Object, page: Object, log: Object, disabled: Boolean, autonomySupported: Boolean, autonomyEnabled: Boolean, autonomyPending: Boolean, autonomyDisabled: Boolean, identityKey: { default: '' } },
  emits: ['refresh', 'more', 'log', 'stop', 'pause', 'resume', 'cancel', 'autonomy'],
  setup(props, { emit }) {
    const confirming = Vue.ref(false);
    const controls = Vue.ref(null);
    const now = Vue.ref(Date.now());
    const active = Vue.computed(() => props.execution.active);
    const blocked = Vue.computed(() => props.disabled || props.execution.stale || !!props.execution.pending);
    let receivedAt = Date.now();
    let timer;
    const foreground = () => document.visibilityState !== 'hidden';
    function clock() {
      clearInterval(timer);
      now.value = Date.now();
      if (foreground() && active.value && !props.execution.stale && !props.disabled) timer = setInterval(() => { now.value = Date.now(); }, 1000);
    }
    Vue.watch(() => props.execution.active, () => { receivedAt = Date.now(); clock(); }, { immediate: true });
    // A metadata poll must not close a confirmation or steal keyboard focus.
    Vue.watch([() => props.identityKey, () => active.value?.episodeId, () => active.value?.status, blocked], () => { confirming.value = false; clock(); });
    Vue.onMounted(() => document.addEventListener('visibilitychange', clock));
    Vue.onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', clock); });
    const elapsed = Vue.computed(() => {
      const value = active.value;
      if (!value) return null;
      // Prefer Agent elapsed time, avoiding clock skew. Freeze stale projections.
      const base = usageKnown(value.elapsedMs) ? value.elapsedMs : null;
      return base == null ? null : base + (!props.execution.stale && !props.disabled ? Math.max(0, now.value - receivedAt) : 0);
    });
    const status = Vue.computed(() => ['running', 'pausing', 'paused', 'cancelling'].includes(active.value?.status) ? active.value.status : 'unknown');
    const step = Vue.computed(() => {
      if (status.value === 'paused') return 'paused';
      if (active.value?.capabilityId) return 'capability';
      return ['model', 'requesting', 'model_request', 'model_requesting', 'provider'].includes(active.value?.phase) ? 'model' : 'waiting';
    });
    const canCancel = Vue.computed(() => ['running', 'pausing', 'paused'].includes(status.value));
    function control(op) {
      if (blocked.value || !active.value?.episodeId) return;
      if (op === 'pause' && status.value !== 'running' || op === 'resume' && (status.value !== 'paused' || active.value.resumable === false) || op === 'cancel' && !canCancel.value) return;
      confirming.value = false;
      emit(op, active.value.episodeId);
    }
    function confirm() {
      if (blocked.value) return;
      confirming.value = true;
      Vue.nextTick(() => controls.value?.querySelector('.btn-secondary')?.focus());
    }
    function dismiss() {
      confirming.value = false;
      Vue.nextTick(() => controls.value?.querySelector('[data-execution-control="cancel"]')?.focus());
    }
    const callModel = call => call.model || call.dispatched?.model || call.requested?.model || '—';
    const callStatus = call => ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(call.status) ? call.status : 'unknown';
    const time = value => value ? new Date(value).toLocaleString() : '';
    return { active, blocked, confirming, controls, elapsed, status, step, canCancel, control, confirm, dismiss, callModel, callStatus, time,
      known: usageKnown, number: usageNumber, input: usageInput, extras: usageExtras, duration: usageDuration };
  },
  template: `
    <PersonTaskBrowser class="person-management" :page="page" :log="log" :disabled="disabled" :identity-key="identityKey"
      @refresh="$emit('refresh')" @more="$emit('more')" @log="(id, more) => $emit('log', id, more)" @stop="(kind, id) => $emit('stop', kind, id)">
      <template #before>
        <section v-if="autonomySupported" class="person-main-execution" :aria-busy="autonomyPending">
          <label><input type="checkbox" :checked="autonomyEnabled" :disabled="disabled || autonomyDisabled || autonomyPending" @change="$emit('autonomy', $event.target.checked)"> {{ $t('person.autonomy.label') }}</label>
          <p class="person-muted">{{ $t('person.autonomy.scope') }}</p>
          <p v-if="autonomyPending" class="person-muted" role="status">{{ $t('person.management.pending') }}</p>
        </section>
        <section class="person-main-execution" :aria-label="$t('person.management.main')" :aria-busy="execution.loading" :data-episode-id="active?.episodeId">
          <header class="person-turn-heading"><strong>{{ $t('person.management.main') }}</strong><span v-if="active" class="person-muted">{{ $t(active.kind === 'autonomous' ? 'person.autonomous' : 'person.autonomy.manual') }}</span><span v-if="active" class="person-muted" role="status">{{ $t('person.management.status.' + status) }}</span></header>
          <p v-if="execution.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ execution.error.message }}</p>
          <p v-if="execution.stale" class="person-muted" role="status">{{ $t('person.management.stale') }}</p>
          <p v-if="!active" class="person-muted">{{ $t(execution.loading && !execution.loaded ? 'person.loading' : 'person.management.empty') }}</p>
          <template v-else>
            <div class="person-turn-totals"><span>{{ $t('person.management.elapsed') }}: {{ duration(elapsed) }}</span><span>{{ $t('person.usage.loops', { n: number(active.loopCount) }) }}</span></div>
            <time class="person-muted">{{ time(active.startedAt) }}</time>
            <p class="person-execution-step">{{ $t('person.management.step.' + step) }}<template v-if="step === 'capability'"> · {{ active.capabilityId }}</template><template v-else-if="step === 'model'"> · {{ active.model || '—' }}</template></p>
            <p v-if="status === 'pausing'" class="person-muted" role="status">{{ $t('person.management.pauseBoundary') }}</p>
            <div ref="controls" class="person-task-actions person-execution-actions">
              <button v-if="status === 'running'" type="button" class="btn-ghost" data-execution-control="pause" :disabled="blocked" @click="control('pause')">{{ $t('person.management.pause') }}</button>
              <button v-if="status === 'paused'" type="button" class="btn-ghost" data-execution-control="resume" :disabled="blocked || active.resumable === false" @click="control('resume')">{{ $t('person.management.resume') }}</button>
              <button v-if="canCancel && !confirming" type="button" class="btn-ghost" data-execution-control="cancel" :disabled="blocked" @click="confirm">{{ $t('person.management.cancel') }}</button>
              <template v-if="confirming && !blocked && canCancel">
                <span>{{ $t('person.management.cancelConfirm') }}</span>
                <button type="button" class="btn-secondary" data-execution-control="confirm-cancel" @click="control('cancel')">{{ $t('person.management.cancel') }}</button>
                <button type="button" class="btn-ghost" @click="dismiss">{{ $t('common.cancel') }}</button>
              </template>
              <span v-if="execution.pending" class="person-muted" role="status">{{ $t('person.management.pending') }}</span>
            </div>
            <p class="person-muted">{{ $t('person.management.scope') }}</p>
            <div class="person-execution-models">
              <article v-for="model in active.models || []" :key="model.model" class="person-execution-model">
                <header class="person-turn-heading"><strong>{{ model.model }}</strong><span>{{ $t('person.management.requestTime') }}: {{ duration(model.durationMs) }}</span></header>
                <div class="person-turn-totals">
                  <span>{{ $t('person.usage.' + input(model.usage)) }}: {{ number(model.usage?.[input(model.usage)]) }}</span>
                  <span>{{ $t('person.usage.outputTokens') }}: {{ number(model.usage?.outputTokens) }}</span>
                  <span>{{ $t('person.usage.total') }}: {{ number(model.usage?.totalTokens) }}</span>
                  <span v-for="field in extras(model.usage)" :key="field" class="person-muted">{{ $t('person.usage.' + field) }}: {{ number(model.usage[field]) }}</span>
                </div>
                <span v-if="!model.usage?.complete" class="person-muted">{{ $t('person.usage.partial') }}</span>
              </article>
            </div>
            <details v-if="active.calls?.length" class="person-execution-calls">
              <summary>{{ $t('person.management.recentCalls') }}</summary>
              <p v-if="active.callsTruncated" class="person-muted">{{ $t('person.management.callWindow', { n: number(active.calls.length) }) }}</p>
              <ol class="person-call-flow">
                <li v-for="call in active.calls" :key="call.callId || call.index" class="person-call-step">
                  <header class="person-turn-heading"><strong>{{ $t('person.usage.loop', { n: number(call.index) }) }}</strong><span class="person-muted">{{ $t('person.usage.status.' + callStatus(call)) }}</span></header>
                  <p class="person-call-model">{{ callModel(call) }} · {{ duration(call.durationMs) }}</p>
                  <div class="person-turn-totals"><span>{{ $t('person.usage.' + input(call.usage)) }}: {{ number(call.usage?.[input(call.usage)]) }}</span><span>{{ $t('person.usage.outputTokens') }}: {{ number(call.usage?.outputTokens) }}</span></div>
                  <span v-if="!call.usage?.complete" class="person-muted">{{ $t('person.usage.partial') }}</span>
                </li>
              </ol>
            </details>
          </template>
        </section>
      </template>
    </PersonTaskBrowser>
  `,
};
