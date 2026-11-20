import { useAuthStore } from '../stores/auth.js';
import AgentInstaller from './AgentInstaller.js';
import MessageItem from './MessageItem.js';
import AssistantTurn from './AssistantTurn.js';
import VpTurnBlock from './VpTurnBlock.js';
import VpSpeakerHeader from './VpSpeakerHeader.js';
import ReflectionCard from './ReflectionCard.js';
import SubAgentCard from './SubAgentCard.js';
import UserTurnBlock from './UserTurnBlock.js';
import VirtualTranscript from './VirtualTranscript.js';
import MessageBlock from './MessageBlock.js';
import ConcurrentUserTurns from './ConcurrentUserTurns.js';
import SessionLaneWait from './SessionLaneWait.js';
import { sessionExecutionKey } from '../stores/helpers/yeaft-session-identity.js';
import { orderUserTurnMessages, partitionUserTurnBlocks, isPendingUserTurn } from '../utils/concurrent-user-turns.js';
import { readWaitClock } from '../utils/wait-clock.js';
import { pickWaitingAnimation, waitingAnimation } from './waiting/index.js';
import {
  orderYeaftVpTurnMessagesByExecution,
  shouldCloseYeaftVpTurn,
} from '../stores/helpers/yeaft-turn-boundary.js';
import {
  estimateVirtualItemHeight,
  historyPrefetchThreshold,
  isTranscriptScrollbarPointer,
  resolveTranscriptUserFollow,
  shouldFollowTranscriptBottom,
  shouldMarkTranscriptKeyScroll,
  virtualTranscriptDefaults,
} from '../utils/virtual-transcript.js';
import {
  annotateMessageBlocksForResponseCollapse,
  collapsedResponsePreviewForMessageBlock,
  estimateCollapsedMessageBlockHeight,
  isResponseItem,
  visibleItemsForMessageBlock,
} from '../utils/message-turn-collapse.js';
import { navigateToPersistedMessage } from '../utils/message-search-navigation.js';
import { createHistoryPageBudget, isHistoryScrollInput } from '../utils/history-pagination.js';
import { formatSessionMessageDateTime } from '../utils/session-message-quote.js';
import { appendTurnResponseSegment, finalizeTurnResponseSegments, orderResponseImageMessages } from '../utils/turn-response.js';
import { resolveLongResponseOrigin } from '../utils/response-origin-navigation.js';
// task-757: appendTypingPlaceholders removed from the pipeline.
// The standalone typing card it produced (at the bottom of the
// conversation) showed "[VP] is typing…" in a separate row that
// duplicated the VP's avatar block. The pure helper at
// `web/stores/helpers/typing-placeholders.js` is kept for its unit
// tests and may be reused later, but the active rendering path no
// longer invokes it — the VpTurnBlock that materialises from the
// first streaming chunk carries its own typing badge on the avatar
// (driven by `isVpTypingInCurrentConv`), so the avatar+state appear
// in the right place (inside the VP's own block) instead of as a
// detached card. There is a sub-second gap between `vp_typing_start`
// and the first chunk where no avatar is shown; user-tested as
// acceptable in v0.1.757.

