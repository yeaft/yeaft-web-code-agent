import PersonInspectorList, { newestPersonRecords } from './PersonInspectorList.js';

export default {
  name: 'PersonDebugLog',
  components: { PersonInspectorList },
  props: { traces: { type: Array, default: () => [] }, state: Object, loading: Boolean, error: Boolean, stale: Boolean, more: Boolean, disabled: Boolean, identityKey: { default: '' }, pageToken: [String, Number] },
  emits: ['refresh', 'more'],
  setup(props) {
    const entries = Vue.computed(() => newestPersonRecords(props.traces));
    const estimate = () => 60;
    return { entries, estimate, format: value => JSON.stringify(value, null, 2), time: value => value ? new Date(value).toLocaleString() : '' };
  },
  template: `
    <section id="person-debug" class="person-journal person-debug" :aria-label="$t('person.debug')">
      <div class="person-journal-toolbar">
        <p class="person-muted">{{ $t('person.debugHint') }}</p>
        <button type="button" class="btn-ghost" :disabled="disabled || loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <p v-if="stale" class="person-notice" role="status">{{ $t('person.recordsStale') }}</p>
      <PersonInspectorList :items="entries" :label="$t('person.debug')" :reset-key="identityKey" :page-token="pageToken ?? traces.length" :estimate-height="estimate"
        :more="more" :more-label="$t('person.moreDebug')" :loading="loading" :disabled="disabled" :stale="stale" :error="error" @more="$emit('more')">
        <template #before>
          <p v-if="!entries.length" class="person-empty" role="status">{{ $t(loading ? 'person.loading' : 'person.noDebug') }}</p>
          <details v-if="state" :key="identityKey" class="person-debug-row"><summary>{{ $t('person.state') }}</summary><pre>{{ format(state) }}</pre></details>
        </template>
        <template #default="{ item: trace }">
          <details class="person-debug-row" :data-trace-id="trace.id">
            <summary><strong>{{ trace.kind }}</strong><time>{{ time(trace.createdAt) }}</time></summary>
            <pre>{{ format(trace) }}</pre>
          </details>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
