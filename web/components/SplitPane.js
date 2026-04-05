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
                    <span class="svg-running-cat" aria-hidden="true">
                      <svg viewBox="0 0 34 28" xmlns="http://www.w3.org/2000/svg">
                        <g class="svg-cat-tail-group">
                          <path class="svg-cat-tail" d="M6 15 Q1 10 3 5 Q4 3 6 4" stroke-width="1.8"/>
                        </g>
                        <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 18 L8 24 Q8 25.5 9.5 25.5 L10.5 25.5" stroke-width="0" /></g>
                        <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 18 L6 24 Q6 25.5 7.5 25.5 L8.5 25.5" stroke-width="0" /></g>
                        <ellipse class="svg-cat-body" cx="15" cy="16" rx="9" ry="4.5"/>
                        <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M22 18 L24 24 Q24 25.5 22.5 25.5 L21.5 25.5" stroke-width="0" /></g>
                        <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M20 18 L22 24 Q22 25.5 20.5 25.5 L19.5 25.5" stroke-width="0" /></g>
                        <circle class="svg-cat-head" cx="24" cy="10" r="5.5"/>
                        <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="19,7 21,1 23,6"/></g>
                        <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 27,1 29,7"/></g>
                        <polygon class="svg-cat-nose" points="19.8,6.5 21.2,2 22.3,5.8" opacity="0.25"/>
                        <polygon class="svg-cat-nose" points="25.7,5.8 26.8,2 28.2,6.5" opacity="0.25"/>
                        <ellipse class="svg-cat-eye" cx="22.2" cy="9.5" rx="1.5" ry="1.7"/>
                        <ellipse class="svg-cat-eye" cx="26.5" cy="9.5" rx="1.5" ry="1.7"/>
                        <ellipse class="svg-cat-pupil" cx="22.6" cy="9.8" rx="0.8" ry="1.0"/>
                        <ellipse class="svg-cat-pupil" cx="26.9" cy="9.8" rx="0.8" ry="1.0"/>
                        <ellipse class="svg-cat-nose" cx="24.5" cy="12" rx="0.8" ry="0.5"/>
                        <path class="svg-cat-mouth" d="M24.5 12.5 Q24 13.5 23.2 13.2" stroke-width="0.5"/>
                        <path class="svg-cat-mouth" d="M24.5 12.5 Q25 13.5 25.8 13.2" stroke-width="0.5"/>
                        <line class="svg-cat-whisker" x1="20" y1="11" x2="16" y2="10" stroke-width="0.4"/>
                        <line class="svg-cat-whisker" x1="20" y1="12" x2="16" y2="12.5" stroke-width="0.4"/>
                        <line class="svg-cat-whisker" x1="28.5" y1="11" x2="32.5" y2="10" stroke-width="0.4"/>
                        <line class="svg-cat-whisker" x1="28.5" y1="12" x2="32.5" y2="12.5" stroke-width="0.4"/>
                      </svg>
                    </span>
                    <span class="svg-fight-scene" aria-hidden="true">
                      <svg viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg">
                        <!-- Cat (left, facing right) -->
                        <g class="svg-fight-cat">
                          <path class="svg-fight-cat-tail" d="M8 38 Q2 30 4 22 Q5 19 7 21" stroke-width="1.8"/>
                          <ellipse class="svg-fight-cat-body" cx="18" cy="38" rx="10" ry="7"/>
                          <path class="svg-fight-cat-leg" d="M12 44 L10 54 Q10 56 12 56 L13 56" stroke-width="0"/>
                          <path class="svg-fight-cat-leg" d="M22 44 L24 54 Q24 56 22 56 L21 56" stroke-width="0"/>
                          <circle class="svg-fight-cat-head" cx="26" cy="24" r="8"/>
                          <polygon class="svg-fight-cat-ear" points="19,20 22,10 25,19"/>
                          <polygon class="svg-fight-cat-ear" points="27,19 30,10 33,20"/>
                          <ellipse class="svg-fight-cat-eye" cx="23.5" cy="23" rx="1.5" ry="1.8"/>
                          <ellipse class="svg-fight-cat-eye" cx="28.5" cy="23" rx="1.5" ry="1.8"/>
                          <ellipse class="svg-fight-cat-pupil" cx="24" cy="23.3" rx="0.8" ry="1.0"/>
                          <ellipse class="svg-fight-cat-pupil" cx="29" cy="23.3" rx="0.8" ry="1.0"/>
                          <ellipse class="svg-fight-cat-nose" cx="26" cy="26.5" rx="1" ry="0.6"/>
                          <path class="svg-fight-cat-mouth" d="M26 27.1 Q25.3 28.2 24.5 27.8" stroke-width="0.5"/>
                          <path class="svg-fight-cat-mouth" d="M26 27.1 Q26.7 28.2 27.5 27.8" stroke-width="0.5"/>
                          <line class="svg-fight-cat-whisker" x1="21" y1="25.5" x2="14" y2="24.5" stroke-width="0.4"/>
                          <line class="svg-fight-cat-whisker" x1="21" y1="26.5" x2="14" y2="27" stroke-width="0.4"/>
                          <line class="svg-fight-cat-whisker" x1="31" y1="25.5" x2="36" y2="24.5" stroke-width="0.4"/>
                          <line class="svg-fight-cat-whisker" x1="31" y1="26.5" x2="36" y2="27" stroke-width="0.4"/>
                          <g class="svg-fight-cat-arm-upper">
                            <path class="svg-fight-cat-arm" d="M28 32 Q34 28 36 26"/>
                            <circle class="svg-fight-cat-fist" cx="36" cy="26" r="2.5"/>
                          </g>
                          <g class="svg-fight-cat-arm-lower">
                            <path class="svg-fight-cat-arm" d="M27 35 Q33 33 35 31"/>
                            <circle class="svg-fight-cat-fist" cx="35" cy="31" r="2.2"/>
                          </g>
                        </g>
                        <!-- Dog/Corgi (right, facing left) -->
                        <g class="svg-fight-dog">
                          <path class="svg-fight-dog-tail" d="M72 36 Q78 28 75 22 Q74 19 72 21" stroke-width="1.8"/>
                          <ellipse class="svg-fight-dog-body" cx="62" cy="38" rx="10" ry="7"/>
                          <path class="svg-fight-dog-leg" d="M56 44 L54 54 Q54 56 56 56 L57 56" stroke-width="0"/>
                          <path class="svg-fight-dog-leg" d="M66 44 L68 54 Q68 56 66 56 L65 56" stroke-width="0"/>
                          <circle class="svg-fight-dog-head" cx="54" cy="24" r="8"/>
                          <path class="svg-fight-dog-ear" d="M47 20 Q44 13 47 17 L49 20" stroke-width="0"/>
                          <path class="svg-fight-dog-ear" d="M59 20 Q62 13 61 17 L59 20" stroke-width="0"/>
                          <ellipse class="svg-fight-dog-ear" cx="47.5" cy="17" rx="2.5" ry="4" transform="rotate(-10 47.5 17)"/>
                          <ellipse class="svg-fight-dog-ear" cx="60.5" cy="17" rx="2.5" ry="4" transform="rotate(10 60.5 17)"/>
                          <ellipse class="svg-fight-dog-eye" cx="51.5" cy="23" rx="1.5" ry="1.8"/>
                          <ellipse class="svg-fight-dog-eye" cx="56.5" cy="23" rx="1.5" ry="1.8"/>
                          <ellipse class="svg-fight-dog-pupil" cx="51" cy="23.3" rx="0.8" ry="1.0"/>
                          <ellipse class="svg-fight-dog-pupil" cx="56" cy="23.3" rx="0.8" ry="1.0"/>
                          <ellipse class="svg-fight-dog-nose" cx="54" cy="27" rx="1.5" ry="1"/>
                          <path class="svg-fight-dog-mouth" d="M54 28 Q52.5 29.5 51.5 29" stroke-width="0.6"/>
                          <path class="svg-fight-dog-snout" d="M51 25.5 Q54 30 57 25.5" stroke-width="0.5"/>
                          <g class="svg-fight-dog-arm-upper">
                            <path class="svg-fight-dog-arm" d="M52 32 Q46 28 44 26"/>
                            <circle class="svg-fight-dog-fist" cx="44" cy="26" r="2.5"/>
                          </g>
                          <g class="svg-fight-dog-arm-lower">
                            <path class="svg-fight-dog-arm" d="M53 35 Q47 33 45 31"/>
                            <circle class="svg-fight-dog-fist" cx="45" cy="31" r="2.2"/>
                          </g>
                        </g>
                      </svg>
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
    let typingTimer = null;

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        typingStartTime.value = Date.now();
        now.value = Date.now();
        typingTimer = setInterval(() => { now.value = Date.now(); }, 1000);
      } else {
        typingStartTime.value = 0;
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      }
    });

    Vue.onUnmounted(() => {
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
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
