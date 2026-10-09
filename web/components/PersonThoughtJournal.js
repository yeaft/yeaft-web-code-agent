import { projectPersonThoughts } from '../stores/helpers/person-thoughts.js';

/** Content-only view of persisted cognition. Transport/diagnostic records live elsewhere. */
export default {
  name: 'PersonThoughtJournal',
  props: { traces: { type: Array, default: () => [] }, loading: Boolean, stale: Boolean, more: Boolean, disabled: Boolean },
  emits: ['refresh', 'more'],
  setup(props) {
    const entries = Vue.computed(() => projectPersonThoughts(props.traces));
    const time = value => value ? new Date(value).toLocaleString() : '';
    return { entries, time };
  },
  template: `
    <section id="person-thoughts" class="person-journal" :aria-label="$t('person.thoughts')">
      <div class="person-journal-toolbar">
        <p class="person-muted">{{ $t('person.thoughtsHint') }}</p>
        <button type="button" class="btn-ghost" :disabled="disabled || loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <p v-if="stale" class="person-notice" role="status">{{ $t('person.recordsStale') }}</p>
      <div class="person-journal-scroll" tabindex="0" :aria-label="$t('person.thoughts')" :aria-busy="loading">
        <div class="person-reading-column">
          <slot name="activity"></slot>
          <button v-if="more" type="button" class="btn-ghost person-load-more" :disabled="disabled || loading" @click="$emit('more')">{{ $t('person.olderThoughts') }}</button>
          <p v-if="!entries.length" class="person-empty" role="status">{{ $t(loading ? 'person.loading' : 'person.noThoughts') }}</p>
          <article v-for="entry in entries" :key="entry.id" class="person-thought" :data-thought-kind="entry.kind">
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
        </div>
      </div>
    </section>
  `,
};
