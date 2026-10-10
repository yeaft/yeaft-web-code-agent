import PersonInspectorList, { newestPersonRecords } from './PersonInspectorList.js';

/** Read-only projections of this Person's committed concepts and capability catalog.
 * Kind/domain labels follow the stored catalog, while row order is latest-first.
 */
export default {
  name: 'PersonKnowledgeBrowser',
  components: { PersonInspectorList },
  props: { section: String, page: Object, disabled: Boolean, identityKey: { default: '' } },
  emits: ['refresh', 'more'],
  setup(props) {
    const entries = Vue.computed(() => newestPersonRecords(props.page.items));
    const estimate = () => 100;
    const json = value => JSON.stringify(value, null, 2);
    return { entries, estimate, json };
  },
  template: `
    <section class="person-knowledge person-journal" :aria-label="$t('person.' + section)" :aria-busy="page.loading">
      <div class="person-journal-toolbar">
        <span class="person-muted">{{ $t(section === 'memory' ? 'person.memoryScope' : 'person.skillsScope') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || page.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <PersonInspectorList :items="entries" :label="$t('person.' + section)" :reset-key="identityKey || page" :page-token="page.nextCursor" :estimate-height="estimate"
        :more="page.nextCursor != null" :more-label="$t('person.loadMore')" :loading="page.loading" :disabled="disabled" :stale="page.stale" :error="!!page.error" @more="$emit('more')">
        <template #before>
        <p v-if="page.error" role="alert" class="person-settings-error">{{ $t('person.requestFailed') }} {{ page.error.message }}</p>
        <p v-if="page.loading" role="status" class="person-muted">{{ $t('person.loading') }}</p>
        <p v-else-if="page.loaded && !page.items.length" class="person-empty">{{ $t('person.knowledgeEmpty') }}</p>
        </template>
        <template #default="{ item }">
            <details class="person-knowledge-item" :data-knowledge-id="item.id">
              <summary><small class="person-muted person-knowledge-kind">{{ $t('person.group.' + (section === 'memory' ? item.kind : item.domain)) }}</small><span>{{ section === 'memory' ? item.statement : item.id }}</span></summary>
              <div class="person-knowledge-detail">
                <template v-if="section === 'memory'">
                  <p class="person-prose">{{ item.statement }}</p>
                  <dl><dt>{{ $t('person.epistemicState') }}</dt><dd>{{ $t('person.epistemic.' + item.epistemicState) }}</dd>
                    <dt>{{ $t('person.revision') }}</dt><dd>{{ item.revision }}</dd>
                    <dt>ID</dt><dd>{{ item.id }}</dd></dl>
                  <details v-if="item.sourceRefs?.length"><summary>{{ $t('person.sources') }}</summary><ul><li v-for="ref in item.sourceRefs" :key="ref">{{ ref }}</li></ul></details>
                  <details v-if="item.associations?.length"><summary>{{ $t('person.associations') }}</summary><ul><li v-for="(link, index) in item.associations" :key="index">{{ link.relation }} → {{ link.targetId }}</li></ul></details>
                </template>
                <template v-else>
                  <p class="person-prose">{{ item.description }}</p>
                  <dl><dt>{{ $t('person.revision') }}</dt><dd>{{ item.version }}</dd>
                    <template v-if="item.contract?.useWhen"><dt>{{ $t('person.useWhen') }}</dt><dd>{{ item.contract.useWhen }}</dd></template>
                    <template v-if="item.contract?.avoidWhen"><dt>{{ $t('person.avoidWhen') }}</dt><dd>{{ item.contract.avoidWhen }}</dd></template></dl>
                  <details><summary>{{ $t('person.contract') }}</summary><pre>{{ json(item) }}</pre></details>
                </template>
              </div>
            </details>
        </template>
      </PersonInspectorList>
    </section>
  `,
};
