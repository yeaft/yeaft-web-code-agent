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
    const known = value => Number.isFinite(value) && value >= 0;
    const number = value => known(value) ? value.toLocaleString() : '—';
    const time = value => value ? new Date(value).toLocaleString() : '';
    const statusKey = value => ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget_exhausted', 'rejected'].includes(value) ? value : 'unknown';
    // Exact inclusive input takes precedence, but never invent cache semantics
    // for older records. Unknown primary counts remain visible, not zero.
    const input = usage => known(usage?.inputTotalTokens) ? 'inputTotalTokens' : 'inputTokens';
    const extras = usage => ['reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'].filter(field => known(usage?.[field]) && usage[field] > 0);
    return { entries, estimate, known, number, time, statusKey, input, extras };
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
        <details v-if="page.items.length" class="person-usage-accounting">
          <summary>{{ $t('person.usage.accountingLabel') }}</summary>
          <p class="person-muted">{{ $t('person.usage.accounting') }}</p>
        </details>
        </template>
        <template #default="{ item: turn }">
        <details class="person-turn-row" :data-turn-id="turn.id">
          <summary>
            <span class="person-turn-heading"><strong>{{ $t('person.usage.turn', { n: turn.seq }) }} · {{ $t('person.' + turn.kind) }}</strong><span class="person-muted">{{ $t('person.usage.status.' + statusKey(turn.status)) }}</span></span>
            <time class="person-muted">{{ time(turn.createdAt) }}</time>
            <span class="person-turn-totals">
              <span>{{ $t('person.usage.loops', { n: turn.calls.length }) }}</span>
              <span>{{ $t('person.usage.' + input(turn.usage)) }}: {{ number(turn.usage?.[input(turn.usage)]) }}</span>
              <span>{{ $t('person.usage.outputTokens') }}: {{ number(turn.usage?.outputTokens) }}</span>
              <span v-if="known(turn.usage?.totalTokens)">{{ $t('person.usage.total') }}: {{ number(turn.usage.totalTokens) }}</span>
            </span>
            <span v-if="turn.models?.length" class="person-turn-models">{{ turn.models.join(' → ') }}</span>
            <span v-if="!turn.usage?.complete" class="person-muted">{{ $t('person.usage.partial') }}</span>
          </summary>
          <div class="person-turn-detail">
            <p v-if="turn.terminalCode" class="person-muted">{{ turn.terminalCode }}</p>
            <p v-if="!turn.calls.length" class="person-muted">{{ $t('person.usage.noCalls') }}</p>
            <ol class="person-call-flow">
              <li v-for="call in turn.calls" :key="call.callId" class="person-call-step" :data-call-id="call.callId">
                <header class="person-turn-heading"><strong>{{ $t('person.usage.loop', { n: call.index }) }}</strong><span class="person-muted">{{ $t('person.usage.status.' + statusKey(call.status)) }}</span></header>
                <p class="person-call-model">{{ call.dispatched?.model || call.requested?.model || '—' }}<span v-if="call.effective?.effort" class="person-muted"> · {{ $t('person.usage.effort') }}: {{ call.effective.effort }}</span></p>
                <div class="person-turn-totals person-call-tokens">
                  <span>{{ $t('person.usage.' + input(call.usage)) }}: {{ number(call.usage?.[input(call.usage)]) }}</span>
                  <span>{{ $t('person.usage.outputTokens') }}: {{ number(call.usage?.outputTokens) }}</span>
                  <span v-for="field in extras(call.usage)" :key="field" class="person-muted">{{ $t('person.usage.' + field) }}: {{ number(call.usage[field]) }}</span>
                </div>
                <dl class="person-usage-metrics person-context-metrics">
                  <template v-if="known(call.contextWindowTokens)"><dt>{{ $t('person.usage.modelWindow') }}</dt><dd>{{ number(call.contextWindowTokens) }} tokens</dd></template>
                  <template v-if="known(call.contextBytes)"><dt>{{ $t('person.usage.requestSize') }}</dt><dd>{{ number(call.contextBytes) }} {{ $t('person.usage.bytes') }}</dd></template>
                  <template v-if="call.contextSources">
                    <dt>{{ $t('person.usage.history') }}</dt><dd>{{ $t('person.usage.messagesCount', { n: number(call.contextSources.recentMessages) }) }}</dd>
                    <dt>{{ $t('person.usage.concepts') }}</dt><dd>{{ $t('person.usage.conceptsCount', { n: number(call.contextSources.recentConcepts) }) }}</dd>
                    <template v-if="call.contextSources.recall?.kind"><dt>{{ $t('person.usage.recall') }}</dt><dd>{{ $t('person.usage.' + (call.contextSources.recall.kind === 'messages' ? 'messagesCount' : 'conceptsCount'), { n: number(call.contextSources.recall.count) }) }}</dd></template>
                  </template>
                </dl>
                <p v-if="call.contextSources && (call.contextSources.omittedMessages > 0 || call.contextSources.omittedConcepts > 0)" class="person-muted">{{ $t('person.usage.omitted', { messages: number(call.contextSources.omittedMessages), concepts: number(call.contextSources.omittedConcepts) }) }}</p>
                <p v-if="call.capability" class="person-call-capability"><span>{{ call.capability.id }}</span><span class="person-muted">{{ $t('person.usage.status.' + statusKey(call.capability.status)) }}<template v-if="call.capability.code"> · {{ call.capability.code }}</template></span></p>
                <p v-if="call.code" class="person-muted">{{ call.code }}</p>
                <details class="person-call-diagnostics">
                  <summary>{{ $t('person.usage.diagnostics') }}</summary>
                  <dl class="person-usage-metrics">
                    <template v-if="known(turn.budget?.calls)"><dt>{{ $t('person.usage.callBudget') }}</dt><dd>{{ number(turn.budget.calls) }}</dd></template>
                    <template v-if="call.requested?.effort"><dt>{{ $t('person.usage.requestedEffort') }}</dt><dd>{{ call.requested.effort }}</dd></template>
                    <template v-if="call.selectionOrigin"><dt>{{ $t('person.usage.selection') }}</dt><dd>{{ call.selectionOrigin }}</dd></template>
                    <template v-if="known(call.contextBudgetBytes)"><dt>{{ $t('person.usage.requestBudget') }}</dt><dd>{{ number(call.contextBudgetBytes) }} {{ $t('person.usage.bytes') }}</dd></template>
                    <template v-if="known(call.outputTokensReserved)"><dt>{{ $t('person.usage.outputReserve') }}</dt><dd>{{ number(call.outputTokensReserved) }}</dd></template>
                  </dl>
                  <p v-if="call.reason" class="person-muted">{{ call.reason }}</p>
                  <p class="person-muted">{{ $t('person.usage.contextNote') }}</p>
                </details>
              </li>
            </ol>
          </div>
        </details>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
