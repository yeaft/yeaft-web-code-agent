import MessageItem from './MessageItem.js';
import AssistantTurn from './AssistantTurn.js';

export default {
  name: 'MessageList',
  components: { MessageItem, AssistantTurn },
  template: `
    <main class="chat-container" ref="containerRef">
      <!-- Session Loading Overlay - only covers message area -->
      <div class="session-loading-overlay" v-if="store.sessionLoading">
        <div class="session-loading-content">
          <div class="session-loading-spinner"></div>
          <div class="session-loading-text">{{ store.sessionLoadingText || $t('common.loading') }}</div>
        </div>
      </div>

      <!-- Welcome Screen when no conversation -->
      <div v-if="!store.currentConversation" class="welcome-screen">
        <div class="welcome-content">
          <div class="welcome-logo">
            <svg viewBox="0 0 48 48" width="64" height="64">
              <rect width="48" height="48" rx="12" fill="#d97706"/>
              <path d="M12 16l6 6-6 6" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              <path d="M21 28h15" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
            </svg>
          </div>
          <h1 class="welcome-title">Claude Web Chat</h1>
          <p class="welcome-subtitle">{{ $t('welcome.subtitle') }}</p>

          <!-- Agent Status -->
          <div class="welcome-status" v-if="onlineAgents.length > 0">
            <span class="status-dot online"></span>
            <span class="status-text">{{ $t('welcome.agentOnline', { count: onlineAgents.length }) }}</span>
          </div>

          <!-- No agents online -->
          <div class="welcome-section" v-else>
            <div class="welcome-empty">
              <div class="empty-icon">📡</div>
              <div class="empty-text">{{ $t('welcome.noAgent') }}</div>
              <div class="empty-hint">{{ $t('welcome.noAgentHint') }}</div>
              <button class="welcome-btn setup-agent-btn" @click="$emit('open-settings')">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                {{ $t('welcome.setupAgent') }}
              </button>
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
        <div v-if="store.loadingMoreMessages" class="loading-more">{{ $t('message.loadingMore') }}</div>
        <div v-else-if="store.hasMoreMessages" class="load-more-hint" @click="store.loadMoreMessages()">{{ $t('message.loadMore') }}</div>
        <template v-for="item in turnGroups" :key="item.id">
          <!-- User / system / error messages: rendered by MessageItem -->
          <MessageItem v-if="item.type === 'user' || item.type === 'system' || item.type === 'error'" :message="item.message" />

          <!-- Assistant Turn card: aggregated rendering -->
          <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />
        </template>
        <!-- Typing dots: visible when processing but not streaming text -->
        <div v-if="showTypingDots" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
          <span></span><span></span><span></span>
          <span class="svg-running-cat" aria-hidden="true">
            <svg viewBox="0 0 34 28" xmlns="http://www.w3.org/2000/svg">
              <!-- Tail -->
              <g class="svg-cat-tail-group">
                <path class="svg-cat-tail" d="M6 15 Q1 10 3 5 Q4 3 6 4" stroke-width="1.8"/>
              </g>
              <!-- Back legs -->
              <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 18 L8 24 Q8 25.5 9.5 25.5 L10.5 25.5" stroke-width="0" /></g>
              <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 18 L6 24 Q6 25.5 7.5 25.5 L8.5 25.5" stroke-width="0" /></g>
              <!-- Body -->
              <ellipse class="svg-cat-body" cx="15" cy="16" rx="9" ry="4.5"/>
              <!-- Front legs -->
              <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M22 18 L24 24 Q24 25.5 22.5 25.5 L21.5 25.5" stroke-width="0" /></g>
              <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M20 18 L22 24 Q22 25.5 20.5 25.5 L19.5 25.5" stroke-width="0" /></g>
              <!-- Head -->
              <circle class="svg-cat-head" cx="24" cy="10" r="5.5"/>
              <!-- Ears -->
              <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="19,7 21,1 23,6"/></g>
              <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 27,1 29,7"/></g>
              <!-- Inner ears -->
              <polygon class="svg-cat-nose" points="19.8,6.5 21.2,2 22.3,5.8" opacity="0.25"/>
              <polygon class="svg-cat-nose" points="25.7,5.8 26.8,2 28.2,6.5" opacity="0.25"/>
              <!-- Eyes -->
              <ellipse class="svg-cat-eye" cx="22.2" cy="9.5" rx="1.5" ry="1.7"/>
              <ellipse class="svg-cat-eye" cx="26.5" cy="9.5" rx="1.5" ry="1.7"/>
              <ellipse class="svg-cat-pupil" cx="22.6" cy="9.8" rx="0.8" ry="1.0"/>
              <ellipse class="svg-cat-pupil" cx="26.9" cy="9.8" rx="0.8" ry="1.0"/>
              <!-- Nose -->
              <ellipse class="svg-cat-nose" cx="24.5" cy="12" rx="0.8" ry="0.5"/>
              <!-- Mouth -->
              <path class="svg-cat-mouth" d="M24.5 12.5 Q24 13.5 23.2 13.2" stroke-width="0.5"/>
              <path class="svg-cat-mouth" d="M24.5 12.5 Q25 13.5 25.8 13.2" stroke-width="0.5"/>
              <!-- Whiskers -->
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
                <!-- Cat tail -->
                <path class="svg-fight-cat-tail" d="M8 38 Q2 30 4 22 Q5 19 7 21" stroke-width="1.8"/>
                <!-- Cat body -->
                <ellipse class="svg-fight-cat-body" cx="18" cy="38" rx="10" ry="7"/>
                <!-- Cat left leg -->
                <path class="svg-fight-cat-leg" d="M12 44 L10 54 Q10 56 12 56 L13 56" stroke-width="0"/>
                <!-- Cat right leg -->
                <path class="svg-fight-cat-leg" d="M22 44 L24 54 Q24 56 22 56 L21 56" stroke-width="0"/>
                <!-- Cat head -->
                <circle class="svg-fight-cat-head" cx="26" cy="24" r="8"/>
                <!-- Cat ears -->
                <polygon class="svg-fight-cat-ear" points="19,20 22,10 25,19"/>
                <polygon class="svg-fight-cat-ear" points="27,19 30,10 33,20"/>
                <!-- Cat eyes -->
                <ellipse class="svg-fight-cat-eye" cx="23.5" cy="23" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-cat-eye" cx="28.5" cy="23" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-cat-pupil" cx="24" cy="23.3" rx="0.8" ry="1.0"/>
                <ellipse class="svg-fight-cat-pupil" cx="29" cy="23.3" rx="0.8" ry="1.0"/>
                <!-- Cat nose + mouth -->
                <ellipse class="svg-fight-cat-nose" cx="26" cy="26.5" rx="1" ry="0.6"/>
                <path class="svg-fight-cat-mouth" d="M26 27.1 Q25.3 28.2 24.5 27.8" stroke-width="0.5"/>
                <path class="svg-fight-cat-mouth" d="M26 27.1 Q26.7 28.2 27.5 27.8" stroke-width="0.5"/>
                <!-- Cat whiskers -->
                <line class="svg-fight-cat-whisker" x1="21" y1="25.5" x2="14" y2="24.5" stroke-width="0.4"/>
                <line class="svg-fight-cat-whisker" x1="21" y1="26.5" x2="14" y2="27" stroke-width="0.4"/>
                <line class="svg-fight-cat-whisker" x1="31" y1="25.5" x2="36" y2="24.5" stroke-width="0.4"/>
                <line class="svg-fight-cat-whisker" x1="31" y1="26.5" x2="36" y2="27" stroke-width="0.4"/>
                <!-- Cat arms (punching) -->
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
                <!-- Dog tail -->
                <path class="svg-fight-dog-tail" d="M72 36 Q78 28 75 22 Q74 19 72 21" stroke-width="1.8"/>
                <!-- Dog body -->
                <ellipse class="svg-fight-dog-body" cx="62" cy="38" rx="10" ry="7"/>
                <!-- Dog left leg -->
                <path class="svg-fight-dog-leg" d="M56 44 L54 54 Q54 56 56 56 L57 56" stroke-width="0"/>
                <!-- Dog right leg -->
                <path class="svg-fight-dog-leg" d="M66 44 L68 54 Q68 56 66 56 L65 56" stroke-width="0"/>
                <!-- Dog head -->
                <circle class="svg-fight-dog-head" cx="54" cy="24" r="8"/>
                <!-- Dog ears (floppy, corgi-style) -->
                <path class="svg-fight-dog-ear" d="M47 20 Q44 13 47 17 L49 20" stroke-width="0"/>
                <path class="svg-fight-dog-ear" d="M59 20 Q62 13 61 17 L59 20" stroke-width="0"/>
                <!-- Dog ear fills -->
                <ellipse class="svg-fight-dog-ear" cx="47.5" cy="17" rx="2.5" ry="4" transform="rotate(-10 47.5 17)"/>
                <ellipse class="svg-fight-dog-ear" cx="60.5" cy="17" rx="2.5" ry="4" transform="rotate(10 60.5 17)"/>
                <!-- Dog eyes -->
                <ellipse class="svg-fight-dog-eye" cx="51.5" cy="23" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-dog-eye" cx="56.5" cy="23" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-dog-pupil" cx="51" cy="23.3" rx="0.8" ry="1.0"/>
                <ellipse class="svg-fight-dog-pupil" cx="56" cy="23.3" rx="0.8" ry="1.0"/>
                <!-- Dog nose (bigger, rounder) -->
                <ellipse class="svg-fight-dog-nose" cx="54" cy="27" rx="1.5" ry="1"/>
                <!-- Dog mouth -->
                <path class="svg-fight-dog-mouth" d="M54 28 Q52.5 29.5 51.5 29" stroke-width="0.6"/>
                <!-- Dog snout outline -->
                <path class="svg-fight-dog-snout" d="M51 25.5 Q54 30 57 25.5" stroke-width="0.5"/>
                <!-- Dog arms (punching) -->
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
  `,
  emits: ['new-conversation', 'resume-conversation', 'open-settings'],
  setup() {
    const store = Pinia.useChatStore();
    const containerRef = Vue.ref(null);

    // Online agents
    const onlineAgents = Vue.computed(() => {
      return store.agents.filter(a => a.online);
    });

    // Turn aggregation: group flat messages into turn groups
    const turnGroups = Vue.computed(() => {
      const messages = store.messages;
      const result = [];
      let currentTurn = null;
      let turnCounter = 0;

      const finishTurn = () => {
        if (currentTurn) {
          // Skip empty turns (no text, no tools, no todo, no ask)
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

        if (msg.type === 'assistant') {
          if (!currentTurn) startTurn();
          if (msg.content) {
            currentTurn.textContent += msg.content;
          }
          if (msg.isStreaming) {
            currentTurn.isStreaming = true;
          }
          currentTurn.messages.push(msg);
          continue;
        }

        if (msg.type === 'tool-use') {
          if (!currentTurn) startTurn();

          // Merge tool-result from next message
          const nextMsg = messages[i + 1];
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

        // Unknown type: pass through
        finishTurn();
        result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
      }

      finishTurn();
      return result;
    });

    // Track if user is at bottom (within threshold)
    const isAtBottom = Vue.ref(true);
    const SCROLL_THRESHOLD = 50;

    const hasStreamingMessage = Vue.computed(() => {
      return store.messages.some(m => m.isStreaming);
    });

    // Show typing dots when AI is processing but hasn't started streaming text yet
    const showTypingDots = Vue.computed(() => {
      return store.isProcessing && !hasStreamingMessage.value;
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
    const checkIfAtBottom = () => {
      if (!containerRef.value) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.value;
      return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    };

    const onScroll = () => {
      isAtBottom.value = checkIfAtBottom();

      if (containerRef.value) {
        const { scrollTop } = containerRef.value;
        if (scrollTop < 100 && store.hasMoreMessages && !store.loadingMoreMessages) {
          const prevScrollHeight = containerRef.value.scrollHeight;
          store.loadMoreMessages();

          const unwatch = Vue.watch(
            () => store.loadingMoreMessages,
            (loading) => {
              if (!loading) {
                Vue.nextTick(() => {
                  if (containerRef.value) {
                    const newScrollHeight = containerRef.value.scrollHeight;
                    containerRef.value.scrollTop = newScrollHeight - prevScrollHeight + scrollTop;
                  }
                });
                unwatch();
              }
            }
          );
        }
      }
    };

    const scrollToBottom = () => {
      if (containerRef.value) {
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
        isAtBottom.value = true;
      }
    };

    const smartScrollToBottom = () => {
      if (isAtBottom.value) {
        Vue.nextTick(scrollToBottom);
      }
    };

    Vue.watch(() => store.messages.length, smartScrollToBottom);
    Vue.watch(() => store.messages[store.messages.length - 1]?.content, smartScrollToBottom);
    Vue.watch(showTypingDots, (show) => { if (show) smartScrollToBottom(); });
    Vue.watch(
      () => store.currentConversation,
      () => {
        isAtBottom.value = true;
        Vue.nextTick(scrollToBottom);
      }
    );

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
    });

    return {
      store,
      containerRef,
      hasStreamingMessage,
      showTypingDots,
      waitingStatus,
      refreshSession,
      onlineAgents,
      turnGroups
    };
  }
};
