import AssistantTurn from './AssistantTurn.js';
import VpAvatar from './VpAvatar.js';
import { useChatStore } from '../stores/chat.js';

/**
 * VpTurnDetailDrawer — right-side slide-in drawer for a single VP turn.
 *
 * Activation: store.unifyOpenVpTurnDetail = { vpId, turnId } | null.
 * Body: reuses <AssistantTurn :turn="targetTurn" /> verbatim — same
 * rendering as before the redesign, just relocated. Header has an info
 * button that toggles an in-drawer popover with persona / dream metadata
 * (no router change, no store swap).
 *
 * Reconstruction of the target turn: walks store.messages once and
 * collects all messages whose (vpId, turnId) match the descriptor, then
 * shapes them into the same `assistant-turn` object literal that
 * MessageList.turnGroups produces. We deliberately rebuild here rather
 * than reach into MessageList's computed because turnGroups is private
 * to that component; this keeps the drawer decoupled.
 */
export default {
  name: 'VpTurnDetailDrawer',
  components: { AssistantTurn, VpAvatar },
  setup() {
    const store = useChatStore();
    return { store };
  },
  data() {
    return { showInfo: false };
  },
  computed: {
    target() {
      return this.store.unifyOpenVpTurnDetail;
    },
    targetTurn() {
      const t = this.target;
      if (!t) return null;
      const msgs = (this.store.messages || []).filter(
        (m) => m.vpId === t.vpId && m.turnId === t.turnId
      );
      if (msgs.length === 0) return null;
      const turn = {
        type: 'assistant-turn',
        id: 'detail_' + t.vpId + '_' + t.turnId,
        textContent: '',
        isStreaming: false,
        todoMsg: null,
        toolMsgs: [],
        imageMsgs: [],
        askMsg: null,
        messages: msgs.slice(),
        speakerVpId: t.vpId,
        turnId: t.turnId,
        speakerTimestamp: 0,
        speakerStateCause: '',
        showSpeakerHeader: false,
        handoffHints: [],
        intent: 'feature',
        atMessageId: null,
      };
      for (const m of msgs) {
        if (m.type === 'assistant') {
          if (m.content) turn.textContent += m.content;
          if (m.isStreaming) turn.isStreaming = true;
        } else if (m.type === 'tool-use') {
          if (m.toolName === 'TodoWrite') turn.todoMsg = m;
          else if (m.toolName === 'AskUserQuestion') turn.askMsg = m;
          else turn.toolMsgs.push(m);
        } else if (m.type === 'chat-image') {
          turn.imageMsgs.push(m);
        }
      }
      return turn;
    },
  },
  watch: {
    target() {
      // Switching to a different (vpId, turnId) collapses the info popover
      // — its content depends on which VP we're showing.
      this.showInfo = false;
    },
  },
  methods: {
    onClose() { this.store.closeVpTurnDetail(); },
    toggleInfo() { this.showInfo = !this.showInfo; },
  },
  template: `
    <transition name="drawer-slide">
      <aside v-if="target" class="vp-turn-detail-drawer" role="dialog" aria-modal="false">
        <header class="drawer-header">
          <VpAvatar :vp-id="target.vpId" :size="32" />
          <span class="drawer-vp-name">{{ target.vpId }}</span>
          <span class="drawer-spacer"></span>
          <button class="drawer-info-btn" :title="$t('unify.vp.detail.info')"
                  @click="toggleInfo" aria-label="Info">ⓘ</button>
          <button class="drawer-close" :title="$t('unify.vp.detail.close')"
                  @click="onClose" aria-label="Close">✕</button>
        </header>

        <div v-if="showInfo" class="drawer-info-popover">
          <div class="info-row"><strong>vpId:</strong> {{ target.vpId }}</div>
          <div class="info-row"><strong>turnId:</strong> {{ target.turnId }}</div>
        </div>

        <div class="drawer-body">
          <AssistantTurn v-if="targetTurn" :turn="targetTurn" />
          <div v-else class="drawer-empty"></div>
        </div>
      </aside>
    </transition>
  `,
};
