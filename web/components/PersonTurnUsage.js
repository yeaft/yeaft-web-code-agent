import PersonInspectorList, { newestPersonRecords } from './PersonInspectorList.js';

/** Durable, metadata-only turn diagnostics. No prompt or hidden reasoning is shown. */
export default {
  name: 'PersonTurnUsage',
  components: { PersonInspectorList },
  props: { page: Object, disabled: Boolean, identityKey: { default: '' } },
  emits: ['refresh', 'more'],
  setup(props) {
    const entries = Vue.computed(() => newestPersonRecords(props.page.items));
    const estimate = () => 160;
    const number = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—';
    const time = value => value ? new Date(value).toLocaleString() : '';
    const statusKey = value => ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget_exhausted', 'rejected'].includes(value) ? value : 'unknown';
    const usageFields = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];
    return { entries, estimate, number, time, statusKey, usageFields };
  },
  template: `
    <section id="person-turns" class="person-journal person-turn-usage" :aria-label="$t('person.turns')" :aria-busy="page.loading">
      <div class="person-journal-toolbar">
        <span class="person-muted">{{ $t('person.usage.scope') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || page.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <PersonInspectorList :items="entries" :label="$t('person.turns')" :reset-key="identityKey || page" :page-token="page.nextCursor" :estimate-height="estimate"
        :more="page.nextCursor != null" :more-label="$t('person.usage.older')" :loading="page.loading" :disabled="disabled" :stale="page.stale" :error="!!page.error" @more="$emit('more')">
        <template #before>
        <p v-if="page.error" class="person-settings-error" role="alert">{{ $t('person.requestFailed') }} {{ page.error.message }}</p>
        <p v-if="page.stale" class="person-muted" role="status">{{ $t('person.usage.stale') }}</p>
        <p v-if="page.loading && !page.loaded" class="person-muted" role="status">{{ $t('person.loading') }}</p>
        <p v-else-if="page.loaded && !page.items.length" class="person-empty">{{ $t('person.usage.empty') }}</p>
        <p v-if="page.items.length" class="person-muted person-usage-note">{{ $t('person.usage.accounting') }}</p>
        </template>
        <template #default="{ item: turn }">
        <details class="person-turn-row" :data-turn-id="turn.id">
          <summary>
            <span class="person-turn-heading"><strong>{{ $t('person.usage.turn', { n: turn.seq }) }} · {{ $t('person.' + turn.kind) }}</strong><span class="person-muted">{{ $t('person.usage.status.' + statusKey(turn.status)) }}</span></span>
            <time class="person-muted">{{ time(turn.createdAt) }}</time>
            <span class="person-turn-totals"><span>{{ $t('person.usage.loops', { n: turn.calls.length }) }}</span><span>{{ $t('person.usage.total') }}: {{ number(turn.usage?.totalTokens) }}</span></span>
            <span v-if="turn.models?.length" class="person-turn-models">{{ turn.models.join(' → ') }}</span>
            <span v-if="!turn.usage?.complete" class="person-muted">{{ $t('person.usage.partial') }}</span>
          </summary>
          <div class="person-turn-detail">
            <dl class="person-usage-metrics">
              <template v-for="field in usageFields" :key="field"><dt>{{ $t('person.usage.' + field) }}</dt><dd>{{ number(turn.usage?.[field]) }}</dd></template>
              <dt>{{ $t('person.usage.inputTotalTokens') }}</dt><dd>{{ number(turn.usage?.inputTotalTokens) }}</dd>
              <dt>{{ $t('person.usage.callBudget') }}</dt><dd>{{ number(turn.budget?.calls) }}</dd>
            </dl>
            <p v-if="turn.terminalCode" class="person-muted">{{ turn.terminalCode }}</p>
            <p v-if="!turn.calls.length" class="person-muted">{{ $t('person.usage.noCalls') }}</p>
            <ol class="person-call-flow">
              <li v-for="call in turn.calls" :key="call.callId" class="person-call-step" :data-call-id="call.callId">
                <header class="person-turn-heading"><strong>{{ $t('person.usage.loop', { n: call.index }) }}</strong><span class="person-muted">{{ $t('person.usage.status.' + statusKey(call.status)) }}</span></header>
                <dl class="person-usage-metrics">
                  <dt>{{ $t('person.usage.model') }}</dt><dd>{{ call.dispatched?.model || call.requested?.model || '—' }}</dd>
                  <dt>{{ $t('person.usage.requestedEffort') }}</dt><dd>{{ call.requested?.effort || '—' }}</dd>
                  <dt>{{ $t('person.usage.effort') }}</dt><dd>{{ call.effective?.effort || '—' }}</dd>
                  <dt>{{ $t('person.usage.selection') }}</dt><dd>{{ call.selectionOrigin || '—' }}</dd>
                  <template v-for="field in usageFields" :key="field"><dt>{{ $t('person.usage.' + field) }}</dt><dd>{{ number(call.usage?.[field]) }}</dd></template>
                  <dt>{{ $t('person.usage.total') }}</dt><dd>{{ number(call.usage?.totalTokens) }}</dd>
                  <dt>{{ $t('person.usage.context') }}</dt><dd>{{ number(call.contextBytes) }} / {{ number(call.contextBudgetBytes) }}</dd>
                  <dt>{{ $t('person.usage.outputReserve') }}</dt><dd>{{ number(call.outputTokensReserved) }}</dd>
                </dl>
                <p v-if="call.reason" class="person-muted">{{ call.reason }}</p>
                <p v-if="call.capability" class="person-call-capability"><span>{{ call.capability.id }}</span><span class="person-muted">{{ $t('person.usage.status.' + statusKey(call.capability.status)) }}<template v-if="call.capability.code"> · {{ call.capability.code }}</template></span></p>
                <p v-if="!call.usage?.complete" class="person-muted">{{ $t('person.usage.partial') }}</p>
                <p v-if="call.code" class="person-muted">{{ call.code }}</p>
              </li>
            </ol>
          </div>
        </details>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
