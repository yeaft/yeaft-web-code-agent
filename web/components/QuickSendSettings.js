import ModernSelect from './ModernSelect.js';
import { modelOptionMatchesRef, modelOptionRef } from '../utils/modelRefs.js';

const MAX_QUICK_SENDS = 5;
const cloneEntries = entries => (Array.isArray(entries) ? entries : []).map(item => ({
  id: item.id, name: item.name, model: item.model,
  effort: item.effort ?? null, maxOutputTokens: item.maxOutputTokens ?? null,
}));

export default {
  name: 'QuickSendSettings',
  components: { ModernSelect },
  props: { agentId: { type: String, required: true } },
  emits: ['saved'],
  data() {
    return { draft: [], models: [], loaded: false, loading: false, saving: false,
      dirty: false, error: '', message: '', generation: 0, pending: null };
  },
  computed: {
    store() { return Pinia.useChatStore(); },
    online() { return !!this.store.agents?.find(agent => agent.id === this.agentId)?.online && this.store.ws?.readyState === 1; },
    currentConfig() { return this.store.llmConfig?.[this.agentId]; },
    disabled() { return !this.online || !this.loaded || this.loading || this.saving; },
    modelOptions() {
      return this.models.map(model => ({ value: modelOptionRef(model), label: model.label || model.id, badge: model.provider }));
    },
    effortOptions() {
      return item => [
        { value: '', label: this.$t('quickSend.default') },
        ...this.effortsFor(item).map(effort => ({ value: effort, label: effort })),
      ];
    },
  },
  watch: {
    agentId: {
      immediate: true,
      handler() {
        this.cancelPending();
        this.draft = []; this.models = []; this.loaded = false; this.dirty = false;
        this.error = ''; this.message = '';
        if (this.online) this.load();
      },
    },
    online(value) {
      this.cancelPending();
      if (value) this.load();
    },
    currentConfig(config) { this.receive(config); },
  },
  beforeUnmount() { this.cancelPending(); },
  methods: {
    cancelPending() {
      this.generation += 1;
      clearTimeout(this._requestTimer);
      this.pending = null; this.loading = false; this.saving = false;
    },
    request(kind, config) {
      if (!this.online) return;
      this.cancelPending();
      const requestId = `quick-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const generation = this.generation;
      this.pending = { kind, requestId, generation, agentId: this.agentId };
      this.loading = kind === 'load'; this.saving = kind === 'save'; this.error = ''; this.message = '';
      this._requestTimer = setTimeout(() => {
        if (this.pending?.generation !== generation) return;
        this.cancelPending();
        this.error = this.$t(kind === 'save' ? 'quickSend.saveFailed' : 'quickSend.loadFailed');
      }, 15000);
      try {
        this.store.sendWsMessage({ type: kind === 'load' ? 'get_llm_config' : 'update_llm_config',
          agentId: this.agentId, requestId, ...(config ? { config } : {}) });
      } catch (error) {
        this.cancelPending(); this.error = error?.message || String(error);
      }
    },
    load() { this.request('load'); },
    receive(config) {
      const pending = this.pending;
      if (!pending || pending.agentId !== this.agentId || pending.generation !== this.generation || config?.requestId !== pending.requestId) return;
      this.cancelPending();
      if (config.error) { this.error = config.error; return; }
      const agentConfig = config.agentConfig || config.effectiveConfig || {};
      this.models = agentConfig.availableModels || [];
      if (!this.dirty || pending.kind === 'save') {
        this.draft = cloneEntries(agentConfig.quickSends);
        this.dirty = false;
      }
      this.loaded = true;
      if (pending.kind === 'save') {
        this.message = config.statusRefreshError
          ? this.$t('quickSend.savedRefreshWarning', { error: config.statusRefreshError }) : this.$t('quickSend.saved');
        this.$emit('saved', this.agentId);
      }
    },
    modelFor(item) { return this.models.find(model => modelOptionMatchesRef(model, item.model)); },
    effortsFor(item) { return this.modelFor(item)?.effortOptions || []; },
    add() {
      if (this.disabled || this.draft.length >= MAX_QUICK_SENDS) return;
      this.draft.push({ id: globalThis.crypto?.randomUUID?.() || `qs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: '', model: '', effort: null, maxOutputTokens: null });
      this.changed();
    },
    remove(index) {
      if (this.disabled) return;
      this.draft.splice(index, 1); this.changed();
    },
    changed() { this.dirty = true; this.message = ''; this.error = ''; },
    changeModel(item, model) {
      item.model = model;
      if (!this.effortsFor(item).includes(item.effort)) item.effort = null;
      this.changed();
    },
    changeEffort(item, effort) { item.effort = effort || null; this.changed(); },
    setMaxOutput(item, value) { item.maxOutputTokens = value === '' ? null : Number(value); this.changed(); },
    validate() {
      if (this.draft.length > MAX_QUICK_SENDS) return this.$t('quickSend.limit');
      for (const item of this.draft) {
        if (!item.name?.trim() || item.name.trim().length > 80) return this.$t('quickSend.nameRequired');
        const model = this.modelFor(item);
        if (!model) return this.$t('quickSend.modelRequired');
        if (item.effort !== null && !this.effortsFor(item).includes(item.effort)) return this.$t('quickSend.effortInvalid');
        if (item.maxOutputTokens !== null && (!Number.isSafeInteger(item.maxOutputTokens) || item.maxOutputTokens <= 0 || item.maxOutputTokens > model.maxOutput)) {
          return this.$t('quickSend.outputInvalid', { max: model.maxOutput });
        }
      }
      return '';
    },
    save() {
      if (this.disabled || !this.dirty) return;
      this.error = this.validate();
      if (this.error) return;
      this.request('save', { quickSends: cloneEntries(this.draft).map(item => ({ ...item, name: item.name.trim() })) });
    },
  },
  template: `
    <section class="quick-send-settings" :aria-label="$t('quickSend.title')" :aria-busy="loading || saving">
      <header class="quick-send-settings-heading">
        <div><h4>{{ $t('quickSend.title') }}</h4><p>{{ $t('quickSend.description') }}</p></div>
        <button class="btn-ghost" type="button" :disabled="!online || loading || saving" @click="load">{{ $t('common.refresh') }}</button>
      </header>
      <p v-if="!online" role="status">{{ $t('quickSend.offline') }}</p>
      <p v-if="loading" role="status">{{ $t('common.loading') }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="loaded && !draft.length" class="quick-send-empty">{{ $t('quickSend.empty') }}</p>
      <fieldset v-for="(item, index) in draft" :key="item.id" class="quick-send-entry" :disabled="disabled">
        <legend><span class="quick-send-index">{{ index + 1 }}</span><span class="quick-send-entry-label">{{ $t('quickSend.entry', { index: index + 1 }) }}</span></legend>
        <label class="quick-send-name"><span>{{ $t('quickSend.name') }}</span><input v-model="item.name" maxlength="80" @input="changed"></label>
        <div class="quick-send-field quick-send-model"><span>{{ $t('quickSend.model') }}</span>
          <ModernSelect :model-value="item.model" :options="modelOptions" :aria-label="$t('quickSend.model')"
            :placeholder="$t('quickSend.chooseModel')" :empty-text="$t('quickSend.noModels')" searchable :disabled="disabled" @update:model-value="changeModel(item, $event)" />
        </div>
        <div class="quick-send-field quick-send-effort"><span>{{ $t('quickSend.effort') }}</span>
          <ModernSelect :model-value="item.effort || ''" :options="effortOptions(item)" :aria-label="$t('quickSend.effort')"
            :disabled="disabled || !effortsFor(item).length" @update:model-value="changeEffort(item, $event)" />
        </div>
        <label class="quick-send-output"><span>{{ $t('quickSend.maxOutputTokens') }}</span>
          <input type="number" min="1" step="1" :max="modelFor(item)?.maxOutput" :value="item.maxOutputTokens"
            :placeholder="$t('quickSend.default')" :title="modelFor(item)?.maxOutput ? $t('quickSend.outputLimit', { max: modelFor(item).maxOutput }) : ''"
            @input="setMaxOutput(item, $event.target.value)">
        </label>
        <button class="btn-ghost quick-send-remove" type="button" :aria-label="$t('quickSend.remove')" :title="$t('quickSend.remove')" @click="remove(index)">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M5 5l10 10M15 5 5 15"/></svg>
        </button>
      </fieldset>
      <footer class="quick-send-settings-actions">
        <button class="btn-secondary" type="button" :disabled="disabled || draft.length >= 5" @click="add">{{ $t('quickSend.add') }}</button>
        <span v-if="draft.length >= 5">{{ $t('quickSend.limit') }}</span>
        <button class="btn-primary" type="button" :disabled="disabled || !dirty" @click="save">{{ saving ? $t('common.saving') : $t('common.save') }}</button>
      </footer>
    </section>
  `,
};
