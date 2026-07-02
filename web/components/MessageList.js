import { useAuthStore } from '../stores/auth.js';
import {
  getAgentInstallCommand,
  getAgentLlmCommand,
  getAgentServiceCommand,
  getServerWsUrl,
} from '../utils/agentSetup.js';
import MessageItem from './MessageItem.js';
import AssistantTurn from './AssistantTurn.js';
import VpTurnBlock from './VpTurnBlock.js';
import VpSpeakerHeader from './VpSpeakerHeader.js';
import ReflectionCard from './ReflectionCard.js';
import SubAgentCard from './SubAgentCard.js';
import UserTurnBlock from './UserTurnBlock.js';
import VirtualTranscript from './VirtualTranscript.js';
import { shouldCloseYeaftVpTurn } from '../stores/helpers/yeaft-turn-boundary.js';
import { estimateVirtualItemHeight } from '../utils/virtual-transcript.js';
import {
  annotateMessageBlocksForResponseCollapse,
  estimateCollapsedMessageBlockHeight,
  visibleItemsForMessageBlock,
} from '../utils/message-turn-collapse.js';
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
  components: { MessageItem, AssistantTurn, VpTurnBlock, VpSpeakerHeader, ReflectionCard, SubAgentCard, UserTurnBlock, VirtualTranscript },
  template: `
    <main class="chat-container" ref="containerRef">
      <!-- Session Loading Overlay - only covers message area -->
      <div class="session-loading-overlay" v-if="showSessionLoadingOverlay">
        <div class="session-loading-content">
          <div class="session-loading-spinner"></div>
          <div class="session-loading-text">{{ store.sessionLoadingText || $t('common.loading') }}</div>
        </div>
      </div>

      <!-- Welcome Screen when no conversation -->
      <div v-if="!store.currentConversation" class="welcome-screen">
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
          <h1 class="welcome-title">Yeaft</h1>
          <p class="welcome-subtitle">{{ $t('welcome.subtitle') }}</p>

          <!-- Agent Status -->
          <div class="welcome-status" v-if="onlineAgents.length > 0">
            <span class="status-dot online"></span>
            <span class="status-text">{{ $t('welcome.agentOnline', { count: onlineAgents.length }) }}</span>
          </div>

          <!-- No agents online -->
          <div class="welcome-section" v-else>
            <div class="welcome-setup-card">
              <div class="welcome-setup-header">
                <div class="welcome-setup-kicker">{{ $t('welcome.setupKicker') }}</div>
                <div class="welcome-setup-title">{{ $t('welcome.setupTitle') }}</div>
                <div class="welcome-setup-desc">{{ $t('welcome.setupDesc') }}</div>
              </div>
              <ol class="welcome-setup-steps">
                <li class="welcome-setup-step">
                  <span class="welcome-setup-step-number">1</span>
                  <div class="welcome-setup-step-body">
                    <div class="welcome-setup-step-title">{{ $t('welcome.setupInstallTitle') }}</div>
                    <div class="welcome-command-row">
                      <code>{{ welcomeInstallCommand }}</code>
                      <button type="button" class="welcome-copy-btn" @click="copyWelcomeCommand(welcomeInstallCommand)">{{ $t('common.copy') }}</button>
                    </div>
                  </div>
                </li>
                <li class="welcome-setup-step">
                  <span class="welcome-setup-step-number">2</span>
                  <div class="welcome-setup-step-body">
                    <div class="welcome-setup-step-title">{{ $t('welcome.setupRunTitle') }}</div>
                    <p class="welcome-setup-step-desc" v-if="welcomeSetupLoading">{{ $t('welcome.setupSecretLoading') }}</p>
                    <p class="welcome-setup-step-desc welcome-setup-error" v-else-if="welcomeSetupError">{{ $t('welcome.setupSecretError') }}</p>
                    <div class="welcome-command-row" v-if="welcomeServiceCommand">
                      <code>{{ welcomeServiceCommand }}</code>
                      <button type="button" class="welcome-copy-btn" @click="copyWelcomeCommand(welcomeServiceCommand)">{{ $t('common.copy') }}</button>
                    </div>
                    <button v-else type="button" class="welcome-btn setup-agent-btn" @click="$emit('open-settings')">
                      {{ $t('welcome.openSecuritySettings') }}
                    </button>
                  </div>
                </li>
                <li class="welcome-setup-step">
                  <span class="welcome-setup-step-number">3</span>
                  <div class="welcome-setup-step-body">
                    <div class="welcome-setup-step-title">{{ $t('welcome.setupCopilotTitle') }}</div>
                    <div class="welcome-command-row">
                      <code>{{ welcomeLlmCommand }}</code>
                      <button type="button" class="welcome-copy-btn" @click="copyWelcomeCommand(welcomeLlmCommand)">{{ $t('common.copy') }}</button>
                    </div>
                  </div>
                </li>
              </ol>
            </div>
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
      <div v-else class="messages">
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
        <div v-else-if="(store.loadingMoreMessages && store.currentView !== 'yeaft') || store.yeaftLoadingMoreHistory" class="loading-more">{{ $t('message.loadingMore') }}</div>
        <div v-else-if="(store.hasMoreMessages && store.currentView !== 'yeaft') || store.yeaftHasMoreHistory || store.hasHiddenYeaftMessages" class="load-more-hint" @click="onClickLoadMore">{{ $t('message.loadMore') }}</div>
        <VirtualTranscript
          :items="messageBlocks"
          :estimate-height="estimateMessageBlockHeight"
          :overscan="1"
          :item-gap="18"
          @scroll-state="onVirtualTranscriptScrollState"
        >
          <template #default="{ item: block }">
          <section
            v-if="block.type === 'message-block'"
            class="message-block"
            :data-vp-id="block.vpId || ''"
            :data-message-id="block.messageId || ''"
          >
            <template v-for="item in visibleItemsForBlock(block)" :key="item.id">
              <!-- task-312: wrapper carries data-msg-id so the Yeaft sidebar
                   jump-to-message feature can scroll/flash a specific row. -->
              <div class="msg-row" :data-msg-id="item.id" :class="{ 'msg-flash': item.id === flashMsgId }">
                <!-- User message in Yeaft group view: render IM-style on the
                     right side via UserTurnBlock (mirror of VpTurnBlock).
                     Outside of group view (legacy 1:1 chat) keep the original
                     MessageItem path so chat-mode is untouched. -->
                <UserTurnBlock
                  v-if="item.type === 'user' && useImStyleForUser"
                  :message="item.message"
                />
                <!-- User / system / error messages: rendered by MessageItem -->
                <MessageItem v-else-if="item.type === 'user' || item.type === 'system' || item.type === 'error'" :message="item.message" />

                <!-- Assistant turn — VP-block redesign (2026-05-08).
                     - Yeaft multi-VP turns (speakerVpId set) -> VpTurnBlock,
                       which renders the VP header plus the full AssistantTurn
                       body. VirtualTranscript handles delayed mounting for
                       off-screen blocks; messages themselves are not collapsed.
                     - Legacy 1:1 Chat turns (no VP attribution) -> plain
                       AssistantTurn unchanged. -->
                <VpTurnBlock
                  v-else-if="item.type === 'assistant-turn' && item.speakerVpId"
                  :turn="item"
                  :now-ms="nowMs"
                />
                <AssistantTurn
                  v-else-if="item.type === 'assistant-turn'"
                  :turn="item"
                  :actions-expanded="assistantTurnActionsExpandedFor(item)"
                  :tool-expand-states="toolExpandStates"
                  :tool-state-prefix="turnUiKey(item)"
                  @update-actions-expanded="value => setAssistantTurnActionsExpanded(item, value)"
                  @update-tool-expanded="setToolExpanded"
                />
              </div>
        <!-- feat-6af5f9f1 PR A: ReflectionCard mounts removed from the
                   main message stream. Reflection is an engine-internal context
                   compaction step - surfacing it inline during normal chat is
                   noise. Cards remain in store.yeaftReflectionCards so the
                   debug panel (PR B) can render them under the loop they
                   summarize. The component is still imported because PR B
                   will reuse it inside YeaftDebugPanel. -->
              <!-- PR-M3: sub-agent cards anchored to this row. -->
              <SubAgentCard
                v-for="card in subAgentCardsForRow(item)"
                :key="card.key"
                :card="card"
              />
            </template>
            <button
              v-if="block.responseCollapsible"
              type="button"
              class="message-turn-collapse-toggle"
              :class="{ 'is-collapsed': block.responseCollapsed }"
              @click="toggleMessageTurnResponse(block)"
              :aria-expanded="String(!block.responseCollapsed)"
            >
              <span>{{ responseCollapseLabel(block) }}</span>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path v-if="block.responseCollapsed" fill="currentColor" d="M7 10l5 5 5-5z"/>
                <path v-else fill="currentColor" d="M7 14l5-5 5 5z"/>
              </svg>
            </button>
          </section>
          <template v-else>
            <div class="msg-row" :data-msg-id="block.id" :class="{ 'msg-flash': block.id === flashMsgId }">
              <UserTurnBlock
                v-if="block.type === 'user' && useImStyleForUser"
                :message="block.message"
              />
              <MessageItem v-else-if="block.type === 'user' || block.type === 'system' || block.type === 'error'" :message="block.message" />
              <VpTurnBlock
                v-else-if="block.type === 'assistant-turn' && block.speakerVpId"
                :turn="block"
                :now-ms="nowMs"
              />
              <AssistantTurn
                v-else-if="block.type === 'assistant-turn'"
                :turn="block"
                :actions-expanded="assistantTurnActionsExpandedFor(block)"
                :tool-expand-states="toolExpandStates"
                :tool-state-prefix="turnUiKey(block)"
                @update-actions-expanded="value => setAssistantTurnActionsExpanded(block, value)"
                @update-tool-expanded="setToolExpanded"
              />
            </div>
            <SubAgentCard
              v-for="card in subAgentCardsForRow(block)"
              :key="card.key"
              :card="card"
            />
          </template>
        </template>
        </VirtualTranscript>
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
        <!-- Typing dots: visible when processing but not streaming text -->
        <div v-if="previewShowTypingDots" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
          <span></span><span></span><span></span>
          <template v-if="animationType === 'cat'">
          <span class="svg-cat-walk" :style="catStyle">
          <span class="svg-running-cat" :class="catSpeed" aria-hidden="true">
            <svg viewBox="0 0 36 28" xmlns="http://www.w3.org/2000/svg">
              <!-- Silhouette group: single opacity prevents overlap darkening -->
              <g class="svg-cat-silhouette">
                <!-- Tail — starts at body edge for seamless connection -->
                <g class="svg-cat-tail-group">
                  <path class="svg-cat-tail" d="M7.5 17 Q3 12 4 6 Q4.5 3 6 5" stroke-width="2"/>
                </g>
                <!-- Back legs -->
                <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 20 L8 25 Q8 26.5 9.5 26.5 L10.5 26.5" stroke-width="0"/></g>
                <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 20 L6 25 Q6 26.5 7.5 26.5 L8.5 26.5" stroke-width="0"/></g>
                <!-- Body -->
                <ellipse class="svg-cat-body" cx="15" cy="17" rx="7.5" ry="5"/>
                <!-- Front legs -->
                <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M21 20 L23 25 Q23 26.5 21.5 26.5 L20.5 26.5" stroke-width="0"/></g>
                <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M19 20 L21 25 Q21 26.5 19.5 26.5 L18.5 26.5" stroke-width="0"/></g>
                <!-- Head group: contains head + face so tired animation moves everything together -->
                <g class="svg-cat-head-group">
                  <circle class="svg-cat-head" cx="24" cy="9" r="7"/>
                  <!-- Ears -->
                  <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="18,7 20,-1 23,6"/></g>
                  <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 28,-1 30,7"/></g>
                  <!-- Face details (inside head group so they follow head movement) -->
                  <polygon class="svg-cat-inner-ear" points="19,6.5 20.5,0.5 22,5.5"/>
                  <polygon class="svg-cat-inner-ear" points="26,5.5 27.5,0.5 29,6.5"/>
                  <ellipse class="svg-cat-eye" cx="21.5" cy="8.5" rx="2" ry="2.2"/>
                  <ellipse class="svg-cat-eye" cx="27" cy="8.5" rx="2" ry="2.2"/>
                  <ellipse class="svg-cat-pupil" cx="22" cy="8.8" rx="1.1" ry="1.3"/>
                  <ellipse class="svg-cat-pupil" cx="27.5" cy="8.8" rx="1.1" ry="1.3"/>
                  <circle class="svg-cat-eye-shine" cx="21.2" cy="7.8" r="0.6"/>
                  <circle class="svg-cat-eye-shine" cx="26.7" cy="7.8" r="0.6"/>
                  <!-- Closed happy eyes — curved ∪ lines, only visible in petted mode -->
                  <path class="svg-cat-closed-eye" d="M19.8 8.5 Q21.5 10.5 23.2 8.5" stroke-width="0.8" fill="none"/>
                  <path class="svg-cat-closed-eye" d="M25.3 8.5 Q27 10.5 28.7 8.5" stroke-width="0.8" fill="none"/>
                  <path class="svg-cat-nose" d="M23.5 11.5 L24.2 12.2 L25 11.5 Z"/>
                  <path class="svg-cat-mouth" d="M23 12.5 Q24.2 13.8 24.2 12.5" stroke-width="0.7"/>
                  <path class="svg-cat-mouth" d="M24.3 12.5 Q24.3 13.8 25.5 12.5" stroke-width="0.7"/>
                  <line class="svg-cat-whisker" x1="19.5" y1="11" x2="14" y2="10" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="19.5" y1="12" x2="14" y2="12.5" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="29" y1="11" x2="34" y2="10" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="29" y1="12" x2="34" y2="12.5" stroke-width="0.5"/>
                  <!-- Breath puffs — only visible in tired mode -->
                  <circle class="svg-cat-breath svg-cat-breath-1" cx="27" cy="14" r="0.8"/>
                  <circle class="svg-cat-breath svg-cat-breath-2" cx="28" cy="13.5" r="0.6"/>
                  <circle class="svg-cat-breath svg-cat-breath-3" cx="29" cy="14.5" r="0.5"/>
                </g>
              </g>
              <!-- Blur legs (outside silhouette — has own opacity control) -->
              <ellipse class="svg-cat-leg-blur" cx="12.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur" cx="17.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="14" cy="22" rx="1.5" ry="1"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="16" cy="22" rx="1.5" ry="1"/>
              <!-- Petting hand — only visible in speed-petted mode -->
              <g class="svg-cat-petting-hand">
                <line class="svg-cat-hand-arm" x1="24" y1="-3" x2="24" y2="0" stroke-width="2.5" stroke-linecap="round"/>
                <ellipse class="svg-cat-hand-palm" cx="24" cy="1.5" rx="3.5" ry="2"/>
                <ellipse class="svg-cat-finger" cx="21.5" cy="3.2" rx="0.9" ry="1.2"/>
                <ellipse class="svg-cat-finger" cx="24" cy="3.5" rx="0.9" ry="1.3"/>
                <ellipse class="svg-cat-finger" cx="26.5" cy="3.2" rx="0.9" ry="1.2"/>
              </g>
              <!-- Napping bed — soft oval cushion, only visible in napping mode -->
              <ellipse class="svg-cat-bed" cx="15" cy="24" rx="12" ry="3"/>
              <!-- Drool — tiny droplet near mouth, only visible in napping mode -->
              <circle class="svg-cat-drool" cx="26.5" cy="14" r="0.6"/>
            </svg>
          </span>
          </span>
          </template>
          <template v-else>
          <span class="svg-dog-scene" :class="'dog-phase-' + dogPhase" aria-hidden="true">
            <svg viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg">
              <!-- Left post -->
              <rect class="svg-dog-post" x="1" y="18" width="2" height="8" rx="0.5"/>
              <!-- Left leash (Spike) -->
              <path class="svg-dog-leash svg-dog-leash-l" :d="leashPathL" stroke-width="0.8" :style="{ opacity: leashOpacityL }"/>
              <!-- Left snap FX (at left post) -->
              <g class="svg-dog-snap-fx" :style="{ transformOrigin: '3px 20px' }">
                <line class="svg-dog-snap-line" x1="0" y1="16" x2="6" y2="24"/>
                <line class="svg-dog-snap-line" x1="6" y1="16" x2="0" y2="24"/>
              </g>
              <!-- Spike (left, big dog) -->
              <g :transform="spikeTransform">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group" style="transform-origin: -1px 13px"><path class="svg-dog-tail" d="M-1 13 Q-3 9 -1 6" stroke-width="2.2"/></g>
                  <g class="svg-dog-leg-bl" style="transform-origin: 2px 18px"><path class="svg-dog-leg" d="M2 18 L1 24 Q1 25.5 2.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br" style="transform-origin: 4px 18px"><path class="svg-dog-leg" d="M4 18 L3 24 Q3 25.5 4.5 25.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="8" cy="14" rx="7" ry="5"/>
                  <g class="svg-dog-leg-fl" style="transform-origin: 13px 18px"><path class="svg-dog-leg" d="M13 18 L14 24 Q14 25.5 12.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr" style="transform-origin: 11px 18px"><path class="svg-dog-leg" d="M11 18 L12 24 Q12 25.5 10.5 25.5" stroke-width="0"/></g>
                  <rect class="svg-dog-collar" x="12" y="9.5" width="3.5" height="2" rx="0.5"/>
                  <polygon class="svg-dog-spike-stud" points="13,9.5 13.4,8.5 13.8,9.5"/>
                  <polygon class="svg-dog-spike-stud" points="14.5,9.5 14.9,8.5 15.3,9.5"/>
                  <g class="svg-dog-head-group">
                    <circle class="svg-dog-head" cx="16" cy="7" r="5.5"/>
                    <polygon class="svg-dog-ear svg-dog-ear-l" points="11.5,5 13,-2 15,4"/>
                    <polygon class="svg-dog-ear svg-dog-ear-r" points="17,4 19,-2 20.5,5"/>
                    <ellipse class="svg-dog-jaw" cx="17" cy="11.5" rx="3" ry="1.8"/>
                    <ellipse class="svg-dog-eye" cx="14" cy="6.5" rx="1.5" ry="1.6"/>
                    <ellipse class="svg-dog-eye" cx="18.5" cy="6.5" rx="1.5" ry="1.6"/>
                    <ellipse class="svg-dog-pupil" cx="14.5" cy="6.8" rx="0.7" ry="0.9"/>
                    <ellipse class="svg-dog-pupil" cx="19" cy="6.8" rx="0.7" ry="0.9"/>
                    <circle class="svg-dog-eye-shine" cx="13.8" cy="6" r="0.4"/>
                    <circle class="svg-dog-eye-shine" cx="18.3" cy="6" r="0.4"/>
                    <ellipse class="svg-dog-nose" cx="17" cy="9.5" rx="1.5" ry="1"/>
                    <path class="svg-dog-mouth" d="M15 10.5 Q17 11.5 19 10.5" stroke-width="0.6"/>
                    <ellipse class="svg-dog-bark-mouth" cx="17" cy="12" rx="2.5" ry="1.5"/>
                    <ellipse class="svg-dog-tongue" cx="17" cy="13" rx="1" ry="0.7"/>
                  </g>
                </g>
              </g>
              <!-- Right post -->
              <rect class="svg-dog-post" x="117" y="18" width="2" height="8" rx="0.5"/>
              <!-- Right leash (Teddy) -->
              <path class="svg-dog-leash svg-dog-leash-r" :d="leashPathR" stroke-width="0.8" :style="{ opacity: leashOpacityR }"/>
              <!-- Right snap FX (at right post) -->
              <g class="svg-dog-snap-fx" :style="{ transformOrigin: '118px 20px' }">
                <line class="svg-dog-snap-line" x1="115" y1="16" x2="121" y2="24"/>
                <line class="svg-dog-snap-line" x1="121" y1="16" x2="115" y2="24"/>
              </g>
              <!-- Teddy (right, small dog) -->
              <g :transform="teddyTransform">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group" style="transform-origin: -1px 11px"><path class="svg-dog-tail" d="M-1 11 Q-3 7 -1 5 Q1 3 0 6" stroke-width="1.5"/></g>
                  <g class="svg-dog-leg-bl" style="transform-origin: 2px 14px"><path class="svg-dog-leg" d="M2 14 L1.5 22 Q1.5 23.5 3 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br" style="transform-origin: 3.5px 14px"><path class="svg-dog-leg" d="M3.5 14 L3 22 Q3 23.5 4.5 23.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="6" cy="12" rx="5" ry="3.5"/>
                  <g class="svg-dog-leg-fl" style="transform-origin: 10px 14px"><path class="svg-dog-leg" d="M10 14 L10.5 22 Q10.5 23.5 9 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr" style="transform-origin: 8.5px 14px"><path class="svg-dog-leg" d="M8.5 14 L9 22 Q9 23.5 7.5 23.5" stroke-width="0"/></g>
                  <rect class="svg-dog-collar" x="9.5" y="7.5" width="2.5" height="1.5" rx="0.5"/>
                  <g class="svg-dog-head-group">
                    <circle class="svg-dog-head" cx="12.5" cy="5.5" r="5"/>
                    <circle class="svg-dog-fluff" cx="12.5" cy="4.5" r="5.5"/>
                    <ellipse class="svg-dog-ear svg-dog-ear-l" cx="8.5" cy="6.5" rx="2" ry="3"/>
                    <ellipse class="svg-dog-ear svg-dog-ear-r" cx="16.5" cy="6.5" rx="2" ry="3"/>
                    <ellipse class="svg-dog-eye" cx="10.5" cy="5" rx="1.8" ry="2"/>
                    <ellipse class="svg-dog-eye" cx="15" cy="5" rx="1.8" ry="2"/>
                    <ellipse class="svg-dog-pupil" cx="11" cy="5.3" rx="0.9" ry="1.1"/>
                    <ellipse class="svg-dog-pupil" cx="15.5" cy="5.3" rx="0.9" ry="1.1"/>
                    <circle class="svg-dog-eye-shine" cx="10.3" cy="4.5" r="0.5"/>
                    <circle class="svg-dog-eye-shine" cx="14.8" cy="4.5" r="0.5"/>
                    <ellipse class="svg-dog-nose" cx="12.8" cy="7.5" rx="1" ry="0.7"/>
                    <path class="svg-dog-mouth" d="M11.5 8.3 Q12.8 9 14 8.3" stroke-width="0.5"/>
                    <ellipse class="svg-dog-bark-mouth" cx="12.8" cy="9.5" rx="2" ry="1.2"/>
                    <ellipse class="svg-dog-tongue" cx="12.8" cy="10.3" rx="0.8" ry="0.5"/>
                  </g>
                </g>
              </g>
              <!-- Question marks (stunned phase) -->
              <text class="svg-dog-question svg-dog-question-l" :x="questionLX" y="4" font-size="6">?</text>
              <text class="svg-dog-question svg-dog-question-r" :x="questionRX" y="4" font-size="6">?</text>
            </svg>
          </span>
          </template>
        </div>
      </div>

      <!-- Preview mode: standalone typing indicator when no conversation -->
      <div v-if="isPreviewMode && !store.currentConversation" class="typing-indicator preview-animation-indicator" style="position: fixed; bottom: 100px; left: 0; right: 0; padding: 16px 24px; z-index: 100;">
        <span></span><span></span><span></span>
        <template v-if="animationType === 'cat'">
        <span class="svg-cat-walk" :style="catStyle">
        <span class="svg-running-cat" :class="catSpeed" aria-hidden="true">
          <svg viewBox="0 0 36 28" xmlns="http://www.w3.org/2000/svg">
            <g class="svg-cat-silhouette">
              <g class="svg-cat-tail-group">
                <path class="svg-cat-tail" d="M7.5 17 Q3 12 4 6 Q4.5 3 6 5" stroke-width="2"/>
              </g>
              <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 20 L8 25 Q8 26.5 9.5 26.5 L10.5 26.5" stroke-width="0"/></g>
              <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 20 L6 25 Q6 26.5 7.5 26.5 L8.5 26.5" stroke-width="0"/></g>
              <ellipse class="svg-cat-body" cx="15" cy="17" rx="7.5" ry="5"/>
              <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M21 20 L23 25 Q23 26.5 21.5 26.5 L20.5 26.5" stroke-width="0"/></g>
              <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M19 20 L21 25 Q21 26.5 19.5 26.5 L18.5 26.5" stroke-width="0"/></g>
              <g class="svg-cat-head-group">
                <circle class="svg-cat-head" cx="24" cy="9" r="7"/>
                <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="18,7 20,-1 23,6"/></g>
                <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 28,-1 30,7"/></g>
                <polygon class="svg-cat-inner-ear" points="19,6.5 20.5,0.5 22,5.5"/>
                <polygon class="svg-cat-inner-ear" points="26,5.5 27.5,0.5 29,6.5"/>
                <ellipse class="svg-cat-eye" cx="21.5" cy="8.5" rx="2" ry="2.2"/>
                <ellipse class="svg-cat-eye" cx="27" cy="8.5" rx="2" ry="2.2"/>
                <ellipse class="svg-cat-pupil" cx="22" cy="8.8" rx="1.1" ry="1.3"/>
                <ellipse class="svg-cat-pupil" cx="27.5" cy="8.8" rx="1.1" ry="1.3"/>
                <circle class="svg-cat-eye-shine" cx="21.2" cy="7.8" r="0.6"/>
                <circle class="svg-cat-eye-shine" cx="26.7" cy="7.8" r="0.6"/>
                <path class="svg-cat-closed-eye" d="M19.8 8.5 Q21.5 10.5 23.2 8.5" stroke-width="0.8" fill="none"/>
                <path class="svg-cat-closed-eye" d="M25.3 8.5 Q27 10.5 28.7 8.5" stroke-width="0.8" fill="none"/>
                <path class="svg-cat-nose" d="M23.5 11.5 L24.2 12.2 L25 11.5 Z"/>
                <path class="svg-cat-mouth" d="M23 12.5 Q24.2 13.8 24.2 12.5" stroke-width="0.7"/>
                <path class="svg-cat-mouth" d="M24.3 12.5 Q24.3 13.8 25.5 12.5" stroke-width="0.7"/>
                <line class="svg-cat-whisker" x1="19.5" y1="11" x2="14" y2="10" stroke-width="0.5"/>
                <line class="svg-cat-whisker" x1="19.5" y1="12" x2="14" y2="12.5" stroke-width="0.5"/>
                <line class="svg-cat-whisker" x1="29" y1="11" x2="34" y2="10" stroke-width="0.5"/>
                <line class="svg-cat-whisker" x1="29" y1="12" x2="34" y2="12.5" stroke-width="0.5"/>
                <circle class="svg-cat-breath svg-cat-breath-1" cx="27" cy="14" r="0.8"/>
                <circle class="svg-cat-breath svg-cat-breath-2" cx="28" cy="13.5" r="0.6"/>
                <circle class="svg-cat-breath svg-cat-breath-3" cx="29" cy="14.5" r="0.5"/>
              </g>
            </g>
            <ellipse class="svg-cat-leg-blur" cx="12.5" cy="22" rx="1.8" ry="1.2"/>
            <ellipse class="svg-cat-leg-blur" cx="17.5" cy="22" rx="1.8" ry="1.2"/>
            <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="14" cy="22" rx="1.5" ry="1"/>
            <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="16" cy="22" rx="1.5" ry="1"/>
            <g class="svg-cat-petting-hand">
              <line class="svg-cat-hand-arm" x1="24" y1="-3" x2="24" y2="0" stroke-width="2.5" stroke-linecap="round"/>
              <ellipse class="svg-cat-hand-palm" cx="24" cy="1.5" rx="3.5" ry="2"/>
              <ellipse class="svg-cat-finger" cx="21.5" cy="3.2" rx="0.9" ry="1.2"/>
              <ellipse class="svg-cat-finger" cx="24" cy="3.5" rx="0.9" ry="1.3"/>
              <ellipse class="svg-cat-finger" cx="26.5" cy="3.2" rx="0.9" ry="1.2"/>
            </g>
            <ellipse class="svg-cat-bed" cx="15" cy="24" rx="12" ry="3"/>
            <circle class="svg-cat-drool" cx="26.5" cy="14" r="0.6"/>
          </svg>
        </span>
        </span>
        </template>
        <template v-else>
        <span class="svg-dog-scene" :class="'dog-phase-' + dogPhase" aria-hidden="true">
          <svg viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg">
            <rect class="svg-dog-post" x="1" y="18" width="2" height="8" rx="0.5"/>
            <path class="svg-dog-leash svg-dog-leash-l" :d="leashPathL" stroke-width="0.8" :style="{ opacity: leashOpacityL }"/>
            <g class="svg-dog-snap-fx" :style="{ transformOrigin: '3px 20px' }">
              <line class="svg-dog-snap-line" x1="0" y1="16" x2="6" y2="24"/>
              <line class="svg-dog-snap-line" x1="6" y1="16" x2="0" y2="24"/>
            </g>
            <g :transform="spikeTransform">
              <g class="svg-dog-silhouette">
                <g class="svg-dog-tail-group" style="transform-origin: -1px 13px"><path class="svg-dog-tail" d="M-1 13 Q-3 9 -1 6" stroke-width="2.2"/></g>
                <g class="svg-dog-leg-bl" style="transform-origin: 2px 18px"><path class="svg-dog-leg" d="M2 18 L1 24 Q1 25.5 2.5 25.5" stroke-width="0"/></g>
                <g class="svg-dog-leg-br" style="transform-origin: 4px 18px"><path class="svg-dog-leg" d="M4 18 L3 24 Q3 25.5 4.5 25.5" stroke-width="0"/></g>
                <ellipse class="svg-dog-body" cx="8" cy="14" rx="7" ry="5"/>
                <g class="svg-dog-leg-fl" style="transform-origin: 13px 18px"><path class="svg-dog-leg" d="M13 18 L14 24 Q14 25.5 12.5 25.5" stroke-width="0"/></g>
                <g class="svg-dog-leg-fr" style="transform-origin: 11px 18px"><path class="svg-dog-leg" d="M11 18 L12 24 Q12 25.5 10.5 25.5" stroke-width="0"/></g>
                <rect class="svg-dog-collar" x="12" y="9.5" width="3.5" height="2" rx="0.5"/>
                <polygon class="svg-dog-spike-stud" points="13,9.5 13.4,8.5 13.8,9.5"/>
                <polygon class="svg-dog-spike-stud" points="14.5,9.5 14.9,8.5 15.3,9.5"/>
                <g class="svg-dog-head-group">
                  <circle class="svg-dog-head" cx="16" cy="7" r="5.5"/>
                  <polygon class="svg-dog-ear svg-dog-ear-l" points="11.5,5 13,-2 15,4"/>
                  <polygon class="svg-dog-ear svg-dog-ear-r" points="17,4 19,-2 20.5,5"/>
                  <ellipse class="svg-dog-jaw" cx="17" cy="11.5" rx="3" ry="1.8"/>
                  <ellipse class="svg-dog-eye" cx="14" cy="6.5" rx="1.5" ry="1.6"/>
                  <ellipse class="svg-dog-eye" cx="18.5" cy="6.5" rx="1.5" ry="1.6"/>
                  <ellipse class="svg-dog-pupil" cx="14.5" cy="6.8" rx="0.7" ry="0.9"/>
                  <ellipse class="svg-dog-pupil" cx="19" cy="6.8" rx="0.7" ry="0.9"/>
                  <circle class="svg-dog-eye-shine" cx="13.8" cy="6" r="0.4"/>
                  <circle class="svg-dog-eye-shine" cx="18.3" cy="6" r="0.4"/>
                  <ellipse class="svg-dog-nose" cx="17" cy="9.5" rx="1.5" ry="1"/>
                  <path class="svg-dog-mouth" d="M15 10.5 Q17 11.5 19 10.5" stroke-width="0.6"/>
                  <ellipse class="svg-dog-bark-mouth" cx="17" cy="12" rx="2.5" ry="1.5"/>
                  <ellipse class="svg-dog-tongue" cx="17" cy="13" rx="1" ry="0.7"/>
                </g>
              </g>
            </g>
            <rect class="svg-dog-post" x="117" y="18" width="2" height="8" rx="0.5"/>
            <path class="svg-dog-leash svg-dog-leash-r" :d="leashPathR" stroke-width="0.8" :style="{ opacity: leashOpacityR }"/>
            <g class="svg-dog-snap-fx" :style="{ transformOrigin: '118px 20px' }">
              <line class="svg-dog-snap-line" x1="115" y1="16" x2="121" y2="24"/>
              <line class="svg-dog-snap-line" x1="121" y1="16" x2="115" y2="24"/>
            </g>
            <g :transform="teddyTransform">
              <g class="svg-dog-silhouette">
                <g class="svg-dog-tail-group" style="transform-origin: -1px 11px"><path class="svg-dog-tail" d="M-1 11 Q-3 7 -1 5 Q1 3 0 6" stroke-width="1.5"/></g>
                <g class="svg-dog-leg-bl" style="transform-origin: 2px 14px"><path class="svg-dog-leg" d="M2 14 L1.5 22 Q1.5 23.5 3 23.5" stroke-width="0"/></g>
                <g class="svg-dog-leg-br" style="transform-origin: 3.5px 14px"><path class="svg-dog-leg" d="M3.5 14 L3 22 Q3 23.5 4.5 23.5" stroke-width="0"/></g>
                <ellipse class="svg-dog-body" cx="6" cy="12" rx="5" ry="3.5"/>
                <g class="svg-dog-leg-fl" style="transform-origin: 10px 14px"><path class="svg-dog-leg" d="M10 14 L10.5 22 Q10.5 23.5 9 23.5" stroke-width="0"/></g>
                <g class="svg-dog-leg-fr" style="transform-origin: 8.5px 14px"><path class="svg-dog-leg" d="M8.5 14 L9 22 Q9 23.5 7.5 23.5" stroke-width="0"/></g>
                <rect class="svg-dog-collar" x="9.5" y="7.5" width="2.5" height="1.5" rx="0.5"/>
                <g class="svg-dog-head-group">
                  <circle class="svg-dog-head" cx="12.5" cy="5.5" r="5"/>
                  <circle class="svg-dog-fluff" cx="12.5" cy="4.5" r="5.5"/>
                  <ellipse class="svg-dog-ear svg-dog-ear-l" cx="8.5" cy="6.5" rx="2" ry="3"/>
                  <ellipse class="svg-dog-ear svg-dog-ear-r" cx="16.5" cy="6.5" rx="2" ry="3"/>
                  <ellipse class="svg-dog-eye" cx="10.5" cy="5" rx="1.8" ry="2"/>
                  <ellipse class="svg-dog-eye" cx="15" cy="5" rx="1.8" ry="2"/>
                  <ellipse class="svg-dog-pupil" cx="11" cy="5.3" rx="0.9" ry="1.1"/>
                  <ellipse class="svg-dog-pupil" cx="15.5" cy="5.3" rx="0.9" ry="1.1"/>
                  <circle class="svg-dog-eye-shine" cx="10.3" cy="4.5" r="0.5"/>
                  <circle class="svg-dog-eye-shine" cx="14.8" cy="4.5" r="0.5"/>
                  <ellipse class="svg-dog-nose" cx="12.8" cy="7.5" rx="1" ry="0.7"/>
                  <path class="svg-dog-mouth" d="M11.5 8.3 Q12.8 9 14 8.3" stroke-width="0.5"/>
                  <ellipse class="svg-dog-bark-mouth" cx="12.8" cy="9.5" rx="2" ry="1.2"/>
                  <ellipse class="svg-dog-tongue" cx="12.8" cy="10.3" rx="0.8" ry="0.5"/>
                </g>
              </g>
            </g>
            <text class="svg-dog-question svg-dog-question-l" :x="questionLX" y="4" font-size="6">?</text>
            <text class="svg-dog-question svg-dog-question-r" :x="questionRX" y="4" font-size="6">?</text>
          </svg>
        </span>
        </template>
      </div>

      <button type="button" class="scroll-to-latest" :class="{ 'is-hidden': isAtBottom }" @click="scrollToLatest">
        {{ $t('message.scrollToLatest') }}
      </button>
    </main>
  `,
  emits: ['new-conversation', 'resume-conversation', 'open-settings'],
  setup() {
    const store = Pinia.useChatStore();
    const authStore = useAuthStore();
    const t = Vue.inject('t', null);
    const containerRef = Vue.ref(null);
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
    const setToolExpanded = ({ key, value } = {}) => {
      if (!key) return;
      toolExpandStates[key] = !!value;
    };
    const estimateMessageBlockHeight = (block) => {
      const collapsedHeight = estimateCollapsedMessageBlockHeight(block, estimateVirtualItemHeight);
      return Number.isFinite(collapsedHeight) ? collapsedHeight : estimateVirtualItemHeight(block);
    };
    const visibleItemsForBlock = (block) => visibleItemsForMessageBlock(block);
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

    const welcomeProfile = Vue.ref(null);
    const welcomeAgentSecret = Vue.ref(null);
    const welcomeSetupLoading = Vue.ref(false);
    const welcomeSetupError = Vue.ref('');
    let welcomeSetupPromise = null;
    let welcomeSetupRequestSeq = 0;
    let lastWelcomeAuthToken = authStore.token || '';

    const resetWelcomeAgentSetup = () => {
      welcomeProfile.value = null;
      welcomeAgentSecret.value = null;
      welcomeSetupError.value = '';
      welcomeSetupPromise = null;
      welcomeSetupRequestSeq += 1;
    };

    const welcomeInstallCommand = getAgentInstallCommand();
    const welcomeLlmCommand = getAgentLlmCommand();
    const welcomeServiceCommand = Vue.computed(() => getAgentServiceCommand({
      profile: welcomeProfile.value,
      agentSecret: welcomeAgentSecret.value,
      serverWsUrl: getServerWsUrl(location),
    }));

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
        const [profileRes, secretRes] = await Promise.all([
          fetch('/api/user/profile', { headers }),
          fetch('/api/user/agent-secret', { headers }),
        ]);
        const profileData = profileRes.ok ? await profileRes.json() : null;
        if (requestSeq !== welcomeSetupRequestSeq || requestToken !== (authStore.token || '')) return;
        if (profileData) welcomeProfile.value = profileData;
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

    const copyWelcomeCommand = async (text) => {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch (err) { console.warn('Failed to copy welcome setup command:', err); }
    };

    const messageBlockMetaForItem = (item, index) => {
      const msg = item?.message || null;
      const messageId = item?.id
        || item?.atMessageId
        || msg?.id
        || msg?.messageId
        || `legacy_${index}`;
      const vpId = item?.speakerVpId
        || item?.vpId
        || msg?.speakerVpId
        || msg?.vpId
        || '';
      return {
        id: `message_${vpId || 'user'}_${messageId}_${index}`,
        vpId,
        messageId,
      };
    };

    // Turn aggregation: group flat messages into turn groups
    const turnGroups = Vue.computed(() => {
      const messages = store.messages;
      const result = [];
      let currentTurn = null;
      let turnCounter = 0;
      // task-708: every VP-attributed turn carries its own avatar header.
      // The previous "consecutive-same-speaker collapse" (Slack-style)
      // produced the user's "VP disappears" complaint — when a VP sent
      // back-to-back turns, the second turn rendered without an avatar
      // because we suppressed the header. The pure helper at
      // `web/stores/helpers/turn-groups.js` already always shows the
      // header per VP turn; this inline aggregator now matches it.

      const finishTurn = () => {
        if (currentTurn) {
          // Has the VP produced anything the user/group can see?
          // Tools are NOT user-visible content — they're internal
          // activity. A route_forward call shows up as a tool chip
          // (ToolLine renders the `Route @target: text` line), so
          // forward-only turns still pass through the `hasTools`
          // gate without a separate handoff pill.
          const hasVisible = !!(
            currentTurn.textContent
            || currentTurn.todoMsg
            || currentTurn.askMsg
            || currentTurn.imageMsgs.length > 0
          );
          const hasTools = currentTurn.toolMsgs.length > 0 || currentTurn.toolSummaryCount > 0;

          // Push the turn if it produced ANY surface (visible content
          // or tools). Empty turns (nothing at all) are still skipped —
          // they're created when latch helpers ran but no message body
          // ever attached.
          if (hasVisible || hasTools) {
            // task-708: render the speaker header on every VP-attributed
            // turn. The avatar (with its inline typing badge) is THE
            // surface that signals which VP is speaking + whether they
            // are still typing — collapsing it on consecutive turns
            // reads as "the VP disappeared", which is exactly the bug
            // the user reported "无数遍".
            currentTurn.showSpeakerHeader = !!currentTurn.speakerVpId;
            result.push(currentTurn);
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

      const startTurn = () => {
        turnCounter++;
        currentTurn = {
          type: 'assistant-turn',
          id: 'turn_' + turnCounter,
          textContent: '',
          isStreaming: false,
          isHistory: false,
          todoMsg: null,
          toolMsgs: [],
          toolSummaryCount: 0,
          imageMsgs: [],
          askMsg: null,
          messages: [],
          // task-314: persisted message id (`m{NNNN}`) for the last
          // assistant chunk in this turn — used as the fork cursor when
          // the user clicks "Fork from here".
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
          result.push({ type: 'user', id: msg.id || 'u_' + i, message: msg });
          continue;
        }

        if (msg.type === 'system' || msg.type === 'error') {
          finishTurn();
          result.push({ type: msg.type, id: msg.id || 's_' + i, message: msg });
          continue;
        }

        // tool-result: skip (merged into tool-use)
        if (msg.type === 'tool-result' || msg.type === 'tool_result') {
          continue;
        }

        if (msg.type === 'tool-summary') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn();
          latchSpeakerFromMsg(msg);
          if (msg.isHistory) currentTurn.isHistory = true;
          currentTurn.toolSummaryCount += Number(msg.count || msg.omittedCount || 0) || 0;
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'assistant') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn();
          if (msg.content) {
            currentTurn.textContent += msg.content;
          }
          if (msg.isStreaming) {
            currentTurn.isStreaming = true;
          }
          if (msg.isHistory) {
            currentTurn.isHistory = true;
          }
          // task-314: remember the persisted message id for this turn so a
          // "Fork from here" click can tell the agent which message to cut
          // at. We latch the LAST assistant message id — forking from the
          // turn cuts after the full assistant reply has been received.
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
          if (!currentTurn) startTurn();
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
          } else if (msg.toolName === 'AskUserQuestion') {
            currentTurn.askMsg = toolEntry;
          } else {
            currentTurn.toolMsgs.push(toolEntry);
          }
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'chat-image') {
          closeTurnIfTurnBoundaryChanged(msg);
          if (!currentTurn) startTurn();
          latchSpeakerFromMsg(msg);
          if (msg.isHistory) currentTurn.isHistory = true;
          currentTurn.imageMsgs.push(msg);
          currentTurn.messages.push(msg);
          continue;
        }

        // Unknown type: pass through
        finishTurn();
        result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
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

      return result;
    });

    const messageBlocks = Vue.computed(() => {
      // Group one user row plus the following AI replies into one virtual item.
      // That keeps reply context attached during virtualization and lets older
      // user turns collapse their AI response without touching message storage.
      const blocks = [];
      let currentBlock = null;
      const finishBlock = () => {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
      };

      turnGroups.value.forEach((item, i) => {
        if (!item || item.type === 'system' || item.type === 'error') {
          finishBlock();
          blocks.push(item);
          return;
        }

        const meta = messageBlockMetaForItem(item, i);
        if (item.type === 'user' || !currentBlock) {
          finishBlock();
          currentBlock = {
            type: 'message-block',
            id: `turn_${meta.messageId}_${i}`,
            vpId: meta.vpId,
            messageId: meta.messageId,
            items: [item],
          };
          return;
        }

        currentBlock.items.push(item);
        if (!currentBlock.vpId && meta.vpId) currentBlock.vpId = meta.vpId;
      });

      finishBlock();
      return annotateMessageBlocksForResponseCollapse(blocks, messageTurnCollapseStates);
    });

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

    // Track if user is at bottom (within threshold)
    const isAtBottom = Vue.ref(true);
    const SCROLL_THRESHOLD = 50;
    const LOAD_MORE_TOP_THRESHOLD = 100;
    let loadMoreArmed = true;

    const hasStreamingMessage = Vue.computed(() => {
      return store.messages.some(m => m.isStreaming);
    });

    const showInitialMessagesLoading = Vue.computed(() => {
      if (!store.currentConversation || messageBlocks.value.length > 0) return false;
      if (store.currentView === 'yeaft') return !!store.yeaftLoadingMoreHistory;
      return !!store.sessionLoading;
    });

    const initialMessagesLoadingText = Vue.computed(() => store.sessionLoadingText || '');

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

    // VP-block redesign Phase 3: a single page-shared "now" ref that
    // ticks once per second WHILE any turn is streaming. VpTurnBlock
    // reads it via prop to compute its live elapsed counter. We tick
    // only during streaming to avoid wasted re-renders when idle.
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
      hasStreamingMessage,
      (streaming) => {
        if (streaming) {
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
    let catRafId = null;

    // Animation type: randomly chosen each time typing starts
    const animationType = Vue.ref('cat');
    // Check URL for preview mode (?preview=cat or ?preview=dog)
    const urlPreview = new URLSearchParams(window.location.search).get('preview');

    // Cat walk position (0-100%) and direction (1=right, -1=left)
    const catPosition = Vue.ref(0);
    const catDirection = Vue.ref(1);

    // Dog walk state
    const dogPosL = Vue.ref(5);
    const dogPosR = Vue.ref(95);
    const dogPhase = Vue.ref('bark-both');
    const dogFlipL = Vue.ref(1);   // 1 = face right, -1 = face left
    const dogFlipR = Vue.ref(-1);  // -1 = face left, 1 = face right
    let dogRafId = null;

    function updateCatWalk() {
      if (!typingStartTime.value) return;
      now.value = Date.now();
      const elapsed = (now.value - typingStartTime.value) % 19000;

      if (elapsed < 4000) {
        // 0-4s: napping — stay at start
        catPosition.value = 0;
        catDirection.value = 1;
      } else if (elapsed < 11500) {
        // 4-11.5s: walk forward — Normal 2.5s, Fast 2.5s, Turbo 2.5s
        // Distance: Normal 16%, Fast 29%, Turbo 55%
        const walkElapsed = elapsed - 4000;
        let pos;
        if (walkElapsed < 2500) {
          pos = (walkElapsed / 2500) * 16;                     // 0→16%
        } else if (walkElapsed < 5000) {
          pos = 16 + ((walkElapsed - 2500) / 2500) * 29;      // 16→45%
        } else {
          pos = 45 + ((walkElapsed - 5000) / 2500) * 55;      // 45→100%
        }
        catPosition.value = pos;
        catDirection.value = 1;
      } else if (elapsed < 14000) {
        // 11.5-14s (crazy): sprint back — 100% in 2.5s
        catPosition.value = (1 - (elapsed - 11500) / 2500) * 100;
        catDirection.value = -1;
      } else {
        // 14-19s (tired + petted): stay at start, face right (same as napping)
        catPosition.value = 0;
        catDirection.value = 1;
      }

      catRafId = requestAnimationFrame(updateCatWalk);
    }

    function updateDogWalk() {
      if (!typingStartTime.value || animationType.value !== 'dog') return;
      now.value = Date.now();
      const elapsed = (now.value - typingStartTime.value) % 18000;

      if (elapsed < 2000) {
        // 0-2s: both bark at edges
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark-both';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 5000) {
        // 2-5s: left dog walks forward (5% → 30%), right barks in place
        const t = (elapsed - 2000) / 3000;
        dogPosL.value = 5 + t * 25; dogPosR.value = 95;
        dogPhase.value = 'left-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 8000) {
        // 5-8s: right dog walks forward (95% → 70%), left barks in place
        const t = (elapsed - 5000) / 3000;
        dogPosL.value = 30; dogPosR.value = 95 - t * 25;
        dogPhase.value = 'right-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 10000) {
        // 8-10s: both walk toward each other (30→43, 70→57)
        const t = (elapsed - 8000) / 2000;
        dogPosL.value = 30 + t * 13; dogPosR.value = 70 - t * 13;
        dogPhase.value = 'both-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 11000) {
        // 10-11s: leash snaps at posts
        dogPosL.value = 43; dogPosR.value = 57;
        dogPhase.value = 'snap';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 12500) {
        // 11-12.5s: stunned
        dogPosL.value = 43; dogPosR.value = 57;
        dogPhase.value = 'stunned';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 15000) {
        // 12.5-15s: retreat (turn around, walk back)
        const t = (elapsed - 12500) / 2500;
        dogPosL.value = 43 - t * 38; dogPosR.value = 57 + t * 38;
        dogPhase.value = 'retreat';
        dogFlipL.value = -1; dogFlipR.value = 1; // flipped — walking back
      } else if (elapsed < 17000) {
        // 15-17s: at post, rehang leash
        dogPosL.value = 5; dogPosR.value = 95;
        dogPhase.value = 'rehang';
        dogFlipL.value = -1; dogFlipR.value = 1; // still facing post
      } else {
        // 17-18s: turn back to face each other
        dogPosL.value = 5; dogPosR.value = 95;
        dogPhase.value = 'reset';
        dogFlipL.value = 1; dogFlipR.value = -1; // back to normal
      }
      dogRafId = requestAnimationFrame(updateDogWalk);
    }

    // Dog computed properties — map 0-100% position to SVG viewBox x coordinates
    // Spike collar at local x=13.5, Teddy collar at local x=10.5
    // Position represents where the collar should be in SVG coords (pos * 1.2)
    const spikeTransform = Vue.computed(() => {
      const collarSvgX = dogPosL.value * 1.2;
      if (dogFlipL.value < 0) {
        // Facing left: mirror around collar point
        return `translate(${collarSvgX + 13.5}, 0) scale(-1, 1)`;
      }
      // Facing right: collar at local x=13.5
      return `translate(${collarSvgX - 13.5}, 0)`;
    });
    const teddyTransform = Vue.computed(() => {
      const collarSvgX = dogPosR.value * 1.2;
      if (dogFlipR.value > 0) {
        // Facing right (retreat): collar at local x=10.5
        return `translate(${collarSvgX - 10.5}, 2)`;
      }
      // Facing left (default): mirror around collar point
      return `translate(${collarSvgX + 10.5}, 2) scale(-1, 1)`;
    });
    // Leash paths depend on phase: connected to post vs dragging
    const leashConnected = Vue.computed(() => {
      const p = dogPhase.value;
      return p === 'bark-both' || p === 'left-approach' || p === 'right-approach' || p === 'both-approach' || p === 'reset';
    });
    const leashPathL = Vue.computed(() => {
      const collarSvgX = dogPosL.value * 1.2;
      const collarY = 10;
      if (leashConnected.value) {
        // Post top (3, 18) to collar
        const sag = Math.max(0, (collarSvgX - 3) * 0.12);
        return `M3,18 Q${(3 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (dogPhase.value === 'rehang') {
        // During rehang, leash goes from collar down to near post then up to post top
        return `M${collarSvgX},${collarY} Q${collarSvgX - 3},20 3,18`;
      }
      // Snap/stunned/retreat: leash hangs from collar, drags trailing behind/below
      const dragDir = dogFlipL.value < 0 ? 1 : -1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    });
    const leashPathR = Vue.computed(() => {
      const collarSvgX = dogPosR.value * 1.2;
      const collarY = 10;
      if (leashConnected.value) {
        // Post top (118, 18) to collar
        const sag = Math.max(0, (118 - collarSvgX) * 0.12);
        return `M118,18 Q${(118 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (dogPhase.value === 'rehang') {
        return `M${collarSvgX},${collarY} Q${collarSvgX + 3},20 118,18`;
      }
      // Snap/stunned/retreat: leash hangs from collar
      const dragDir = dogFlipR.value > 0 ? -1 : 1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    });
    const leashOpacityL = Vue.computed(() => {
      return dogPhase.value === 'snap' ? 0.2 : 0.4;
    });
    const leashOpacityR = Vue.computed(() => {
      return dogPhase.value === 'snap' ? 0.2 : 0.4;
    });
    const questionLX = Vue.computed(() => dogPosL.value * 1.2);
    const questionRX = Vue.computed(() => dogPosR.value * 1.2);

    // Preview mode: ?preview=cat|dog|animation forces typing indicator permanently
    const isPreviewMode = urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation';

    // ★ task-346: Minimum visibility window for the typing indicator.
    //
    // Root cause: `showTypingDots = isProcessing && !hasStreamingMessage` is
    // true only during the pre-TTFB window — from the user's send to the
    // first `text_delta`. For low-latency providers (especially some routed
    // through the Yeaft engine where the LLM proxy can respond in <100 ms),
    // that window is shorter than a single browser paint frame, so the
    // running-cat animation never becomes visible. Chat mode happens to
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
        // Always use cat for now; dog animation needs more polish
        // Dog can still be previewed via ?preview=dog
        animationType.value = 'cat';
        catPosition.value = 0;
        catDirection.value = 1;
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark-both';
        dogFlipL.value = 1; dogFlipR.value = -1;
        if (animationType.value === 'cat') {
          catRafId = requestAnimationFrame(updateCatWalk);
        } else {
          dogRafId = requestAnimationFrame(updateDogWalk);
        }
      } else {
        const elapsed = typingStartTime.value ? (Date.now() - typingStartTime.value) : MIN_VISIBLE_MS;
        const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
        const finalize = () => {
          typingHideTimer = null;
          displayTypingDots.value = false;
          typingStartTime.value = 0;
          catPosition.value = 0;
          catDirection.value = 1;
          if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
          if (dogRafId) { cancelAnimationFrame(dogRafId); dogRafId = null; }
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
      if (urlPreview === 'dog') {
        animationType.value = 'dog';
      } else if (urlPreview === 'cat') {
        animationType.value = 'cat';
      } else {
        animationType.value = 'cat';
      }
      if (animationType.value === 'cat') {
        catRafId = requestAnimationFrame(updateCatWalk);
      } else {
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark-both';
        dogFlipL.value = 1; dogFlipR.value = -1;
        dogRafId = requestAnimationFrame(updateDogWalk);
      }
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

    // Cat running speed based on waiting time (7 tiers, 19s cycle)
    const catSpeed = Vue.computed(() => {
      if (!typingStartTime.value) return 'speed-napping';
      const elapsed = (now.value - typingStartTime.value) % 19000;
      if (elapsed >= 16000) return 'speed-petted';
      if (elapsed >= 14000) return 'speed-tired';
      if (elapsed >= 11500) return 'speed-crazy';
      if (elapsed >= 9000) return 'speed-turbo';
      if (elapsed >= 6500) return 'speed-fast';
      if (elapsed >= 4000) return 'speed-normal';
      return 'speed-napping';
    });

    // Cat walk style — position range: 40px (after dots) to calc(100% - 40px)
    const catStyle = Vue.computed(() => {
      const pos = catPosition.value;
      const dir = catDirection.value;
      const frac = pos / 100;
      const style = { left: `calc(40px + (100% - 80px) * ${frac})` };
      if (dir < 0) style.transform = 'scaleX(-1)';
      return style;
    });

    function refreshSession() {
      const convId = store.currentConversation;
      if (!convId) return;
      const conv = store.conversations.find(c => c.id === convId);
      store.sendWsMessage({ type: 'refresh_conversation', conversationId: convId, agentId: conv?.agentId });
    }

    // Scroll handling
    const checkIfAtBottom = () => {
      if (!containerRef.value) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.value;
      return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    };

    const maybeLoadMoreNearTop = (scrollTop, { allowContinuation = false } = {}) => {
      if (scrollTop > LOAD_MORE_TOP_THRESHOLD) {
        loadMoreArmed = true;
        return;
      }
      if (allowContinuation) loadMoreArmed = true;
      if (!loadMoreArmed || !canLoadMoreMessages()) return;
      loadMoreArmed = false;

      // Auto-fire load-more when the user scrolls near the top. Chat and
      // Yeaft share onClickLoadMore() so the click path and scroll path
      // cannot drift apart.
      onClickLoadMore();
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

    const continueLoadMoreIfStillNearTop = (beforeSnapshot) => {
      Vue.nextTick(() => {
        if (!containerRef.value) return;
        const afterSnapshot = getLoadMoreProgressSnapshot();
        if (!hasLoadMoreProgress(beforeSnapshot, afterSnapshot)) return;
        maybeLoadMoreNearTop(containerRef.value.scrollTop || 0, { allowContinuation: true });
      });
    };

    const onVirtualTranscriptScrollState = ({ scrollTop, scrollHeight, clientHeight }) => {
      isAtBottom.value = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
      maybeLoadMoreNearTop(scrollTop || 0);
    };

    const preserveScrollAnchorDuringLoad = (loadFn, loadingRef) => {
      const beforeSnapshot = getLoadMoreProgressSnapshot();
      if (!containerRef.value) {
        loadFn();
        continueLoadMoreIfStillNearTop(beforeSnapshot);
        return;
      }

      const prevScrollHeight = containerRef.value.scrollHeight;
      const prevScrollTop = containerRef.value.scrollTop;
      let restored = false;
      let unwatch = null;

      const restore = () => {
        if (restored) return;
        restored = true;
        if (unwatch) unwatch();
        Vue.nextTick(() => {
          if (!containerRef.value) return;
          const newScrollHeight = containerRef.value.scrollHeight;
          containerRef.value.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
          continueLoadMoreIfStillNearTop(beforeSnapshot);
        });
      };

      if (loadingRef) {
        unwatch = Vue.watch(loadingRef, (loading) => {
          if (!loading) restore();
        });
      }

      loadFn();

      // Covers synchronous test doubles and cached responses that prepend
      // rows without a visible loading-flag round trip. The normal async
      // path restores from the watcher above when loading flips false.
      Vue.nextTick(() => {
        if (!loadingRef || !loadingRef()) restore();
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

    const onClickLoadMore = () => {
      if (!canLoadMoreMessages()) return;
      const isYeaft = store.currentView === 'yeaft';
      preserveScrollAnchorDuringLoad(
        isYeaft ? loadMoreYeaft : () => store.loadMoreMessages(),
        isYeaft ? () => store.yeaftLoadingMoreHistory : () => store.loadingMoreMessages
      );
    };

    const onScroll = () => {
      isAtBottom.value = checkIfAtBottom();
      if (isAtBottom.value) pruneYeaftWindowNearBottom();

      if (containerRef.value) maybeLoadMoreNearTop(containerRef.value.scrollTop || 0);
    };

    const pruneYeaftWindowNearBottom = () => {
      if (store.currentView === 'yeaft') store.pruneYeaftMessageWindow();
    };

    const scrollToBottom = () => {
      if (containerRef.value) {
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
        isAtBottom.value = true;
        pruneYeaftWindowNearBottom();
      }
    };

    const scrollToLatest = () => {
      // If the user jumped away while an initial Yeaft group page was still
      // being hydrated, make the intent explicit: stay on the newest loaded
      // row, and when the in-flight page lands the existing smart-scroll
      // watchers will keep us pinned because isAtBottom is true.
      isAtBottom.value = true;
      Vue.nextTick(scrollToBottom);
    };

    const smartScrollToBottom = () => {
      if (isAtBottom.value) {
        pruneYeaftWindowNearBottom();
        Vue.nextTick(scrollToBottom);
      }
    };

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

    Vue.watch(() => store.messages.length, smartScrollToBottom);
    Vue.watch(() => store.messages[store.messages.length - 1]?.content, smartScrollToBottom);
    Vue.watch(previewShowTypingDots, (show) => { if (show) smartScrollToBottom(); });
    Vue.watch(
      () => store.currentConversation,
      () => {
        for (const key of Object.keys(assistantTurnActionStates)) delete assistantTurnActionStates[key];
        for (const key of Object.keys(toolExpandStates)) delete toolExpandStates[key];
        for (const key of Object.keys(messageTurnCollapseStates)) delete messageTurnCollapseStates[key];
        isAtBottom.value = true;
        Vue.nextTick(scrollToBottom);
      }
    );

    // H2.f.6: yeaftJumpTarget watcher removed (sidebar no longer emits
    // jump-to-message events; message block navigation uses message ids). The
    // flashMsgId ref is kept (currently unused) so any v-bind referencing
    // it stays valid.
    const flashMsgId = Vue.ref(null);

    Vue.onMounted(() => {
      scrollToBottom();
      if (containerRef.value) {
        containerRef.value.addEventListener('scroll', onScroll);
      }
    });

    Vue.onUnmounted(() => {
      if (containerRef.value) {
        containerRef.value.removeEventListener('scroll', onScroll);
      }
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      if (typingHideTimer) { clearTimeout(typingHideTimer); typingHideTimer = null; }
      if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
      if (dogRafId) { cancelAnimationFrame(dogRafId); dogRafId = null; }
    });

    return {
      store,
      containerRef,
      flashMsgId,
      hasStreamingMessage,
      nowMs,
      showTypingDots,
      showInitialMessagesLoading,
      showSessionLoadingOverlay,
      initialMessagesLoadingText,
      previewShowTypingDots,
      isPreviewMode,
      waitingStatus,
      animationType,
      catSpeed,
      catStyle,
      dogPhase,
      spikeTransform,
      teddyTransform,
      leashPathL,
      leashPathR,
      leashOpacityL,
      leashOpacityR,
      questionLX,
      questionRX,
      refreshSession,
      onlineAgents,
      welcomeInstallCommand,
      welcomeLlmCommand,
      welcomeServiceCommand,
      welcomeSetupLoading,
      welcomeSetupError,
      copyWelcomeCommand,
      turnGroups,
      messageBlocks,
      estimateMessageBlockHeight,
      visibleItemsForBlock,
      toggleMessageTurnResponse,
      responseCollapseLabel,
      turnUiKey,
      assistantTurnActionsExpandedFor,
      setAssistantTurnActionsExpanded,
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
      scrollToLatest,
    };
  }
};
