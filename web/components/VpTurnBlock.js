/**
 * VpTurnBlock — collapsible per-VP turn wrapper (VP-block redesign Phase 3).
 *
 * Wraps an AssistantTurn for Unify multi-VP conversations. Each VP × turn
 * gets its own block, with:
 *   • Always-visible header: avatar + name + start time + (live elapsed
 *     ticker while streaming) + stop button + chevron toggle.
 *   • Collapsed body (default after streaming ends): last 6 lines of
 *     text + the most-recent 1 tool action — see compactBody helper.
 *   • Expanded body: the full AssistantTurn surface (all text, all tool
 *     history, todo, ask, images, hand-off pills, footer actions).
 *
 * 4-state expand machine (see turn-compact.js docstring for the full
 * truth-table):
 *
 *     'streaming'      — auto, while turn.isStreaming === true
 *     'auto-collapsed' — auto, after streaming ends
 *     'user-expanded'  — sticky, set when user clicks toggle to open
 *     'user-collapsed' — sticky, set when user clicks toggle to close
 *
 * The user-* states win over auto-* transitions so a click during
 * streaming sticks even after the turn finishes (and vice-versa).
 *
 * Why a wrapper rather than baking collapse into AssistantTurn:
 *   AssistantTurn is reused by both Unify (multi-VP) and legacy 1:1
 *   Chat. Chat turns have no VP attribution and shouldn't gain a
 *   collapse affordance — the user wants to see every Chat turn
 *   in full. MessageList only mounts VpTurnBlock when the turn
 *   carries a `speakerVpId`; otherwise it falls through to a plain
 *   AssistantTurn render.
 *
 * The live elapsed ticker is driven by a `nowMs` prop passed in by
 * MessageList (one shared interval per page, not per turn). This
 * avoids creating dozens of setInterval handles when many VPs are
 * speaking concurrently.
 *
 * Props:
 *   turn         — required; the turn object produced by MessageList.turnGroups.
 *                  Carries: speakerVpId, speakerTimestamp, isStreaming,
 *                  textContent, toolMsgs, todoMsg, askMsg, imageMsgs,
 *                  handoffHints, turnId, atMessageId, etc.
 *   conversationId — optional; passed through to AssistantTurn.
 *   nowMs        — required when streaming; the page-shared live timestamp
 *                  used to compute the elapsed counter. Updated ~1Hz by
 *                  MessageList while any turn is streaming.
 */
import AssistantTurn from './AssistantTurn.js';
import VpBadge from './VpBadge.js';
import ToolLine from './ToolLine.js';
import { useChatStore } from '../stores/chat.js';
import {
  compactBody,
  isExpanded as isExpandedFn,
  toggleState,
  reconcileStreamingState,
  formatElapsed,
} from '../stores/helpers/turn-compact.js';

