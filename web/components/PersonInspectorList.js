import VirtualTranscript from './VirtualTranscript.js';

/** Latest-first inspector window. Only deliberate forward scroll gestures may
 * request one older page; layout/resize/loading events never drain the cursor.
 * resetKey belongs to the owner/Agent/Person identity (or its replaced page).
 */
export default {
  name: 'PersonInspectorList',
  components: { VirtualTranscript },
  props: {
    items: { type: Array, default: () => [] },
    label: String,
    moreLabel: String,
    more: Boolean,
    loading: Boolean,
    disabled: Boolean,
    stale: Boolean,
    error: Boolean,
    pageToken: [String, Number],
    resetKey: { default: '' },
    estimateHeight: { type: Function, default: () => 150 },
  },
  emits: ['more'],
  setup(props, { emit }) {
    const scroller = Vue.ref(null);
    const transcript = Vue.ref(null);
    const generation = Vue.ref(0);
    const virtual = Vue.computed(() => props.items.length > 20);
    const rows = new Map();
    const expanded = new Map();
    let intent = false;
    let intentUntil = 0;
    let touchY = null;
    let inFlight = false;
    let requestedToken = null;
    let frame = null;
    let lastTop = 0;
    let focusIndex = -1;
    let navigation = 0;
    const token = () => String(props.pageToken ?? props.items.length);

    function requestMore(manual = false) {
      if (!props.more || props.loading || props.disabled || inFlight) return;
      if (!manual && (props.stale || props.error || requestedToken === token())) return;
      intent = false;
      inFlight = true;
      requestedToken = token();
      emit('more');
      // Hosts normally set loading synchronously. A rejected/no-op request must
      // not permanently disable the accessible retry button.
      Vue.nextTick(() => { if (!props.loading) inFlight = false; });
    }
    function nearEnd() {
      const el = scroller.value;
      if (!el) return false;
      const threshold = Math.min(240, Math.max(80, el.clientHeight * 0.4));
      return el.scrollHeight - el.clientHeight - el.scrollTop <= threshold;
    }
    function scheduleIntentCheck() {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (intent && nearEnd()) requestMore();
        if (performance.now() > intentUntil) intent = false;
      });
    }
    function releaseKeyboardTarget() {
      navigation += 1; // Do not steal focus after a superseded async keyboard jump.
      transcript.value?.clearTargetAnchor();
      transcript.value?.cancelPendingBottomFollow();
    }
    function forwardIntent(event) {
      // Scrolling a long JSON/result pane belongs to that pane, not its list.
      for (let el = event.target; el && el !== scroller.value; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) return;
      }
      if (['wheel', 'touchmove', 'pointerdown'].includes(event.type)) releaseKeyboardTarget();
      if (props.loading || props.disabled || inFlight) return;
      if (event.type === 'wheel' && event.deltaY <= 0) { intent = false; return; }
      if (event.type === 'touchmove') {
        const y = event.touches?.[0]?.clientY;
        const forward = touchY != null && y < touchY;
        touchY = y;
        if (!forward) { intent = false; return; }
      }
      intent = true;
      intentUntil = performance.now() + 500;
      scheduleIntentCheck();
    }
    function startTouch(event) {
      releaseKeyboardTarget();
      touchY = event.touches?.[0]?.clientY;
    }
    function onScroll() {
      const el = scroller.value;
      if (!el) return;
      const forward = el.scrollTop > lastTop;
      lastTop = el.scrollTop;
      // Only user intent can arm paging; virtual measurements and browser scroll
      // anchoring also emit scroll and must never exhaust the history.
      if (forward && intent && performance.now() <= intentUntil && !props.loading && !inFlight && nearEnd()) requestMore();
    }
    function rememberDetails(id, event) {
      const row = rows.get(id);
      if (!row || event.target?.tagName !== 'DETAILS') return;
      const index = [...row.querySelectorAll('details')].indexOf(event.target);
      if (index < 0) return;
      if (!expanded.has(id)) expanded.set(id, new Map());
      expanded.get(id).set(index, event.target.open);
    }
    function rowRef(item, index, el) {
      const id = String(item.id);
      if (!el) {
        const previous = rows.get(id);
        // Native toggle is queued: an immediate keyboard jump may unmount a
        // disclosure before that event reaches the list. Snapshot synchronously.
        if (previous) {
          const states = new Map([...previous.querySelectorAll('details')].map((detail, detailIndex) => [detailIndex, detail.open]));
          if (states.size) expanded.set(id, states);
        }
        const hadFocus = previous?.contains(document.activeElement);
        rows.delete(id);
        // Function refs also unset during ordinary updates; recover focus only
        // after an actually focused row has left the rendered window.
        Vue.nextTick(() => {
          if (hadFocus && !rows.has(id)) {
            focusIndex = index;
            scroller.value?.focus({ preventScroll: true });
          }
        });
        return;
      }
      // Vue invokes function refs on updates as well as mounts. Reapplying an
      // old snapshot to an existing element races its native queued toggle.
      if (rows.get(id) === el) return;
      rows.set(id, el);
      const states = expanded.get(id);
      if (states) {
        [...el.querySelectorAll('details')].forEach((detail, detailIndex) => {
          if (states.has(detailIndex)) detail.open = states.get(detailIndex);
        });
      }
    }
    async function focusRow(index) {
      if (!props.items.length) return;
      focusIndex = Math.max(0, Math.min(props.items.length - 1, index));
      const id = String(props.items[focusIndex].id);
      const ticket = ++navigation;
      if (virtual.value) await transcript.value?.scrollToIndex(focusIndex, { align: 'start' });
      else rows.get(id)?.scrollIntoView?.({ block: 'nearest' });
      await Vue.nextTick();
      if (ticket !== navigation) return;
      const row = rows.get(id);
      (row?.querySelector('summary, button, a, [tabindex]') || row)?.focus({ preventScroll: true });
    }
    function onKeydown(event) {
      if (event.key === 'Escape') {
        const detail = event.target.closest?.('details[open]');
        if (detail) {
          detail.open = false;
          const row = detail.closest('[data-inspector-index]');
          const item = props.items[Number(row?.dataset.inspectorIndex)];
          if (item) rememberDetails(String(item.id), { target: detail });
          detail.querySelector('summary')?.focus({ preventScroll: true });
          event.preventDefault();
        }
        return;
      }
      const row = event.target.closest?.('[data-inspector-index]');
      if (event.target !== scroller.value && event.target !== row && event.target.tagName !== 'SUMMARY') return;
      // Space on a summary expands details; it is not a paging gesture.
      if ((['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && event.target === scroller.value)) && !event.repeat) forwardIntent(event);
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = row ? Number(row.dataset.inspectorIndex) : focusIndex;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? props.items.length - 1
        : event.key === 'ArrowDown' ? current + 1 : current < 0 ? 0 : current - 1;
      void focusRow(index);
    }
    function reset() {
      const hadFocus = scroller.value?.contains(document.activeElement);
      navigation += 1;
      generation.value += 1;
      intent = false;
      inFlight = false;
      requestedToken = null;
      focusIndex = -1;
      lastTop = 0;
      expanded.clear();
      rows.clear();
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
      if (scroller.value) scroller.value.scrollTop = 0;
      Vue.nextTick(() => {
        if (hadFocus && document.activeElement === document.body) scroller.value?.focus({ preventScroll: true });
      });
    }
    Vue.watch(() => props.resetKey, reset, { flush: 'sync' });
    Vue.watch(() => props.items.length, length => { if (!length) reset(); });
    Vue.watch(() => props.loading, loading => { intent = false; if (!loading) inFlight = false; });
    Vue.watch(transcript, value => value?.setBottomFollowEnabled(false));
    Vue.onBeforeUnmount(() => { navigation += 1; if (frame != null) cancelAnimationFrame(frame); });
    return { scroller, transcript, generation, virtual, requestMore, onScroll, forwardIntent, startTouch, onKeydown, rowRef, rememberDetails };
  },
  template: `
    <div ref="scroller" class="person-journal-scroll person-inspector-list" tabindex="0" role="region" :aria-label="label" :aria-busy="loading"
      @scroll.passive="onScroll" @wheel.passive="forwardIntent" @touchstart.passive="startTouch" @touchmove.passive="forwardIntent" @pointerdown.self="forwardIntent" @keydown="onKeydown">
      <div class="person-inspector-before"><slot name="before"></slot></div>
      <VirtualTranscript v-if="virtual" ref="transcript" :key="'virtual:' + generation" :items="items" :estimate-height="estimateHeight" :item-gap="0" :overscan="1">
        <template #default="{ item, index }">
          <div :ref="el => rowRef(item, index, el)" :data-inspector-index="index" tabindex="-1" @toggle.capture="rememberDetails(String(item.id), $event)">
            <slot :item="item" :index="index"></slot>
          </div>
        </template>
      </VirtualTranscript>
      <div v-else class="person-inspector-small" :key="'small:' + generation">
        <div v-for="(item, index) in items" :key="item.id" :ref="el => rowRef(item, index, el)" :data-inspector-index="index" tabindex="-1" @toggle.capture="rememberDetails(String(item.id), $event)">
          <slot :item="item" :index="index"></slot>
        </div>
      </div>
      <div class="person-inspector-after"><slot name="after"></slot>
        <button v-if="more" type="button" class="btn-ghost person-load-more" :disabled="disabled || loading" @click="requestMore(true)">{{ moreLabel }}</button>
      </div>
    </div>
  `,
};

/** Stable, non-mutating ordering of the loaded subset. Sequence is authoritative
 * for traces/turns; catalogs without timestamps retain their contract order. */
export function newestPersonRecords(records = []) {
  const stamp = item => {
    const value = item.updatedAt ?? item.createdAt;
    if (value == null) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  };
  return [...records].sort((a, b) => {
    if (Number.isFinite(a.seq) && Number.isFinite(b.seq) && a.seq !== b.seq) return b.seq - a.seq;
    return stamp(b) - stamp(a);
  });
}
