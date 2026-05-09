/**
 * VpTurnBlock — Slack-style per-VP turn block (Slack-layout redesign,
 * 2026-05-09). Two-column grid: avatar gutter on the LEFT, content
 * column on the RIGHT. The content column has its own header on top
 * (name + time + state cause + per-turn stop) and the message body
 * (text + tools + todo + ask + images + hand-off pills) below it.
 *
 * Why a 2-column grid (vs. the prior horizontal flex header + indented
 * body): the previous shape rendered `[avatar | name | time | toggle]`
 * across the FULL row width, with the body indented 36px below. After
 * a turn finished and entered `auto-collapsed`, the compact body
 * stripped most context, and several reports came back saying the
 * "who replied" identity disappeared visually because the eye-line
 * separated the bare text from the small avatar a row up. The grid
 * keeps avatar and message side-by-side at all times, like Slack /
 * Crew workspace's `crew-message` layout.
 *
 * Header content (always visible, never collapsed):
 *   [Display name] · [HH:MM start time] [· Ns elapsed while streaming]
 *                                                  [stop btn] [toggle]
 *
 * Body collapse — kept the 4-state expand machine (see
 * turn-compact.js) but ONLY collapses the body. The header is
 * unconditional, so identity never disappears post-streaming, even
 * in `auto-collapsed`:
 *
 *     'streaming'      — auto, while turn.isStreaming === true     → expanded body
 *     'auto-collapsed' — auto, after streaming ends                → collapsed body
 *     'user-expanded'  — sticky, after user clicks chevron open    → expanded body
 *     'user-collapsed' — sticky, after user clicks chevron close   → collapsed body
 *
 * Expanded body delegates to AssistantTurn (full markdown, tool
 * history, todo, ask, images, footer actions). Collapsed body shows
 * a 6-line tail + the most-recent tool action — same as before, just
 * pinned next to the avatar instead of indented under a wide header.
 *
 * MessageList mounts VpTurnBlock only when the turn carries a
 * `speakerVpId`; legacy 1:1 chat turns (no VP attribution) fall
 * through to a plain AssistantTurn. The live elapsed ticker is
 * driven by a single page-shared `nowMs` ref passed in by MessageList
 * (one interval, not per-turn).
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
import VpAvatar from './VpAvatar.js';
import ToolLine from './ToolLine.js';
import { useChatStore } from '../stores/chat.js';
import { useVpStore } from '../stores/vp.js';
import {
  compactBody,
  isExpanded as isExpandedFn,
  toggleState,
  reconcileStreamingState,
  formatElapsed,
} from '../stores/helpers/turn-compact.js';

export default {
  name: 'VpTurnBlock',
  components: { AssistantTurn, VpAvatar, ToolLine },
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

      <!-- Left gutter: avatar only. Clickable opens VP detail. The
           name lives in the right column's header so it shares the
           message column's text baseline (Slack style). -->
      <div class="vp-turn-block-avatar"
           :class="{ 'vp-turn-block-avatar-clickable': !!turn.speakerVpId }"
           @click.stop="onAvatarClick"
           :title="displayName"
           :role="turn.speakerVpId ? 'button' : null"
           :tabindex="turn.speakerVpId ? '0' : null"
           @keydown.enter.stop="onAvatarClick"
           @keydown.space.stop.prevent="onAvatarClick">
        <VpAvatar
          v-if="turn.speakerVpId"
          :vp-id="turn.speakerVpId"
          :size="36"
          :typing="isTyping"
        />
      </div>

      <!-- Right column: header (always visible) + body (collapsible) -->
      <div class="vp-turn-block-main">
        <div class="vp-turn-block-main-header">
          <span
            v-if="displayName"
            class="vp-turn-block-name"
            @click.stop="onAvatarClick"
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
              :title="$t ? $t('unify.vp.turnBlock.elapsedTitle') : 'Elapsed time'"
              aria-live="polite"
            >{{ elapsedText }}</span>
          </template>
          <span class="vp-turn-block-spacer"></span>
          <button
            v-if="showStop"
            type="button"
            class="vp-turn-block-stop"
            @click.stop="onStopTurn"
            :title="$t ? $t('unify.vp.speaker.stop') : 'Stop'"
            :aria-label="$t ? $t('unify.vp.speaker.stop') : 'Stop'"
          ><svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
          <button
            type="button"
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

        <!-- Expanded body: full AssistantTurn delegates rendering of
             markdown text + tool history + todo + ask + images +
             handoff pills. We pass 'hide-speaker-header' so AssistantTurn
             suppresses its own VpSpeakerHeader — the avatar/name are
             already in our right-column header. -->
        <AssistantTurn
          v-if="expanded"
          class="vp-turn-block-body-expanded"
          :turn="turn"
          :conversation-id="conversationId"
          :hide-speaker-header="true"
        />

        <!-- Collapsed body: 6-line text tail + last 1 tool action.
             Identity is preserved by the header above — the body just
             communicates "what they said / what they did". -->
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
    </div>
  `,
  setup(props) {
    const store = useChatStore();
    const vpStore = useVpStore();
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

    const onAvatarClick = () => {
      // Reuse the same path the timeline + speaker header use. Click on
      // either the avatar gutter or the name in the right-column header
      // routes here so users have a wide, obvious affordance.
      const vpId = props.turn && props.turn.speakerVpId;
      if (!vpId) return;
      store.enterVpDetailView(vpId);
    };

    const displayName = Vue.computed(() => {
      const vpId = props.turn && props.turn.speakerVpId;
      if (!vpId) return '';
      // vpLabel lives on the VP store (same as VpAvatar / VpBadge); calling
      // it on the chat store would silently TypeError and leave the always-
      // visible header showing raw `vp-…` ids — the exact bug this PR fixes.
      return vpStore.vpLabel(vpId) || vpId;
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

    const truncatedTitle = Vue.computed(() => {
      const total = compactText.value.totalLines;
      return t
        ? t('unify.vp.turnBlock.truncated', { total })
        : `Showing last 6 of ${total} lines — click to expand.`;
    });

    const emptyText = Vue.computed(() => {
      if (props.turn.isStreaming) {
        return t ? t('unify.vp.turnBlock.thinking') : 'thinking…';
      }
      return t ? t('unify.vp.turnBlock.empty') : '(no text)';
    });

    const toggleExpandTitle = Vue.computed(() =>
      t ? t('unify.vp.turnBlock.expand') : 'Expand turn'
    );
    const toggleCollapseTitle = Vue.computed(() =>
      t ? t('unify.vp.turnBlock.collapse') : 'Collapse turn'
    );

    return {
      expanded,
      onToggle,
      onAvatarClick,
      onStopTurn,
      isTyping,
      showStop,
      displayName,
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
