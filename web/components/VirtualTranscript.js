import {
  computeVirtualWindow,
  estimateVirtualItemHeight,
  getVirtualItemKey,
  shouldFollowTranscriptBottom,
  virtualTranscriptDefaults,
} from '../utils/virtual-transcript.js';

const BOTTOM_THRESHOLD = 80;

export default {
  name: 'VirtualTranscript',
  props: {
    items: { type: Array, default: () => [] },
    overscan: { type: Number, default: virtualTranscriptDefaults.overscan },
    itemGap: { type: Number, default: virtualTranscriptDefaults.itemGap },
    estimateHeight: { type: Function, default: estimateVirtualItemHeight },
  },
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
  setup(props) {
    const rootRef = Vue.ref(null);
    const scrollEl = Vue.ref(null);
    const scrollTop = Vue.ref(0);
    const viewportHeight = Vue.ref(virtualTranscriptDefaults.viewportHeight);
    const heightCache = Vue.reactive({});
    const itemIndexByKey = new Map();
    const itemEls = new Map();
    let resizeObserver = null;
    let rafId = null;

    const virtualWindow = Vue.computed(() => computeVirtualWindow(props.items, {
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      heightCache,
      overscan: props.overscan,
      itemGap: props.itemGap,
      estimateHeight: props.estimateHeight,
    }));

    const visibleEntries = Vue.computed(() => virtualWindow.value.items);
    const topSpacerHeight = Vue.computed(() => virtualWindow.value.topSpacerHeight);
    const bottomSpacerHeight = Vue.computed(() => virtualWindow.value.bottomSpacerHeight);

    function readScrollState() {
      const el = scrollEl.value;
      if (!el) return;
      scrollTop.value = Math.max(0, el.scrollTop || 0);
      viewportHeight.value = Math.max(1, el.clientHeight || virtualTranscriptDefaults.viewportHeight);
    }

    function scheduleReadScrollState() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        readScrollState();
      });
    }

    function isNearBottom(el) {
      if (!el) return true;
      return shouldFollowTranscriptBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        threshold: BOTTOM_THRESHOLD,
      });
    }

    function measureElement(key, index, el) {
      if (!el) return;
      const nextHeight = Math.ceil(el.getBoundingClientRect?.().height || el.offsetHeight || 0);
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;

      const previousHeight = heightCache[key];
      if (previousHeight === nextHeight) return;

      const scroller = scrollEl.value;
      const wasNearBottom = isNearBottom(scroller);
      const previousIndex = itemIndexByKey.get(key);
      const changedBeforeWindow = Number.isFinite(previousIndex) && previousIndex < virtualWindow.value.visibleStart;
      heightCache[key] = nextHeight;

      if (scroller && Number.isFinite(previousHeight)) {
        const delta = nextHeight - previousHeight;
        if (changedBeforeWindow && Math.abs(delta) > 0) {
          scroller.scrollTop += delta;
          scrollTop.value = scroller.scrollTop;
        } else if (wasNearBottom) {
          Vue.nextTick(() => {
            scroller.scrollTop = scroller.scrollHeight;
            readScrollState();
          });
        }
      }
    }

    function observeItem(key, index, el) {
      itemIndexByKey.set(key, index);
      if (!el) return;
      itemEls.set(key, el);
      if (resizeObserver) resizeObserver.observe(el);
      Vue.nextTick(() => measureElement(key, index, el));
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

    Vue.watch(
      () => props.items.map((item, index) => getVirtualItemKey(item, index)).join('\n'),
      () => {
        itemIndexByKey.clear();
        props.items.forEach((item, index) => itemIndexByKey.set(getVirtualItemKey(item, index), index));
        Vue.nextTick(readScrollState);
      },
      { immediate: true },
    );

    Vue.onMounted(() => {
      scrollEl.value = rootRef.value?.closest?.('.chat-container') || rootRef.value?.parentElement || null;
      readScrollState();
      scrollEl.value?.addEventListener('scroll', scheduleReadScrollState, { passive: true });
      window.addEventListener('resize', scheduleReadScrollState);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const key = entry.target?.dataset?.virtualId;
            const index = Number(entry.target?.dataset?.virtualIndex);
            if (key) measureElement(key, index, entry.target);
          }
        });
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
      if (rafId) cancelAnimationFrame(rafId);
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
