import VirtualTranscript from './VirtualTranscript.js';
import { userTurnExcerpt } from '../utils/concurrent-user-turns.js';

export default {
  name: 'ConcurrentUserTurns',
  components: { VirtualTranscript },
  props: { turns: { type: Array, default: () => [] }, messages: { type: Array, default: () => [] }, estimateHeight: Function },
  emits: ['stop'],
  template: `
    <section class="concurrent-user-turns" :aria-label="$t('chat.concurrent.turns')">
      <nav class="concurrent-turn-tabs" :aria-label="$t('chat.concurrent.turns')">
        <button v-for="(turn, index) in turns" :key="turn.userTurnId" type="button"
          class="btn-ghost concurrent-turn-tab" :aria-controls="panelId(turn)"
          @click="scrollToTurn(turn.userTurnId)" @keydown="onTabKey($event, index)">
          {{ label(turn) || $t('chat.concurrent.turn') }}
        </button>
      </nav>
      <div class="concurrent-turn-track" ref="trackRef" :style="{ '--turn-count': turns.length }">
        <section v-for="turn in turns" :key="turn.userTurnId" :id="panelId(turn)"
          :data-user-turn-id="turn.userTurnId" class="concurrent-turn-column" :aria-label="label(turn) || $t('chat.concurrent.turn')">
          <header class="concurrent-turn-header">
            <span class="concurrent-turn-state" role="status">{{ $t('chat.concurrent.' + turn.state) }}</span>
            <button type="button" class="btn-ghost" @click="$emit('stop', turn)">{{ $t('chat.concurrent.stop') }}</button>
          </header>
          <div class="concurrent-turn-body" tabindex="0" :aria-label="label(turn) || $t('chat.concurrent.turn')">
            <VirtualTranscript :ref="el => setTranscript(turn.userTurnId, el)" :items="turn.blocks"
              :estimate-height="estimateHeight" scroll-container=".concurrent-turn-body" :overscan="1" :item-gap="18">
              <template #default="{ item: block }"><slot :block="block"></slot></template>
            </VirtualTranscript>
          </div>
        </section>
      </div>
    </section>
  `,
  setup(props, { expose }) {
    const trackRef = Vue.ref(null);
    const transcripts = new Map();
    const setTranscript = (id, instance) => {
      if (instance) {
        transcripts.set(id, instance);
        instance.setBottomFollowEnabled?.(false);
      } else transcripts.delete(id);
    };
    const panelId = turn => `pending-user-turn-${encodeURIComponent(turn.userTurnId)}`;
    const label = turn => userTurnExcerpt(props.messages.find(message => message.id === (turn.userMessageId || turn.userTurnId)));
    const columnFor = id => Array.from(trackRef.value?.children || []).find(el => el.dataset.userTurnId === id);
    const scrollToTurn = id => {
      const track = trackRef.value;
      const column = columnFor(id);
      if (!track || !column) return false;
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
      if (!previous || !trackRef.value) return;
      const track = trackRef.value;
      const bounds = track.getBoundingClientRect();
      const anchor = Array.from(track.children).find(el => ids.includes(el.dataset.userTurnId)
        && el.getBoundingClientRect().right > bounds.left);
      const left = anchor?.getBoundingClientRect().left;
      const scrollLeft = track.scrollLeft;
      Vue.nextTick(() => {
        if (anchor?.isConnected) track.scrollLeft = scrollLeft + anchor.getBoundingClientRect().left - left;
      });
    }, { flush: 'pre' });
    const revealBlock = async (id, blockId, options) => {
      if (!scrollToTurn(id)) return false;
      columnFor(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      await Vue.nextTick();
      return transcripts.get(id)?.scrollToKey?.(blockId, options) || false;
    };
    const anchorRow = (id, blockId, row, options) => transcripts.get(id)?.anchorTarget?.(blockId, row, options);
    expose({ revealBlock, anchorRow });
    return { trackRef, setTranscript, panelId, label, scrollToTurn, onTabKey };
  },
};
