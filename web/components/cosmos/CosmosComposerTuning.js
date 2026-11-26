/**
 * Yeaft Cosmos — Unified Upward-Floating Composer Tuning Trigger & Popover
 *
 * Consolidates Model, Reasoning Effort, and localized Scene selection into a
 * single calm borderless trigger + upward-opening atmospheric glass sheet.
 * Shared identically by CosmosQuickComposer and CosmosConversationDrawer so
 * both surfaces stay minimal, border-free, accessible, and viewport-safe.
 */
import { modelOptionMatchesRef } from '../../utils/modelRefs.js';

export default {
  name: 'CosmosComposerTuning',
  props: {
    modelRows: { type: Array, default: () => [] },
    activeModel: { type: String, default: '' },
    activeModelLabel: { type: String, default: '' },
    modelDisabled: { type: Boolean, default: false },
    modelBusy: { type: Boolean, default: false },
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
  emits: ['open', 'select-model', 'select-effort', 'select-scene', 'open-llm-config'],
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
        :aria-busy="modelBusy || sceneBusy ? 'true' : undefined"
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
        :style="popoverStyle"
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
          <div
            ref="modelGroupRef"
            class="cosmos-tune-model-list"
            role="radiogroup"
            :aria-label="$t('yeaft.modelMenu.label')"
            :aria-busy="modelBusy ? 'true' : undefined"
            @keydown="onRadioGroupKeydown($event, 'model')"
          >
            <button
              v-for="(row, idx) in modelRows"
              :key="row.modelRef"
              type="button"
              class="cosmos-tune-model-row"
              :class="{ 'is-active': isModelActive(row) }"
              role="radio"
              :tabindex="idx === modelTabIndex ? 0 : -1"
              :aria-checked="isModelActive(row) ? 'true' : 'false'"
              :disabled="modelDisabled"
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
          <div
            ref="effortGroupRef"
            class="cosmos-tune-segments"
            role="radiogroup"
            :aria-label="$t('yeaft.modelMenu.effort')"
            :aria-busy="modelBusy ? 'true' : undefined"
            @keydown="onRadioGroupKeydown($event, 'effort')"
          >
            <button
              v-for="(eff, idx) in effortOptions"
              :key="eff"
              type="button"
              class="cosmos-tune-seg"
              :class="{ 'is-active': eff === effectiveEffort }"
              role="radio"
              :tabindex="idx === effortTabIndex ? 0 : -1"
              :aria-checked="eff === effectiveEffort ? 'true' : 'false'"
              :disabled="modelDisabled"
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
          <div
            ref="sceneGroupRef"
            class="cosmos-tune-chips"
            role="radiogroup"
            :aria-label="$t('yeaft.session.scene.label')"
            :aria-busy="sceneBusy ? 'true' : undefined"
            @keydown="onRadioGroupKeydown($event, 'scene')"
          >
            <button
              v-for="(opt, idx) in sceneOptions"
              :key="opt.id"
              type="button"
              class="cosmos-tune-chip"
              :class="{ 'is-active': opt.id === activeScene }"
              role="radio"
              :tabindex="idx === sceneTabIndex ? 0 : -1"
              :aria-checked="opt.id === activeScene ? 'true' : 'false'"
              :disabled="sceneDisabled"
              :aria-disabled="sceneDisabled || sceneBusy ? 'true' : undefined"
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
    const modelGroupRef = Vue.ref(null);
    const effortGroupRef = Vue.ref(null);
    const sceneGroupRef = Vue.ref(null);
    const isOpen = Vue.ref(false);
    const popoverLayout = Vue.ref(null);
    const rovingIndex = Vue.reactive({ model: -1, effort: -1, scene: -1 });

    let boundsObserver = null;
    let stopBoundsListeners = null;
    let pendingFocusOnOpen = false;

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

    const popoverStyle = Vue.computed(() => popoverLayout.value || undefined);

    function isModelActive(row) {
      if (!row?.model || !props.activeModel) return false;
      return modelOptionMatchesRef(row.model, props.activeModel);
    }

    const modelTabIndex = Vue.computed(() => {
      if (rovingIndex.model >= 0 && rovingIndex.model < props.modelRows.length) return rovingIndex.model;
      const idx = props.modelRows.findIndex((r) => isModelActive(r));
      return idx >= 0 ? idx : 0;
    });

    const effortTabIndex = Vue.computed(() => {
      if (rovingIndex.effort >= 0 && rovingIndex.effort < props.effortOptions.length) return rovingIndex.effort;
      const idx = props.effortOptions.indexOf(effectiveEffort.value);
      return idx >= 0 ? idx : 0;
    });

    const sceneTabIndex = Vue.computed(() => {
      if (rovingIndex.scene >= 0 && rovingIndex.scene < props.sceneOptions.length) return rovingIndex.scene;
      const idx = props.sceneOptions.findIndex((o) => o.id === props.activeScene);
      return idx >= 0 ? idx : 0;
    });

    function isBlocked() {
      if (props.disabled) return true;
      const el = triggerRef.value;
      if (!el) return true;
      if (typeof el.closest === 'function' && el.closest('[inert], [aria-hidden="true"]')) {
        return true;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
      }
      return false;
    }

    function isInteractive() {
      if (isBlocked()) return false;
      const el = triggerRef.value;
      if (!el || !el.isConnected) return false;
      return typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true;
    }

    function revealWithinScrollableAncestors(target, boundaryEl) {
      if (!target || !boundaryEl || typeof target.getBoundingClientRect !== 'function') return;
      let scroller = target.parentElement;
      while (scroller) {
        if (scroller.scrollHeight > scroller.clientHeight + 1 && typeof scroller.getBoundingClientRect === 'function') {
          const targetRect = target.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          if (targetRect.top < scrollerRect.top + 4) {
            scroller.scrollTop -= (scrollerRect.top + 4 - targetRect.top);
          } else if (targetRect.bottom > scrollerRect.bottom - 4) {
            scroller.scrollTop += (targetRect.bottom - (scrollerRect.bottom - 4));
          }
        }
        if (scroller === boundaryEl) break;
        scroller = scroller.parentElement;
      }
    }

    function updatePopoverBounds() {
      if (!isOpen.value || !popoverRef.value) return;
      const anchorEl = popoverRef.value.offsetParent
        || rootRef.value?.closest?.('.cosmos-quick-composer, .input-wrapper.chat-composer');
      if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return;
      const anchorRect = anchorEl.getBoundingClientRect();
      if (!anchorRect || (anchorRect.width === 0 && anchorRect.height === 0)) return;
      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      const viewportTop = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
      const viewportHeight = vv && Number.isFinite(vv.height) ? vv.height : (window.innerHeight || 0);
      const viewportBottom = viewportTop + viewportHeight;
      const drawerEl = rootRef.value?.closest?.('.cosmos-drawer');
      const drawerHeadEl = drawerEl?.querySelector?.('.cosmos-drawer-head');
      let topLimit = viewportTop + 12;
      let bottomLimit = viewportBottom - 12;
      if (drawerEl && typeof drawerEl.getBoundingClientRect === 'function') {
        const drawerRect = drawerEl.getBoundingClientRect();
        topLimit = Math.max(topLimit, drawerRect.top + 8);
        bottomLimit = Math.min(bottomLimit, drawerRect.bottom - 8);
        if (drawerHeadEl && typeof drawerHeadEl.getBoundingClientRect === 'function') {
          const headRect = drawerHeadEl.getBoundingClientRect();
          topLimit = Math.max(topLimit, headRect.bottom + 8);
        }
      }
      const gapAboveAnchor = 10;
      const minUsableAbove = 120;
      const intendedBottom = anchorRect.top - gapAboveAnchor;
      const availableAbove = Math.floor(intendedBottom - topLimit);
      if (availableAbove >= minUsableAbove && intendedBottom <= bottomLimit) {
        popoverLayout.value = {
          top: 'auto',
          bottom: `calc(100% + ${gapAboveAnchor}px)`,
          maxHeight: `${Math.min(440, availableAbove)}px`,
        };
      } else {
        // Too little room above the anchor, or the anchor's upward edge lies below
        // visualViewport bottom (e.g. mobile soft keyboard shrinks only visualViewport):
        // keep the sheet strictly inside [topLimit, bottomLimit].
        const availableViewport = Math.max(0, Math.floor(bottomLimit - topLimit));
        const topOffset = Math.ceil(topLimit - anchorRect.top);
        popoverLayout.value = {
          top: `${topOffset}px`,
          bottom: 'auto',
          maxHeight: `${Math.min(440, availableViewport)}px`,
        };
      }
    }

    function teardownBoundsTracking() {
      if (boundsObserver) {
        boundsObserver.disconnect();
        boundsObserver = null;
      }
      if (stopBoundsListeners) {
        stopBoundsListeners();
        stopBoundsListeners = null;
      }
    }

    function setupBoundsTracking() {
      teardownBoundsTracking();
      updatePopoverBounds();
      if (typeof ResizeObserver === 'function') {
        boundsObserver = new ResizeObserver(() => updatePopoverBounds());
        const anchorEl = popoverRef.value?.offsetParent
          || rootRef.value?.closest?.('.cosmos-quick-composer, .input-wrapper.chat-composer');
        if (anchorEl) boundsObserver.observe(anchorEl);
        const drawerEl = rootRef.value?.closest?.('.cosmos-drawer');
        if (drawerEl && drawerEl !== anchorEl) boundsObserver.observe(drawerEl);
      }
      const onViewportChange = () => updatePopoverBounds();
      window.addEventListener('resize', onViewportChange);
      const vv = window.visualViewport;
      vv?.addEventListener?.('resize', onViewportChange);
      vv?.addEventListener?.('scroll', onViewportChange);
      stopBoundsListeners = () => {
        window.removeEventListener('resize', onViewportChange);
        vv?.removeEventListener?.('resize', onViewportChange);
        vv?.removeEventListener?.('scroll', onViewportChange);
      };
    }

    function focusFirstPopoverControl() {
      const pop = popoverRef.value;
      const target = pop?.querySelector?.('button[role="radio"][tabindex="0"]:not(:disabled)')
        || pop?.querySelector?.('button:not(:disabled)')
        || triggerRef.value;
      target?.focus?.({ preventScroll: true });
      if (target && pop && pop.contains(target)) {
        revealWithinScrollableAncestors(target, pop);
      }
    }

    function resetRovingIndices() {
      rovingIndex.model = -1;
      rovingIndex.effort = -1;
      rovingIndex.scene = -1;
    }

    function openPopover({ focusFirst = false } = {}) {
      if (isBlocked()) return;
      if (!isOpen.value) {
        resetRovingIndices();
        pendingFocusOnOpen = focusFirst;
        isOpen.value = true;
        emit('open');
      } else if (focusFirst) {
        focusFirstPopoverControl();
      }
    }

    function close(restoreFocus = false) {
      if (!isOpen.value) return;
      isOpen.value = false;
      pendingFocusOnOpen = false;
      resetRovingIndices();
      teardownBoundsTracking();
      popoverLayout.value = null;
      if (restoreFocus && !isBlocked()) {
        Vue.nextTick(() => triggerRef.value?.focus?.({ preventScroll: true }));
      }
    }

    function toggle() {
      if (isBlocked()) return;
      if (isOpen.value) close(false);
      else openPopover();
    }

    function onSelectModel(row) {
      if (!row?.modelRef || props.modelDisabled) return;
      rovingIndex.model = -1;
      rovingIndex.effort = -1;
      emit('select-model', { modelRef: row.modelRef, defaultEffort: row.defaultEffort || null });
    }

    function onSelectEffort(eff) {
      if (props.modelDisabled) return;
      rovingIndex.effort = -1;
      emit('select-effort', eff);
    }

    function onSelectScene(sceneId) {
      if (props.sceneDisabled || props.sceneBusy) return;
      rovingIndex.scene = -1;
      emit('select-scene', sceneId);
    }

    function onOpenConfig() {
      close(false);
      emit('open-llm-config');
    }

    function onRadioGroupKeydown(event, groupName) {
      const { key } = event;
      const groupEl = groupName === 'model'
        ? modelGroupRef.value
        : groupName === 'effort'
          ? effortGroupRef.value
          : sceneGroupRef.value;
      if (!groupEl) return;
      const allRadios = Array.from(groupEl.querySelectorAll('button[role="radio"]'));
      const enabledIndices = [];
      allRadios.forEach((btn, idx) => {
        if (!btn.disabled) enabledIndices.push(idx);
      });
      if (!enabledIndices.length) return;
      const currentDomIdx = allRadios.includes(event.target)
        ? allRadios.indexOf(event.target)
        : allRadios.indexOf(document.activeElement);
      const currentPos = enabledIndices.indexOf(currentDomIdx);
      let nextPos = -1;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        nextPos = currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length;
      } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
        nextPos = currentPos < 0 ? enabledIndices.length - 1 : (currentPos - 1 + enabledIndices.length) % enabledIndices.length;
      } else if (key === 'Home') {
        nextPos = 0;
      } else if (key === 'End') {
        nextPos = enabledIndices.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const targetIdx = enabledIndices[nextPos];
      // WAI-ARIA APG standalone radiogroup: arrow navigation moves focus AND selects
      // through the existing guarded handlers only when changing selection (so Home
      // on an already-checked model never resets a custom effort or queues a no-op write).
      if (groupName === 'model' && props.modelRows[targetIdx]) {
        if (!isModelActive(props.modelRows[targetIdx])) {
          onSelectModel(props.modelRows[targetIdx]);
        }
      } else if (groupName === 'effort' && props.effortOptions[targetIdx] !== undefined) {
        if (props.effortOptions[targetIdx] !== effectiveEffort.value) {
          onSelectEffort(props.effortOptions[targetIdx]);
        }
      } else if (groupName === 'scene' && props.sceneOptions[targetIdx]) {
        if (props.sceneOptions[targetIdx].id !== props.activeScene) {
          onSelectScene(props.sceneOptions[targetIdx].id);
        }
      }
      rovingIndex[groupName] = targetIdx;
      const targetBtn = allRadios[targetIdx];
      targetBtn?.focus({ preventScroll: true });
      if (targetBtn && popoverRef.value) {
        revealWithinScrollableAncestors(targetBtn, popoverRef.value);
      }
    }

    function onKeydown(event) {
      if (event.key === 'Escape' && isOpen.value) {
        if (isBlocked()) {
          close(false);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (!isOpen.value && !isBlocked() && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        openPopover({ focusFirst: true });
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
      if (!isInteractive()) {
        close(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }

    Vue.watch(isOpen, (open) => {
      if (open) {
        setupBoundsTracking();
        if (pendingFocusOnOpen) {
          pendingFocusOnOpen = false;
          // Wait one tick so inline maxHeight/top layout has flushed before measuring scroll reveal
          Vue.nextTick(() => focusFirstPopoverControl());
        }
      } else {
        teardownBoundsTracking();
        popoverLayout.value = null;
      }
    }, { flush: 'post' });

    Vue.watch(() => props.scopeKey, () => {
      close(false);
    });

    Vue.watch(() => props.disabled, (val) => {
      if (val) close(false);
    });

    Vue.watch(() => props.sceneDisabled, (disabledNow) => {
      if (disabledNow && isOpen.value && sceneGroupRef.value?.contains(document.activeElement)) {
        focusFirstPopoverControl();
      }
    });

    Vue.watch(() => props.modelDisabled, (disabledNow) => {
      if (disabledNow && isOpen.value
          && (modelGroupRef.value?.contains(document.activeElement)
            || effortGroupRef.value?.contains(document.activeElement))) {
        focusFirstPopoverControl();
      }
    });

    Vue.onMounted(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeydown);
    });

    Vue.onBeforeUnmount(() => {
      teardownBoundsTracking();
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeydown);
    });

    expose({
      close,
      isOpen: () => isOpen.value,
      updatePopoverBounds,
    });

    return {
      popoverId,
      rootRef,
      triggerRef,
      popoverRef,
      modelGroupRef,
      effortGroupRef,
      sceneGroupRef,
      isOpen,
      popoverStyle,
      hasAnyControls,
      effectiveEffort,
      hasCustomScene,
      summaryModel,
      summaryEffort,
      summaryScene,
      triggerAriaLabel,
      modelTabIndex,
      effortTabIndex,
      sceneTabIndex,
      isModelActive,
      toggle,
      close,
      onSelectModel,
      onSelectEffort,
      onSelectScene,
      onOpenConfig,
      onRadioGroupKeydown,
      onKeydown,
      onFocusout,
    };
  },
};
