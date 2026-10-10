import { projectPersonThoughts } from '../stores/helpers/person-thoughts.js';
import PersonInspectorList from './PersonInspectorList.js';

/** Content-only view of persisted cognition. Transport/diagnostic records live elsewhere. */
export default {
  name: 'PersonThoughtJournal',
  components: { PersonInspectorList },
  props: { traces: { type: Array, default: () => [] }, loading: Boolean, error: Boolean, stale: Boolean, more: Boolean, disabled: Boolean, identityKey: { default: '' }, pageToken: [String, Number] },
  emits: ['refresh', 'more'],
  setup(props) {
    // The projector uses ascending sequence to correlate proposals and commits;
    // reverse its completed projection, never the evidence supplied to it.
    const entries = Vue.computed(() => projectPersonThoughts(props.traces).reverse());
    const time = value => value ? new Date(value).toLocaleString() : '';
    const estimate = entry => Math.min(1400, 90 + entry.sections.reduce((height, section) => height + 40 + Math.ceil((section.text?.length || 0) / 55) * 20 + (section.items?.length || 0) * 30, 0));
    return { entries, time, estimate };
  },
  template: `
    <section id="person-thoughts" class="person-journal" :aria-label="$t('person.thoughts')">
      <div class="person-journal-toolbar">
        <p class="person-muted">{{ $t('person.thoughtsHint') }}</p>
        <button type="button" class="btn-ghost" :disabled="disabled || loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <p v-if="stale" class="person-notice" role="status">{{ $t('person.recordsStale') }}</p>
      <PersonInspectorList :items="entries" :label="$t('person.thoughts')" :reset-key="identityKey" :page-token="pageToken ?? traces.length" :estimate-height="estimate"
        :more="more" :more-label="$t('person.olderThoughts')" :loading="loading" :disabled="disabled" :stale="stale" :error="error" @more="$emit('more')">
        <template #before>
          <slot name="activity"></slot>
          <p v-if="!entries.length" class="person-empty" role="status">{{ $t(loading ? 'person.loading' : 'person.noThoughts') }}</p>
        </template>
        <template #default="{ item: entry }">
          <article class="person-thought" :data-thought-kind="entry.kind">
            <header class="person-message-meta">
              <strong>{{ $t('person.thought.' + entry.kind) }}</strong>
              <span v-if="entry.status" class="person-thought-status">{{ $t('person.thought.' + entry.status) }}</span>
              <time>{{ time(entry.createdAt) }}</time>
            </header>
            <section v-for="(section, index) in entry.sections" :key="index" class="person-thought-section">
              <h3><span v-if="section.scope">{{ $t('person.thought.' + section.scope) }} · </span>{{ $t('person.thought.' + section.label) }}</h3>
              <p v-if="section.text" class="person-prose">{{ section.text }}</p>
              <ul v-if="section.items?.length"><li v-for="(item, i) in section.items" :key="i" class="person-prose">{{ item }}</li></ul>
            </section>
          </article>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
