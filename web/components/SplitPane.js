/**
 * SplitPane — one panel in multi-panel mode.
 * Each panel has: ChatHeader + content area (column layout).
 *
 * Key design: SplitPane does NOT modify global store.currentConversation.
 * Instead, it reads its own conversation from store.panels and passes
 * per-conversation data via props (conversationId, sendFn, cancelFn) to children.
 */
import ChatHeader from './ChatHeader.js';
import MessageItem from './MessageItem.js';
import AssistantTurn from './AssistantTurn.js';
import ChatInput from './ChatInput.js';
import CrewChatView from './CrewChatView.js';
import ExpertPanel from './ExpertPanel.js';
import SubAgentPanel from './SubAgentPanel.js';

export default {
  name: 'SplitPane',
  components: { ChatHeader, MessageItem, AssistantTurn, ChatInput, CrewChatView, ExpertPanel, SubAgentPanel },
  props: {
    paneId: { type: String, required: true },
    paneIndex: { type: Number, default: 0 },
    paneCount: { type: Number, default: 2 }
  },
  template: `
    <div class="split-pane" @click="setActive">
      <!-- ChatHeader — always visible, with close-pane button -->
      <ChatHeader
        :conversationId="conversationId"
        :paneId="paneId"
        :showClosePane="true"
        @close-pane="closePane"
      />

      <template v-if="conversationId">
        <!-- Crew mode -->
        <CrewChatView v-if="isCrew" :conversationId="conversationId" :paneId="paneId" />

        <!-- Chat mode -->
        <template v-else>
          <div class="chat-body" :class="{ 'expert-panel-open': paneRightPanel }">
            <div class="chat-body-main">
              <!-- Inline message list (avoids modifying MessageList.js) -->
              <main class="chat-container split-pane-messages" ref="containerRef">
                <div class="messages">
                  <template v-for="item in turnGroups" :key="item.id">
                    <MessageItem v-if="item.type === 'user' || item.type === 'system' || item.type === 'error'" :message="item.message" />
                    <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" :conversationId="conversationId" />
                  </template>
                  <div v-if="previewShowTypingDots" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
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
                    <span v-if="waitingStatus === 'disconnected'" class="typing-status-text typing-status-error">
                      {{ $t('chat.waiting.disconnected') }}
                    </span>
                    <span v-else-if="waitingStatus === 'compacting'" class="typing-status-text typing-status-compact">
                      {{ $t('chat.waiting.compacting') }}
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
                </div>
              </main>

              <!-- Chat input with per-pane send/cancel -->
              <ChatInput
                :sendFn="sendFn"
                :cancelFn="cancelFn"
                :showStop="isProcessing"
              />
            </div>
            <!-- Right Panel overlay (mobile only) -->
            <div class="expert-panel-overlay" v-if="paneRightPanel" @click="closePanePanel"></div>
            <SubAgentPanel
              v-if="paneRightPanel === 'subagents'"
              :visible="true"
              @close="closePanePanel"
            />
            <ExpertPanel
              v-else-if="paneRightPanel === 'experts'"
              :visible="true"
              :modelValue="store.expertSelections"
              @update:modelValue="store.expertSelections = $event"
              @close="closePanePanel"
            />
          </div>
        </template>
      </template>

      <!-- Empty state: no conversation selected -->
      <div v-else class="pane-empty-state">
        <div class="pane-empty-icon">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <rect width="48" height="48" rx="12" fill="var(--accent)" opacity="0.15"/>
            <path d="M12 16l6 6-6 6" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <path d="M21 28h15" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round"/>
          </svg>
        </div>
        <p class="pane-empty-text">{{ $t('splitScreen.selectFromSidebar') }}</p>
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const containerRef = Vue.ref(null);

    // Is this panel the active (focused) one?
    const isActivePanel = Vue.computed(() => store.activePanelId === props.paneId);

    // Current panel's conversation ID
    const conversationId = Vue.computed(() => {
      const panel = store.panels.find(p => p.id === props.paneId);
      return panel?.conversationId || null;
    });

    // Is this a crew conversation?
    const isCrew = Vue.computed(() => {
      if (!conversationId.value) return false;
      const conv = store.conversations.find(c => c.id === conversationId.value);
      return conv?.type === 'crew';
    });

    // Messages for this panel
    const messages = Vue.computed(() => {
      if (!conversationId.value) return [];
      return store.messagesMap[conversationId.value] || [];
    });

    // Is this conversation processing?
    const isProcessing = Vue.computed(() => {
      return conversationId.value ? !!store.processingConversations[conversationId.value] : false;
    });

    // Has streaming message
    const hasStreamingMessage = Vue.computed(() => {
      return messages.value.some(m => m.isStreaming);
    });

    // Show typing dots
    const showTypingDots = Vue.computed(() => {
      return isProcessing.value && !hasStreamingMessage.value;
    });

    // Reactive timer for long-processing fallback status
    const typingStartTime = Vue.ref(0);
    const now = Vue.ref(Date.now());
    let catRafId = null;

    // Animation type: randomly chosen each time typing starts
    const animationType = Vue.ref('cat');
    const urlPreview = new URLSearchParams(window.location.search).get('preview');

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
        catPosition.value = 0;
        catDirection.value = 1;
      } else if (elapsed < 11500) {
        const walkElapsed = elapsed - 4000;
        let pos;
        if (walkElapsed < 2500) {
          pos = (walkElapsed / 2500) * 16;
        } else if (walkElapsed < 5000) {
          pos = 16 + ((walkElapsed - 2500) / 2500) * 29;
        } else {
          pos = 45 + ((walkElapsed - 5000) / 2500) * 55;
        }
        catPosition.value = pos;
        catDirection.value = 1;
      } else if (elapsed < 14000) {
        catPosition.value = (1 - (elapsed - 11500) / 2500) * 100;
        catDirection.value = -1;
      } else {
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
    const previewShowTypingDots = Vue.computed(() => {
      if (urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation') return true;
      return showTypingDots.value;
    });

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        typingStartTime.value = Date.now();
        now.value = Date.now();
        animationType.value = Math.random() < 0.5 ? 'cat' : 'dog';
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
        typingStartTime.value = 0;
        catPosition.value = 0;
        catDirection.value = 1;
        if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
        if (dogRafId) { cancelAnimationFrame(dogRafId); dogRafId = null; }
      }
    }, { immediate: true });

    // Preview mode initialization
    if (urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation') {
      typingStartTime.value = Date.now();
      now.value = Date.now();
      if (urlPreview === 'dog') {
        animationType.value = 'dog';
      } else if (urlPreview === 'cat') {
        animationType.value = 'cat';
      } else {
        animationType.value = Math.random() < 0.5 ? 'cat' : 'dog';
      }
      if (animationType.value === 'cat') {
        catRafId = requestAnimationFrame(updateCatWalk);
      } else {
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark-both';
        dogFlipL.value = 1; dogFlipR.value = -1;
        dogRafId = requestAnimationFrame(updateDogWalk);
      }
    }

    Vue.onUnmounted(() => {
      if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
      if (dogRafId) { cancelAnimationFrame(dogRafId); dogRafId = null; }
    });

    // Event-driven waiting status
    const waitingStatus = Vue.computed(() => {
      if (!isProcessing.value) return null;
      if (store.connectionState !== 'connected') return 'disconnected';
      const convId = conversationId.value;
      if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'compacting') return 'compacting';
      const health = store.sessionHealth?.[convId];
      if (health) return health.status;
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

    const catStyle = Vue.computed(() => {
      const pos = catPosition.value;
      const dir = catDirection.value;
      const frac = pos / 100;
      const style = { left: `calc(40px + (100% - 80px) * ${frac})` };
      if (dir < 0) style.transform = 'scaleX(-1)';
      return style;
    });

    function refreshSession() {
      const convId = conversationId.value;
      if (!convId) return;
      const conv = store.conversations.find(c => c.id === convId);
      store.sendWsMessage({ type: 'refresh_conversation', conversationId: convId, agentId: conv?.agentId });
    }

    // Turn aggregation (same logic as MessageList)
    const turnGroups = Vue.computed(() => {
      const msgs = messages.value;
      const result = [];
      let currentTurn = null;
      let turnCounter = 0;

      const finishTurn = () => {
        if (currentTurn) {
          if (currentTurn.textContent || currentTurn.toolMsgs.length > 0 || currentTurn.todoMsg || currentTurn.askMsg) {
            result.push(currentTurn);
          }
          currentTurn = null;
        }
      };

      const startTurn = () => {
        turnCounter++;
        currentTurn = {
          type: 'assistant-turn',
          id: 'turn_' + turnCounter,
          textContent: '',
          isStreaming: false,
          todoMsg: null,
          toolMsgs: [],
          askMsg: null,
          messages: []
        };
      };

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];

        if (msg.type === 'user') {
          if (!msg.content || !msg.content.trim()) continue;
          finishTurn();
          result.push({ type: 'user', id: msg.id || 'u_' + i, message: msg });
          continue;
        }

        if (msg.type === 'system' || msg.type === 'error') {
          finishTurn();
          result.push({ type: msg.type, id: msg.id || 's_' + i, message: msg });
          continue;
        }

        if (msg.type === 'tool-result' || msg.type === 'tool_result') continue;

        if (msg.type === 'assistant') {
          if (!currentTurn) startTurn();
          if (msg.content) currentTurn.textContent += msg.content;
          if (msg.isStreaming) currentTurn.isStreaming = true;
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'tool-use') {
          if (!currentTurn) startTurn();
          const nextMsg = msgs[i + 1];
          const hasResult = nextMsg && (nextMsg.type === 'tool-result' || nextMsg.type === 'tool_result');
          const toolEntry = {
            ...msg,
            hasResult: hasResult || msg.hasResult || false,
            toolResult: msg.toolResult || null
          };
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

        finishTurn();
        result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
      }

      finishTurn();
      return result;
    });

    // Per-panel send function
    const sendFn = (text, attachmentInfos) => {
      if (!conversationId.value) return;
      const attachments = attachmentInfos || [];
      store.sendMessageToConversation(conversationId.value, text, attachments);
    };

    // Per-panel cancel function
    const cancelFn = () => {
      if (!conversationId.value) return;
      store.cancelExecutionForConversation(conversationId.value);
    };

    // Set this panel as active on click
    function setActive() {
      store.setActivePanel(props.paneId);
    }

    // Close this panel
    function closePane() {
      store.removePanel(props.paneId);
    }

    // Right panel state for this panel
    const paneRightPanel = Vue.computed(() => {
      return store.getPaneRightPanel(props.paneId);
    });

    function closePanePanel() {
      store.setPaneRightPanel(props.paneId, null);
    }

    // Auto-scroll when new messages arrive
    const isAtBottom = Vue.ref(true);
    const SCROLL_THRESHOLD = 50;

    const checkIfAtBottom = () => {
      if (!containerRef.value) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.value;
      return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    };

    const scrollToBottom = () => {
      if (!containerRef.value) return;
      containerRef.value.scrollTop = containerRef.value.scrollHeight;
    };

    const onScroll = () => {
      isAtBottom.value = checkIfAtBottom();
    };

    // Watch messages for auto-scroll
    Vue.watch(
      () => messages.value.length,
      () => {
        if (isAtBottom.value) {
          Vue.nextTick(scrollToBottom);
        }
      }
    );

    // Watch for streaming content changes
    Vue.watch(
      () => {
        const msgs = messages.value;
        const last = msgs[msgs.length - 1];
        return last?.isStreaming ? last.content?.length : 0;
      },
      () => {
        if (isAtBottom.value) {
          Vue.nextTick(scrollToBottom);
        }
      }
    );

    // Watch for conversation changes — re-bind scroll listener on new DOM
    Vue.watch(conversationId, () => {
      if (containerRef.value) {
        containerRef.value.removeEventListener('scroll', onScroll);
      }
      isAtBottom.value = true;
      Vue.nextTick(() => {
        if (containerRef.value) {
          containerRef.value.addEventListener('scroll', onScroll);
          scrollToBottom();
        }
      });
    });

    Vue.onMounted(() => {
      if (containerRef.value) {
        containerRef.value.addEventListener('scroll', onScroll);
        scrollToBottom();
      }
    });

    Vue.onUnmounted(() => {
      if (containerRef.value) {
        containerRef.value.removeEventListener('scroll', onScroll);
      }
    });

    return {
      store,
      containerRef,
      isActivePanel,
      conversationId,
      isCrew,
      messages,
      isProcessing,
      showTypingDots,
      previewShowTypingDots,
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
      turnGroups,
      sendFn,
      cancelFn,
      setActive,
      closePane,
      paneRightPanel,
      closePanePanel
    };
  }
};
