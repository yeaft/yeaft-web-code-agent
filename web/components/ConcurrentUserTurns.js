import VirtualTranscript from './VirtualTranscript.js';
import { isTranscriptScrollbarPointer } from '../utils/virtual-transcript.js';
import { userTurnExcerpt } from '../utils/concurrent-user-turns.js';

export default {
  name: 'ConcurrentUserTurns',
  components: { VirtualTranscript },
  props: { turns: { type: Array, default: () => [] }, messages: { type: Array, default: () => [] }, estimateHeight: Function, itemGap: { type: Number, default: 18 }, stopDisabled: Boolean },
  emits: ['stop', 'pane-scroll'],
  template: `
    <section class="concurrent-user-turns parallel-turn-region" :aria-label="$t('chat.concurrent.turns')">
      <!-- Tabs navigate lanes that are off screen; when every lane fits they only repeat the lane headers. -->
      <nav v-show="tabsVisible" ref="tabsRef" class="concurrent-turn-tabs parallel-turn-tabs" role="tablist" :aria-label="$t('chat.concurrent.turns')">
        <button v-for="(turn, index) in turns" :key="turn.userTurnId" type="button"
          class="btn-ghost concurrent-turn-tab" role="tab" :id="panelId(turn) + '-tab'" :data-user-turn-id="turn.userTurnId"
          :aria-selected="selectedId === turn.userTurnId" :tabindex="selectedId === turn.userTurnId ? 0 : -1" :aria-controls="panelId(turn)"
          @click="scrollToTurn(turn.userTurnId)" @keydown="onTabKey($event, index)">
          {{ label(turn) || $t('chat.concurrent.turn') }}
        </button>
      </nav>
      <div class="concurrent-turn-track parallel-turn-track" ref="trackRef" @scroll.passive="onTrackScroll" :style="{ '--turn-count': turns.length }">
        <section v-for="turn in turns" :key="turn.userTurnId" :id="panelId(turn)"
          :data-user-turn-id="turn.userTurnId" class="concurrent-turn-column parallel-turn-pane" :class="'is-' + turn.state" role="tabpanel" :aria-labelledby="panelId(turn) + '-tab'">
          <header class="concurrent-turn-header">
            <span class="concurrent-turn-state" role="status"><span class="concurrent-turn-dot" aria-hidden="true"></span>{{ $t('chat.concurrent.' + turn.state) }}</span>
            <span v-if="label(turn)" class="concurrent-turn-title" :title="label(turn)">{{ label(turn) }}</span>
            <button type="button" class="btn-ghost concurrent-turn-stop" :disabled="stopDisabled || turn.disabled || turn.state === 'cancelling'" @click="$emit('stop', turn)">{{ $t('chat.concurrent.stop') }}</button>
          </header>
          <div class="concurrent-turn-body" @scroll.passive="$emit('pane-scroll', turn)" @wheel.passive="onPaneWheel($event, turn.userTurnId)"
            @touchstart.passive="touchStart($event, turn.userTurnId)" @touchmove.passive="touchMove($event, turn.userTurnId)"
            @keydown="onPaneKey($event, turn.userTurnId)" @pointerdown="onPanePointer($event, turn.userTurnId)" tabindex="0" :aria-label="label(turn) || $t('chat.concurrent.turn')">
            <VirtualTranscript :ref="el => setTranscript(turn.userTurnId, el)" :items="turn.blocks"
              :estimate-height="estimateHeight" initial-align="end" scroll-container=".concurrent-turn-body" :overscan="1" :item-gap="itemGap">
              <template #default="{ item: block }"><slot :block="block" :turn="turn"></slot></template>
            </VirtualTranscript>
            <slot name="after" :turn="turn"></slot>
          </div>
        </section>
      </div>
    </section>
  `,
  setup(props, { expose }) {
    const trackRef = Vue.ref(null);
    const selectedId = Vue.ref(props.turns[0]?.userTurnId || '');
    const onTrackScroll = () => {
      const track = trackRef.value;
      if (!track) return;
      const bounds = track.getBoundingClientRect();
      const visible = Array.from(track.children).find(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2;
      });
      if (visible && !Array.from(track.children).some(el => el.dataset.userTurnId === selectedId.value
        && el.getBoundingClientRect().left >= bounds.left - 2 && el.getBoundingClientRect().right <= bounds.right + 2)) {
        selectedId.value = visible.dataset.userTurnId;
      }
    };
    const transcripts = new Map();
    const paused = new Set();
    const touchY = new Map();
    const followPane = (id, follow) => {
      if (follow) paused.delete(id); else paused.add(id);
      transcripts.get(id)?.setBottomFollowEnabled?.(follow);
    };
    const onPanePointer = (event, id) => {
      if (isTranscriptScrollbarPointer(event, event.currentTarget)) followPane(id, false);
    };
    const onPaneWheel = (event, id) => {
      if (!event.deltaY) return;
      if (event.deltaY < 0) followPane(id, false);
      else {
        const body = event.currentTarget;
        if (body.scrollHeight - body.scrollTop - body.clientHeight < event.deltaY + 40) followPane(id, true);
      }
    };
    const touchStart = (event, id) => touchY.set(id, event.touches?.[0]?.clientY);
    const touchMove = (event, id) => {
      const y = event.touches?.[0]?.clientY;
      const previous = touchY.get(id);
      if (Number.isFinite(previous) && Number.isFinite(y)) {
        onPaneWheel({ currentTarget: event.currentTarget, deltaY: previous - y }, id);
      }
      touchY.set(id, y);
    };
    const onPaneKey = (event, id) => {
      if (event.target !== event.currentTarget) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) followPane(id, false);
      if (event.key === 'End') followPane(id, true);
      if (['ArrowDown', 'PageDown'].includes(event.key)) onPaneWheel({ currentTarget: event.currentTarget, deltaY: event.key === 'PageDown' ? event.currentTarget.clientHeight : 40 }, id);
    };
    const setTranscript = (id, instance) => {
      if (instance) {
        transcripts.set(id, instance);
        instance.setBottomFollowEnabled?.(!paused.has(id));
      } else transcripts.delete(id);
    };
    const panelId = turn => `pending-user-turn-${encodeURIComponent(turn.userTurnId)}`;
    // Tab, header and tooltip share one lookup per lane instead of scanning the transcript per render.
    const labels = Vue.computed(() => new Map(props.turns.map(turn => [turn.userTurnId, turn.label
      || userTurnExcerpt(props.messages.find(message => message.type === 'user'
        && (message.userTurnId === turn.userTurnId || [message.id, message.messageId, message.clientMessageId].includes(turn.userMessageId || turn.userTurnId))))])));
    const label = turn => labels.value.get(turn.userTurnId) || '';
    const tabsRef = Vue.ref(null);
    const tabsVisible = Vue.ref(true);
    const measureTabs = () => {
      const track = trackRef.value;
      // Unmeasured layouts (hidden, tests) keep the tab list as the safe default.
      if (!track?.clientWidth) return;
      tabsVisible.value = track.scrollWidth > track.clientWidth + 1;
    };
    // Swiping or keyboard selection keeps the matching tab inside the tab strip
    // without scrolling the page itself.
    const keepTabVisible = (id) => {
      const nav = tabsRef.value;
      const tab = Array.from(nav?.children || []).find(el => el.dataset.userTurnId === id);
      if (!tab || !nav.clientWidth) return;
      if (tab.offsetLeft < nav.scrollLeft) nav.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = tab.offsetLeft + tab.offsetWidth - nav.clientWidth;
    };
    Vue.watch(selectedId, id => Vue.nextTick(() => keepTabVisible(id)));
    let resizeObserver = null;
    Vue.onMounted(() => {
      if (typeof ResizeObserver === 'function' && trackRef.value) {
        resizeObserver = new ResizeObserver(measureTabs);
        resizeObserver.observe(trackRef.value);
      }
      measureTabs();
    });
    Vue.onBeforeUnmount(() => resizeObserver?.disconnect());
    const columnFor = id => Array.from(trackRef.value?.children || []).find(el => el.dataset.userTurnId === id);
    const scrollToTurn = id => {
      const track = trackRef.value;
      const column = columnFor(id);
      if (!track || !column) return false;
      selectedId.value = id;
      track.scrollTo({ left: column.offsetLeft - track.offsetLeft, behavior: 'instant' });
      return true;
    };
    const onTabKey = (event, index) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const count = props.turns.length;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
      event.currentTarget.parentElement.children[next]?.focus({ preventScroll: true });
      scrollToTurn(props.turns[next].userTurnId);
    };
    // Preserve the leading surviving column's screen offset when another turn
    // finishes. Appends never select, focus, or scroll to the new turn.
    Vue.watch(() => props.turns.map(turn => turn.userTurnId), (ids, previous) => {
      if (!ids.includes(selectedId.value)) selectedId.value = ids[0] || '';
      if (!previous || !trackRef.value) return;
      const track = trackRef.value;
      const bounds = track.getBoundingClientRect();
      const anchor = Array.from(track.children).find(el => ids.includes(el.dataset.userTurnId)
        && el.getBoundingClientRect().right > bounds.left);
      const left = anchor?.getBoundingClientRect().left;
      const scrollLeft = track.scrollLeft;
      Vue.nextTick(() => {
        if (anchor?.isConnected) track.scrollLeft = scrollLeft + anchor.getBoundingClientRect().left - left;
        measureTabs();
      });
    }, { flush: 'pre' });
    const revealBlock = async (id, blockId, options) => {
      if (!scrollToTurn(id)) return false;
      followPane(id, false);
      columnFor(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      await Vue.nextTick();
      return transcripts.get(id)?.scrollToKey?.(blockId, options) || false;
    };
    const anchorRow = (id, blockId, row, options) => transcripts.get(id)?.anchorTarget?.(blockId, row, options);
    // The global Latest action resumes all live panes, not just the outer page.
    const revealLatest = () => {
      for (const turn of props.turns) {
        followPane(turn.userTurnId, true);
        transcripts.get(turn.userTurnId)?.scrollToBottom?.();
      }
      trackRef.value?.scrollIntoView?.({ block: 'end', inline: 'nearest' });
    };
    expose({ revealBlock, anchorRow, revealLatest });
    return { trackRef, tabsRef, tabsVisible, selectedId, onTrackScroll, onPaneWheel, onPanePointer, touchStart, touchMove, onPaneKey, setTranscript, panelId, label, scrollToTurn, onTabKey };
  },
};
