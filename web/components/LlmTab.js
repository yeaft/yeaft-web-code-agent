export default {
  name: 'LlmTab',
  template: `
    <div class="llm-tab">
      <!-- No agent selected -->
      <div v-if="!chatStore.currentAgent" class="sp-desc">
        {{ $t('settings.llm.noAgent') }}
      </div>

      <!-- Agent offline -->
      <div v-else-if="!agentOnline" class="sp-desc">
        {{ $t('settings.llm.agentOffline') }}
      </div>

      <!-- Loading -->
      <div v-else-if="loading" class="sp-desc">
        {{ $t('settings.llm.loading') }}
      </div>

      <!-- Error -->
      <div v-else-if="loadError" class="sp-desc sp-error-text">
        {{ $t('settings.llm.loadError') }}: {{ loadError }}
      </div>

      <!-- Config loaded -->
      <div v-else>
        <!-- First-time setup banner -->
        <div v-if="currentConfig?.needsSetup" class="llm-setup-banner">
          <div class="llm-setup-icon">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          </div>
          <div class="llm-setup-text">
            <strong>{{ $t('settings.llm.setupTitle') }}</strong>
            <p>{{ $t('settings.llm.setupDesc') }}</p>
          </div>
        </div>
        <!-- Providers Section -->
        <div class="sp-group">
          <div class="sp-group-title">{{ $t('settings.llm.providersTitle') }}</div>
          <p class="sp-desc">{{ $t('settings.llm.providersDesc') }}</p>

          <!-- Provider cards -->
          <div class="llm-provider-card" v-for="(provider, idx) in localProviders" :key="idx">
            <div class="llm-provider-header">
              <span class="llm-provider-index">#{{ idx + 1 }}</span>
              <button class="sp-icon-btn llm-remove-btn" @click="removeProvider(idx)" :title="$t('settings.llm.removeProvider')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>
            </div>

            <div class="llm-field-row">
              <div class="llm-field llm-field-name">
                <label class="llm-field-label">{{ $t('settings.llm.providerName') }}</label>
                <input type="text" class="sp-input" v-model="provider.name"
                  :placeholder="$t('settings.llm.providerNamePlaceholder')" @input="markDirty" />
              </div>
              <div class="llm-field llm-field-protocol">
                <label class="llm-field-label">{{ $t('settings.llm.protocol') }}</label>
                <div class="sp-custom-select" :class="{ open: openDropdown === 'protocol-' + idx }" v-click-outside="() => closeDropdown('protocol-' + idx)">
                  <button class="sp-custom-select-trigger" @click="toggleDropdown('protocol-' + idx)">
                    <span>{{ provider.protocol === 'anthropic' ? $t('settings.llm.protocolAnthropic') : $t('settings.llm.protocolOpenAI') }}</span>
                    <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  <div class="sp-custom-select-menu" v-show="openDropdown === 'protocol-' + idx">
                    <div class="sp-custom-select-option" :class="{ active: !provider.protocol || provider.protocol === 'openai' }"
                      @click="setProtocol(idx, 'openai'); closeDropdown('protocol-' + idx)">
                      {{ $t('settings.llm.protocolOpenAI') }}
                      <svg v-if="!provider.protocol || provider.protocol === 'openai'" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                    <div class="sp-custom-select-option" :class="{ active: provider.protocol === 'anthropic' }"
                      @click="setProtocol(idx, 'anthropic'); closeDropdown('protocol-' + idx)">
                      {{ $t('settings.llm.protocolAnthropic') }}
                      <svg v-if="provider.protocol === 'anthropic'" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="llm-field">
              <label class="llm-field-label">{{ $t('settings.llm.baseUrl') }}</label>
              <input type="text" class="sp-input" v-model="provider.baseUrl"
                :placeholder="$t('settings.llm.baseUrlPlaceholder')" @input="markDirty" />
            </div>

            <div class="llm-field">
              <label class="llm-field-label">{{ $t('settings.llm.apiKey') }}</label>
              <div class="llm-secret-input">
                <input :type="showApiKey[idx] ? 'text' : 'password'" class="sp-input" v-model="provider.apiKey"
                  :placeholder="$t('settings.llm.apiKeyPlaceholder')" @input="markDirty" />
                <button class="sp-icon-btn llm-eye-btn" @click="toggleApiKeyVisibility(idx)">
                  <svg v-if="showApiKey[idx]" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>
                </button>
              </div>
            </div>

            <div class="llm-field">
              <label class="llm-field-label">{{ $t('settings.llm.models') }}</label>
              <p class="llm-models-hint">{{ $t('settings.llm.modelsHint') }}</p>
              <textarea class="sp-input llm-models-textarea" v-model="providerModelsText[idx]"
                :placeholder="$t('settings.llm.modelsPlaceholder')"
                @input="onModelsTextChange(idx, $event)" rows="3"></textarea>
            </div>
          </div>

          <!-- Add provider button -->
          <button class="sp-btn llm-add-btn" @click="addProvider">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            {{ $t('settings.llm.addProvider') }}
          </button>
        </div>

        <!-- Model Selection Section -->
        <div class="sp-group">
          <div class="sp-group-title">{{ $t('settings.llm.modelSelectionTitle') }}</div>
          <p class="sp-desc">{{ $t('settings.llm.modelSelectionDesc') }}</p>

          <div v-if="allModelRefs.length === 0" class="sp-desc">
            {{ $t('settings.llm.noModels') }}
          </div>

          <div v-else>
            <div class="llm-model-select-row">
              <div class="llm-model-select-field">
                <label class="llm-field-label">{{ $t('settings.llm.primaryModel') }}</label>
                <p class="sp-desc llm-model-hint">{{ $t('settings.llm.primaryModelDesc') }}</p>
                <div class="sp-custom-select" :class="{ open: openDropdown === 'primaryModel' }" v-click-outside="() => closeDropdown('primaryModel')">
                  <button class="sp-custom-select-trigger" @click="toggleDropdown('primaryModel')">
                    <span>{{ localPrimaryModel || $t('settings.llm.selectModel') }}</span>
                    <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  <div class="sp-custom-select-menu llm-model-menu" v-show="openDropdown === 'primaryModel'">
                    <div class="sp-custom-select-option"
                      v-for="ref in allModelRefs" :key="'primary-' + ref"
                      :class="{ active: localPrimaryModel === ref }"
                      @click="localPrimaryModel = ref; closeDropdown('primaryModel'); markDirty()">
                      {{ ref }}
                      <svg v-if="localPrimaryModel === ref" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                  </div>
                </div>
              </div>

              <div class="llm-model-select-field">
                <label class="llm-field-label">{{ $t('settings.llm.fastModel') }}</label>
                <p class="sp-desc llm-model-hint">{{ $t('settings.llm.fastModelDesc') }}</p>
                <div class="sp-custom-select" :class="{ open: openDropdown === 'fastModel' }" v-click-outside="() => closeDropdown('fastModel')">
                  <button class="sp-custom-select-trigger" @click="toggleDropdown('fastModel')">
                    <span>{{ localFastModel || $t('settings.llm.selectModel') }}</span>
                    <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  <div class="sp-custom-select-menu llm-model-menu" v-show="openDropdown === 'fastModel'">
                    <div class="sp-custom-select-option"
                      v-for="ref in allModelRefs" :key="'fast-' + ref"
                      :class="{ active: localFastModel === ref }"
                      @click="localFastModel = ref; closeDropdown('fastModel'); markDirty()">
                      {{ ref }}
                      <svg v-if="localFastModel === ref" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Save button -->
        <div class="llm-save-row">
          <span v-if="isDirty" class="llm-dirty-hint">{{ $t('settings.llm.unsavedChanges') }}</span>
          <button class="sp-btn" :class="{ 'sp-btn-primary': isDirty }" @click="saveConfig" :disabled="saving || !isDirty">
            {{ saving ? $t('settings.llm.saving') : $t('settings.llm.save') }}
          </button>
        </div>
      </div>
    </div>
  `,
  directives: {
    'click-outside': {
      mounted(el, binding) {
        el._clickOutside = (e) => {
          if (!el.contains(e.target)) binding.value();
        };
        document.addEventListener('click', el._clickOutside);
      },
      unmounted(el) {
        document.removeEventListener('click', el._clickOutside);
      }
    }
  },
  data() {
    return {
      loading: false,
      loadError: null,
      localProviders: [],
      providerModelsText: [],
      localPrimaryModel: null,
      localFastModel: null,
      isDirty: false,
      saving: false,
      openDropdown: null,
      showApiKey: {}
    };
  },
  computed: {
    chatStore() {
      return Pinia.useChatStore();
    },
    agentOnline() {
      const agentId = this.chatStore.currentAgent;
      if (!agentId) return false;
      const agent = this.chatStore.agents.find(a => a.id === agentId);
      return agent ? agent.online : false;
    },
    currentConfig() {
      const agentId = this.chatStore.currentAgent;
      if (!agentId) return null;
      return this.chatStore.llmConfig[agentId] || null;
    },
    allModelRefs() {
      const refs = [];
      for (const p of this.localProviders) {
        if (!p.name) continue;
        const models = this.parseModelsFromProvider(p);
        for (const m of models) {
          refs.push(`${p.name}/${m}`);
        }
      }
      return refs;
    }
  },
  watch: {
    'chatStore.currentAgent': {
      handler(agentId) {
        if (agentId) this.requestConfig();
      },
      immediate: true
    },
    agentOnline(online) {
      // Auto-retry when agent comes online (and we haven't loaded yet)
      if (online && !this.currentConfig && this.chatStore.currentAgent) {
        this.requestConfig();
      }
    },
    currentConfig: {
      handler(config) {
        if (config && config.loaded) {
          this.loadFromConfig(config);
        }
      },
      deep: true
    }
  },
  methods: {
    requestConfig() {
      const agentId = this.chatStore.currentAgent;
      if (!agentId) return;

      // Check if agent is online before sending request
      if (!this.agentOnline) {
        this.loading = false;
        this.loadError = null;
        return;
      }

      this.loading = true;
      this.loadError = null;
      this.chatStore.sendWsMessage({
        type: 'get_llm_config',
        agentId
      });
      // Timeout: if no response in 5s, show error
      this._loadTimeout = setTimeout(() => {
        if (this.loading) {
          this.loading = false;
          this.loadError = 'Timeout';
        }
      }, 5000);
    },

    loadFromConfig(config) {
      if (this._loadTimeout) {
        clearTimeout(this._loadTimeout);
        this._loadTimeout = null;
      }
      this.loading = false;
      if (config.error) {
        this.loadError = config.error;
        return;
      }
      this.loadError = null;

      // Deep clone providers to avoid mutating store
      this.localProviders = (config.providers || []).map(p => ({
        name: p.name || '',
        baseUrl: p.baseUrl || '',
        apiKey: p.apiKey || '',
        protocol: p.protocol || 'openai',
        models: Array.isArray(p.models) ? [...p.models] : []
      }));

      // Build text representations for model textareas (comma-separated)
      this.providerModelsText = this.localProviders.map(p =>
        (p.models || []).join(', ')
      );

      this.localPrimaryModel = config.primaryModel || null;
      this.localFastModel = config.fastModel || null;
      this.isDirty = false;
      this.showApiKey = {};
    },

    parseModelsFromProvider(provider) {
      return Array.isArray(provider.models) ? provider.models.filter(m => m) : [];
    },

    addProvider() {
      this.localProviders.push({
        name: '',
        baseUrl: '',
        apiKey: '',
        protocol: 'openai',
        models: []
      });
      this.providerModelsText.push('');
      this.markDirty();
    },

    removeProvider(idx) {
      this.localProviders.splice(idx, 1);
      this.providerModelsText.splice(idx, 1);
      // Reindex showApiKey
      const newShow = {};
      for (let i = 0; i < this.localProviders.length; i++) {
        if (i < idx) newShow[i] = this.showApiKey[i];
        else newShow[i] = this.showApiKey[i + 1];
      }
      this.showApiKey = newShow;
      this.markDirty();
    },

    onModelsTextChange(idx, event) {
      const text = event.target.value;
      this.providerModelsText[idx] = text;
      // Parse text → models array (support both newline and comma separators)
      this.localProviders[idx].models = text
        .split(/[\n,]+/)
        .map(l => l.trim())
        .filter(l => l);
      this.markDirty();
    },

    setProtocol(idx, protocol) {
      const prev = this.localProviders[idx].protocol;
      this.localProviders[idx].protocol = protocol;
      this.markDirty();

      // Auto-fill model presets if the models field is empty
      const currentModels = (this.localProviders[idx].models || []).filter(m => m);
      if (currentModels.length === 0 && protocol !== prev) {
        const presets = this._getModelPresets(protocol);
        if (presets.length > 0) {
          this.localProviders[idx].models = [...presets];
          this.providerModelsText[idx] = presets.join(', ');
        }
      }
    },

    _getModelPresets(protocol) {
      if (protocol === 'anthropic') {
        return ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-20250414'];
      }
      // Default: OpenAI-compatible presets
      return ['gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'];
    },

    toggleApiKeyVisibility(idx) {
      this.showApiKey = { ...this.showApiKey, [idx]: !this.showApiKey[idx] };
    },

    toggleDropdown(name) {
      this.openDropdown = this.openDropdown === name ? null : name;
    },

    closeDropdown(name) {
      if (this.openDropdown === name) this.openDropdown = null;
    },

    markDirty() {
      this.isDirty = true;
    },

    saveConfig() {
      const agentId = this.chatStore.currentAgent;
      if (!agentId || this.saving) return;

      this.saving = true;

      // Build providers for saving (clean up empty entries)
      const providers = this.localProviders
        .filter(p => p.name && p.baseUrl)
        .map(p => {
          const clean = {
            name: p.name.trim(),
            baseUrl: p.baseUrl.trim(),
            apiKey: p.apiKey || '',
            models: (p.models || []).filter(m => m)
          };
          if (p.protocol && p.protocol !== 'openai') {
            clean.protocol = p.protocol;
          }
          return clean;
        });

      this.chatStore.sendWsMessage({
        type: 'update_llm_config',
        agentId,
        config: {
          providers,
          primaryModel: this.localPrimaryModel || null,
          fastModel: this.localFastModel || null
        }
      });

      // Wait for llm_config_updated response (handled by watcher on currentConfig)
      // Use a timeout as fallback
      this._saveTimeout = setTimeout(() => {
        this.saving = false;
        this.$emit('message', this.$t('settings.llm.saveFailed'), true);
      }, 10000);

      // Watch for update
      const unwatch = this.$watch('currentConfig', (config) => {
        if (config && config.loaded) {
          if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
          }
          this.saving = false;
          if (config.error) {
            this.$emit('message', config.error, true);
          } else {
            this.isDirty = false;
            this.$emit('message', this.$t('settings.llm.saved'), false);
          }
          unwatch();
        }
      }, { deep: true });
    }
  },

  beforeUnmount() {
    if (this._loadTimeout) clearTimeout(this._loadTimeout);
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
  }
};
