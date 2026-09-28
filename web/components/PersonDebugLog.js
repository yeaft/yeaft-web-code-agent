export default {
  name: 'PersonDebugLog',
  props: { traces: { type: Array, default: () => [] }, state: Object, loading: Boolean, stale: Boolean, more: Boolean, disabled: Boolean },
  emits: ['refresh', 'more'],
  setup() {
    return { format: value => JSON.stringify(value, null, 2), time: value => value ? new Date(value).toLocaleString() : '' };
  },
  template: `
    <section id="person-debug" class="person-journal person-debug" :aria-label="$t('person.debug')">
      <div class="person-journal-toolbar">
        <p class="person-muted">{{ $t('person.debugHint') }}</p>
        <button type="button" class="btn-ghost" :disabled="disabled || loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <p v-if="stale" class="person-notice" role="status">{{ $t('person.recordsStale') }}</p>
      <div class="person-journal-scroll" tabindex="0" :aria-label="$t('person.debug')" :aria-busy="loading">
        <div class="person-reading-column">
          <p v-if="!traces.length" class="person-empty">{{ $t(loading ? 'person.loading' : 'person.noDebug') }}</p>
          <details v-if="state" class="person-debug-row"><summary>{{ $t('person.state') }}</summary><pre>{{ format(state) }}</pre></details>
          <details v-for="trace in traces" :key="trace.id" class="person-debug-row">
            <summary><strong>{{ trace.kind }}</strong><time>{{ time(trace.createdAt) }}</time></summary>
            <pre>{{ format(trace) }}</pre>
          </details>
          <button v-if="more" type="button" class="btn-ghost" :disabled="disabled || loading" @click="$emit('more')">{{ $t('person.moreDebug') }}</button>
        </div>
      </div>
    </section>
  `,
};
