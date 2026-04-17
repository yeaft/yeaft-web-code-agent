/**
 * UnifySettings.js — LLM provider configuration panel for the Unify page.
 *
 * Replicates the provider CRUD logic from LlmTab but scoped to
 * the Unify agent (store.unifyAgentId). Embedded in UnifyPage's
 * main area when the user clicks the settings gear button.
 */
export default {
  name: 'UnifySettings',
  emits: ['close', 'saved'],
  template: `
    <div class="unify-settings">
      <div class="unify-settings-header">
        <span class="unify-settings-title">{{ $t('unify.settings.title') }}</span>
        <button class="unify-settings-close-btn" @click="$emit('close')" :title="$t('common.close')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <div class="unify-settings-body">
        <!-- Loading -->
        <div v-if="loading" class="unify-settings-status">
          {{ $t('settings.llm.loading') }}
        </div>

        <!-- Error -->
        <div v-else-if="loadError" class="unify-settings-status unify-settings-error">
          {{ $t('settings.llm.loadError') }}: {{ loadError }}
        </div>

        <!-- Config loaded -->
        <div v-else>
          <!-- First-time setup banner -->
          <div v-if="needsSetup" class="unify-settings-banner">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            <div>
              <strong>{{ $t('settings.llm.setupTitle') }}</strong>
              <p>{{ $t('settings.llm.setupDesc') }}</p>
            </div>
          </div>

          <!-- Providers -->
          <div class="unify-settings-group">
            <div class="unify-settings-group-title">{{ $t('settings.llm.providersTitle') }}</div>
            <p class="unify-settings-desc">{{ $t('settings.llm.providersDesc') }}</p>

            <div class="unify-settings-provider" v-for="(provider, idx) in localProviders" :key="idx">
              <div class="unify-settings-provider-header">
                <span class="unify-settings-provider-idx">#{{ idx + 1 }}</span>
                <button class="unify-settings-icon-btn" @click="removeProvider(idx)" :title="$t('settings.llm.removeProvider')">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
              </div>

              <div class="unify-settings-row">
                <div class="unify-settings-field" style="flex:1">
                  <label>{{ $t('settings.llm.providerName') }}</label>
                  <input type="text" v-model="provider.name" :placeholder="$t('settings.llm.providerNamePlaceholder')" @input="markDirty" />
                </div>
                <div class="unify-settings-field" style="flex:0 0 180px">
                  <label>{{ $t('settings.llm.protocol') }}</label>
                  <select v-model="provider.protocol" @change="onProtocolChange(idx)">
                    <option value="openai">{{ $t('settings.llm.protocolOpenAI') }}</option>
                    <option value="openai-responses">{{ $t('settings.llm.protocolOpenAIResponses') }}</option>
                    <option value="anthropic">{{ $t('settings.llm.protocolAnthropic') }}</option>
                  </select>
                  <small class="unify-settings-hint unify-settings-protocol-hint">{{ protocolHint(provider.protocol) }}</small>
                </div>
              </div>

              <div class="unify-settings-field">
                <label>{{ $t('settings.llm.baseUrl') }}</label>
                <input type="text" v-model="provider.baseUrl" :placeholder="$t('settings.llm.baseUrlPlaceholder')" @input="markDirty" />
              </div>

              <div class="unify-settings-field">
                <label>{{ $t('settings.llm.apiKey') }}</label>
                <div class="unify-settings-secret">
                  <input :type="showApiKey[idx] ? 'text' : 'password'" v-model="provider.apiKey" :placeholder="$t('settings.llm.apiKeyPlaceholder')" @input="markDirty" />
                  <button class="unify-settings-icon-btn" @click="toggleApiKey(idx)">
                    <svg v-if="showApiKey[idx]" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>
                  </button>
                </div>
              </div>

              <div class="unify-settings-field">
                <label>{{ $t('settings.llm.models') }}</label>
                <p class="unify-settings-hint">{{ $t('settings.llm.modelsHint') }}</p>
                <div class="unify-settings-model-rows">
                  <div class="unify-settings-model-row" v-for="(mrow, midx) in provider.models" :key="midx">
                    <input
                      class="unify-settings-model-id"
                      type="text"
                      v-model="mrow.id"
                      :placeholder="$t('settings.llm.modelsPlaceholder')"
                      @input="markDirty" />
                    <input
                      class="unify-settings-model-ctx llm-model-ctx"
                      type="number"
                      min="0"
                      v-model.number="mrow.contextWindow"
                      :placeholder="$t('settings.llm.modelCtxPlaceholder')"
                      :title="$t('settings.llm.modelCtxPlaceholder')"
                      @input="markDirty" />
                    <input
                      class="unify-settings-model-max llm-model-max"
                      type="number"
                      min="0"
                      v-model.number="mrow.maxOutput"
                      :placeholder="$t('settings.llm.modelMaxPlaceholder')"
                      :title="$t('settings.llm.modelMaxPlaceholder')"
                      @input="markDirty" />
                    <button class="unify-settings-icon-btn" @click="removeModel(idx, midx)" :title="$t('settings.llm.removeProvider')">
                      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                  </div>
                  <button class="unify-settings-add-btn" @click="addModel(idx)">
                    <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                    {{ $t('settings.llm.addProvider') }}
                  </button>
                </div>
              </div>
            </div>

            <button class="unify-settings-add-btn" @click="addProvider">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              {{ $t('settings.llm.addProvider') }}
            </button>
          </div>

          <!-- Model Selection -->
          <div class="unify-settings-group">
            <div class="unify-settings-group-title">{{ $t('settings.llm.modelSelectionTitle') }}</div>
            <p class="unify-settings-desc">{{ $t('settings.llm.modelSelectionDesc') }}</p>

            <div v-if="allModelRefs.length === 0" class="unify-settings-desc">
              {{ $t('settings.llm.noModels') }}
            </div>
            <div v-else class="unify-settings-row">
              <div class="unify-settings-field" style="flex:1">
                <label>{{ $t('settings.llm.primaryModel') }}</label>
                <p class="unify-settings-hint">{{ $t('settings.llm.primaryModelDesc') }}</p>
                <select v-model="localPrimaryModel" @change="markDirty">
                  <option :value="null">{{ $t('settings.llm.selectModel') }}</option>
                  <option v-for="ref in allModelRefs" :key="'p-'+ref" :value="ref">{{ ref }}</option>
                </select>
              </div>
              <div class="unify-settings-field" style="flex:1">
                <label>{{ $t('settings.llm.fastModel') }}</label>
                <p class="unify-settings-hint">{{ $t('settings.llm.fastModelDesc') }}</p>
                <select v-model="localFastModel" @change="markDirty">
                  <option :value="null">{{ $t('settings.llm.selectModel') }}</option>
                  <option v-for="ref in allModelRefs" :key="'f-'+ref" :value="ref">{{ ref }}</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Save -->
          <div class="unify-settings-save-row">
            <span v-if="saveMessage" :class="saveError ? 'unify-settings-error' : 'unify-settings-success'">{{ saveMessage }}</span>
            <span v-else-if="isDirty" class="unify-settings-dirty">{{ $t('settings.llm.unsavedChanges') }}</span>
            <button class="unify-settings-save-btn" :class="{ primary: isDirty }" @click="saveConfig" :disabled="saving || !isDirty">
              {{ saving ? $t('settings.llm.saving') : $t('settings.llm.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const instance = Vue.getCurrentInstance();
    const $t = (key) => instance?.proxy?.$t?.(key) ?? key;

    const loading = Vue.ref(false);
    const loadError = Vue.ref(null);
    const needsSetup = Vue.ref(false);
    const localProviders = Vue.ref([]);
    const providerModelsText = Vue.ref([]);
    const localPrimaryModel = Vue.ref(null);
    const localFastModel = Vue.ref(null);
    const isDirty = Vue.ref(false);
    const saving = Vue.ref(false);
    const showApiKey = Vue.reactive({});
    const saveMessage = Vue.ref('');
    const saveError = Vue.ref(false);

    let loadTimeout = null;
    let saveTimeout = null;

    const allModelRefs = Vue.computed(() => {
      const refs = [];
      for (const p of localProviders.value) {
        if (!p.name) continue;
        const models = Array.isArray(p.models) ? p.models : [];
        for (const m of models) {
          const id = m && typeof m === 'object' ? m.id : m;
          if (id) refs.push(`${p.name}/${id}`);
        }
      }
      return refs;
    });

    function requestConfig() {
      const agentId = store.unifyAgentId;
      if (!agentId) return;

      loading.value = true;
      loadError.value = null;
      store.sendWsMessage({ type: 'get_llm_config', agentId });

      loadTimeout = setTimeout(() => {
        if (loading.value) {
          loading.value = false;
          loadError.value = 'Timeout';
        }
      }, 5000);
    }

    function loadFromConfig(config) {
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
      loading.value = false;
      if (config.error) { loadError.value = config.error; return; }
      loadError.value = null;
      needsSetup.value = !!config.needsSetup;

      // Normalize each model entry to `{ id, contextWindow?, maxOutput? }`
      // so the UI can bind uniformly regardless of legacy string format.
      localProviders.value = (config.providers || []).map(p => ({
        name: p.name || '',
        baseUrl: p.baseUrl || '',
        apiKey: p.apiKey || '',
        protocol: p.protocol || 'openai',
        models: Array.isArray(p.models) ? p.models.map(toModelRow).filter(r => r) : [],
      }));

      providerModelsText.value = localProviders.value.map(() => '');
      localPrimaryModel.value = config.primaryModel || null;
      localFastModel.value = config.fastModel || null;
      isDirty.value = false;
    }

    // Convert a string or object model entry into a ui-friendly row.
    function toModelRow(entry) {
      if (typeof entry === 'string') {
        const id = entry.trim();
        return id ? { id, contextWindow: null, maxOutput: null } : null;
      }
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        return {
          id: entry.id,
          contextWindow: toUiNumber(entry.contextWindow),
          maxOutput: toUiNumber(entry.maxOutput),
        };
      }
      return null;
    }

    function toUiNumber(v) {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    // Normalize a single model row for WS payload (used by save).
    // id-only → string; with ctx/max → { id, contextWindow?, maxOutput? }.
    function normalizeModelForSave(row) {
      if (!row || !row.id || !String(row.id).trim()) return null;
      const id = String(row.id).trim();
      const ctx = toUiNumber(row.contextWindow);
      const max = toUiNumber(row.maxOutput);
      if (ctx == null && max == null) return id;
      const obj = { id };
      if (ctx != null) obj.contextWindow = ctx;
      if (max != null) obj.maxOutput = max;
      return obj;
    }

    // Watch for llmConfig updates from store
    Vue.watch(
      () => {
        const agentId = store.unifyAgentId;
        return agentId ? store.llmConfig[agentId] : null;
      },
      (config) => {
        if (config && config.loaded) loadFromConfig(config);
      },
      { deep: true }
    );

    // Request config on mount
    Vue.onMounted(() => {
      const agentId = store.unifyAgentId;
      if (agentId) {
        const existing = store.llmConfig[agentId];
        if (existing && existing.loaded) loadFromConfig(existing);
        else requestConfig();
      }
    });

    Vue.onUnmounted(() => {
      if (loadTimeout) clearTimeout(loadTimeout);
      if (saveTimeout) clearTimeout(saveTimeout);
    });

    function markDirty() { isDirty.value = true; saveMessage.value = ''; }

    function addProvider() {
      localProviders.value.push({ name: '', baseUrl: '', apiKey: '', protocol: 'openai', models: [] });
      providerModelsText.value.push('');
      markDirty();
    }

    function removeProvider(idx) {
      localProviders.value.splice(idx, 1);
      providerModelsText.value.splice(idx, 1);
      markDirty();
    }

    function addModel(idx) {
      if (!Array.isArray(localProviders.value[idx].models)) {
        localProviders.value[idx].models = [];
      }
      localProviders.value[idx].models.push({ id: '', contextWindow: null, maxOutput: null });
      markDirty();
    }

    function removeModel(providerIdx, modelIdx) {
      localProviders.value[providerIdx].models.splice(modelIdx, 1);
      markDirty();
    }

    function onModelsTextChange(idx, event) {
      // Legacy textarea path — still parse for back-compat if anything calls this.
      const text = event.target.value;
      providerModelsText.value[idx] = text;
      localProviders.value[idx].models = text.split(/[\n,]+/)
        .map(l => l.trim()).filter(l => l)
        .map(id => ({ id, contextWindow: null, maxOutput: null }));
      markDirty();
    }

    function onProtocolChange(idx) {
      const provider = localProviders.value[idx];
      const currentModels = (provider.models || []).filter(m => m && (typeof m === 'string' ? m : m.id));
      if (currentModels.length === 0) {
        const presets = provider.protocol === 'anthropic'
          ? ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-20250414']
          : provider.protocol === 'openai-responses'
            ? ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro']
            : ['gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'];
        provider.models = presets.map(id => ({ id, contextWindow: null, maxOutput: null }));
        providerModelsText.value[idx] = '';
      }
      markDirty();
    }

    function protocolHint(protocol) {
      if (protocol === 'anthropic') return $t('settings.llm.protocolHint.anthropic');
      if (protocol === 'openai-responses') return $t('settings.llm.protocolHint.openaiResponses');
      return $t('settings.llm.protocolHint.openai');
    }

    function toggleApiKey(idx) {
      showApiKey[idx] = !showApiKey[idx];
    }

    function saveConfig() {
      const agentId = store.unifyAgentId;
      if (!agentId || saving.value) return;

      saving.value = true;
      saveMessage.value = '';

      const providers = localProviders.value
        .filter(p => p.name && p.baseUrl)
        .map(p => {
          // Serialize each model row: id-only → string; with ctx/max → object.
          // This preserves back-compat with existing `models: ["gpt-4"]` configs.
          const models = (p.models || [])
            .map(normalizeModelForSave)
            .filter(m => m);
          const clean = {
            name: p.name.trim(),
            baseUrl: p.baseUrl.trim(),
            apiKey: p.apiKey || '',
            models,
          };
          if (p.protocol && p.protocol !== 'openai') clean.protocol = p.protocol;
          return clean;
        });

      store.sendWsMessage({
        type: 'update_llm_config',
        agentId,
        config: { providers, primaryModel: localPrimaryModel.value || null, fastModel: localFastModel.value || null },
      });

      // Timeout fallback
      saveTimeout = setTimeout(() => {
        saving.value = false;
        saveMessage.value = store.$t ? store.$t('settings.llm.saveFailed') : 'Failed to save';
        saveError.value = true;
      }, 10000);

      // Watch for config update
      const unwatch = Vue.watch(
        () => store.llmConfig[agentId],
        (config) => {
          if (config && config.loaded) {
            if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
            saving.value = false;
            if (config.error) {
              saveMessage.value = config.error;
              saveError.value = true;
            } else {
              isDirty.value = false;
              saveMessage.value = 'Saved';
              saveError.value = false;
              emit('saved');
              // Trigger Unify session reset so Engine picks up new config
              store.sendWsMessage({ type: 'unify_reset', agentId });
            }
            unwatch();
          }
        },
        { deep: true }
      );
    }

    return {
      store, loading, loadError, needsSetup,
      localProviders, providerModelsText, localPrimaryModel, localFastModel,
      allModelRefs, isDirty, saving, showApiKey,
      saveMessage, saveError,
      markDirty, addProvider, removeProvider,
      addModel, removeModel,
      onModelsTextChange, onProtocolChange, toggleApiKey, saveConfig,
      protocolHint,
    };
  },
};
