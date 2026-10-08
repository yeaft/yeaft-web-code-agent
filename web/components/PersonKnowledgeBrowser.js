/** Read-only projections of this Person's committed concepts and capability catalog.
 * Grouping is by stored kind/domain, not an invented filesystem or inferred taxonomy.
 */
export default {
  name: 'PersonKnowledgeBrowser',
  props: { section: String, page: Object, disabled: Boolean },
  emits: ['refresh', 'more'],
  setup(props) {
    const groups = Vue.computed(() => {
      const grouped = new Map();
      for (const item of props.page.items) {
        const key = props.section === 'memory' ? item.kind : item.domain;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
      }
      return [...grouped].map(([key, items]) => ({ key, items }));
    });
    const json = value => JSON.stringify(value, null, 2);
    return { groups, json };
  },
  template: `
    <section class="person-knowledge person-journal" :aria-label="$t('person.' + section)" :aria-busy="page.loading">
      <div class="person-journal-toolbar">
        <span class="person-muted">{{ $t(section === 'memory' ? 'person.memoryScope' : 'person.skillsScope') }}</span>
        <button type="button" class="btn-ghost" :disabled="disabled || page.loading" @click="$emit('refresh')">{{ $t('common.refresh') }}</button>
      </div>
      <div class="person-journal-scroll">
        <p v-if="page.error" role="alert" class="person-settings-error">{{ $t('person.requestFailed') }} {{ page.error.message }}</p>
        <p v-if="page.loading" role="status" class="person-muted">{{ $t('person.loading') }}</p>
        <p v-else-if="page.loaded && !page.items.length" class="person-empty">{{ $t('person.knowledgeEmpty') }}</p>
        <details v-for="group in groups" :key="section + group.key" open class="person-knowledge-group">
          <summary>{{ $t('person.group.' + group.key) }} <span class="person-muted">{{ group.items.length }}</span></summary>
          <div class="person-knowledge-branch">
            <details v-for="item in group.items" :key="item.id" class="person-knowledge-item">
              <summary><span>{{ section === 'memory' ? item.statement : item.id }}</span></summary>
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
          </div>
        </details>
        <button v-if="page.nextCursor != null" type="button" class="btn-ghost person-load-more" :disabled="disabled || page.loading" @click="$emit('more')">{{ $t('person.loadMore') }}</button>
      </div>
    </section>
  `,
};
