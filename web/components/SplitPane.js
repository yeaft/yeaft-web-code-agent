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
                  <div v-if="showTypingDots" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
                    <span></span><span></span><span></span>
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
                          <line class="svg-cat-hand-arm" x1="24" y1="-8" x2="24" y2="-1" stroke-width="3" stroke-linecap="round"/>
                          <ellipse class="svg-cat-hand-palm" cx="24" cy="0.5" rx="4" ry="2.5"/>
                          <ellipse class="svg-cat-finger" cx="20.8" cy="2.8" rx="1" ry="1.5"/>
                          <ellipse class="svg-cat-finger" cx="22.8" cy="3.3" rx="0.9" ry="1.6"/>
                          <ellipse class="svg-cat-finger" cx="25" cy="3.3" rx="0.9" ry="1.6"/>
                          <ellipse class="svg-cat-finger" cx="27" cy="2.8" rx="1" ry="1.5"/>
                        </g>
                        <!-- Napping bed — soft oval cushion, only visible in napping mode -->
                        <ellipse class="svg-cat-bed" cx="15" cy="24" rx="12" ry="3"/>
                        <!-- Drool — tiny droplet near mouth, only visible in napping mode -->
                        <circle class="svg-cat-drool" cx="26.5" cy="14" r="0.6"/>
                      </svg>
                    </span>
                    </span>
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

    const catPosition = Vue.ref(0);
    const catDirection = Vue.ref(1);

    function updateCatWalk() {
      if (!typingStartTime.value) return;
      now.value = Date.now();
      const elapsed = (now.value - typingStartTime.value) % 16500;
      if (elapsed < 2500) {
        catPosition.value = 0;
        catDirection.value = 1;
      } else if (elapsed < 10000) {
        const walkElapsed = elapsed - 2500;
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
      } else if (elapsed < 12500) {
        catPosition.value = (1 - (elapsed - 10000) / 2500) * 100;
        catDirection.value = -1;
      } else {
        catPosition.value = 0;
        catDirection.value = -1;
      }
      catRafId = requestAnimationFrame(updateCatWalk);
    }

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        typingStartTime.value = Date.now();
        now.value = Date.now();
        catPosition.value = 0;
        catDirection.value = 1;
        catRafId = requestAnimationFrame(updateCatWalk);
      } else {
        typingStartTime.value = 0;
        catPosition.value = 0;
        catDirection.value = 1;
        if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
      }
    }, { immediate: true });

    Vue.onUnmounted(() => {
      if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
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

    // Cat running speed based on waiting time (7 tiers, 16.5s cycle)
    const catSpeed = Vue.computed(() => {
      if (!typingStartTime.value) return 'speed-napping';
      const elapsed = (now.value - typingStartTime.value) % 16500;
      if (elapsed >= 14500) return 'speed-petted';
      if (elapsed >= 12500) return 'speed-tired';
      if (elapsed >= 10000) return 'speed-crazy';
      if (elapsed >= 7500) return 'speed-turbo';
      if (elapsed >= 5000) return 'speed-fast';
      if (elapsed >= 2500) return 'speed-normal';
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
      waitingStatus,
      catSpeed,
      catStyle,
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