export default {
  name: 'VpTurnBlock',
  components: { AssistantTurn, VpBadge, ToolLine },
  props: {
    turn: { type: Object, required: true },
    conversationId: { type: String, default: null },
    nowMs: { type: Number, default: 0 },
  },
  template: `
    <div class="vp-turn-block"
         :class="{ 'vp-turn-block-streaming': turn.isStreaming, 'vp-turn-block-collapsed': !expanded }"
         :data-turn-id="turn.turnId || ''"
         :data-vp-id="turn.speakerVpId || ''">

      <!-- Header: avatar (left gutter) + name + time + elapsed + stop + toggle -->
      <div class="vp-turn-block-header">
        <VpBadge
          v-if="turn.speakerVpId"
          :vp-id="turn.speakerVpId"
          :size="28"
          :show-subtitle="true"
          :clickable="true"
          :typing="isTyping"
          @open-detail="onOpenVpDetail"
        />
        <span class="vp-turn-block-meta">
          <span
            v-if="startedTimeText"
            class="vp-turn-block-time"
            :title="startedTimeFullText"
          >{{ startedTimeText }}</span>
          <span
            v-if="turn.isStreaming && elapsedText"
            class="vp-turn-block-elapsed"
            :title="$t ? $t('unify.vp.turnBlock.elapsedTitle') : 'Elapsed time'"
            aria-live="polite"
          >· {{ elapsedText }}</span>
        </span>
        <button
          v-if="showStop"
          class="vp-turn-block-stop"
          @click.stop="onStopTurn"
          :title="$t ? $t('unify.vp.speaker.stop') : 'Stop'"
          :aria-label="$t ? $t('unify.vp.speaker.stop') : 'Stop'"
        ><svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
        <button
          class="vp-turn-block-toggle"
          @click.stop="onToggle"
          :title="expanded ? toggleCollapseTitle : toggleExpandTitle"
          :aria-label="expanded ? toggleCollapseTitle : toggleExpandTitle"
          :aria-expanded="expanded ? 'true' : 'false'"
        >
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path v-if="expanded" fill="currentColor" d="M7 14l5-5 5 5z"/>
            <path v-else fill="currentColor" d="M7 10l5 5 5-5z"/>
          </svg>
        </button>
      </div>

      <!-- Expanded body: full AssistantTurn (passes the same turn object).
           The original AssistantTurn already renders its own VpSpeakerHeader
           when turn.showSpeakerHeader is true; we set showSpeakerHeader=false
           on the proxy turn so we don't double up the avatar. -->
      <AssistantTurn
        v-if="expanded"
        :turn="proxyTurn"
        :conversation-id="conversationId"
      />

      <!-- Collapsed body: last 6 lines of text + last 1 tool action.
           Empty turn (no text, no tools) collapses to an empty body, which
           is fine because the header already shows avatar + name. -->
      <div v-else class="vp-turn-block-compact">
        <div
          v-if="compactText.text"
          class="vp-turn-block-compact-text"
          :class="{ 'vp-turn-block-compact-truncated': compactText.truncated }"
          :title="compactText.truncated ? truncatedTitle : ''"
        >{{ compactText.text }}</div>
        <div v-if="lastTool" class="vp-turn-block-compact-tool">
          <ToolLine
            :tool-name="lastTool.toolName"
            :tool-input="lastTool.toolInput"
            :tool-result="lastTool.toolResult"
            :has-result="!!lastTool.hasResult"
            :start-time="lastTool.startTime"
          />
        </div>
        <div
          v-if="!compactText.text && !lastTool"
          class="vp-turn-block-compact-empty"
        >{{ emptyText }}</div>
      </div>
    </div>
  `,
  setup(props) {
    const store = useChatStore();
    const t = Vue.inject('t', null);

    // 4-state expand machine. Initial value depends on whether the turn
    // is streaming when first mounted (resumes mid-stream → 'streaming').
    const expandState = Vue.ref(props.turn.isStreaming ? 'streaming' : 'auto-collapsed');

    // Reconcile the auto-* part of the machine whenever the upstream
    // streaming flag changes. The user-* states are immune (see
    // reconcileStreamingState).
    Vue.watch(
      () => props.turn.isStreaming,
      (isStreaming) => {
        expandState.value = reconcileStreamingState(expandState.value, !!isStreaming);
      },
    );

    const expanded = Vue.computed(() => isExpandedFn(expandState.value));

    const onToggle = () => {
      expandState.value = toggleState(expandState.value);
    };

    const onOpenVpDetail = (vpId) => {
      // Reuse the same path the timeline + speaker header use.
      if (!vpId) return;
      store.enterVpDetailView(vpId);
    };

    const onStopTurn = () => {
      const turnId = props.turn && props.turn.turnId;
      if (!turnId) return;
      if (typeof store.cancelVpTurn === 'function') {
        store.cancelVpTurn(turnId);
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

    // Inner AssistantTurn shouldn't render its own speaker header — we
    // already render the avatar in our own block header. Spreading via
    // a proxy is cheap (object identity changes only when the relevant
    // field flips) and avoids monkey-patching the upstream turn object.
    const proxyTurn = Vue.computed(() => ({
      ...props.turn,
      showSpeakerHeader: false,
    }));

    // Compact body — recomputed reactively as text streams in.
    const compactText = Vue.computed(() => compactBody(props.turn.textContent || '', 6));

    const lastTool = Vue.computed(() => {
      const tools = props.turn.toolMsgs;
      if (!Array.isArray(tools) || tools.length === 0) return null;
      return tools[tools.length - 1];
    });

    const startedTimeText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleTimeString(undefined, {
          hour: '2-digit', minute: '2-digit',
        });
      } catch { return ''; }
    });

    const startedTimeFullText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    });

    const elapsedText = Vue.computed(() => {
      const ts = props.turn.speakerTimestamp;
      if (!ts || !props.nowMs) return '';
      const ms = props.nowMs - ts;
      if (ms < 0) return '';
      return formatElapsed(ms);
    });

    const truncatedTitle = Vue.computed(() => {
      const total = compactText.value.totalLines;
      if (t) {
        try { return t('unify.vp.turnBlock.truncated', { total }); } catch {}
      }
      return `Showing last 6 of ${total} lines — click to expand.`;
    });

    const emptyText = Vue.computed(() => {
      if (props.turn.isStreaming) {
        return t ? t('unify.vp.turnBlock.thinking') : 'thinking…';
      }
      return t ? t('unify.vp.turnBlock.empty') : '(no text)';
    });

    const toggleExpandTitle = Vue.computed(
      () => (t ? t('unify.vp.turnBlock.expand') : 'Expand turn')
    );
    const toggleCollapseTitle = Vue.computed(
      () => (t ? t('unify.vp.turnBlock.collapse') : 'Collapse turn')
    );

    return {
      expanded,
      onToggle,
      onOpenVpDetail,
      onStopTurn,
      isTyping,
      showStop,
      proxyTurn,
      compactText,
      lastTool,
      startedTimeText,
      startedTimeFullText,
      elapsedText,
      truncatedTitle,
      emptyText,
      toggleExpandTitle,
      toggleCollapseTitle,
    };
  },
};
