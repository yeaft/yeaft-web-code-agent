export default {
  name: 'PersonSettingsModal',
  props: { models: { type: Array, default: () => [] }, candidates: { type: Array, default: () => [] }, saving: Boolean, disabled: Boolean, error: Object },
  emits: ['close', 'save'],
  setup(props, { emit }) {
    const selected = Vue.ref([...props.candidates]);
    const dialog = Vue.ref(null);
    const followingDefault = Vue.ref(!props.candidates.length);
    const previousFocus = document.activeElement;
    Vue.onMounted(() => Vue.nextTick(() => dialog.value?.querySelector('button')?.focus()));
    Vue.onBeforeUnmount(() => previousFocus?.isConnected && previousFocus.focus());
    Vue.watch(() => props.saving, () => Vue.nextTick(() => dialog.value?.focus()));
    const unavailable = Vue.computed(() => selected.value.filter(id => !props.models.some(m => m.id === id)));
    function keydown(event) {
      if (event.key === 'Escape' && !props.saving) { event.preventDefault(); event.stopPropagation(); emit('close'); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.value.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      if (!controls.length) { event.preventDefault(); dialog.value.focus(); return; }
      const first = controls[0], last = controls.at(-1);
      if (document.activeElement === dialog.value || !dialog.value.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    const invalid = Vue.computed(() => !followingDefault.value && (!selected.value.length || selected.value.length > 8 || selected.value.some(id => !props.models.some(m => m.id === id))));
    return { selected, dialog, followingDefault, invalid, unavailable, keydown, emit };
  },
  template: `
    <div class="modal-overlay person-settings-overlay" @click.self="!saving && emit('close')" @keydown="keydown">
      <section ref="dialog" class="modal person-settings-modal" role="dialog" aria-modal="true" aria-labelledby="person-settings-title" tabindex="-1">
        <header class="person-settings-header"><h2 id="person-settings-title">{{ $t('person.settings') }}</h2><button type="button" class="btn-ghost" :disabled="saving" @click="emit('close')">{{ $t('common.close') }}</button></header>
        <div class="person-settings-body">
          <h3>{{ $t('person.modelCandidates') }}</h3>
          <p class="person-muted">{{ $t('person.modelCandidatesHint') }}</p>
          <label class="person-model-option"><input type="checkbox" v-model="followingDefault" :disabled="saving || disabled">{{ $t('person.modelsDefault') }}</label>
          <div v-if="!models.length" class="person-muted">{{ $t('person.modelsEmpty') }}</div>
          <label v-for="model in models" :key="model.id" class="person-model-option"><input type="checkbox" v-model="selected" :value="model.id" :disabled="followingDefault || saving || disabled"> <span>{{ model.id }}</span></label>
          <label v-for="id in unavailable" :key="id" class="person-model-option"><input type="checkbox" v-model="selected" :value="id" :disabled="followingDefault || saving || disabled"> <span>{{ id }} · {{ $t('person.modelUnavailable') }}</span></label>
          <p v-if="invalid" role="alert" class="person-settings-error">{{ $t('person.modelsInvalid') }}</p>
          <p v-if="error" role="alert" class="person-settings-error">{{ $t('person.requestFailed') }} {{ error.message }}</p>
          <p class="person-muted">{{ $t('person.modelsScope') }}</p>
        </div>
        <footer class="person-settings-footer"><button type="button" class="btn-secondary" :disabled="saving" @click="emit('close')">{{ $t('common.cancel') }}</button><button type="button" class="btn-primary" :disabled="disabled || saving || invalid || !models.length" @click="emit('save', followingDefault ? [] : selected)">{{ $t(saving ? 'person.settingsSaving' : 'common.save') }}</button></footer>
      </section>
    </div>
  `,
};