export default {
  name: 'MessageList',
  components: { AgentInstaller, MessageItem, AssistantTurn, VpTurnBlock, VpSpeakerHeader, ReflectionCard, SubAgentCard, UserTurnBlock, VirtualTranscript, MessageBlock, ConcurrentUserTurns, SessionLaneWait },
  template: `
    <main class="chat-container virtual-transcript-scroller" ref="containerRef" tabindex="-1">
      <!-- Session Loading Overlay - only covers message area -->
      <div class="session-loading-overlay" v-if="showSessionLoadingOverlay">
        <div class="session-loading-content">
          <div class="session-loading-spinner"></div>
          <div class="session-loading-text">{{ store.sessionLoadingText || $t('common.loading') }}</div>
        </div>
      </div>

      <!-- Welcome Screen when no conversation -->
      <div v-if="!store.activeConversationId" class="welcome-screen">
        <div class="welcome-content">
          <div class="welcome-logo">
            <svg viewBox="0 0 48 48" width="64" height="64" aria-hidden="true">
              <rect width="48" height="48" rx="12" fill="var(--accent)"/>
              <path d="M24 34V19M24 19L15 11M24 19L33 11" stroke="var(--accent-fg)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              <circle cx="15" cy="11" r="3.5" fill="var(--accent-fg)"/>
              <circle cx="33" cy="11" r="3.5" fill="var(--accent-fg)"/>
              <circle cx="24" cy="34" r="3.5" fill="var(--accent-fg)"/>
            </svg>
          </div>
          <h1 class="welcome-title">{{ onlineAgents.length ? 'Yeaft' : $t('welcome.setupTitle') }}</h1>
          <p class="welcome-subtitle">{{ $t(onlineAgents.length ? 'welcome.subtitle' : 'welcome.setupDesc') }}</p>

          <!-- Agent Status -->
          <div class="welcome-status" v-if="onlineAgents.length > 0">
            <span class="status-dot online"></span>
            <span class="status-text">{{ $t('welcome.agentOnline', { count: onlineAgents.length }) }}</span>
          </div>

          <!-- A single setup action; no chat controls until an Agent is available. -->
          <div class="welcome-setup" v-if="onlineAgents.length === 0">
            <AgentInstaller
              :agent-secret="welcomeAgentSecret || ''"
              :loading="welcomeSetupLoading"
              :error="welcomeSetupError"
              @open-settings="$emit('open-settings')"
            />
          </div>

          <!-- Quick Actions -->
          <div class="welcome-actions" v-if="onlineAgents.length > 0">
            <button class="welcome-btn primary" @click="$emit('new-conversation')">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/>
              </svg>
              {{ $t('welcome.newConv') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Messages when in conversation -->
      <div v-else class="messages" :class="{ 'has-concurrent-turns': splitActive }">
        <!-- A tool-only reply has no transcript row; parallel lanes already announce their state. -->
        <span v-if="toolsInStatus" class="response-sr-only session-tool-only-status" role="status">{{ !splitActive && turnProjection.hasToolOnlyResponse ? $t('chat.concurrent.running') : '' }}</span>
        <!-- Connecting banner: non-Claude provider session booting in background -->
        <div v-if="store.isConversationConnecting(store.currentConversation)" class="typing-status-banner typing-status-banner-connecting">
          <span class="typing-status-text typing-status-compact">
            <span class="spinner-mini"></span> {{ $t('chat.connecting') }}
          </span>
        </div>
        <!-- Waiting status banner (shown above messages, not overlapping cat animation) -->
        <div v-if="waitingStatus && waitingStatus !== 'normal'" class="typing-status-banner" :class="'typing-status-banner-' + waitingStatus">
          <span v-if="waitingStatus === 'disconnected'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.disconnected') }}
          </span>
          <span v-else-if="waitingStatus === 'compacting'" class="typing-status-text typing-status-compact">
            <span class="spinner-mini"></span> {{ $t('chat.waiting.compacting') }}
          </span>
          <span v-else-if="waitingStatus === 'agent-offline'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.agentOffline') }}
            <button class="typing-refresh-btn" @click="refreshSession">{{ $t('chat.waiting.refresh') }}</button>
          </span>
          <span v-else-if="waitingStatus === 'session-lost'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.sessionLost') }}
          </span>
          <span v-else-if="waitingStatus === 'cli-exited'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.cliExited') }}
          </span>
        </div>
        <!-- Load-more hint + spinner. Two parallel paths share one row:
             - Chat mode dispatches 'sync_messages' against the SQLite
               messageDb (gated on store.hasMoreMessages).
             - Yeaft mode dispatches 'yeaft_load_more_history' which the
               agent reads from disk-backed conversationStore (gated on
               store.yeaftHasMoreHistory).
             onClickLoadMore branches by currentView so a single visual
             affordance can drive either mode without leaking state. -->
        <div v-if="showInitialMessagesLoading" class="initial-message-loading" role="status" aria-live="polite">
          <div class="initial-message-loading-spinner" aria-hidden="true"></div>
          <div class="initial-message-loading-text">{{ initialMessagesLoadingText || $t('chat.session.loadingHistory') }}</div>
        </div>
        <div v-else-if="(store.loadingMoreMessages && store.currentView !== 'yeaft') || showYeaftOlderHistoryLoading" class="loading-more">{{ $t('message.loadingMore') }}</div>
        <button v-else-if="(store.hasMoreMessages && store.currentView !== 'yeaft') || store.yeaftHasMoreHistory || store.hasHiddenYeaftMessages" type="button" class="load-more-hint" @click="onClickLoadMore">{{ $t('message.loadMore') }}</button>
        <VirtualTranscript
          :key="virtualTranscriptIdentity"
          ref="virtualTranscriptRef"
          :items="historyBlocks"
          :estimate-height="estimateMessageBlockHeight"
          initial-align="end"
          :overscan="1"
          :item-gap="18"
          @scroll-state="onVirtualTranscriptScrollState"
        >
          <template #default="{ item: block }">
          <MessageBlock :block="block" :context="blockRenderContext"
            @quote-message="$emit('quote-message', $event)"
            @edit-message-as-new="$emit('edit-message-as-new', $event)"
            @delete-turn="$emit('delete-turn', $event)"
            @fork-from-turn="$emit('fork-from-turn', $event)" />
        </template>
        </VirtualTranscript>
        <ConcurrentUserTurns v-if="splitActive" ref="concurrentTurnsRef" :turns="pendingTurns" :messages="store.messages"
          :estimate-height="estimateMessageBlockHeight" @stop="stopUserTurn" @read-pane="onReadPane">
          <template #default="{ block }">
            <MessageBlock :block="block" :context="blockRenderContext"
              @quote-message="$emit('quote-message', $event)"
              @edit-message-as-new="$emit('edit-message-as-new', $event)"
              @delete-turn="$emit('delete-turn', $event)"
              @fork-from-turn="$emit('fork-from-turn', $event)" />
          </template>
          <template v-if="toolsInStatus" #after="{ turn }">
            <SessionLaneWait v-if="laneWaiting(turn)"
              :preference="store.waitingAnimation" :seed="turn.startedAt" :clock-key="waitClockKey + ':' + turn.userTurnId" :status="waitingStatus || ''" />
          </template>
        </ConcurrentUserTurns>
        <!-- feat-6af5f9f1 PR A: orphan-card flush also removed. Orphans
             still latch in the store; PR B's debug panel surfaces them
             under the matching loop range. -->
        <SubAgentCard
          v-for="card in orphanSubAgentCards"
          :key="card.key"
          :card="card"
        />
        <!--
          task-708: per-VP typing is now an avatar-attached badge on
          every VP-attributed AssistantTurn (see VpSpeakerHeader →
          VpBadge → VpAvatar :typing). The previous standalone
          .vp-typing-row container was removed because it flashed
          in/out when AssistantTurn materialised — the avatar on the
          in-flight turn's own header now signals the typing state
          continuously.

          When 'vp_typing_start' lands but the engine hasn't emitted a
          first chunk yet, a placeholder pseudo-turn is synthesised
          below in turnGroups; AssistantTurn renders just the speaker
          header (with typing badge on the avatar) when the body is
          empty.
        -->
        <!-- Waiting indicator: shown while processing but not streaming text. The
             chosen animation plays in it; with animations off, three dots. -->
        <div v-if="previewShowTypingDots && !splitActive && (!toolsInStatus || store.isProcessing || isPreviewMode)" class="typing-indicator" :class="[animation ? 'is-' + animation.layout : '', waitingStatus ? ('status-' + waitingStatus) : '']">
          <component v-if="animation" :is="animation.component" :clock-key="waitClockKey" :status="waitingStatus || ''" />
          <template v-else><span></span><span></span><span></span></template>
        </div>
      </div>

      <!-- Preview mode: standalone typing indicator when no conversation -->
      <div v-if="isPreviewMode && !store.currentConversation" class="typing-indicator preview-animation-indicator" :class="animation ? 'is-' + animation.layout : ''" style="position: fixed; bottom: 100px; left: 0; right: 0; padding-inline: var(--space-6); z-index: 100;">
        <component v-if="animation" :is="animation.component" :clock-key="waitClockKey" />
        <template v-else><span></span><span></span><span></span></template>
      </div>

      <nav v-if="store.activeConversationId" class="transcript-navigation" :aria-label="$t('message.navigation')">
        <button
          v-if="activeLongResponseOriginId"
          type="button"
          class="transcript-navigation-btn response-origin-btn"
          @click="jumpToOrigin(activeLongResponseOriginId)"
          :title="$t('message.backToCurrentTurn')"
          :aria-label="$t('message.backToCurrentTurn')"
        >
          {{ $t('message.currentTurn') }}
        </button>
        <button type="button" class="transcript-navigation-btn scroll-to-latest" :class="{ 'is-hidden': isAtBottom }" @click="scrollToLatest">
          {{ $t('message.scrollToLatest') }}
        </button>
      </nav>
    </main>
  `,
  props: {
    toolsInStatus: { type: Boolean, default: false },
    liveExecutionKeys: { type: Set, default: () => new Set() },
    hideSpeakerIdentity: { type: Boolean, default: false },
    deleteTurnActionFor: { type: Function, default: null },
    forkFromTurnEnabled: { type: Boolean, default: false },
    forkFromTurnDisabled: { type: Boolean, default: false },
    forkFromTurnTitle: { type: String, default: '' },
  },
  emits: ['new-conversation', 'resume-conversation', 'open-settings', 'quote-message', 'edit-message-as-new', 'fork-from-turn', 'delete-turn'],
  setup(_props, { expose }) {
    const store = Pinia.useChatStore();
    const authStore = useAuthStore();
    const vpStore = (typeof window !== 'undefined' && window.Pinia?.useVpStore)
      ? window.Pinia.useVpStore()
      : null;
    const t = Vue.inject('t', null);
    const containerRef = Vue.ref(null);
    const virtualTranscriptRef = Vue.ref(null);
    const assistantTurnActionStates = Vue.reactive({});
    const toolExpandStates = Vue.reactive({});
    const messageTurnCollapseStates = Vue.reactive({});

    const turnUiKey = (turn) => String(
      turn?.id
        || turn?.turnId
        || turn?.messageId
        || turn?.atMessageId
        || turn?.message?.id
        || 'turn_unknown'
    );
    const assistantTurnActionsExpandedFor = (turn) => {
      const key = turnUiKey(turn);
      return Object.prototype.hasOwnProperty.call(assistantTurnActionStates, key)
        ? !!assistantTurnActionStates[key]
        : false;
    };
    const setAssistantTurnActionsExpanded = (turn, value) => {
      assistantTurnActionStates[turnUiKey(turn)] = !!value;
    };
    const onOpenTurnDebug = (turn) => {
      const turnId = turn && (turn.turnId || turn.id);
      if (!turnId || typeof store.openYeaftTurnDebug !== 'function') return;
      store.openYeaftTurnDebug({
        sessionId: activeYeaftSessionId.value || null,
        turnId,
      });
    };
    const setToolExpanded = ({ key, value } = {}) => {
      if (!key) return;
      toolExpandStates[key] = !!value;
    };
    const estimateMessageBlockHeight = (block) => {
      const collapsedHeight = estimateCollapsedMessageBlockHeight(block, estimateVirtualItemHeight);
      return Number.isFinite(collapsedHeight) ? collapsedHeight : estimateVirtualItemHeight(block);
    };
    const visibleItemsForBlock = (block) => visibleItemsForMessageBlock(block);
    const collapsedResponsePreviewLines = (block) => {
      const preview = Array.isArray(block?.collapsedResponsePreview)
        ? block.collapsedResponsePreview
        : collapsedResponsePreviewForMessageBlock(block);
      return Array.isArray(preview) ? preview : (preview ? [String(preview)] : []);
    };
    const collapsedResponsePreviewSpeaker = (block) => {
      const firstResponse = Array.isArray(block?.items)
        ? block.items.find(item => isResponseItem(item))
        : null;
      const vpId = firstResponse?.speakerVpId
        || firstResponse?.vpId
        || firstResponse?.message?.speakerVpId
        || firstResponse?.message?.vpId
        || block?.vpId
        || '';
      const name = vpId && vpStore && typeof vpStore.vpLabel === 'function'
        ? (vpStore.vpLabel(vpId) || vpId)
        : (vpId || (typeof t === 'function' ? t('message.assistant') : 'Assistant'));
      const style = vpId && vpStore && typeof vpStore.vpTextColor === 'function'
        ? { color: vpStore.vpTextColor(vpId) }
        : {};
      const ts = firstResponse?.speakerTimestamp
        || firstResponse?.timestamp
        || firstResponse?.createdAt
        || firstResponse?.message?.timestamp
        || firstResponse?.message?.createdAt
        || 0;
      let timeText = '';
      let fullTimeText = '';
      if (ts) {
        try {
          const d = new Date(ts);
          if (!Number.isNaN(d.getTime())) {
            timeText = formatSessionMessageDateTime(ts);
            fullTimeText = d.toLocaleString();
          }
        } catch (_) {}
      }
      return { name, style, timeText, fullTimeText };
    };
    const lastResponseItemForBlock = (block) => {
      const items = Array.isArray(block?.items) ? block.items : [];
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (isResponseItem(items[i])) return items[i];
      }
      return null;
    };
    const responseToggleBelongsToItem = (block, item) => {
      if (!block?.responseCollapsible || !item) return false;
      return lastResponseItemForBlock(block) === item;
    };
    const showBlockResponseToggle = (block) => !!(
      block?.responseCollapsible
      && !visibleItemsForMessageBlock(block).some(item => responseToggleBelongsToItem(block, item))
    );
    const toggleMessageTurnResponse = (block) => {
      const key = block?.responseCollapseKey;
      if (!key) return;
      messageTurnCollapseStates[key] = !block.responseCollapsed;
    };
    const responseCollapseLabel = (block) => {
      const count = Number(block?.responseCount || 0);
      const key = block?.responseCollapsed ? 'message.showResponses' : 'message.hideResponses';
      const template = (typeof t === 'function' ? t(key) : '') || (block?.responseCollapsed ? 'Show {count} response(s)' : 'Hide response(s)');
      return String(template).replace('{count}', String(count));
    };

    // Resolve whether the user is viewing an active Yeaft Session. This gates
    // IM-style turn layout here; the announcement editor itself now lives in
    // the Session status pane so status context stays grouped together.
    const sessionsStore = (() => {
      try { return window.Pinia?.useSessionsStore?.() || null; }
      catch (_) { return null; }
    });
    const activeYeaftSessionId = Vue.computed(() => {
      if (store.currentView !== 'yeaft') return null;
      const gs = sessionsStore();
      if (!gs) return null;
      const filterId = store.yeaftActiveSessionFilter || null;
      if (filterId && typeof gs.sessionById === 'function' && gs.sessionById(filterId, store.currentAgent || null)) return filterId;
      if (gs.activeSessionId && typeof gs.sessionById === 'function' && gs.sessionById(gs.activeSessionId, store.currentAgent || null)) return gs.activeSessionId;
      return null;
    });
    const virtualTranscriptIdentity = Vue.computed(() => {
      const view = store.currentView || '';
      const agentId = store.currentAgent || '';
      if (view === 'yeaft') {
        // A Yeaft bridge conversation id is transport state. Cold history and
        // session_ready may promote local/old ids while the user is still reading
        // the same Session; keying Vue by that id destroys and recreates the whole
        // virtual transcript, producing a visible refresh and a transient blank
        // pane. User navigation identity is Agent + Session, which changes only
        // when the user actually switches context.
        const sessionId = store.yeaftActiveSessionFilter || activeYeaftSessionId.value || '__all__';
        return [view, agentId, sessionId].join('\u001f');
      }
      return [view, agentId, store.activeConversationId || ''].join('\u001f');
    });

    // Issue C (2026-05-12) — IM-style dual-column layout gate.
    // The user explicitly scoped this to Yeaft Session conversations only:
    // 1:1 chat is unchanged. Yeaft view + an active Session renders
    // user messages as right-side bubbles (UserTurnBlock) and VP turns on the
    // left (existing VpTurnBlock). Outside a Session, user messages fall
    // through to the legacy centered MessageItem.
    const useImStyleForUser = Vue.computed(() => activeYeaftSessionId.value !== null);

    // Online agents
    const onlineAgents = Vue.computed(() => {
      return store.agents.filter(a => a.online);
    });

    const welcomeAgentSecret = Vue.ref(null);
    const welcomeSetupLoading = Vue.ref(false);
    const welcomeSetupError = Vue.ref('');
    let welcomeSetupPromise = null;
    let welcomeSetupRequestSeq = 0;
    let lastWelcomeAuthToken = authStore.token || '';

    const resetWelcomeAgentSetup = () => {
      welcomeAgentSecret.value = null;
      welcomeSetupError.value = '';
      welcomeSetupPromise = null;
      welcomeSetupRequestSeq += 1;
    };

    const welcomeHeaders = () => {
      const headers = { 'Content-Type': 'application/json' };
      if (authStore.token) headers.Authorization = `Bearer ${authStore.token}`;
      return headers;
    };

    const ensureWelcomeAgentSetup = async () => {
      if (onlineAgents.value.length > 0 || store.currentConversation) return;
      if (welcomeAgentSecret.value || welcomeSetupPromise) return welcomeSetupPromise;
      welcomeSetupLoading.value = true;
      welcomeSetupError.value = '';
      const requestSeq = ++welcomeSetupRequestSeq;
      welcomeSetupPromise = (async () => {
        const requestToken = authStore.token || '';
        const headers = welcomeHeaders();
        const secretRes = await fetch('/api/user/agent-secret', { headers });
        if (requestSeq !== welcomeSetupRequestSeq || requestToken !== (authStore.token || '')) return;
        if (!secretRes.ok) {
          let message = '';
          try { message = (await secretRes.json())?.error || ''; } catch {}
          throw new Error(message || 'Failed to load Agent secret');
        }
        const data = await secretRes.json();
        if (requestSeq !== welcomeSetupRequestSeq || requestToken !== (authStore.token || '')) return;
        const secret = data?.agentSecret || data?.agent_secret || null;
        welcomeAgentSecret.value = secret && String(secret).trim() ? String(secret) : null;
      })()
        .catch((err) => {
          if (requestSeq !== welcomeSetupRequestSeq) return;
          welcomeSetupError.value = err?.message || 'Failed to load Agent secret';
        })
        .finally(() => {
          if (requestSeq !== welcomeSetupRequestSeq) return;
          welcomeSetupLoading.value = false;
          welcomeSetupPromise = null;
        });
      return welcomeSetupPromise;
    };

    const fallbackUiKeys = new WeakMap();
    let fallbackUiKeySequence = 0;
    const objectUiFallback = (item, msg) => {
      const identityObject = (item?.message && typeof item.message === 'object')
        ? item.message
        : (Array.isArray(item?.messages) && item.messages[0] && typeof item.messages[0] === 'object'
          ? item.messages[0]
          : (msg && typeof msg === 'object'
            ? msg
            : (item && typeof item === 'object' ? item : null)));
      if (!identityObject) return `legacy_render_${++fallbackUiKeySequence}`;
      let key = fallbackUiKeys.get(identityObject);
      if (!key) {
        key = `legacy_render_${++fallbackUiKeySequence}`;
        fallbackUiKeys.set(identityObject, key);
      }
      return key;
    };
    const messageUiKey = (item) => {
      const msg = item?.message || item || null;
      return item?.entryId
        || item?.uiKey
        || item?.stableKey
        || msg?.entryId
        || msg?.uiKey
        || msg?.stableKey
        || item?.atMessageId
        || item?.messageId
        || msg?.messageId
        || item?.id
        || msg?.id
        || objectUiFallback(item, msg);
    };
    const renderSafeUiKey = value => encodeURIComponent(String(value || 'legacy'));
    const messageBlockMetaForItem = (item) => {
      const msg = item?.message || null;
      const uiKey = messageUiKey(item);
      const messageId = item?.id
        || item?.atMessageId
        || msg?.id
        || msg?.messageId
        || uiKey;
      const vpId = item?.speakerVpId
        || item?.vpId
        || msg?.speakerVpId
        || msg?.vpId
        || '';
      return {
        id: `message_${renderSafeUiKey(uiKey)}`,
        uiKey,
        vpId,
        messageId,
      };
    };

    const currentSessionTurns = Vue.computed(() => (store.currentView === 'yeaft' ? (store.yeaftSessionTurns || []) : []));
    const userTurnProjection = Vue.computed(() => orderUserTurnMessages(store.messages || [], currentSessionTurns.value));

    // Turn aggregation: group flat messages into turn groups
    const turnProjection = Vue.computed(() => {
      const inlineMessages = orderResponseImageMessages(store.currentView === 'yeaft' ? userTurnProjection.value.messages : store.messages);
      const messages = store.currentView === 'yeaft'
        ? orderYeaftVpTurnMessagesByExecution(inlineMessages)
        : inlineMessages;
      const result = [];
      let hasToolOnlyResponse = false;
      // Rendering can bucket parallel VP executions. Fork endpoints must still
      // follow transcript order, not the reordered visual row positions.
      const transcriptOrder = new Map(store.messages.map((message, index) => [message, index]));
      let currentTurn = null;

      // task-708: every VP-attributed turn carries its own avatar header.
      // The previous "consecutive-same-speaker collapse" (Slack-style)
      // produced the user's "VP disappears" complaint — when a VP sent
      // back-to-back turns, the second turn rendered without an avatar
      // because we suppressed the header. The pure helper at
      // `web/stores/helpers/turn-groups.js` already always shows the
      // header per VP turn; this inline aggregator now matches it.

      const finishTurn = () => {
        if (currentTurn) {
          const turnIds = new Set([currentTurn.turnId, ...currentTurn.messages.map(message => message.turnId)].filter(Boolean));
          const activeTurnMeta = Object.entries(store.activeVpTurns || {}).find(([key, row]) => (
            turnIds.has(row?.turnId || key)
            && (!store.currentAgent || !row?.agentId || row.agentId === store.currentAgent)
            && (!row?.sessionId || row.sessionId === activeYeaftSessionId.value)
          ))?.[1] || null;
          // A replayed reply can merge multiple runtime turn IDs. Keep the
          // first ID for debug/grouping, but fork through its latest durable
          // assistant row (tool-use rows also project persisted assistants).
          // A legacy endpoint without identity must not fall back to an earlier
          // row, which would silently cut off part of the selected response.
          const forkEndpoint = currentTurn.messages.reduce((latest, message) => (
            (message.type === 'assistant' || message.type === 'tool-use')
              && (!latest || transcriptOrder.get(message) > transcriptOrder.get(latest))
              ? message : latest
          ), null);
          currentTurn.forkBoundaryTurnId = typeof forkEndpoint?.turnId === 'string'
            ? forkEndpoint.turnId.trim() : '';
          currentTurn.isActive = !!activeTurnMeta;
          if (_props.toolsInStatus) {
            currentTurn.isResponding = currentTurn.messages.some(message => (
              message.turnId && _props.liveExecutionKeys.has(sessionExecutionKey(message))
            ));
            currentTurn.isActive ||= currentTurn.isResponding;
          }
          if (Number.isFinite(activeTurnMeta?.startedAt)) currentTurn.startedAt = activeTurnMeta.startedAt;
          finalizeTurnResponseSegments(currentTurn);
          const persistedLlmCallCount = currentTurn.messages.reduce((count, message) => (
            Number.isInteger(message?.llmCallCount) && message.llmCallCount > count
              ? message.llmCallCount
              : count
          ), 0);
          const liveTurnMeta = currentTurn.turnId
            ? store.yeaftDebugTurnsById?.[currentTurn.turnId]
            : null;
          currentTurn.llmCallCount = Math.max(persistedLlmCallCount, liveTurnMeta?.loopCount || 0);
          const persistedResponseMeta = [...currentTurn.messages].reverse().find(message => (
            message?.type === 'assistant'
            && (message.model || message.effort
              || Number.isFinite(message.inputTokens)
              || Number.isFinite(message.outputTokens)
              || Number.isFinite(message.totalTokens)
              || Number.isFinite(message.totalMs)
              || Number.isFinite(message.turnDurationMs))
          ));
          currentTurn.model = liveTurnMeta?.model || persistedResponseMeta?.model || null;
          currentTurn.effort = liveTurnMeta?.effort || persistedResponseMeta?.effort || null;
          for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
            const liveValue = liveTurnMeta?.[key];
            const persistedValue = persistedResponseMeta?.[key];
            if (Number.isFinite(liveValue)) currentTurn[key] = liveValue;
            else if (Number.isFinite(persistedValue)) currentTurn[key] = persistedValue;
          }
          if (Number.isFinite(liveTurnMeta?.totalMs)) currentTurn.totalMs = liveTurnMeta.totalMs;
          else if (Number.isFinite(persistedResponseMeta?.totalMs)) currentTurn.totalMs = persistedResponseMeta.totalMs;
          else if (Number.isFinite(persistedResponseMeta?.turnDurationMs)) currentTurn.totalMs = persistedResponseMeta.turnDurationMs;
          const hasVisible = !!(currentTurn.textContent || currentTurn.todoMsg || currentTurn.askMsg || currentTurn.imageMsgs.length);
          const hasInlineTools = currentTurn.toolMsgs.some(tool => !_props.toolsInStatus || tool.toolName === 'RouteForward');
          // Tools shown in the activity pane do not create an empty reply row.
          if (hasVisible || hasInlineTools) {
            // task-708: render the speaker header on every VP-attributed
            // turn. The avatar (with its inline typing badge) is THE
            // surface that signals which VP is speaking + whether they
            // are still typing — collapsing it on consecutive turns
            // reads as "the VP disappeared", which is exactly the bug
            // the user reported "无数遍".
            currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
            result.push(currentTurn);
          } else if (currentTurn.isResponding) {
            hasToolOnlyResponse = true;
          }
          currentTurn = null;
        }
      };

      // task-vp-header-pos: latch turn-level VP attribution from ANY
      // message in the turn that carries routing context — not just
      // `type==='assistant'`. When a VP's reply opens with a tool_call
      // (no preceding text_delta), the FIRST message in the turn is a
      // tool-use, and the previous "assistant-only latch" left
      // `speakerVpId` null. Two visible bugs followed:
      //   (1) the synthesized typing-placeholder (below) was pushed AFTER
      //       the tool-bearing turn because `streamingVps.has(vpId)`
      //       evaluated false → avatar appeared BELOW the tools.
      //   (2) when `vp_typing_end` cleared the typing set, the placeholder
      //       vanished and the real turn never had a speaker → avatar
      //       disappeared once the message completed.
      // Latching from any Yeaft-stamped message is idempotent (only fills
      // missing fields) and matches what `messages-speaker.js` stamps on
      // assistants — `m.vpId` is the falsy fallback when an inbound
      // tool-use was stamped before its assistant peer arrived.
      const latchSpeakerFromMsg = (msg) => {
        if (!currentTurn) return;
        if (!currentTurn.speakerVpId) {
          const vp = msg.speakerVpId || msg.vpId;
          if (vp) {
            currentTurn.speakerVpId = vp;
            currentTurn.speakerTimestamp =
              (typeof msg.timestamp === 'number' && msg.timestamp > 0)
                ? msg.timestamp
                : (typeof msg.createdAt === 'number' ? msg.createdAt : 0);
            // Match the surrounding "first wins" latch policy — only
            // accept the state cause from the SAME message that gave us
            // speakerVpId. A later message in the same turn must not
            // overwrite it.
            if (typeof msg.lastStateChangeCause === 'string'
                && !currentTurn.speakerStateCause) {
              currentTurn.speakerStateCause = msg.lastStateChangeCause;
            }
          }
        }
        if (!currentTurn.turnId && msg.turnId) {
          currentTurn.turnId = msg.turnId;
        }
      };

      const startTurn = (message = null) => {
        const uiKey = messageUiKey(message);
        currentTurn = {
          type: 'assistant-turn',
          id: `response_${renderSafeUiKey(uiKey)}`,
          uiKey,
          userTurnId: userTurnProjection.value.userTurnByMessage.get(message) || '',
          ...(message?.entryId ? { entryId: message.entryId } : {}),
          textContent: '',
          textSegments: [],
          isStreaming: false,
          isActive: false,
          isHistory: false,
          todoMsg: null,
          toolMsgs: [],
          toolsInStatus: _props.toolsInStatus,
          imageMsgs: [],
          askMsg: null,
          messages: [],
          // Last persisted assistant message ID for message navigation.
          // Fork uses forkBoundaryTurnId instead of this display anchor.
          atMessageId: null,
          // task-334-ui-b: speaker attribution. `speakerVpId` latches from
          // the first VP-attributed message in the turn (assistant /
          // tool-use / chat-image) via `latchSpeakerFromMsg`;
          // `speakerTimestamp` / `speakerStateCause` read from the same
          // message. `showSpeakerHeader` is set at finishTurn() and is
          // true on every VP-attributed turn (no same-speaker collapse).
          speakerVpId: null,
          speakerTimestamp: 0,
          speakerStateCause: '',
          showSpeakerHeader: false,
          startedAt: 0,
          totalMs: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          turnId: null,
        };
      };

      // task-group-vp-block-split (v0.1.776): close the current turn
      // when an incoming VP-attributed message belongs to a DIFFERENT
      // VP turn than the one currently being assembled. Without this,
      // a `route_forward` from VP_A to VP_B leaves VP_A's turn open
      // and VP_B's first chunks get appended into VP_A's block —
      // visually the user sees Linus's text inside Jobs's bubble.
      //
      // Owner is the hard boundary. A refreshed history row may reuse a
      // user-level turnId for several VP deliveries in the same user turn,
      // so equal turnId alone must not merge different speakerVpId blocks.
      // After owner is checked, turnId still splits same-speaker deliveries.
      const closeTurnIfTurnBoundaryChanged = (msg) => {
        if (currentTurn && currentTurn.userTurnId !== userTurnProjection.value.userTurnByMessage.get(msg)) finishTurn();
        if (shouldCloseYeaftVpTurn(currentTurn, msg)) finishTurn();
      };

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.type === 'user') {
          // Skip empty user messages (tool_result artifacts from DB)
          if (!msg.content || !msg.content.trim()) {
            continue;
          }
          finishTurn();
          result.push({ type: 'user', id: messageUiKey(msg), userTurnId: userTurnProjection.value.userTurnByMessage.get(msg) || '', message: msg });
          continue;
        }

        if (msg.type === 'system' || msg.type === 'error') {
          finishTurn();
          result.push({ type: msg.type, id: messageUiKey(msg), userTurnId: userTurnProjection.value.userTurnByMessage.get(msg) || '', message: msg });
          continue;
        }

        // tool-result: skip (merged into tool-use)
        if (msg.type === 'tool-result' || msg.type === 'tool_result') {
          continue;
        }

        if (msg.type === 'assistant') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn(msg);
          appendTurnResponseSegment(currentTurn, msg);
          if (msg.isStreaming) {
            currentTurn.isStreaming = true;
          }
          if (msg.isHistory) {
            currentTurn.isHistory = true;
          }
          // Keep the last persisted assistant message as the display anchor.
          if (msg.id && /^m\d+$/.test(msg.id)) {
            currentTurn.atMessageId = msg.id;
          }
          // task-334-ui-b: latch speaker attribution from the first
          // assistant message that carries a VP id. The shared helper
          // (defined above) covers the same idempotent fill rules and is
          // also used for tool-use / chat-image branches so a turn that
          // opens with a non-assistant message still gets a header.
          latchSpeakerFromMsg(msg);
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'tool-use') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn(msg);
          latchSpeakerFromMsg(msg);

          // Merge tool-result from next message
          const nextMsg = messages[i + 1];
          const hasResult = nextMsg && (nextMsg.type === 'tool-result' || nextMsg.type === 'tool_result');
          const toolEntry = {
            ...msg,
            hasResult: hasResult || msg.hasResult || false,
            toolResult: msg.toolResult || null
          };

          if (msg.isHistory) currentTurn.isHistory = true;
          if (msg.toolName === 'TodoWrite') {
            currentTurn.todoMsg = toolEntry;
          } else if (msg.toolName === 'AskUserQuestion' || (_props.toolsInStatus && msg.toolName === 'AskUser')) {
            currentTurn.askMsg = toolEntry;
          } else {
            currentTurn.toolMsgs.push(toolEntry);
          }
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'chat-image') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn(msg);
          latchSpeakerFromMsg(msg);
          if (msg.isHistory) currentTurn.isHistory = true;
          currentTurn.imageMsgs.push(msg);
          currentTurn.messages.push(msg);
          continue;
        }

        // Unknown type: pass through
        finishTurn();
        result.push({ type: msg.type || 'unknown', id: messageUiKey(msg), userTurnId: userTurnProjection.value.userTurnByMessage.get(msg) || '', message: msg });
      }

      finishTurn();

      // task-757: removed the call to the typing-placeholder helper
      // [appendTypingPlaceholders, kept in web/stores/helpers/ for its
      // unit tests] which used to be invoked here. That call appended a
      // standalone typing card at the bottom for any VP
      // whose typing flag was set but had no in-flight turn. Reasons:
      //
      //   1. Visual: the card rendered as a detached row at the end of
      //      the conversation, not "inside" the VP's eventual block —
      //      so the avatar+typing dot read as a separate / orphan VP
      //      rather than as the VP that was about to speak.
      //   2. Redundant: once the first text_delta lands, a VpTurnBlock
      //      materialises with the VP's avatar AND a typing badge
      //      driven by `isVpTypingInCurrentConv` — the same signal the
      //      placeholder used. Two rows competed for the same surface.
      //
      // (The v0.1.757 rationale also cited a `route_forward` typing-
      // card hang, but that case has been reshaped by v0.1.776: the
      // forward-source VP now renders as a body-less block with a
      // hand-off pill, so the typing card would overlap with the
      // rendered block rather than appear next to a hidden one. Reasons
      // 1 and 2 still hold on their own.)
      //
      // Trade-off: there is a sub-second gap between `vp_typing_start`
      // and the first chunk where no avatar is shown. User-accepted in
      // v0.1.757 as the price of keeping the typing indicator inside
      // the VP's own block.

      return { turns: result, hasToolOnlyResponse };
    });
    const turnGroups = Vue.computed(() => turnProjection.value.turns);

    const messageBlocks = Vue.computed(() => {
      // Group one user row plus the following AI replies into one virtual item.
      // That keeps reply context attached during virtualization. VirtualTranscript
      // limits DOM mounting, so response bodies do not need a second collapse layer.
      const blocks = [];
      let currentBlock = null;
      const finishBlock = () => {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
      };

      turnGroups.value.forEach((item) => {
        if (!item || item.type === 'system' || item.type === 'error') {
          finishBlock();
          blocks.push(item);
          return;
        }

        const meta = messageBlockMetaForItem(item);
        const isSupplement = store.currentView === 'yeaft' && item.type === 'user'
          && item.message?.turnRelation === 'supplement' && !!item.message?.userTurnId;
        if ((item.type === 'user' && !isSupplement) || !currentBlock || currentBlock.userTurnId !== item.userTurnId) {
          finishBlock();
          currentBlock = {
            type: 'message-block',
            id: `block_${renderSafeUiKey(meta.uiKey)}`,
            uiKey: meta.uiKey,
            userTurnId: item.userTurnId || '',
            vpId: meta.vpId,
            messageId: meta.messageId,
            originMessageId: item.type === 'user' ? item.id : '',
            items: [item],
          };
          return;
        }

        currentBlock.items.push(item);
        if (!currentBlock.vpId && meta.vpId) currentBlock.vpId = meta.vpId;
      });

      finishBlock();
      return blocks;
    });

    const concurrentTurnsRef = Vue.ref(null);
    const currentPendingTurns = Vue.computed(() => currentSessionTurns.value.filter(isPendingUserTurn));
    const streamingUserTurns = Vue.computed(() => new Set(turnGroups.value
      .filter(item => item.isStreaming && item.userTurnId).map(item => item.userTurnId)));
    // Lane placement follows the root snapshot. Animation needs stronger
    // evidence: an exact live execution, which can settle before that snapshot.
    const laneWaiting = turn => turn.state === 'running' && !streamingUserTurns.value.has(turn.userTurnId)
      && turn.executions.some(execution => _props.liveExecutionKeys.has(sessionExecutionKey(execution)));
    // Settled roots still determine history order, but cannot keep a single
    // pending root in parallel layout. This also applies after navigation/reload.
    const splitActive = Vue.computed(() => currentPendingTurns.value.length > 1);
    // Free reading width only when this conversation enters parallel layout.
    // A user may reopen Workbench; streaming/new siblings must not close it again.
    Vue.watch(() => [virtualTranscriptIdentity.value, splitActive.value], ([, active]) => {
      if (active && store.workbenchExpanded) store.toggleWorkbench();
    }, { immediate: true });
    const splitProjection = Vue.computed(() => partitionUserTurnBlocks(messageBlocks.value, currentPendingTurns.value));
    const historyBlocks = Vue.computed(() => splitActive.value ? splitProjection.value.history : messageBlocks.value);
    const pendingTurns = Vue.computed(() => splitProjection.value.pending);
    const stopUserTurn = (turn) => store.stopYeaftTurn?.({ userTurnId: turn.userTurnId });

    // PR-L: reflection cards grouped by anchor (the message id present at the
    // moment the `pending` event arrived). Cards whose anchor isn't in the
    // current turn list (or never had one) are flushed at the tail of the
    // stream so they're never lost.
    const reflectionCardsByAnchor = Vue.computed(() => {
      const map = store.yeaftReflectionCards || {};
      const convId = store.yeaftConversationId;
      const out = { __orphans: [] };
      const sorted = Object.values(map)
        .filter((c) => c && c.conversationId === convId)
        .sort((a, b) => (a.anchorOrder || 0) - (b.anchorOrder || 0)
          || (a.updatedAt || 0) - (b.updatedAt || 0));
      const knownIds = new Set();
      for (const m of (store.messages || [])) {
        if (m && m.id) knownIds.add(m.id);
      }
      for (const card of sorted) {
        if (card.anchorMsgId && knownIds.has(card.anchorMsgId)) {
          if (!out[card.anchorMsgId]) out[card.anchorMsgId] = [];
          out[card.anchorMsgId].push(card);
        } else {
          out.__orphans.push(card);
        }
      }
      return out;
    });

    // For a given row item, return the message id this row "ends on" so we
    // can attach reflection cards to it. Assistant turns latch
    // `atMessageId` from their last assistant chunk; user/system/task rows
    // carry `message.id` directly.
    const rowAnchorId = (item) => {
      if (!item) return null;
      if (item.type === 'assistant-turn') return item.atMessageId || null;
      return (item.message && item.message.id) || null;
    };
    const cardsForRow = (item) => {
      const id = rowAnchorId(item);
      if (!id) return [];
      const map = reflectionCardsByAnchor.value || {};
      return map[id] || [];
    };
    const orphanCards = Vue.computed(() => {
      const map = reflectionCardsByAnchor.value || {};
      return map.__orphans || [];
    });

    // PR-M3: sub-agent cards anchored the same way reflection cards are.
    // VP-block redesign: the `featureId` routing branch (which steered cards
    // into FeaturePill bodies) is gone. Cards always render under their
    // anchor row now — same behavior as cards that lacked `featureId` in
    // the prior code.
    const subAgentCardsByAnchor = Vue.computed(() => {
      const map = store.yeaftSubAgentCards || {};
      const convId = store.yeaftConversationId;
      const out = { __orphans: [] };
      const sorted = Object.values(map)
        .filter((c) => c && c.conversationId === convId)
        .sort((a, b) => (a.anchorOrder || 0) - (b.anchorOrder || 0)
          || (a.updatedAt || 0) - (b.updatedAt || 0));
      const knownIds = new Set();
      for (const m of (store.messages || [])) {
        if (m && m.id) knownIds.add(m.id);
      }
      for (const card of sorted) {
        if (card.anchorMsgId && knownIds.has(card.anchorMsgId)) {
          if (!out[card.anchorMsgId]) out[card.anchorMsgId] = [];
          out[card.anchorMsgId].push(card);
        } else {
          out.__orphans.push(card);
        }
      }
      return out;
    });
    const subAgentCardsForRow = (item) => {
      const id = rowAnchorId(item);
      if (!id) return [];
      const map = subAgentCardsByAnchor.value || {};
      return map[id] || [];
    };
    const orphanSubAgentCards = Vue.computed(() => {
      const map = subAgentCardsByAnchor.value || {};
      return map.__orphans || [];
    });

    // Track if user is at bottom (within threshold). `autoFollowPaused` is the
    // stronger user-intent latch: once the user scrolls into history, live
    // updates must not pull the transcript back down until they explicitly
    // return to the latest row or switch sessions.
    const isAtBottom = Vue.ref(true);
    const activeLongResponseOriginId = Vue.ref('');
    const autoFollowPaused = Vue.ref(false);
    const SCROLL_THRESHOLD = virtualTranscriptDefaults.bottomThreshold;
    const historyPageBudget = createHistoryPageBudget();
    let historyLoadGeneration = 0;
    let historyLoadPending = false;
    let historyLoadUnwatch = null;
    let historyContinuationRafId = null;

    const resetHistoryPagination = () => {
      historyLoadGeneration += 1;
      historyPageBudget.reset();
      historyLoadPending = false;
      historyLoadUnwatch?.();
      historyLoadUnwatch = null;
      if (historyContinuationRafId != null) cancelAnimationFrame(historyContinuationRafId);
      historyContinuationRafId = null;
    };

    const hasStreamingMessage = Vue.computed(() => (
      store.messages.some(m => m.isStreaming)
    ));

    // Text streaming can pause while a VP executes tools. Keep the response
    // duration clock tied to the active turn lifecycle instead of changing the
    // existing typing-dots semantics of `hasStreamingMessage`.
    const hasRunningVpTurn = Vue.computed(() => {
      const currentAgentId = store.currentAgent || null;
      const currentSessionId = store.yeaftActiveSessionFilter || store.activeYeaftSessionId || null;
      return Object.values(store.activeVpTurns || {}).some(turn => (
        (!currentAgentId || !turn?.agentId || turn.agentId === currentAgentId)
        && (!currentSessionId || !turn?.sessionId || turn.sessionId === currentSessionId)
      ));
    });

    const showInitialMessagesLoading = Vue.computed(() => {
      if (!store.activeConversationId || messageBlocks.value.length > 0) return false;
      if (store.currentView === 'yeaft') return !!store.yeaftInitialHistoryLoading;
      return !!store.sessionLoading;
    });

    // Recent/delta loads are background synchronization. Rendering the shared
    // "loading more" row for them makes an otherwise stable Session visibly
    // flash on open/reconnect. Only an explicit older-page request owns that UI.
    const showYeaftOlderHistoryLoading = Vue.computed(() => (
      store.currentView === 'yeaft'
      && !!store.yeaftLoadingMoreHistory
      && store.activeYeaftHistoryState?.mode === 'older'
    ));

    const initialMessagesLoadingText = Vue.computed(() => (
      store.currentView === 'yeaft' ? '' : (store.sessionLoadingText || '')
    ));

    const showSessionLoadingOverlay = Vue.computed(() => {
      return !!store.sessionLoading && !showInitialMessagesLoading.value;
    });

    // Show typing dots when AI is processing but hasn't started streaming text yet
    const showTypingDots = Vue.computed(() => {
      return store.isProcessing && !hasStreamingMessage.value;
    });

    // task-708: the standalone vp-typing-row was removed; the placeholder
    // pseudo-turn synth in `turnGroups` reads `store.vpsTypingInCurrentConv`
    // directly, so we no longer need a separate computed here.

    // VP-block redesign Phase 3: a single page-shared "now" ref that ticks
    // once per second while any VP turn is active, including pauses in text
    // streaming during tool execution. VpTurnBlock reads it via prop to compute
    // the live elapsed counter; idle transcripts do not keep a timer running.
    //
    // Why one shared ref (not one per VpTurnBlock instance): a multi-VP
    // group can have 5+ in-flight turns simultaneously; per-component
    // setIntervals would all fire on different cycles and cause
    // staircase repaints. One ref + one interval gives every block
    // the same wall-clock value at the same render frame.
    const nowMs = Vue.ref(Date.now());
    let nowTickHandle = null;
    const startNowTick = () => {
      if (nowTickHandle) return;
      nowTickHandle = setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
    };
    const stopNowTick = () => {
      if (nowTickHandle) {
        clearInterval(nowTickHandle);
        nowTickHandle = null;
      }
    };
    Vue.watch(
      hasRunningVpTurn,
      (running) => {
        if (running) {
          // Take an immediate sample so the "started 0s ago" reads
          // accurately on the first paint, not after the next 1s tick.
          nowMs.value = Date.now();
          startNowTick();
        } else {
          stopNowTick();
        }
      },
      { immediate: true },
    );
    Vue.onBeforeUnmount(() => stopNowTick());

    // Reactive timer for long-processing fallback status
    const typingStartTime = Vue.ref(0);
    const now = Vue.ref(Date.now());
    let typingTimer = null;

    // Animation showing in the indicator: an entry of components/waiting,
    // picked once per turn. With none, the indicator shows three dots.
    const animationType = Vue.ref('none');
    const animation = Vue.computed(() => waitingAnimation(animationType.value));
    // ?preview=<animation id> keeps that animation on screen, for looking at it.
    const urlPreview = new URLSearchParams(window.location.search).get('preview');
    // Identity of the wait this transcript shows; see wait-clock.js.
    const waitClockKey = Vue.computed(() => virtualTranscriptIdentity.value);

    // Preview mode: ?preview=<animation id> (or "animation") keeps the indicator on.
    const isPreviewMode = urlPreview === 'animation' || !!waitingAnimation(urlPreview);

    // ★ task-346: Minimum visibility window for the typing indicator.
    //
    // Root cause: `showTypingDots = isProcessing && !hasStreamingMessage` is
    // true only during the pre-TTFB window — from the user's send to the
    // first `text_delta`. For low-latency providers (especially some routed
    // through the Yeaft engine where the LLM proxy can respond in <100 ms),
    // that window is shorter than a single browser paint frame, so the
    // waiting animation never becomes visible. Chat mode happens to
    // avoid this because spawning the Claude CLI always adds ≥300 ms of
    // startup latency.
    //
    // Fix: latch ON instantly when `showTypingDots` goes true, but defer
    // latch-OFF until at least `MIN_VISIBLE_MS` has elapsed since the ON
    // transition. This is purely presentational — it does NOT delay any
    // store state, assistant rendering, or scroll behavior, and it affects
    // both Chat and Yeaft identically (no mode-specific branching).
    const MIN_VISIBLE_MS = 600;
    const displayTypingDots = Vue.ref(false);
    let typingHideTimer = null;

    const previewShowTypingDots = Vue.computed(() => {
      if (isPreviewMode) return true;
      return displayTypingDots.value;
    });

    // The animation for the turn in progress, from the user's preference
    // (Settings → General). It is picked when the turn's first indicator shows
    // and kept until processing ends, so a turn does not change animation, and
    // row height, between its tool calls. ?preview= forces one instead, which
    // is also the only way to see an animation that is hidden.
    const previewAnimation = waitingAnimation(urlPreview) ? urlPreview : 'cat';
    let turnAnimation = null;
    const startWaitingAnimation = () => {
      if (isPreviewMode) {
        animationType.value = previewAnimation;
        return;
      }
      if (!turnAnimation) turnAnimation = pickWaitingAnimation(store.waitingAnimation, readWaitClock(waitClockKey.value));
      animationType.value = turnAnimation;
    };
    Vue.watch(() => store.isProcessing, (processing) => { if (!processing) turnAnimation = null; });
    Vue.watch(waitClockKey, () => { turnAnimation = null; });
    // A change in Settings applies to the wait already on screen.
    Vue.watch(() => store.waitingAnimation, () => {
      turnAnimation = null;
      if (displayTypingDots.value) startWaitingAnimation();
    });

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        // Cancel any pending hide from a prior cycle — we're visible again.
        if (typingHideTimer) {
          clearTimeout(typingHideTimer);
          typingHideTimer = null;
        }
        displayTypingDots.value = true;
        typingStartTime.value = Date.now();
        now.value = Date.now();
        if (!typingTimer) {
          typingTimer = setInterval(() => {
            now.value = Date.now();
          }, 1000);
        }
        startWaitingAnimation();
      } else {
        const elapsed = typingStartTime.value ? (Date.now() - typingStartTime.value) : MIN_VISIBLE_MS;
        const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
        const finalize = () => {
          typingHideTimer = null;
          displayTypingDots.value = false;
          typingStartTime.value = 0;
          if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
        };
        if (remaining === 0) {
          finalize();
        } else {
          if (typingHideTimer) clearTimeout(typingHideTimer);
          typingHideTimer = setTimeout(finalize, remaining);
        }
      }
    }, { immediate: true });

    // Preview mode initialization
    if (isPreviewMode) {
      typingStartTime.value = Date.now();
      now.value = Date.now();
      startWaitingAnimation();
    }

    // Event-driven waiting status (replaces time-based waitingPhase)
    const waitingStatus = Vue.computed(() => {
      if (!store.isProcessing) return null;
      if (store.connectionState !== 'connected') return 'disconnected';
      const convId = store.currentConversation;
      if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'compacting') return 'compacting';
      const health = store.sessionHealth?.[convId];
      if (health) return health.status;
      // Fallback: show "thinking" after 8s of no output
      if (typingStartTime.value && now.value - typingStartTime.value > 8000) return 'thinking';
      return null;
    });

    function refreshSession() {
      const convId = store.currentConversation;
      if (!convId) return;
      const conv = store.conversations.find(c => c.id === convId);
      store.sendWsMessage({ type: 'refresh_conversation', conversationId: convId, agentId: conv?.agentId });
    }

    // Scroll handling
    let responseNavigationRafId = null;
    let responseNavigationResizeObserver = null;
    const observedResponseElements = new Set();

    const syncResponseNavigationObservers = (responseElements) => {
      if (!responseNavigationResizeObserver) return;
      const nextElements = new Set(responseElements);
      for (const element of observedResponseElements) {
        if (nextElements.has(element)) continue;
        responseNavigationResizeObserver.unobserve(element);
        observedResponseElements.delete(element);
      }
      for (const element of nextElements) {
        if (observedResponseElements.has(element)) continue;
        responseNavigationResizeObserver.observe(element);
        observedResponseElements.add(element);
      }
    };

    const updateResponseNavigation = () => {
      responseNavigationRafId = null;
      const container = containerRef.value;
      if (!container) {
        activeLongResponseOriginId.value = '';
        return;
      }
      const viewport = container.getBoundingClientRect?.();
      const responseEls = Array.from(container.querySelectorAll?.('[data-response-origin-id]') || []);
      syncResponseNavigationObservers(responseEls);
      activeLongResponseOriginId.value = resolveLongResponseOrigin({
        viewportTop: viewport?.top || 0,
        viewportHeight: container.clientHeight || viewport?.height || 0,
        responses: responseEls.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            originMessageId: element.dataset?.responseOriginId || '',
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
          };
        }),
      });
    };

    const scheduleResponseNavigationUpdate = () => {
      if (responseNavigationRafId != null) return;
      responseNavigationRafId = requestAnimationFrame(updateResponseNavigation);
    };

    const checkIfAtBottom = () => {
      if (!containerRef.value) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.value;
      return shouldFollowTranscriptBottom({ scrollTop, scrollHeight, clientHeight, threshold: SCROLL_THRESHOLD });
    };

    const maybeLoadMoreNearTop = (scrollTop, clientHeight = 0) => {
      if (scrollTop > historyPrefetchThreshold(clientHeight) || historyLoadPending || !canLoadMoreMessages()) return;
      if (!historyPageBudget.consume()) return;
      loadMoreHistoryPage();
    };

    const getFirstLoadBlockIdentity = (block) => {
      if (!block) return '';
      const items = Array.isArray(block.items) ? block.items : [];
      const firstItem = items[0] || null;
      return [
        block.type || '',
        block.messageId || '',
        block.turnId || '',
        block.vpId || '',
        firstItem?.id || '',
        firstItem?.turnId || '',
        firstItem?.messageId || '',
      ].join(':');
    };

    const getLoadMoreProgressSnapshot = () => {
      const blocks = messageBlocks.value || [];
      return {
        blockCount: blocks.length,
        firstBlockIdentity: getFirstLoadBlockIdentity(blocks[0]),
      };
    };

    const hasLoadMoreProgress = (before, after) => {
      if (!before || !after) return false;
      return after.blockCount > before.blockCount
        || after.firstBlockIdentity !== before.firstBlockIdentity;
    };

    let readingTransferGeneration = 0;
    const resumeAutoFollow = () => {
      readingTransferGeneration += 1;
      autoFollowPaused.value = false;
      isAtBottom.value = true;
      virtualTranscriptRef.value?.setBottomFollowEnabled?.(true);
    };

    let resumeFollowingAfterSplit = false;
    let readingPaneId = null;
    const onReadPane = id => { readingPaneId = id; };
    const pauseAutoFollow = ({ forSplit = false } = {}) => {
      readingTransferGeneration += 1;
      if (!forSplit) {
        resumeFollowingAfterSplit = false;
        readingPaneId = null;
      }
      autoFollowPaused.value = true;
      isAtBottom.value = false;
      virtualTranscriptRef.value?.setBottomFollowEnabled?.(false);
      virtualTranscriptRef.value?.cancelPendingBottomFollow?.();
    };

    const onVirtualTranscriptScrollState = ({ scrollTop, scrollHeight, clientHeight }) => {
      const atBottom = shouldFollowTranscriptBottom({
        scrollTop: scrollTop || 0,
        scrollHeight: scrollHeight || 0,
        clientHeight: clientHeight || 0,
        threshold: SCROLL_THRESHOLD,
      });
      // Geometry only controls the Latest indicator. Layout and programmatic
      // scrolling must not cancel the user's explicit follow intent.
      isAtBottom.value = !autoFollowPaused.value && atBottom;
      if (!userScrollInteractionActive) lastObservedScrollTop = Number(scrollTop || 0);
      scheduleResponseNavigationUpdate();
    };

    const preserveScrollAnchorDuringLoad = (loadFn, loadingRef) => {
      const beforeSnapshot = getLoadMoreProgressSnapshot();
      const generation = historyLoadGeneration;
      historyLoadPending = true;
      let finished = false;

      const finishLoadMore = () => {
        if (finished || generation !== historyLoadGeneration) return;
        finished = true;
        historyLoadUnwatch?.();
        historyLoadUnwatch = null;
        // VirtualTranscript owns prepend anchoring by stable block key. Wait for
        // that layout, then spend only the current user gesture's remaining budget.
        Vue.nextTick(() => {
          if (generation !== historyLoadGeneration) return;
          historyContinuationRafId = requestAnimationFrame(() => {
            historyContinuationRafId = null;
            if (generation !== historyLoadGeneration) return;
            historyLoadPending = false;
            if (!containerRef.value || !hasLoadMoreProgress(beforeSnapshot, getLoadMoreProgressSnapshot())) {
              historyPageBudget.stop();
              return;
            }
            maybeLoadMoreNearTop(containerRef.value.scrollTop, containerRef.value.clientHeight);
          });
        });
      };

      if (loadingRef) {
        historyLoadUnwatch = Vue.watch(loadingRef, (loading) => {
          if (!loading) finishLoadMore();
        });
      }

      loadFn();

      // Cached resident rows may expand without a loading-flag round trip.
      Vue.nextTick(() => {
        if (!loadingRef || !loadingRef()) finishLoadMore();
      });
    };

    const loadMoreYeaft = () => {
      if (store.hasHiddenYeaftMessages) {
        store.expandYeaftMessageWindow();
        return;
      }
      store.loadMoreYeaftHistory();
    };

    const canLoadMoreMessages = () => {
      if (store.currentView === 'yeaft') {
        return store.hasHiddenYeaftMessages || (
          store.yeaftHasMoreHistory
          && !store.yeaftLoadingMoreHistory
          && store.yeaftOldestLoadedSeq != null
        );
      }
      return !!store.currentConversation && store.hasMoreMessages && !store.loadingMoreMessages;
    };

    const loadMoreHistoryPage = () => {
      const isYeaft = store.currentView === 'yeaft';
      preserveScrollAnchorDuringLoad(
        isYeaft ? loadMoreYeaft : () => store.loadMoreMessages(),
        isYeaft ? () => store.yeaftLoadingMoreHistory : () => store.loadingMoreMessages
      );
    };

    const onClickLoadMore = () => {
      if (historyLoadPending || !canLoadMoreMessages()) return;
      pauseAutoFollow();
      historyPageBudget.start();
      historyPageBudget.consume();
      loadMoreHistoryPage();
    };

    const recordHistoryScrollInput = (direction, newGesture) => {
      historyPageBudget.recordInput({ direction, newGesture });
      if (direction < 0 && containerRef.value) {
        maybeLoadMoreNearTop(containerRef.value.scrollTop, containerRef.value.clientHeight);
      }
    };

    let userScrollInteractionActive = false;
    let pointerScrollActive = false;
    let pointerGesturePending = false;
    let userScrollEndTimer = null;
    let lastObservedScrollTop = 0;
    const USER_SCROLL_END_FALLBACK_MS = 250;

    const clearUserScrollInteraction = () => {
      userScrollInteractionActive = false;
      if (userScrollEndTimer) {
        clearTimeout(userScrollEndTimer);
        userScrollEndTimer = null;
      }
    };

    const scheduleUserScrollInteractionEnd = () => {
      if (pointerScrollActive) return;
      if (userScrollEndTimer) clearTimeout(userScrollEndTimer);
      userScrollEndTimer = setTimeout(clearUserScrollInteraction, USER_SCROLL_END_FALLBACK_MS);
    };

    const markUserScrollIntent = () => {
      pauseAutoFollow();
      userScrollInteractionActive = true;
      virtualTranscriptRef.value?.clearTargetAnchor?.();
      lastObservedScrollTop = Number(containerRef.value?.scrollTop || 0);
      scheduleUserScrollInteractionEnd();
    };

    const onWheel = (event) => {
      if (event.defaultPrevented || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!isHistoryScrollInput(event.target, containerRef.value, Math.sign(event.deltaY))) return;
      markUserScrollIntent();
      recordHistoryScrollInput(Math.sign(event.deltaY));
    };

    let touchY = null;
    let touchGesturePending = false;
    const onTouchStart = (event) => {
      touchY = event.touches?.length === 1 ? event.touches[0].clientY : null;
      touchGesturePending = true;
    };
    const onTouchMove = (event) => {
      const nextY = event.touches?.length === 1 ? event.touches[0].clientY : null;
      if (event.defaultPrevented || nextY == null || touchY == null) {
        touchY = nextY;
        return;
      }
      const delta = touchY - nextY;
      touchY = nextY;
      if (!delta || !isHistoryScrollInput(event.target, containerRef.value, Math.sign(delta))) return;
      markUserScrollIntent();
      recordHistoryScrollInput(Math.sign(delta), touchGesturePending);
      touchGesturePending = false;
    };
    const onTouchEnd = () => { touchY = null; };

    const onPointerScrollStart = (event) => {
      if (!isTranscriptScrollbarPointer(event, containerRef.value)) return;
      pauseAutoFollow();
      pointerScrollActive = true;
      historyPageBudget.reset();
      pointerGesturePending = true;
      userScrollInteractionActive = true;
      virtualTranscriptRef.value?.clearTargetAnchor?.();
      lastObservedScrollTop = Number(containerRef.value?.scrollTop || 0);
      if (userScrollEndTimer) {
        clearTimeout(userScrollEndTimer);
        userScrollEndTimer = null;
      }
    };

    const onPointerScrollEnd = () => {
      pointerScrollActive = false;
      scheduleUserScrollInteractionEnd();
    };

    const onScrollKey = (event) => {
      if (!shouldMarkTranscriptKeyScroll(event, containerRef.value)) return;
      const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      const target = containerRef.value.contains(event.target) ? event.target : containerRef.value;
      if (!isHistoryScrollInput(target, containerRef.value, upward ? -1 : 1)) return;
      pauseAutoFollow();
      userScrollInteractionActive = true;
      virtualTranscriptRef.value?.clearTargetAnchor?.();
      scheduleUserScrollInteractionEnd();
      recordHistoryScrollInput(upward ? -1 : 1, !event.repeat);
    };

    const onScroll = () => {
      const currentScrollTop = Number(containerRef.value?.scrollTop || 0);
      const wasFollowing = !autoFollowPaused.value;
      const delta = currentScrollTop - lastObservedScrollTop;
      lastObservedScrollTop = currentScrollTop;
      if (pointerScrollActive && delta !== 0) {
        historyPageBudget.recordInput({ direction: Math.sign(delta), newGesture: pointerGesturePending });
        pointerGesturePending = false;
      }
      const atBottom = checkIfAtBottom();
      const following = resolveTranscriptUserFollow({
        following: wasFollowing,
        atBottom,
        userScroll: userScrollInteractionActive,
      });
      autoFollowPaused.value = !following;
      isAtBottom.value = following && atBottom;
      virtualTranscriptRef.value?.setBottomFollowEnabled?.(following);
      if (userScrollInteractionActive) scheduleUserScrollInteractionEnd();

      if (userScrollInteractionActive && delta < 0 && containerRef.value) {
        maybeLoadMoreNearTop(
          containerRef.value.scrollTop || 0,
          containerRef.value.clientHeight || 0,
        );
      }
      scheduleResponseNavigationUpdate();
    };

    const scrollToBottom = () => {
      if (autoFollowPaused.value) return;
      virtualTranscriptRef.value?.scrollToBottom?.();
    };

    const scrollToLatest = () => {
      // A search/outline jump owns a detached contiguous window. Returning to
      // latest must first restore the recent tail projection; scrolling the
      // detached window itself to its bottom would still leave newer turns absent.
      virtualTranscriptRef.value?.clearTargetAnchor?.();
      if (store.currentView === 'yeaft') {
        store.showLatestYeaftMessageWindow?.(
          activeYeaftSessionId.value || store.yeaftActiveSessionFilter || null,
          store.currentAgent || null,
        );
      }
      clearUserScrollInteraction();
      resetHistoryPagination();
      if (splitActive.value) {
        readingPaneId = null;
        resumeFollowingAfterSplit = true;
        pauseAutoFollow({ forSplit: true });
      } else resumeAutoFollow();
      Vue.nextTick(() => {
        if (splitActive.value) concurrentTurnsRef.value?.revealLatest?.();
        else scrollToBottom();
      });
    };

    const smartScrollToBottom = () => {
      if (!autoFollowPaused.value) {
        Vue.nextTick(scrollToBottom);
      }
    };

    const autoScrollItemIdentity = (item) => {
      if (!item) return '';
      if (Array.isArray(item.items)) {
        return item.items.map(autoScrollItemIdentity).join(',');
      }
      const msg = item.message || {};
      return [
        item.type || '',
        item.id || '',
        item.atMessageId || '',
        item.turnId || '',
        item.messageId || '',
        item.speakerVpId || '',
        msg.id || '',
        msg.content ? String(msg.content).length : 0,
        item.textContent ? String(item.textContent).length : 0,
        item.isStreaming || msg.isStreaming ? 'streaming' : 'done',
      ].join(':');
    };

    const visibleTranscriptTailSignature = Vue.computed(() => {
      const blocks = messageBlocks.value || [];
      return [
        store.activeConversationId || '',
        activeYeaftSessionId.value || '',
        autoScrollItemIdentity(blocks[blocks.length - 1]),
      ].join('|');
    });

    Vue.watch(
      () => [store.currentConversation, onlineAgents.value.length, authStore.token],
      () => {
        const currentToken = authStore.token || '';
        if (currentToken !== lastWelcomeAuthToken) {
          lastWelcomeAuthToken = currentToken;
          resetWelcomeAgentSetup();
        }
        ensureWelcomeAgentSetup();
      },
      { immediate: true }
    );

    // Transfer the surviving lane's reading position by stable row id. A
    // visible Markdown block is a better anchor than a pixel offset when the
    // same text reflows from a narrow lane to the wider transcript.
    const laneRows = (root) => Array.from(root?.querySelectorAll('.virtual-transcript-item > .message-block > .msg-row, .virtual-transcript-item > .msg-row') || []);
    const markdownBlocks = (row) => Array.from(row.querySelectorAll('.turn-text > *'));
    const captureLaneReadingPosition = (body) => {
      const { top, bottom } = body.getBoundingClientRect();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > top && rect.top < bottom;
      };
      const row = laneRows(body).find(visible);
      if (!row?.dataset.msgId) return null;
      const itemKey = row.closest('.virtual-transcript-item')?.dataset.virtualId;
      if (!itemKey) return null;
      const markdown = markdownBlocks(row);
      const blockIndex = markdown.findIndex(visible);
      const block = markdown[blockIndex];
      const offsetFromTop = (el) => el.getBoundingClientRect().top - top;
      return { itemKey, rowId: row.dataset.msgId, rowOffset: offsetFromTop(row), blockIndex,
        blockPrefix: block?.textContent?.slice(0, 64), blockOffset: block ? offsetFromTop(block) : 0 };
    };
    const restoreLaneReadingPosition = async (position, identity, generation) => {
      await Vue.nextTick();
      const current = () => identity === virtualTranscriptIdentity.value && !splitActive.value
        && generation === readingTransferGeneration && !!virtualTranscriptRef.value;
      if (!current() || !await virtualTranscriptRef.value.scrollToKey(position.itemKey, { align: 'start' }) || !current()) return;
      const findRow = () => laneRows(virtualTranscriptRef.value?.$el).find(el => el.dataset.msgId === position.rowId);
      const findBlock = () => {
        const row = findRow();
        const block = row && markdownBlocks(row)[position.blockIndex];
        return position.blockPrefix && block?.textContent?.startsWith(position.blockPrefix) ? block : null;
      };
      // Streaming may replace the Markdown DOM; resolve the anchor again after
      // measurements instead of pinning a detached paragraph or its old offset.
      if (findBlock()) virtualTranscriptRef.value.anchorTarget(position.itemKey, findBlock, { offset: position.blockOffset });
      else if (findRow()) virtualTranscriptRef.value.anchorTarget(position.itemKey, findRow, { offset: position.rowOffset });
    };

    Vue.watch([virtualTranscriptIdentity, splitActive], ([identity, active], [previousIdentity, wasActive]) => {
      if (active) {
        readingPaneId = null;
        resumeFollowingAfterSplit = (!!previousIdentity && identity !== previousIdentity) || !autoFollowPaused.value;
        pauseAutoFollow({ forSplit: true });
      } else if (wasActive && identity === previousIdentity) {
        const focused = document.activeElement;
        const focusLeavingLane = focused && concurrentTurnsRef.value?.$el?.contains(focused);
        const survivor = currentPendingTurns.value[0];
        const pausedPane = survivor?.userTurnId === readingPaneId
          ? concurrentTurnsRef.value?.pausedPaneBody(readingPaneId) : null;
        const position = pausedPane && captureLaneReadingPosition(pausedPane);
        if (position) void restoreLaneReadingPosition(position, identity, ++readingTransferGeneration);
        else if (resumeFollowingAfterSplit && !pausedPane) {
          resumeAutoFollow();
          smartScrollToBottom();
        }
        readingPaneId = null;
        resumeFollowingAfterSplit = false;
        if (focusLeavingLane) Vue.nextTick(() => {
          // A removed lane (e.g. its Stop button or selected tab) must not
          // strand keyboard focus. Leave the composer/sidebar alone.
          if (identity === virtualTranscriptIdentity.value && !focused.isConnected && document.activeElement === document.body) {
            containerRef.value?.focus({ preventScroll: true });
          }
        });
      }
    }, { immediate: true });
    Vue.watch(visibleTranscriptTailSignature, () => {
      if (!splitActive.value) smartScrollToBottom();
      Vue.nextTick(scheduleResponseNavigationUpdate);
    });
    Vue.watch(previewShowTypingDots, (show) => { if (show && !splitActive.value) smartScrollToBottom(); });
    // Reset local transcript state only when the user actually navigates to a
    // different conversation. Yeaft history loading may replace the transport
    // conversation id while retaining the same Agent + Session identity; using
    // that transient id here would discard a user's paused-follow intent and
    // jump them back to the latest message when loading completes.
    Vue.watch(virtualTranscriptIdentity, () => {
      resetHistoryPagination();
      clearUserScrollInteraction();
      pointerScrollActive = false;
      touchY = null;
      for (const key of Object.keys(assistantTurnActionStates)) delete assistantTurnActionStates[key];
      for (const key of Object.keys(toolExpandStates)) delete toolExpandStates[key];
      for (const key of Object.keys(messageTurnCollapseStates)) delete messageTurnCollapseStates[key];
      if (splitActive.value) pauseAutoFollow({ forSplit: true });
      else resumeAutoFollow();
      Vue.nextTick(() => { if (!splitActive.value) scrollToBottom(); });
    });

    const flashMsgId = Vue.ref(null);
    let flashGeneration = 0;
    const flashMessageRow = (rowId) => {
      const generation = ++flashGeneration;
      flashMsgId.value = rowId;
      setTimeout(() => {
        if (generation === flashGeneration) flashMsgId.value = null;
      }, 1800);
    };

    const jumpToOrigin = async (originMessageId) => {
      if (!originMessageId) return false;
      const block = messageBlocks.value.find(item => item?.originMessageId === originMessageId);
      if (!block?.id) return false;
      activeLongResponseOriginId.value = '';
      pauseAutoFollow();
      const turn = splitActive.value && pendingTurns.value.find(turn => turn.blocks.some(item => item.id === block.id));
      const moved = turn
        ? await concurrentTurnsRef.value?.revealBlock?.(turn.userTurnId, block.id, { align: 'start' })
        : await virtualTranscriptRef.value?.scrollToKey?.(block.id, { align: 'start' });
      if (!moved) return false;
      await Vue.nextTick();
      const rows = containerRef.value?.querySelectorAll?.('[data-msg-id]') || [];
      const row = Array.from(rows).find(el => el?.dataset?.msgId === originMessageId) || null;
      if (!row) return false;
      if (turn) concurrentTurnsRef.value?.anchorRow?.(turn.userTurnId, block.id, row, { align: 'start' });
      else virtualTranscriptRef.value?.anchorTarget?.(block.id, row, { align: 'start' });
      flashMessageRow(originMessageId);
      return true;
    };

    const revealMessage = async (target) => {
      if (!target) return false;
      pauseAutoFollow();
      const revealed = await navigateToPersistedMessage({
        blocks: messageBlocks.value,
        target,
        collapseStates: messageTurnCollapseStates,
        nextTick: Vue.nextTick,
        scrollToBlock: (blockId, options) => {
          pauseAutoFollow();
          const turn = pendingTurns.value.find(turn => turn.blocks.some(block => block.id === blockId));
          if (splitActive.value && turn) return concurrentTurnsRef.value?.revealBlock?.(turn.userTurnId, blockId, options);
          return virtualTranscriptRef.value?.scrollToKey?.(blockId, options);
        },
        findRow: (rowId) => {
          const rows = containerRef.value?.querySelectorAll?.('[data-msg-id]') || [];
          return Array.from(rows).find(el => el?.dataset?.msgId === rowId) || null;
        },
        anchorRow: (blockId, _rowId, row, options) => {
          const turn = splitActive.value && pendingTurns.value.find(turn => turn.blocks.some(block => block.id === blockId));
          if (turn) concurrentTurnsRef.value?.anchorRow?.(turn.userTurnId, blockId, row, options);
          else virtualTranscriptRef.value?.anchorTarget?.(blockId, row, options);
        },
        flashRow: flashMessageRow,
      });
      return revealed;
    };

    expose({ revealMessage });

    Vue.onMounted(() => {
      if (typeof ResizeObserver !== 'undefined') {
        responseNavigationResizeObserver = new ResizeObserver(scheduleResponseNavigationUpdate);
      }
      if (splitActive.value) pauseAutoFollow({ forSplit: true });
      else scrollToBottom();
      Vue.nextTick(scheduleResponseNavigationUpdate);
      if (containerRef.value) {
        containerRef.value.addEventListener('wheel', onWheel, { passive: true });
        containerRef.value.addEventListener('touchstart', onTouchStart, { passive: true });
        containerRef.value.addEventListener('touchmove', onTouchMove, { passive: true });
        containerRef.value.addEventListener('touchend', onTouchEnd, { passive: true });
        containerRef.value.addEventListener('touchcancel', onTouchEnd, { passive: true });
        containerRef.value.addEventListener('pointerdown', onPointerScrollStart, { passive: true });
        containerRef.value.addEventListener('scroll', onScroll);
      }
      window.addEventListener('pointerup', onPointerScrollEnd, { passive: true });
      window.addEventListener('pointercancel', onPointerScrollEnd, { passive: true });
      window.addEventListener('keydown', onScrollKey);
    });

    Vue.onUnmounted(() => {
      if (containerRef.value) {
        containerRef.value.removeEventListener('wheel', onWheel);
        containerRef.value.removeEventListener('touchstart', onTouchStart);
        containerRef.value.removeEventListener('touchmove', onTouchMove);
        containerRef.value.removeEventListener('touchend', onTouchEnd);
        containerRef.value.removeEventListener('touchcancel', onTouchEnd);
        containerRef.value.removeEventListener('pointerdown', onPointerScrollStart);
        containerRef.value.removeEventListener('scroll', onScroll);
      }
      window.removeEventListener('pointerup', onPointerScrollEnd);
      window.removeEventListener('pointercancel', onPointerScrollEnd);
      window.removeEventListener('keydown', onScrollKey);
      if (responseNavigationRafId != null) cancelAnimationFrame(responseNavigationRafId);
      responseNavigationRafId = null;
      responseNavigationResizeObserver?.disconnect();
      responseNavigationResizeObserver = null;
      observedResponseElements.clear();
      resetHistoryPagination();
      clearUserScrollInteraction();
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      if (typingHideTimer) { clearTimeout(typingHideTimer); typingHideTimer = null; }
    });

    const blockRenderContext = Vue.computed(() => ({
      visibleItemsForBlock,
      deleteTurnActionFor: _props.deleteTurnActionFor,
      flashMsgId: flashMsgId.value,
      useImStyleForUser: useImStyleForUser.value,
      toolsInStatus: _props.toolsInStatus,
      hideSpeakerIdentity: _props.hideSpeakerIdentity,
      forkFromTurnEnabled: _props.forkFromTurnEnabled,
      forkFromTurnDisabled: _props.forkFromTurnDisabled,
      forkFromTurnTitle: _props.forkFromTurnTitle,
      nowMs: nowMs.value,
      responseToggleBelongsToItem,
      responseCollapseLabel,
      toggleMessageTurnResponse,
      onOpenTurnDebug,
      assistantTurnActionsExpandedFor,
      toolExpandStates,
      turnUiKey,
      setAssistantTurnActionsExpanded,
      setToolExpanded,
      subAgentCardsForRow,
      showBlockResponseToggle,
      collapsedResponsePreviewSpeaker,
      collapsedResponsePreviewLines
    }));

    return {
      store,
      containerRef,
      virtualTranscriptRef,
      flashMsgId,
      jumpToOrigin,
      hasStreamingMessage,
      nowMs,
      showTypingDots,
      showInitialMessagesLoading,
      showYeaftOlderHistoryLoading,
      showSessionLoadingOverlay,
      initialMessagesLoadingText,
      previewShowTypingDots,
      isPreviewMode,
      waitingStatus,
      animation,
      waitClockKey,
      refreshSession,
      onlineAgents,
      welcomeAgentSecret,
      welcomeSetupLoading,
      welcomeSetupError,
      turnProjection,
      turnGroups,
      messageBlocks,
      historyBlocks, pendingTurns, splitActive, laneWaiting, concurrentTurnsRef, stopUserTurn, onReadPane, blockRenderContext,
      virtualTranscriptIdentity,
      estimateMessageBlockHeight,
      visibleItemsForBlock,
      collapsedResponsePreviewLines,
      collapsedResponsePreviewSpeaker,
      responseToggleBelongsToItem,
      showBlockResponseToggle,
      toggleMessageTurnResponse,
      responseCollapseLabel,
      turnUiKey,
      assistantTurnActionsExpandedFor,
      setAssistantTurnActionsExpanded,
      onOpenTurnDebug,
      toolExpandStates,
      setToolExpanded,
      cardsForRow,
      orphanCards,
      subAgentCardsForRow,
      orphanSubAgentCards,
      useImStyleForUser,
      onClickLoadMore,
      onVirtualTranscriptScrollState,
      isAtBottom,
      activeLongResponseOriginId,
      scrollToLatest,
    };
  }
};
