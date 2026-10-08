import {
  buildVirtualOffsets,
  computeVirtualWindowFromLayout,
  estimateVirtualItemHeight,
  getVirtualItemKey,
  virtualScrollTopForIndex,
  virtualTranscriptDefaults,
} from '../utils/virtual-transcript.js';

const HEIGHT_CHANGE_THRESHOLD = 2;

export default {
  name: 'VirtualTranscript',
  props: {
    items: { type: Array, default: () => [] },
    overscan: { type: Number, default: virtualTranscriptDefaults.overscan },
    itemGap: { type: Number, default: virtualTranscriptDefaults.itemGap },
    estimateHeight: { type: Function, default: estimateVirtualItemHeight },
    initialAlign: { type: String, default: 'start' },
  },
  emits: ['scroll-state'],
  template: `
    <div class="virtual-transcript" ref="rootRef">
      <div
        v-if="topSpacerHeight > 0"
        class="virtual-transcript-spacer"
        :style="{ height: topSpacerHeight + 'px' }"
        aria-hidden="true"
      ></div>
      <div class="virtual-transcript-window" :style="{ gap: itemGap + 'px' }">
        <div
          v-for="entry in visibleEntries"
          :key="entry.key"
          class="virtual-transcript-item"
          :data-virtual-index="entry.index"
          :data-virtual-id="entry.key"
          :ref="el => setItemRef(entry.key, entry.index, el)"
        >
          <slot :item="entry.item" :index="entry.index"></slot>
        </div>
      </div>
      <div
        v-if="bottomSpacerHeight > 0"
        class="virtual-transcript-spacer"
        :style="{ height: bottomSpacerHeight + 'px' }"
        aria-hidden="true"
      ></div>
    </div>
  `,
  setup(props, { emit, expose }) {
    const rootRef = Vue.ref(null);
    const scrollEl = Vue.ref(null);
    let initialEndPending = props.initialAlign === 'end';
    const scrollTop = Vue.ref(initialEndPending ? Number.MAX_SAFE_INTEGER : 0);
    const viewportHeight = Vue.ref(virtualTranscriptDefaults.viewportHeight);
    const heightCache = Vue.reactive({});
    const itemIndexByKey = new Map();
    const itemEls = new Map();
    const pendingMeasurements = new Map();
    let resizeObserver = null;
    let geometryObserver = null;
    const geometryTargets = new Set();
    let rafId = null;
    let measureRafId = null;
    let scrollAdjustRafId = null;
    let pendingScrollDelta = 0;
    let pendingScrollBaseTop = null;
    let pendingScrollToBottom = false;
    let scrollAdjustmentGeneration = 0;
    const bottomFollowEnabled = Vue.ref(true);
    let activeTargetKey = null;
    let activeTargetAlign = 'start';
    let activeTargetElement = null;
    let previousItems = [];
    let itemChangeGeneration = 0;
    let transcriptContentTop = 0;
    let geometryScrollTop = 0;
    let lastGeometryDOMTop = 0;

    function readTranscriptContentTop() {
      const root = rootRef.value;
      const scroller = scrollEl.value;
      if (!root || !scroller) return 0;
      return Number(root.getBoundingClientRect().top) - Number(scroller.getBoundingClientRect().top)
        + Number(scroller.scrollTop || 0) - Number(scroller.clientTop || 0);
    }

    function reconcileGeometry() {
      const nextTop = readTranscriptContentTop();
      const delta = nextTop - transcriptContentTop;
      transcriptContentTop = nextTop;
      if (bottomFollowEnabled.value && props.initialAlign === 'end') {
        scheduleScrollAdjustment({ toBottom: true });
      } else if (Math.abs(delta) >= HEIGHT_CHANGE_THRESHOLD) {
        // Only the root's content origin belongs here. Row/prepend changes are
        // compensated separately; total scrollHeight would count them twice.
        // Restore from the pre-layout position. A shrinking sibling may have
        // already clamped DOM scrollTop; adding delta to that would apply the
        // browser's consumed displacement twice.
        scheduleScrollAdjustment({ delta, baseTop: geometryScrollTop });
      }
      lastGeometryDOMTop = Number(scrollEl.value?.scrollTop || 0);
      readScrollState();
    }

    // Item offsets only change when the items, estimates, or measured heights
    // change. Keep them out of the scroll-dependent computed so wheel/touch
    // events only do binary range lookup plus a small visible slice.
    const virtualLayout = Vue.computed(() => buildVirtualOffsets(props.items, heightCache, {
      itemGap: props.itemGap,
      estimateHeight: props.estimateHeight,
    }));
    const virtualWindow = Vue.computed(() => computeVirtualWindowFromLayout(props.items, virtualLayout.value, {
      // Following owns the tail window, even while DOM heights are settling.
      // Selecting rows from a transient/clamped DOM scrollTop can unmount the
      // tail, replace it with estimates, and oscillate between two windows.
      scrollTop: bottomFollowEnabled.value && props.initialAlign === 'end'
        ? Math.max(0, virtualLayout.value.totalHeight - viewportHeight.value)
        : scrollTop.value,
      viewportHeight: viewportHeight.value,
      overscan: props.overscan,
    }));

    const visibleEntries = Vue.computed(() => virtualWindow.value.items);
    const topSpacerHeight = Vue.computed(() => virtualWindow.value.topSpacerHeight);
    const bottomSpacerHeight = Vue.computed(() => virtualWindow.value.bottomSpacerHeight);

    function emitScrollState(el) {
      if (!el) return;
      emit('scroll-state', {
        scrollTop: el.scrollTop || 0,
        scrollHeight: el.scrollHeight || 0,
        clientHeight: el.clientHeight || 0,
      });
    }

    function readScrollState() {
      const el = scrollEl.value;
      if (!el) return;
      viewportHeight.value = Math.max(1, el.clientHeight || virtualTranscriptDefaults.viewportHeight);
      // Preserve the synthetic tail position until the first non-empty item
      // set is mounted. Otherwise an async history response briefly mounts the
      // oldest Markdown/Mermaid rows before MessageList scrolls to the latest.
      if (!(initialEndPending && props.items.length === 0)) {
        scrollTop.value = Math.max(0, el.scrollTop || 0);
      }
      // Do not adopt a browser-clamped position while an origin compensation
      // is pending or before the geometry observer has reconciled a layout shift.
      if (pendingScrollBaseTop === null && Math.abs(pendingScrollDelta) < HEIGHT_CHANGE_THRESHOLD
        && Math.abs(readTranscriptContentTop() - transcriptContentTop) < HEIGHT_CHANGE_THRESHOLD) {
        geometryScrollTop = Number(el.scrollTop || 0);
      }
      emitScrollState(el);
    }

    function alignInitialEnd() {
      const el = scrollEl.value;
      if (!initialEndPending || props.initialAlign !== 'end' || props.items.length === 0 || !el) {
        return false;
      }
      clearTargetAnchor();
      el.scrollTop = el.scrollHeight;
      initialEndPending = false;
      readScrollState();
      return true;
    }

    function syncInitialPosition() {
      if (!alignInitialEnd()) readScrollState();
    }

    function offsetForKey(items, key) {
      const index = items.findIndex((item, itemIndex) => getVirtualItemKey(item, itemIndex) === key);
      if (index < 0) return null;
      const layout = buildVirtualOffsets(items, heightCache, {
        itemGap: props.itemGap,
        estimateHeight: props.estimateHeight,
      });
      return layout.offsets[index] || 0;
    }

    function preserveAnchorAcrossItems(previous, next, generation) {
      const scroller = scrollEl.value;
      if (!scroller || bottomFollowEnabled.value || previous.length === 0 || next.length === 0) return;
      const previousLayout = buildVirtualOffsets(previous, heightCache, {
        itemGap: props.itemGap,
        estimateHeight: props.estimateHeight,
      });
      const previousWindow = computeVirtualWindowFromLayout(previous, previousLayout, {
        scrollTop: scroller.scrollTop || 0,
        viewportHeight: scroller.clientHeight || viewportHeight.value,
        overscan: 0,
      });
      const anchorIndex = Math.min(previous.length - 1, previousWindow.visibleStart);
      const anchorKey = getVirtualItemKey(previous[anchorIndex], anchorIndex);
      const previousOffset = previousLayout.offsets[anchorIndex] || 0;
      Vue.nextTick(() => {
        if (generation !== itemChangeGeneration) return;
        const nextOffset = offsetForKey(next, anchorKey);
        if (!Number.isFinite(nextOffset)) return;
        scheduleScrollAdjustment({ delta: nextOffset - previousOffset });
      });
    }

    function scheduleReadScrollState() {
      // Capture user movement synchronously, before another scroll listener can
      // mutate status layout. RAF is only for the reactive window projection.
      const currentTop = Number(scrollEl.value?.scrollTop || 0);
      if (Math.abs(readTranscriptContentTop() - transcriptContentTop) < HEIGHT_CHANGE_THRESHOLD) {
        if (pendingScrollBaseTop !== null) {
          pendingScrollBaseTop += currentTop - lastGeometryDOMTop;
        } else {
          geometryScrollTop = currentTop;
        }
      }
      lastGeometryDOMTop = currentTop;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        readScrollState();
      });
    }

    function scheduleScrollAdjustment({ delta = 0, baseTop, toBottom = false } = {}, generation = scrollAdjustmentGeneration) {
      if (generation !== scrollAdjustmentGeneration) return;
      if (Number.isFinite(baseTop) && pendingScrollBaseTop === null) pendingScrollBaseTop = baseTop;
      if (Math.abs(delta) >= HEIGHT_CHANGE_THRESHOLD) pendingScrollDelta += delta;
      if (toBottom) pendingScrollToBottom = true;
      if (scrollAdjustRafId) return;
      const scheduledGeneration = generation;
      scrollAdjustRafId = requestAnimationFrame(() => {
        scrollAdjustRafId = null;
        if (scheduledGeneration !== scrollAdjustmentGeneration) return;
        const scroller = scrollEl.value;
        if (!scroller) {
          pendingScrollDelta = 0;
          pendingScrollBaseTop = null;
          pendingScrollToBottom = false;
          return;
        }
        if (pendingScrollToBottom) {
          scroller.scrollTop = scroller.scrollHeight;
        } else if (pendingScrollBaseTop !== null || Math.abs(pendingScrollDelta) >= HEIGHT_CHANGE_THRESHOLD) {
          scroller.scrollTop = (pendingScrollBaseTop ?? scroller.scrollTop) + pendingScrollDelta;
        }
        pendingScrollDelta = 0;
        pendingScrollBaseTop = null;
        pendingScrollToBottom = false;
        readScrollState();
      });
    }

    function clearTargetAnchor() {
      activeTargetKey = null;
      activeTargetElement = null;
    }

    function cancelPendingBottomFollow({ preserveTarget = false } = {}) {
      scrollAdjustmentGeneration += 1;
      pendingScrollToBottom = false;
      pendingScrollDelta = 0;
      pendingScrollBaseTop = null;
      if (!preserveTarget) clearTargetAnchor();
      if (scrollAdjustRafId) cancelAnimationFrame(scrollAdjustRafId);
      scrollAdjustRafId = null;
    }

    function scheduleMeasureElement(key, index, el) {
      if (!key || !el) return;
      pendingMeasurements.set(key, { index, el });
      if (measureRafId) return;
      measureRafId = requestAnimationFrame(() => {
        measureRafId = null;
        const entries = Array.from(pendingMeasurements.entries());
        pendingMeasurements.clear();
        commitMeasurements(entries);
      });
    }

    function commitMeasurements(entries) {
      // Read every DOM height before touching reactive state. Each cache write
      // invalidates virtualLayout, so reading virtualWindow between writes would
      // rebuild all offsets once per mounted row.
      const measurements = [];
      for (const [key, entry] of entries) {
        const el = entry?.el;
        if (!el) continue;
        const nextHeight = Math.ceil(el.getBoundingClientRect?.().height || el.offsetHeight || 0);
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        const previousHeight = heightCache[key];
        if (previousHeight === nextHeight) continue;
        const mappedIndex = itemIndexByKey.get(key);
        measurements.push({
          key,
          nextHeight,
          previousHeight,
          itemIndex: Number.isFinite(mappedIndex) ? mappedIndex : entry.index,
        });
      }
      if (!measurements.length) return;

      const scroller = scrollEl.value;
      const windowStart = virtualWindow.value.visibleStart;
      const shouldRealignTarget = !!activeTargetKey && measurements.some(measurement => measurement.key === activeTargetKey);
      let anchorDelta = 0;
      // User intent, not transient layout geometry, owns bottom following.
      const shouldScrollToBottom = bottomFollowEnabled.value && props.initialAlign === 'end';

      // Do not read virtualWindow or virtualLayout in this loop. Vue can then
      // collapse all cache invalidations into one render/layout recomputation.
      for (const measurement of measurements) {
        const {
          key,
          nextHeight,
          previousHeight,
          itemIndex,
        } = measurement;
        heightCache[key] = nextHeight;
        if (!scroller || !Number.isFinite(previousHeight)) continue;

        const delta = nextHeight - previousHeight;
        if (Math.abs(delta) < HEIGHT_CHANGE_THRESHOLD) continue;
        if (Number.isFinite(itemIndex) && itemIndex < windowStart) {
          anchorDelta += delta;
        }
      }

      // Once the active target itself participates in this measurement batch,
      // its final DOM geometry already includes every predecessor height change.
      // Target alignment must therefore be the only scroll owner for the batch;
      // applying anchorDelta as well would count predecessor growth twice.
      if (shouldRealignTarget) {
        cancelPendingBottomFollow({ preserveTarget: true });
        scheduleTargetAlignment(activeTargetKey, activeTargetAlign);
        return;
      }

      const hasAnchorAdjustment = Math.abs(anchorDelta) >= HEIGHT_CHANGE_THRESHOLD;
      if (hasAnchorAdjustment || shouldScrollToBottom) {
        const adjustment = { delta: anchorDelta, toBottom: shouldScrollToBottom };
        const adjustmentGeneration = scrollAdjustmentGeneration;
        if (shouldScrollToBottom) {
          Vue.nextTick(() => scheduleScrollAdjustment(adjustment, adjustmentGeneration));
        } else {
          scheduleScrollAdjustment(adjustment, adjustmentGeneration);
        }
      }
    }

    function alignTarget(key, align = 'start') {
      const scroller = scrollEl.value;
      const target = activeTargetElement || itemEls.get(String(key));
      if (!scroller || !target) return false;
      // Final target geometry includes both root displacement and row growth.
      // Consume queued deltas so a later frame cannot apply either twice.
      cancelPendingBottomFollow({ preserveTarget: true });
      transcriptContentTop = readTranscriptContentTop();
      const scrollerRect = scroller.getBoundingClientRect?.();
      const targetRect = target.getBoundingClientRect?.();
      if (!scrollerRect || !targetRect) return false;
      const scrollerTop = Number(scrollerRect.top);
      const scrollerHeight = Number(scroller.clientHeight || viewportHeight.value);
      const targetHeight = Number(targetRect.height || 0);
      const desiredTop = align === 'center' && targetHeight <= scrollerHeight
        ? scrollerTop + (scrollerHeight - targetHeight) / 2
        : align === 'end' && targetHeight <= scrollerHeight
          ? Number(scrollerRect.bottom) - targetHeight
          : scrollerTop;
      const delta = Number(targetRect.top) - desiredTop;
      if (Math.abs(delta) >= HEIGHT_CHANGE_THRESHOLD) scroller.scrollTop += delta;
      readScrollState();
      return true;
    }

    function scheduleTargetAlignment(key, align = 'start', targetElement) {
      const targetKey = String(key);
      activeTargetKey = targetKey;
      activeTargetAlign = align;
      // Remeasuring an outer virtual block must retain any persisted child row
      // that currently owns the search anchor. Callers can still replace or
      // clear that owner explicitly by passing an element or null.
      if (targetElement !== undefined) activeTargetElement = targetElement;
      const run = () => {
        if (activeTargetKey !== targetKey) return;
        alignTarget(targetKey, activeTargetAlign);
      };
      Vue.nextTick(run);
    }

    function setBottomFollowEnabled(enabled) {
      const nextEnabled = !!enabled;
      if (nextEnabled) clearTargetAnchor();
      if (bottomFollowEnabled.value === nextEnabled) return;
      // Hand ownership to the user at the current DOM position, not a stale
      // pre-follow scrollTop that selected a different virtual window.
      if (!nextEnabled) readScrollState();
      bottomFollowEnabled.value = nextEnabled;
      if (!nextEnabled) cancelPendingBottomFollow();
    }

    function scrollToBottom() {
      cancelPendingBottomFollow();
      setBottomFollowEnabled(true);
      const generation = scrollAdjustmentGeneration;
      // Mount the tail window before reading its DOM height. Pausing follow
      // invalidates this queued work, including a click followed by a wheel.
      Vue.nextTick(() => {
        if (generation !== scrollAdjustmentGeneration || !bottomFollowEnabled.value) return;
        const scroller = scrollEl.value;
        if (!scroller) return;
        scroller.scrollTop = scroller.scrollHeight;
        readScrollState();
      });
    }

    function observeItem(key, index, el) {
      itemIndexByKey.set(key, index);
      if (!el) return;
      itemEls.set(key, el);
      if (resizeObserver) resizeObserver.observe(el);
      Vue.nextTick(() => scheduleMeasureElement(key, index, el));
    }

    function setItemRef(key, index, el) {
      if (!key) return;
      const previousEl = itemEls.get(key);
      if (previousEl && previousEl !== el && resizeObserver) resizeObserver.unobserve(previousEl);
      if (!el) {
        itemEls.delete(key);
        return;
      }
      observeItem(key, index, el);
    }

    async function scrollToIndex(index, { align = 'center' } = {}) {
      const safeIndex = Number.isFinite(index) ? Math.floor(index) : -1;
      const scroller = scrollEl.value;
      if (!scroller || safeIndex < 0 || safeIndex >= props.items.length) return false;
      cancelPendingBottomFollow({ preserveTarget: true });
      const key = getVirtualItemKey(props.items[safeIndex], safeIndex);
      activeTargetKey = key;
      activeTargetAlign = align;
      activeTargetElement = null;
      scroller.scrollTop = virtualScrollTopForIndex(props.items, safeIndex, heightCache, {
        itemGap: props.itemGap,
        estimateHeight: props.estimateHeight,
        viewportHeight: scroller.clientHeight || viewportHeight.value,
        align,
      });
      readScrollState();
      await Vue.nextTick();
      const target = itemEls.get(key);
      if (!target) return false;
      scheduleTargetAlignment(key, align);
      return true;
    }

    function scrollToKey(key, options = {}) {
      const index = itemIndexByKey.get(String(key));
      return Number.isFinite(index) ? scrollToIndex(index, options) : Promise.resolve(false);
    }

    function anchorTarget(key, targetElement, { align = 'start' } = {}) {
      const targetKey = String(key || '');
      if (!targetKey || !targetElement) return false;
      activeTargetKey = targetKey;
      activeTargetAlign = align;
      activeTargetElement = targetElement;
      alignTarget(targetKey, align);
      return true;
    }

    expose({ scrollToBottom, scrollToKey, scrollToIndex, anchorTarget, clearTargetAnchor, cancelPendingBottomFollow, setBottomFollowEnabled });

    Vue.watch(
      () => props.items.map((item, index) => getVirtualItemKey(item, index)).join('\n'),
      () => {
        const nextItems = props.items.slice();
        const previous = previousItems;
        previousItems = nextItems;
        itemChangeGeneration += 1;
        const generation = itemChangeGeneration;
        itemIndexByKey.clear();
        props.items.forEach((item, index) => itemIndexByKey.set(getVirtualItemKey(item, index), index));
        if (activeTargetKey && !itemIndexByKey.has(activeTargetKey)) clearTargetAnchor();
        if (previous.length > 0) preserveAnchorAcrossItems(previous, nextItems, generation);
        Vue.nextTick(() => {
          if (generation !== itemChangeGeneration) return;
          syncInitialPosition();
        });
      },
      { immediate: true },
    );

    Vue.onMounted(() => {
      scrollEl.value = rootRef.value?.closest?.('.chat-container') || rootRef.value?.parentElement || null;
      syncInitialPosition();
      transcriptContentTop = readTranscriptContentTop();
      geometryScrollTop = Number(scrollEl.value?.scrollTop || 0);
      lastGeometryDOMTop = geometryScrollTop;
      scrollEl.value?.addEventListener('scroll', scheduleReadScrollState, { passive: true });
      window.addEventListener('resize', scheduleReadScrollState);

      if (typeof ResizeObserver !== 'undefined') {
        const syncGeometryTargets = () => {
          const nextTargets = new Set([rootRef.value, scrollEl.value].filter(Boolean));
          // Banners can live beside the root inside .messages rather than
          // directly inside the scroller. Observe only this ancestor path.
          for (let parent = rootRef.value?.parentElement; parent; parent = parent.parentElement) {
            nextTargets.add(parent);
            for (const child of parent.children) nextTargets.add(child);
            if (parent === scrollEl.value) break;
          }
          for (const target of geometryTargets) {
            if (!nextTargets.has(target)) {
              resizeObserver.unobserve(target);
              geometryTargets.delete(target);
            }
          }
          for (const target of nextTargets) {
            if (!geometryTargets.has(target)) {
              geometryTargets.add(target);
              resizeObserver.observe(target);
            }
          }
        };
        resizeObserver = new ResizeObserver((entries) => {
          let geometryChanged = false;
          for (const entry of entries) {
            if (geometryTargets.has(entry.target)) {
              geometryChanged = true;
              continue;
            }
            const key = entry.target?.dataset?.virtualId;
            const index = Number(entry.target?.dataset?.virtualIndex);
            if (key) scheduleMeasureElement(key, index, entry.target);
          }
          // Sibling navigation or the composer can change the true bottom or
          // viewport without resizing any row. Keep the same scroll owner.
          if (geometryChanged) reconcileGeometry();
        });
        syncGeometryTargets();
        // Loading/status siblings may be inserted into .messages after mount.
        // Observe child lists only along the ancestor path, not row mutations.
        if (scrollEl.value && typeof MutationObserver !== 'undefined') {
          geometryObserver = new MutationObserver(() => {
            syncGeometryTargets();
            reconcileGeometry();
          });
          for (let parent = rootRef.value?.parentElement; parent; parent = parent.parentElement) {
            geometryObserver.observe(parent, { childList: true });
            if (parent === scrollEl.value) break;
          }
        }
        for (const [key, el] of itemEls.entries()) {
          const index = itemIndexByKey.get(key) ?? Number(el.dataset?.virtualIndex || 0);
          observeItem(key, index, el);
        }
      }
    });

    Vue.onBeforeUnmount(() => {
      scrollEl.value?.removeEventListener('scroll', scheduleReadScrollState);
      window.removeEventListener('resize', scheduleReadScrollState);
      if (resizeObserver) resizeObserver.disconnect();
      if (geometryObserver) geometryObserver.disconnect();
      geometryTargets.clear();
      if (rafId) cancelAnimationFrame(rafId);
      if (measureRafId) cancelAnimationFrame(measureRafId);
      if (scrollAdjustRafId) cancelAnimationFrame(scrollAdjustRafId);
      pendingMeasurements.clear();
      pendingScrollDelta = 0;
      pendingScrollBaseTop = null;
      pendingScrollToBottom = false;
    });

    return {
      rootRef,
      visibleEntries,
      topSpacerHeight,
      bottomSpacerHeight,
      setItemRef,
    };
  },
};
