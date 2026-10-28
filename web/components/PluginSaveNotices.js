/** Store-owned failures remain visible even after navigating away from Plugins. */
export default {
  name: 'PluginSaveNotices',
  computed: {
    store() { return window.Pinia?.useChatStore?.(); },
    errors() {
      if (this.store?.pluginCenterOpen) return [];
      return Object.entries(this.store?.pluginConfigByAgent || {}).filter(([, record]) => (record.errorOperation === 'save' && record.error));
    },
  },
  methods: {
    agent(id) { return this.store.agents.find(agent => agent.id === id); },
  },
  template: `
    <aside v-if="errors.length" class="plugin-center-save-notices" :aria-label="$t('yeaft.plugins.saveErrors')">
      <div v-for="[id, record] in errors" :key="id" class="plugin-center-notice is-error" role="alert">
        <span>{{ $t('yeaft.plugins.saveFailed', { agent: agent(id)?.name || id, error: record.error }) }}</span>
        <button type="button" class="btn-ghost" :disabled="!agent(id)?.online || record.saving" @click="store.retryPluginConfig(id)">{{ $t('yeaft.plugins.retry') }}</button>
      </div>
    </aside>
  `,
};
