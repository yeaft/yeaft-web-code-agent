/**
 * ProviderPresetPicker — modal for picking a provider + models from the
 * community models.dev catalog. Pre-fills a new provider entry so the user
 * doesn't have to type baseUrl / model ids by hand.
 *
 * Emits:
 *   - close          : user dismissed the picker
 *   - pick(payload)  : user confirmed a selection. Payload shape:
 *       { name, baseUrl, protocol, models: string[] }
 *       Caller (LlmTab) appends this to localProviders.
 */
export default {
  name: 'ProviderPresetPicker',
  emits: ['close', 'pick'],
  template: `
    <div class="llm-preset-modal-backdrop" @click.self="$emit('close')">
      <div class="llm-preset-modal">
        <div class="llm-preset-header">
          <strong>{{ $t('settings.llm.preset.title') }}</strong>
          <div class="llm-preset-header-actions">
            <button class="sp-icon-btn" :title="$t('settings.llm.preset.refresh')"
              @click="refresh" :disabled="loading">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button class="sp-icon-btn" @click="$emit('close')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>

        <div v-if="loading" class="sp-desc llm-preset-status">
          {{ $t('settings.llm.preset.loading') }}
        </div>
        <div v-else-if="error" class="sp-desc sp-error-text llm-preset-status">
          {{ error }}
        </div>
        <div v-else-if="!providerIds.length" class="sp-desc llm-preset-status">
          {{ $t('settings.llm.preset.empty') }}
        </div>
        <div v-else class="llm-preset-body">
          <div class="llm-preset-col llm-preset-providers">
            <input type="text" class="sp-input llm-preset-search" v-model="providerFilter"
              :placeholder="$t('settings.llm.preset.filterProviders')" />
            <div class="llm-preset-list">
              <div v-for="pid in filteredProviderIds" :key="pid"
                class="llm-preset-row"
                :class="{ active: pid === selectedProviderId }"
                @click="selectProvider(pid)">
                <span class="llm-preset-row-name">{{ providerName(pid) }}</span>
                <span class="llm-preset-row-meta">{{ providerModelCount(pid) }}</span>
              </div>
            </div>
          </div>
          <div class="llm-preset-col llm-preset-models">
            <div v-if="!selectedProviderId" class="sp-desc llm-preset-status">
              {{ $t('settings.llm.preset.pickProvider') }}
            </div>
            <template v-else>
              <input type="text" class="sp-input llm-preset-search" v-model="modelFilter"
                :placeholder="$t('settings.llm.preset.filterModels')" />
              <div class="llm-preset-actions">
                <button class="sp-btn-link" @click="selectAll">{{ $t('settings.llm.preset.selectAll') }}</button>
                <button class="sp-btn-link" @click="selectNone">{{ $t('settings.llm.preset.selectNone') }}</button>
              </div>
              <div class="llm-preset-list">
                <label v-for="mid in filteredModelIds" :key="mid" class="llm-preset-row llm-preset-model-row">
                  <input type="checkbox" :checked="selectedModels.has(mid)" @change="toggleModel(mid)" />
                  <span class="llm-preset-row-name">{{ mid }}</span>
                </label>
              </div>
            </template>
          </div>
        </div>

        <div class="llm-preset-footer">
          <span v-if="fetchedAtLabel" class="sp-desc llm-preset-fetched">
            {{ fetchedAtLabel }}
          </span>
          <span class="llm-preset-spacer"></span>
          <button class="sp-btn" @click="$emit('close')">{{ $t('settings.llm.preset.cancel') }}</button>
          <button class="sp-btn sp-btn-primary"
            :disabled="!selectedProviderId || selectedModels.size === 0"
            @click="confirm">
            {{ $t('settings.llm.preset.add') }}
          </button>
        </div>
      </div>
    </div>
  `,
  data() {
    return {
      loading: false,
      error: null,
      registry: {},
      fetchedAt: 0,
      providerFilter: '',
      modelFilter: '',
      selectedProviderId: null,
      selectedModels: new Set(),
    };
  },
  computed: {
    chatStore() { return Pinia.useChatStore(); },
    providerIds() {
      return Object.keys(this.registry).sort();
    },
    filteredProviderIds() {
      const f = this.providerFilter.trim().toLowerCase();
      if (!f) return this.providerIds;
      return this.providerIds.filter(pid =>
        pid.toLowerCase().includes(f) ||
        (this.providerName(pid) || '').toLowerCase().includes(f)
      );
    },
    selectedProviderModels() {
      const p = this.registry[this.selectedProviderId];
      if (!p || typeof p.models !== 'object') return [];
      return Object.keys(p.models).sort();
    },
    filteredModelIds() {
      const f = this.modelFilter.trim().toLowerCase();
      const ids = this.selectedProviderModels;
      if (!f) return ids;
      return ids.filter(m => m.toLowerCase().includes(f));
    },
    fetchedAtLabel() {
      if (!this.fetchedAt) return null;
      const minutes = Math.max(0, Math.floor((Date.now() - this.fetchedAt) / 60000));
      return this.$t('settings.llm.preset.fetchedAt', { minutes });
    },
  },
  async mounted() {
    await this.load(false);
  },
  methods: {
    async load(forceRefresh) {
      this.loading = true;
      this.error = null;
      try {
        const snap = await this.chatStore.loadModelsDevRegistry({ forceRefresh });
        this.registry = snap?.registry || {};
        this.fetchedAt = snap?.fetchedAt || 0;
        if (snap?.error) this.error = snap.error;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loading = false;
      }
    },
    refresh() { this.load(true); },
    providerName(pid) {
      return this.registry[pid]?.name || pid;
    },
    providerModelCount(pid) {
      const m = this.registry[pid]?.models;
      return m && typeof m === 'object' ? Object.keys(m).length : 0;
    },
    selectProvider(pid) {
      if (this.selectedProviderId === pid) return;
      this.selectedProviderId = pid;
      this.selectedModels = new Set();
      this.modelFilter = '';
    },
    toggleModel(mid) {
      const next = new Set(this.selectedModels);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      this.selectedModels = next;
    },
    selectAll() {
      this.selectedModels = new Set(this.filteredModelIds);
    },
    selectNone() {
      this.selectedModels = new Set();
    },
    confirm() {
      if (!this.selectedProviderId || this.selectedModels.size === 0) return;
      const entry = this.registry[this.selectedProviderId] || {};
      // Detect Anthropic protocol from models.dev provider id.
      const protocol = this.selectedProviderId === 'anthropic' ? 'anthropic' : 'openai';
      this.$emit('pick', {
        name: this.selectedProviderId,
        baseUrl: entry.api || '',
        protocol,
        models: Array.from(this.selectedModels),
      });
    },
  },
};
