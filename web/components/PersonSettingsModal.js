import NavigationIcon from './NavigationIcon.js';
import {
  clearOverlayPointerGesture,
  shouldDismissFromOverlayClick,
  trackOverlayPointerDown,
  trackOverlayPointerUp,
} from '../utils/overlay-dismiss.js';

export default {
  name: 'PersonSettingsModal',
  components: { NavigationIcon },
  props: {
    name: { type: String, default: '' },
    renameSupported: Boolean,
    models: { type: Array, default: () => [] },
    candidates: { type: Array, default: () => [] },
    effectiveCandidates: { type: Array, default: () => [] },
    defaultModel: { type: String, default: null },
    agentDefaultModel: { type: String, default: null },
    effectiveDefaultModel: { type: String, default: null },
    defaultModelSupported: Boolean,
    saving: Boolean,
    disabled: Boolean,
    loading: Boolean,
    error: Object,
  },
  emits: ['close', 'save'],
  setup(props, { emit }) {
    // New Agents expose the effective set and a default-first eligible catalog.
    // Older Agents expose only a catalog: do not guess their inherited choice set.
    const inheritedCandidates = Vue.computed(() => !props.candidates.length && props.effectiveCandidates.length
      ? props.effectiveCandidates : props.defaultModelSupported ? props.models.slice(0, 8).map(model => model.id) : []);
    const inheritedKnown = Vue.computed(() => props.defaultModelSupported || !!props.effectiveCandidates.length);
    const selected = Vue.ref(props.candidates.length ? [...props.candidates] : [...inheritedCandidates.value]);
    const preferredDefault = Vue.ref(props.defaultModel || '');
    const defaultEdited = Vue.ref(false);
    const personName = Vue.ref(props.name);
    const nameEdited = Vue.ref(false);
    const invalidName = Vue.computed(() => !personName.value.trim() || new TextEncoder().encode(personName.value.trim()).length > 160);
    const dialog = Vue.ref(null);
    const followingDefault = Vue.ref(!props.candidates.length);
    const edited = Vue.ref(false);
    const previousFocus = document.activeElement;
    const unavailable = Vue.computed(() => selected.value.filter(id => !props.models.some(model => model.id === id)));
    const candidateIds = Vue.computed(() => followingDefault.value ? inheritedCandidates.value : selected.value);
    const invalid = Vue.computed(() => !followingDefault.value && (!selected.value.length || selected.value.length > 8 || unavailable.value.length > 0));
    const defaultChoices = Vue.computed(() => props.models.filter(model => candidateIds.value.includes(model.id)));
    const invalidDefault = Vue.computed(() => !!preferredDefault.value && !defaultChoices.value.some(model => model.id === preferredDefault.value));
    const automaticDefault = Vue.computed(() => props.defaultModelSupported
      ? defaultChoices.value.find(model => model.id === props.agentDefaultModel)?.id || defaultChoices.value[0]?.id || '—' : '—');
    const displayedDefault = Vue.computed(() => preferredDefault.value || automaticDefault.value);
    const controlsDisabled = Vue.computed(() => props.saving || props.disabled || props.loading);
    const cannotSave = Vue.computed(() => controlsDisabled.value || invalidName.value ||
      ((edited.value || defaultEdited.value) && (invalid.value || invalidDefault.value)));

    function focusableControls() {
      return [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])];
    }
    function keepFocusInside() {
      const active = document.activeElement;
      if (dialog.value && (!dialog.value.contains(active) || active?.disabled)) {
        (focusableControls()[0] || dialog.value).focus();
      }
    }
    function requestClose() {
      if (!props.saving) emit('close');
    }
    function onOverlayClick(event) {
      if (shouldDismissFromOverlayClick(event)) requestClose();
    }
    function save() {
      if (!cannotSave.value) {
        const update = {};
        if (props.renameSupported && personName.value.trim() !== props.name) update.name = personName.value.trim();
        if (edited.value) update.modelCandidates = followingDefault.value ? [] : [...selected.value];
        if (props.defaultModelSupported && defaultEdited.value) update.defaultModel = preferredDefault.value || null;
        emit('save', update);
      }
    }
    function keydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.value) return;
      const controls = focusableControls();
      const first = controls[0], last = controls.at(-1);
      const active = document.activeElement;
      if (!controls.length) {
        event.preventDefault();
        dialog.value.focus();
      } else if (active === dialog.value || !dialog.value.contains(active) || active?.disabled) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    Vue.onMounted(() => {
      document.addEventListener('keydown', keydown);
      document.addEventListener('focusin', keepFocusInside);
      Vue.nextTick(keepFocusInside);
    });
    Vue.onBeforeUnmount(() => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', keepFocusInside);
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    Vue.watch([controlsDisabled, followingDefault, unavailable], () => Vue.nextTick(keepFocusInside));
    // An initial/reconnect snapshot may arrive after the dialog opens. Do not
    // overwrite a user's in-progress selection with that snapshot.
    Vue.watch(() => props.name, name => { if (!nameEdited.value) personName.value = name; });
    Vue.watch([() => props.candidates, inheritedCandidates], ([candidates]) => {
      if (edited.value) return;
      selected.value = candidates.length ? [...candidates] : [...inheritedCandidates.value];
      followingDefault.value = !candidates.length;
    }, { deep: true });
    Vue.watch(() => props.defaultModel, model => { if (!defaultEdited.value) preferredDefault.value = model || ''; });

    return {
      personName, nameEdited, invalidName, selected, dialog, followingDefault, edited, invalid, unavailable, controlsDisabled, cannotSave,
      candidateIds, inheritedKnown, preferredDefault, defaultEdited, defaultChoices, invalidDefault, automaticDefault, displayedDefault,
      requestClose, save, onOverlayClick, trackOverlayPointerDown, trackOverlayPointerUp, clearOverlayPointerGesture,
    };
  },
  template: `
    <div class="modal-overlay person-settings-overlay"
      @pointerdown="trackOverlayPointerDown" @pointerup="trackOverlayPointerUp"
      @pointercancel="clearOverlayPointerGesture" @click="onOverlayClick">
      <section ref="dialog" class="modal person-settings-modal" role="dialog" aria-modal="true"
        aria-labelledby="person-settings-title" :aria-busy="saving || loading" tabindex="-1">
        <header class="person-settings-header">
          <h2 id="person-settings-title">{{ $t('person.settings') }}</h2>
          <button type="button" class="btn-ghost person-settings-close" :disabled="saving"
            :aria-label="$t('common.close')" @click="requestClose"><NavigationIcon name="close" :size="18" /></button>
        </header>
        <div class="person-settings-body">
          <label class="person-name-field" for="person-name">{{ $t('person.name') }}
            <input id="person-name" v-model="personName" @input="nameEdited = true" :disabled="controlsDisabled || !renameSupported" :aria-invalid="invalidName" maxlength="160" autocomplete="off">
          </label>
          <p v-if="!renameSupported" class="person-settings-help" role="status">{{ $t('person.renameUpgrade') }}</p>
          <p v-if="invalidName" class="person-settings-error" role="alert">{{ $t('person.nameInvalid') }}</p>
          <div class="person-model-fields" @change="edited = true">
            <div class="person-settings-intro">
              <h3 id="person-model-heading">{{ $t('person.modelCandidates') }}</h3>
              <p id="person-model-hint" class="person-settings-help">{{ $t('person.modelCandidatesHint') }}</p>
            </div>
            <label class="person-model-option person-model-default" :class="{ 'is-selected': followingDefault }">
              <input type="checkbox" v-model="followingDefault" :disabled="controlsDisabled" aria-describedby="person-model-hint">
              <span>{{ $t('person.modelsDefault') }}</span>
            </label>
            <p v-if="loading" class="person-settings-state" role="status">{{ $t('person.loading') }}</p>
            <template v-else>
              <p v-if="!models.length" class="person-settings-state" role="status">{{ $t('person.modelsEmpty') }}</p>
              <div v-if="models.length || unavailable.length" class="person-model-list" role="group"
                aria-labelledby="person-model-heading" aria-describedby="person-model-hint">
                <label v-for="model in models" :key="model.id" class="person-model-option"
                  :class="{ 'is-selected': candidateIds.includes(model.id) }">
                  <input type="checkbox" :checked="candidateIds.includes(model.id)" :value="model.id" :aria-label="model.id"
                    @change="selected = $event.target.checked ? [...selected, model.id] : selected.filter(id => id !== model.id)"
                    :disabled="followingDefault || controlsDisabled">
                  <span class="person-model-description"><span class="person-model-name">{{ model.id }}</span>
                    <span v-if="model.id === displayedDefault && candidateIds.includes(model.id)" class="person-model-role">{{ $t('person.defaultModel') }}</span>
                  </span>
                </label>
                <label v-for="id in unavailable" :key="id" class="person-model-option person-model-unavailable">
                  <input type="checkbox" v-model="selected" :value="id" :disabled="followingDefault || controlsDisabled">
                  <span class="person-model-description"><span class="person-model-name">{{ id }}</span><span class="person-model-warning">{{ $t('person.modelUnavailable') }}</span></span>
                </label>
              </div>
              <p v-if="invalid" role="alert" class="person-settings-error">{{ $t('person.modelsInvalid') }}</p>
              <p class="person-settings-help person-model-summary">{{ $t(followingDefault && !inheritedKnown ? 'person.candidatesUnknown' : 'person.candidatesSummary', { count: candidateIds.length }) }}</p>
            </template>
          </div>
          <div class="person-default-model-field">
            <label for="person-default-model">{{ $t('person.defaultModel') }}</label>
            <p v-if="agentDefaultModel" class="person-settings-help">{{ $t('person.agentDefaultModel', { model: agentDefaultModel }) }}</p>
            <select id="person-default-model" v-model="preferredDefault" @change="defaultEdited = true"
              :disabled="controlsDisabled || !defaultModelSupported || !defaultChoices.length"
              :aria-invalid="invalidDefault" aria-describedby="person-default-model-hint">
              <option value="">{{ $t('person.defaultModelAutomatic', { model: automaticDefault }) }}</option>
              <option v-for="model in defaultChoices" :key="model.id" :value="model.id">{{ model.id }}</option>
              <option v-if="invalidDefault" :value="preferredDefault" disabled>{{ preferredDefault }}</option>
            </select>
            <p id="person-default-model-hint" class="person-settings-help">{{ $t('person.defaultModelHint') }}</p>
            <p v-if="!defaultModelSupported" class="person-settings-help" role="status">{{ $t('person.defaultModelUpgrade') }}</p>
            <p v-if="invalidDefault" class="person-settings-error" role="alert">{{ $t('person.defaultModelInvalid') }}</p>
          </div>
          <p v-if="error" role="alert" class="person-settings-error">{{ $t('person.requestFailed') }} {{ error.message }}</p>
          <p class="person-settings-help person-settings-scope">{{ $t('person.modelsScope') }}</p>
        </div>
        <footer class="person-settings-footer">
          <span v-if="saving" class="person-settings-save-status" role="status">{{ $t('person.settingsSaving') }}</span>
          <button type="button" class="btn-secondary" :disabled="saving" @click="requestClose">{{ $t('common.cancel') }}</button>
          <button type="button" class="btn-primary" :disabled="cannotSave" @click="save">{{ $t(saving ? 'person.settingsSaving' : 'common.save') }}</button>
        </footer>
      </section>
    </div>
  `,
};
