/**
 * Yeaft Cosmos — Unified Upward-Floating Composer Tuning Trigger & Popover
 *
 * Consolidates Model, Reasoning Effort, and localized Scene selection into a
 * single calm borderless trigger + upward-opening atmospheric glass sheet.
 * Shared identically by CosmosQuickComposer and CosmosConversationDrawer so
 * both surfaces stay minimal, border-free, and zero-clutter.
 */
import { modelOptionMatchesRef } from '../../utils/modelRefs.js';

export default {
  name: 'CosmosComposerTuning',
  props: {
    modelRows: { type: Array, default: () => [] },
    activeModel: { type: String, default: '' },
    activeModelLabel: { type: String, default: '' },
    effortOptions: { type: Array, default: () => [] },
    activeEffort: { type: String, default: '' },
    showScene: { type: Boolean, default: false },
    sceneOptions: { type: Array, default: () => [] },
    activeScene: { type: String, default: '' },
    defaultSceneId: { type: String, default: 'general' },
    sceneHint: { type: String, default: '' },
    sceneDisabled: { type: Boolean, default: false },
    sceneBusy: { type: Boolean, default: false },
    sceneError: { type: String, default: '' },
    showConfigure: { type: Boolean, default: true },
    disabled: { type: Boolean, default: false },
    scopeKey: { type: String, default: '' },
  },
  emits: ['select-model', 'select-effort', 'select-scene', 'open-llm-config'],
  template: `
    <div
      v-if="hasAnyControls"
      ref="rootRef"
      class="cosmos-tune"
      :class="{ 'is-open': isOpen, 'is-disabled': disabled }"
      @keydown="onKeydown"
      @focusout="onFocusout"
    >
      <button
        ref="triggerRef"
        type="button"
        class="cosmos-tune-trigger"
        :class="{ 'is-open': isOpen, 'has-custom-scene': hasCustomScene }"
        :disabled="disabled"
        aria-haspopup="dialog"
        :aria-expanded="isOpen ? 'true' : 'false'"
        :aria-controls="isOpen ? popoverId : undefined"
        :aria-label="triggerAriaLabel"
        :title="triggerAriaLabel"
        @click.stop="toggle"
      >
        <span v-if="hasCustomScene" class="cosmos-tune-dot" aria-hidden="true"></span>
        <span v-if="summaryScene" class="cosmos-tune-scene">{{ summaryScene }}</span>
        <span v-if="summaryScene && summaryModel" class="cosmos-tune-sep" aria-hidden="true">·</span>
        <span v-if="summaryModel" class="cosmos-tune-model">{{ summaryModel }}</span>
        <span v-if="summaryModel && summaryEffort" class="cosmos-tune-sep" aria-hidden="true">·</span>
        <span v-if="summaryEffort" class="cosmos-tune-effort">{{ summaryEffort }}</span>
        <svg class="cosmos-tune-chevron" :class="{ 'is-open': isOpen }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m7 10 5 5 5-5"/>
        </svg>
      </button>

      <div
        v-if="isOpen"
        :id="popoverId"
        ref="popoverRef"
        class="cosmos-tune-popover"
        role="dialog"
        :aria-label="$t('cosmos.composer.tuneLabel')"
        @pointerdown.stop
        @wheel.stop
      >
        <!-- Section 1: Model Selection -->
        <section v-if="modelRows.length > 0" class="cosmos-tune-section">
          <div class="cosmos-tune-section-head">
            <span class="cosmos-tune-section-title">{{ $t('yeaft.modelMenu.label') }}</span>
            <button
              v-if="showConfigure"
              type="button"
              class="cosmos-tune-config-link"
              @click="onOpenConfig"
            >{{ $t('cosmos.composer.configureShort') }}</button>
          </div>
          <div class="cosmos-tune-model-list" role="radiogroup" :aria-label="$t('yeaft.modelMenu.label')">
            <button
              v-for="row in modelRows"
              :key="row.modelRef"
              type="button"
              class="cosmos-tune-model-row"
              :class="{ 'is-active': isModelActive(row) }"
              role="radio"
              :aria-checked="isModelActive(row) ? 'true' : 'false'"
              @click="onSelectModel(row)"
            >
              <span class="cosmos-tune-check" aria-hidden="true">
                <span v-if="isModelActive(row)" class="cosmos-tune-check-dot"></span>
              </span>
              <span class="cosmos-tune-model-label">{{ row.label }}</span>
              <span v-if="row.model?.provider" class="cosmos-tune-model-provider">{{ row.model.provider }}</span>
            </button>
          </div>
        </section>

        <!-- Section 2: Reasoning Effort (Single-Row Segmented Track) -->
        <section v-if="effortOptions.length > 0" class="cosmos-tune-section">
          <div class="cosmos-tune-section-head">
            <span class="cosmos-tune-section-title">{{ $t('yeaft.modelMenu.effort') }}</span>
          </div>
          <div class="cosmos-tune-segments" role="radiogroup" :aria-label="$t('yeaft.modelMenu.effort')">
            <button
              v-for="eff in effortOptions"
              :key="eff"
              type="button"
              class="cosmos-tune-seg"
              :class="{ 'is-active': eff === effectiveEffort }"
              role="radio"
              :aria-checked="eff === effectiveEffort ? 'true' : 'false'"
              @click="onSelectEffort(eff)"
            >{{ $t('yeaft.modelMenu.effort.' + eff) }}</button>
          </div>
        </section>

        <!-- Section 3: Localized Scene Chips -->
        <section v-if="showScene && sceneOptions.length > 0" class="cosmos-tune-section">
          <div class="cosmos-tune-section-head">
            <span class="cosmos-tune-section-title">{{ $t('yeaft.session.scene.label') }}</span>
            <span v-if="sceneHint" class="cosmos-tune-section-hint">{{ sceneHint }}</span>
          </div>
          <div class="cosmos-tune-chips" role="radiogroup" :aria-label="$t('yeaft.session.scene.label')">
            <button
              v-for="opt in sceneOptions"
              :key="opt.id"
              type="button"
              class="cosmos-tune-chip"
              :class="{ 'is-active': opt.id === activeScene }"
              role="radio"
              :aria-checked="opt.id === activeScene ? 'true' : 'false'"
              :disabled="sceneDisabled || sceneBusy"
              :aria-busy="sceneBusy && opt.id === activeScene ? 'true' : undefined"
              @click="onSelectScene(opt.id)"
            >{{ opt.label }}</button>
          </div>
          <div v-if="sceneError" class="cosmos-tune-error" role="alert">{{ sceneError }}</div>
        </section>
      </div>
    </div>
  `,
  setup(props, { emit, expose }) {
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);
    const popoverId = `cosmos-tune-${typeof Vue.useId === 'function' ? Vue.useId() : Math.random().toString(36).slice(2, 8)}`;

    const rootRef = Vue.ref(null);
    const triggerRef = Vue.ref(null);
    const popoverRef = Vue.ref(null);
    const isOpen = Vue.ref(false);

    const hasAnyControls = Vue.computed(() => (
      props.modelRows.length > 0
      || props.effortOptions.length > 0
      || (props.showScene && props.sceneOptions.length > 0)
    ));

    const effectiveEffort = Vue.computed(() => {
      if (props.activeEffort && props.effortOptions.includes(props.activeEffort)) {
        return props.activeEffort;
      }
      return props.effortOptions[0] || '';
    });

    const activeSceneOption = Vue.computed(() => (
      props.sceneOptions.find((o) => o.id === props.activeScene) || null
    ));

    const hasCustomScene = Vue.computed(() => (
      Boolean(props.showScene && props.activeScene && props.activeScene !== props.defaultSceneId)
    ));

    const summaryModel = Vue.computed(() => (
      props.modelRows.length > 0 ? (props.activeModelLabel || '') : ''
    ));

    const summaryEffort = Vue.computed(() => {
      if (!effectiveEffort.value) return '';
      return $t(`yeaft.modelMenu.effort.${effectiveEffort.value}`);
    });

    const summaryScene = Vue.computed(() => {
      if (!props.showScene || !props.sceneOptions.length) return '';
      // Show scene in compact trigger when user explicitly chose a non-default scene,
      // or when model catalog is empty so the trigger still has a crisp label.
      if (hasCustomScene.value || !summaryModel.value) {
        if (props.activeScene === 'none') return $t('cosmos.composer.sceneNoneShort');
        if (props.activeScene === 'auto') return $t('cosmos.composer.sceneAutoShort');
        return activeSceneOption.value?.label || '';
      }
      return '';
    });

    const triggerAriaLabel = Vue.computed(() => {
      const parts = [summaryScene.value, summaryModel.value, summaryEffort.value].filter(Boolean);
      const base = $t('cosmos.composer.tuneLabel');
      return parts.length ? `${base}: ${parts.join(' · ')}` : base;
    });

    function isModelActive(row) {
      if (!row?.model || !props.activeModel) return false;
      return modelOptionMatchesRef(row.model, props.activeModel);
    }

    function isRendered() {
      const el = triggerRef.value;
      if (!el || !el.isConnected) return false;
      return typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true;
    }

    function close(restoreFocus = false) {
      if (!isOpen.value) return;
      isOpen.value = false;
      if (restoreFocus) {
        Vue.nextTick(() => triggerRef.value?.focus?.({ preventScroll: true }));
      }
    }

    function toggle() {
      if (props.disabled) return;
      isOpen.value = !isOpen.value;
    }

    function onSelectModel(row) {
      if (!row?.modelRef) return;
      emit('select-model', { modelRef: row.modelRef, defaultEffort: row.defaultEffort || null });
    }

    function onSelectEffort(eff) {
      emit('select-effort', eff);
    }

    function onSelectScene(sceneId) {
      if (props.sceneDisabled || props.sceneBusy) return;
      emit('select-scene', sceneId);
    }

    function onOpenConfig() {
      close(false);
      emit('open-llm-config');
    }

    function onKeydown(event) {
      if (event.key === 'Escape' && isOpen.value) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (!isOpen.value && !props.disabled && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        isOpen.value = true;
      }
    }

    function onFocusout(event) {
      if (isOpen.value && event.relatedTarget && !rootRef.value?.contains(event.relatedTarget)) {
        close(false);
      }
    }

    function onDocPointerDown(event) {
      if (isOpen.value && !rootRef.value?.contains(event.target)) {
        close(false);
      }
    }

    function onDocKeydown(event) {
      if (!isOpen.value || event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isRendered()) {
        isOpen.value = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }

    Vue.watch(() => props.scopeKey, () => {
      isOpen.value = false;
    });

    Vue.watch(() => props.disabled, (val) => {
      if (val) isOpen.value = false;
    });

    Vue.onMounted(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeydown);
    });

    Vue.onBeforeUnmount(() => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeydown);
    });

    expose({
      close,
      isOpen: () => isOpen.value,
    });

    return {
      popoverId,
      rootRef,
      triggerRef,
      popoverRef,
      isOpen,
      hasAnyControls,
      effectiveEffort,
      hasCustomScene,
      summaryModel,
      summaryEffort,
      summaryScene,
      triggerAriaLabel,
      isModelActive,
      toggle,
      close,
      onSelectModel,
      onSelectEffort,
      onSelectScene,
      onOpenConfig,
      onKeydown,
      onFocusout,
    };
  },
};
