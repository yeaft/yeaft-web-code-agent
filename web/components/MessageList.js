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
          <span class="svg-running-cat" :class="catSpeed" aria-hidden="true">
            <svg viewBox="0 0 36 28" xmlns="http://www.w3.org/2000/svg">
              <!-- Tail -->
              <g class="svg-cat-tail-group">
                <path class="svg-cat-tail" d="M5 16 Q0 11 2 5 Q3 2 5 4" stroke-width="2"/>
              </g>
              <!-- Back legs -->
              <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 20 L8 25 Q8 26.5 9.5 26.5 L10.5 26.5" stroke-width="0"/></g>
              <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 20 L6 25 Q6 26.5 7.5 26.5 L8.5 26.5" stroke-width="0"/></g>
              <!-- Body (shorter, rounder) -->
              <ellipse class="svg-cat-body" cx="15" cy="17" rx="7.5" ry="5"/>
              <!-- Front legs -->
              <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M21 20 L23 25 Q23 26.5 21.5 26.5 L20.5 26.5" stroke-width="0"/></g>
              <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M19 20 L21 25 Q21 26.5 19.5 26.5 L18.5 26.5" stroke-width="0"/></g>
              <!-- Blur legs for turbo (shimmer) + crazy (rotate) — centered under body, hidden by default -->
              <ellipse class="svg-cat-leg-blur" cx="12.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur" cx="17.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="14" cy="22" rx="1.5" ry="1"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="16" cy="22" rx="1.5" ry="1"/>
              <!-- Head (bigger, more chibi) -->
              <circle class="svg-cat-head" cx="24" cy="10" r="7"/>
              <!-- Ears (taller, pointier) -->
              <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="18,8 20,0 23,7"/></g>
              <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,7 28,0 30,8"/></g>
              <!-- Inner ears (pink patches) -->
              <polygon class="svg-cat-inner-ear" points="19,7.5 20.5,1.5 22,6.5"/>
              <polygon class="svg-cat-inner-ear" points="26,6.5 27.5,1.5 29,7.5"/>
              <!-- Eyes (bigger, rounder, cuter) -->
              <ellipse class="svg-cat-eye" cx="21.5" cy="9.5" rx="2" ry="2.2"/>
              <ellipse class="svg-cat-eye" cx="27" cy="9.5" rx="2" ry="2.2"/>
              <ellipse class="svg-cat-pupil" cx="22" cy="9.8" rx="1.1" ry="1.3"/>
              <ellipse class="svg-cat-pupil" cx="27.5" cy="9.8" rx="1.1" ry="1.3"/>
              <!-- Eye shine -->
              <circle class="svg-cat-eye-shine" cx="21.2" cy="8.8" r="0.6"/>
              <circle class="svg-cat-eye-shine" cx="26.7" cy="8.8" r="0.6"/>
              <!-- Nose -->
              <path class="svg-cat-nose" d="M23.5 12.5 L24.2 13.2 L25 12.5 Z"/>
              <!-- Mouth (cute W shape) -->
              <path class="svg-cat-mouth" d="M23 13.5 Q24.2 14.8 24.2 13.5" stroke-width="0.5"/>
              <path class="svg-cat-mouth" d="M24.3 13.5 Q24.3 14.8 25.5 13.5" stroke-width="0.5"/>
              <!-- Whiskers -->
              <line class="svg-cat-whisker" x1="19.5" y1="12" x2="14" y2="11" stroke-width="0.4"/>
              <line class="svg-cat-whisker" x1="19.5" y1="13" x2="14" y2="13.5" stroke-width="0.4"/>
              <line class="svg-cat-whisker" x1="29" y1="12" x2="34" y2="11" stroke-width="0.4"/>
              <line class="svg-cat-whisker" x1="29" y1="13" x2="34" y2="13.5" stroke-width="0.4"/>
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
          // Skip empty turns (no text, no tools, no todo, no ask, no images)
          if (currentTurn.textContent || currentTurn.toolMsgs.length > 0 || currentTurn.todoMsg || currentTurn.askMsg || currentTurn.imageMsgs.length > 0) {
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
          imageMsgs: [],
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

        if (msg.type === 'chat-image') {
          if (!currentTurn) startTurn();
          currentTurn.imageMsgs.push(msg);
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

    // Cat running speed based on waiting time (4 tiers, every 2s)
    const catSpeed = Vue.computed(() => {
      if (!typingStartTime.value) return 'speed-normal';
      const elapsed = now.value - typingStartTime.value;
      if (elapsed >= 6000) return 'speed-crazy';
      if (elapsed >= 4000) return 'speed-turbo';
      if (elapsed >= 2000) return 'speed-fast';
      return 'speed-normal';
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
      catSpeed,
      refreshSession,
      onlineAgents,
      turnGroups
    };
  }
};
