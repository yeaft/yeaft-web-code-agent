/**
 * VpTurnBlock — Slack-style per-VP turn block (Slack-layout redesign,
 * 2026-05-09). Single content column with colored speaker text.
 * The content column has its own header on top
 * (name + time + state cause + per-turn stop) and the message body
 * (text + tools + todo + ask + images + hand-off pills) below it.
 *
 * Avatar display was removed after user feedback; the VP identity now lives
 * in the colored name text so the sidebar stays readable at small sizes.
 *
 * Header content:
 *   [Display name] · [HH:MM start time] [· Ns elapsed while streaming]
 *                                                  [stop btn]
 *
 * The body is never message-collapsed. The transcript virtualization layer
 * decides when off-screen turns mount; once a turn is mounted, users see the
 * real AssistantTurn content instead of a compact placeholder.
 *
 * Props:
 *   turn         — required; the turn object produced by MessageList.turnGroups.
 *                  Carries: speakerVpId, speakerTimestamp, isStreaming,
 *                  textContent, toolMsgs, todoMsg, askMsg, imageMsgs,
 *                  turnId, atMessageId, etc.
 *   conversationId — optional; passed through to AssistantTurn.
 *   nowMs        — required when streaming; the page-shared live timestamp
 *                  used to compute the elapsed counter. Updated ~1Hz by
 *                  MessageList while any turn is streaming.
 */
import AssistantTurn from './AssistantTurn.js';
import { useChatStore } from '../stores/chat.js';
import { useVpStore } from '../stores/vp.js';
import { formatElapsed } from '../stores/helpers/turn-timing.js';

export default {
  name: 'VpTurnBlock',
  components: { AssistantTurn },
  props: {
    turn: { type: Object, required: true },
    conversationId: { type: String, default: null },
    nowMs: { type: Number, default: 0 },
  },
  template: `
    <div class="vp-turn-block"
         :class="{ 'vp-turn-block-streaming': turn.isStreaming }"
         :data-turn-id="turn.turnId || ''"
         :data-vp-id="turn.speakerVpId || ''">

      <!-- Header text carries VP identity; avatars were removed from the turn list. -->
      <!-- Right column: header plus full body. VirtualTranscript handles deferred mounting. -->
      <div class="vp-turn-block-main">
        <div class="vp-turn-block-main-header">
          <span
            v-if="displayName"
            class="vp-turn-block-name"
            :style="speakerNameStyle"
          >{{ displayName }}</span>
          <span
            v-if="displayName && startedTimeText"
            class="vp-turn-block-sep"
            aria-hidden="true"
          >·</span>
          <span
            v-if="startedTimeText"
            class="vp-turn-block-time"
            :title="startedTimeFullText"
          >{{ startedTimeText }}</span>
          <template v-if="turn.isStreaming && elapsedText">
            <span
              v-if="displayName || startedTimeText"
              class="vp-turn-block-sep"
              aria-hidden="true"
            >·</span>
            <span
              class="vp-turn-block-elapsed"
              :title="$t ? $t('yeaft.vp.turnBlock.elapsedTitle') : 'Elapsed time'"
              aria-live="polite"
            >{{ elapsedText }}</span>
          </template>
          <span class="vp-turn-block-spacer"></span>
          <button
            v-if="showStop"
            type="button"
            class="vp-turn-block-stop"
            @click.stop="onStopTurn"
            :title="$t ? $t('yeaft.vp.speaker.stop') : 'Stop'"
            :aria-label="$t ? $t('yeaft.vp.speaker.stop') : 'Stop'"
          ><svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
        </div>

        <!-- Full AssistantTurn delegates rendering of markdown text + tool
             history + todo + ask + images. VirtualTranscript handles deferred
             mounting for off-screen turns; this component must not replace the
             message body with a collapsed preview. -->
        <AssistantTurn
          class="vp-turn-block-body-expanded"
          :turn="turn"
          :conversation-id="conversationId"
          :hide-speaker-header="true"
        />
      </div>
    </div>
  `,
  setup(props) {
    const store = useChatStore();
    const vpStore = useVpStore();

    const displayName = Vue.computed(() => {
      const vpId = props.turn && props.turn.speakerVpId;
      if (!vpId) return '';
      // vpLabel lives on the VP store (same as VpAvatar / VpBadge); calling
      // it on the chat store would silently TypeError and leave the always-
      // visible header showing raw `vp-…` ids — the exact bug this PR fixes.
      return vpStore.vpLabel(vpId) || vpId;
    });

    const speakerNameStyle = Vue.computed(() => {
      const vpId = props.turn && props.turn.speakerVpId;
      if (!vpId || typeof vpStore.vpTextColor !== 'function') return {};
      return { color: vpStore.vpTextColor(vpId) };
    });

    const onStopTurn = () => {
      const turnId = props.turn && props.turn.turnId;
      if (!turnId) return;
      try {
        if (typeof store.cancelVpTurn === 'function') {
          store.cancelVpTurn(turnId);
        }
      } catch (e) {
        console.error('[VpTurnBlock] cancelVpTurn failed:', e);
      }
    };

    const isTyping = Vue.computed(() => {
      const vp = props.turn && props.turn.speakerVpId;
      if (!vp) return false;
      return store.isVpTypingInCurrentConv(vp);
    });

    const showStop = Vue.computed(
      () => !!(props.turn && props.turn.isStreaming && props.turn.turnId)
    );

    const startedTimeText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit',
      });
    });

    const startedTimeFullText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString();
    });

    const elapsedText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts || !props.nowMs) return '';
      const ms = props.nowMs - ts;
      if (ms < 0) return '';
      return formatElapsed(ms);
    });

    return {
      onStopTurn,
      isTyping,
      showStop,
      displayName,
      speakerNameStyle,
      startedTimeText,
      startedTimeFullText,
      elapsedText,
    };
  },
};
