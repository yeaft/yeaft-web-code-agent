import { PROTOCOL_PRESET_MODELS } from '../utils/protocolPresets.js';
import ProviderPresetPicker from './ProviderPresetPicker.js';

export default {
  name: 'LlmTab',
  components: { ProviderPresetPicker },
  props: {
    // task-343: 'chat' (default) binds provider CRUD to chatStore.currentAgent;
    // 'yeaft' binds to chatStore.yeaftAgentId so Yeaft settings can reuse
    // this tab without cross-polluting the Chat agent config.
    context: { type: String, default: 'chat' },
  },
  emits: ['message', 'saved'],
  template: `
    <div class="llm-tab">
      <!-- No agent selected -->
      <div v-if="!effectiveAgentId" class="sp-desc">
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
                    <span>{{ protocolLabel(provider.protocol) }}</span>
                    <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  <div class="sp-custom-select-menu" v-show="openDropdown === 'protocol-' + idx">
                    <div class="sp-custom-select-option" :class="{ active: !provider.protocol || provider.protocol === 'openai' }"
                      @click="setProtocol(idx, 'openai'); closeDropdown('protocol-' + idx)">
                      {{ $t('settings.llm.protocolOpenAI') }}
                      <svg v-if="!provider.protocol || provider.protocol === 'openai'" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                    <div class="sp-custom-select-option" :class="{ active: provider.protocol === 'openai-responses' }"
                      @click="setProtocol(idx, 'openai-responses'); closeDropdown('protocol-' + idx)">
                      {{ $t('settings.llm.protocolOpenAIResponses') }}
                      <svg v-if="provider.protocol === 'openai-responses'" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                    <div class="sp-custom-select-option" :class="{ active: provider.protocol === 'anthropic' }"
                      @click="setProtocol(idx, 'anthropic'); closeDropdown('protocol-' + idx)">
                      {{ $t('settings.llm.protocolAnthropic') }}
                      <svg v-if="provider.protocol === 'anthropic'" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    </div>
                  </div>
                </div>
                <small class="llm-field-hint llm-protocol-hint">{{ protocolHint(provider.protocol) }}</small>
              </div>
            </div>

            <div class="llm-field">
              <label class="llm-field-label">{{ $t('settings.llm.baseUrl') }}</label>
              <input type="text" class="sp-input" v-model="provider.baseUrl"
                :placeholder="$t('settings.llm.baseUrlPlaceholder')" @input="markDirty" />
            </div>

            <div class="llm-field">
              <label class="llm-field-label">{{ $t('settings.llm.apiKey') }}</label>
              <label class="llm-auto-auth-toggle">
                <input type="checkbox"
                  :checked="provider.credentialProvider === 'github-copilot'"
                  @change="toggleAutoAuth(idx, $event)" />
                <span>{{ $t('settings.llm.autoAuthGithubCopilot') }}</span>
              </label>
              <div v-if="provider.credentialProvider === 'github-copilot'" class="sp-desc llm-auto-auth-hint">
                {{ $t('settings.llm.autoAuthGithubCopilotHint') }}
              </div>
              <div v-else class="llm-secret-input">
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
          <div class="llm-add-row">
            <button class="sp-btn llm-add-btn" @click="addProvider">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              {{ $t('settings.llm.addProvider') }}
            </button>
            <button v-if="context === 'yeaft'" class="sp-btn llm-add-btn" @click="showPresetPicker = true">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
              {{ $t('settings.llm.addFromPreset') }}
            </button>
          </div>
        </div>

        <provider-preset-picker v-if="showPresetPicker"
          @close="showPresetPicker = false"
          @pick="onPresetPick" />

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
      showApiKey: {},
      showPresetPicker: false,
    };
  },
  computed: {
    chatStore() {
      return Pinia.useChatStore();
    },
    // task-343: effective agent id depends on tab context. Swapping here
    // cascades to agentOnline / currentConfig / requestConfig / saveConfig
    // without any other call-site changes.
    effectiveAgentId() {
      return this.context === 'yeaft'
        ? this.chatStore.yeaftAgentId
        : this.chatStore.currentAgent;
    },
    agentOnline() {
      const agentId = this.effectiveAgentId;
      if (!agentId) return false;
      // Yeaft context: the "agent" is the embedded yeaft runtime, which is
      // always online when an agentId exists (no separate agent record).
      if (this.context === 'yeaft') return true;
      const agent = this.chatStore.agents.find(a => a.id === agentId);
      return agent ? agent.online : false;
    },
    currentConfig() {
      const agentId = this.effectiveAgentId;
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
    effectiveAgentId: {
      handler(agentId) {
        if (agentId) this.requestConfig();
      },
      immediate: true
    },
    agentOnline(online) {
      // Auto-retry when agent comes online (and we haven't loaded yet)
      if (online && !this.currentConfig && this.effectiveAgentId) {
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
      const agentId = this.effectiveAgentId;
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

      // Deep clone providers to avoid mutating store. Model entries may be
      // bare string ids OR { id, protocol? } objects — preserve whichever
      // shape the agent persisted so per-model protocol metadata from the
      // preset picker survives load → edit → save round trips.
      this.localProviders = (config.providers || []).map(p => ({
        name: p.name || '',
        baseUrl: p.baseUrl || '',
        apiKey: p.apiKey || '',
        protocol: p.protocol || 'openai',
        // Per-provider opt-in to dynamic credential resolution (e.g. gh CLI
        // or GitHub device-flow token). Absent/null = static apiKey path.
        credentialProvider: p.credentialProvider || null,
        models: Array.isArray(p.models)
          ? p.models.map(m => (m && typeof m === 'object') ? { ...m } : m)
          : []
      }));

      // Textareas only show ids — the protocol metadata is invisible to the
      // user but preserved in the underlying objects (see onModelsTextChange).
      this.providerModelsText = this.localProviders.map(p =>
        (p.models || []).map(m => this._modelId(m)).join(', ')
      );

      this.localPrimaryModel = config.primaryModel || null;
      this.localFastModel = config.fastModel || null;
      this.isDirty = false;
      this.showApiKey = {};
    },

    parseModelsFromProvider(provider) {
      if (!Array.isArray(provider.models)) return [];
      return provider.models.map(m => this._modelId(m)).filter(m => m);
    },

    // Extract the id string from either a bare string entry or { id, ... }.
    _modelId(entry) {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id;
      return '';
    },

    addProvider() {
      this.localProviders.push({
        name: '',
        baseUrl: '',
        apiKey: '',
        protocol: 'openai',
        credentialProvider: null,
        models: []
      });
      this.providerModelsText.push('');
      this.markDirty();
    },

    // Append a provider pre-filled from the models.dev preset picker.
    // API key is intentionally left blank — picker has no way to know it.
    onPresetPick(payload) {
      this.showPresetPicker = false;
      if (!payload || !payload.name) return;
      // Avoid duplicate provider names — append numeric suffix if needed.
      const existing = new Set(this.localProviders.map(p => (p.name || '').trim()));
      let name = payload.name;
      let n = 2;
      while (existing.has(name)) {
        name = `${payload.name}-${n++}`;
      }
      const models = Array.isArray(payload.models) ? payload.models.filter(Boolean) : [];
      this.localProviders.push({
        name,
        baseUrl: payload.baseUrl || '',
        apiKey: '',
        protocol: payload.protocol || 'openai',
        credentialProvider: null,
        models,
      });
      this.providerModelsText.push(models.join(', '));
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
      // Parse text → model ids (support both newline and comma separators).
      // For each id, look up the prior entry by id so per-model `protocol`
      // metadata (e.g. attached by ProviderPresetPicker) survives the edit.
      const prev = Array.isArray(this.localProviders[idx].models)
        ? this.localProviders[idx].models
        : [];
      const prevById = new Map();
      for (const m of prev) {
        const id = this._modelId(m);
        if (id) prevById.set(id, m);
      }
      this.localProviders[idx].models = text
        .split(/[\n,]+/)
        .map(l => l.trim())
        .filter(l => l)
        .map(id => prevById.has(id) ? prevById.get(id) : id);
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

    protocolLabel(protocol) {
      if (protocol === 'anthropic') return this.$t('settings.llm.protocolAnthropic');
      if (protocol === 'openai-responses') return this.$t('settings.llm.protocolOpenAIResponses');
      return this.$t('settings.llm.protocolOpenAI');
    },

    protocolHint(protocol) {
      if (protocol === 'anthropic') return this.$t('settings.llm.protocolHint.anthropic');
      if (protocol === 'openai-responses') return this.$t('settings.llm.protocolHint.openaiResponses');
      return this.$t('settings.llm.protocolHint.openai');
    },

    _getModelPresets(protocol) {
      return PROTOCOL_PRESET_MODELS[protocol] || PROTOCOL_PRESET_MODELS.openai;
    },

    toggleApiKeyVisibility(idx) {
      this.showApiKey = { ...this.showApiKey, [idx]: !this.showApiKey[idx] };
    },

    // Per-provider opt-in for the github-copilot credential provider.
    // When on, the apiKey field is hidden and the agent resolves a live
    // token at request time from env / gh CLI / persisted device-flow token.
    toggleAutoAuth(idx, event) {
      const on = !!event.target.checked;
      const row = this.localProviders[idx];
      row.credentialProvider = on ? 'github-copilot' : null;
      if (on) {
        // Stash the previously-typed apiKey on the local row so a user who
        // toggles on then off doesn't lose their static key. Cleared at
        // save time (saveConfig forces apiKey='' when credentialProvider
        // is set, so what gets persisted is still the regression-safe shape).
        if (row.apiKey) row._stashedApiKey = row.apiKey;
        row.apiKey = '';
      } else if (row._stashedApiKey) {
        row.apiKey = row._stashedApiKey;
        row._stashedApiKey = '';
      }
      this.markDirty();
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
      const agentId = this.effectiveAgentId;
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
            // Preserve mixed string/object entries — agent-side normalize
            // collapses to plain string when no metadata is attached.
            models: (p.models || []).filter(m => this._modelId(m))
          };
          if (p.protocol && p.protocol !== 'openai') {
            clean.protocol = p.protocol;
          }
          // Only emit credentialProvider when explicitly opted-in. Omitting
          // the field on disk keeps existing configs byte-identical and
          // makes the agent's static-apiKey path the default.
          if (p.credentialProvider) {
            clean.credentialProvider = p.credentialProvider;
            // When auto-auth is on, force apiKey empty — the live token is
            // resolved per-request by the credential provider.
            clean.apiKey = '';
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
            // task-343: notify host (e.g. YeaftSettings) to dispatch
            // yeaft_reset so the Engine picks up new provider config.
            this.$emit('saved');
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
