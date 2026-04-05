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
          <span class="svg-fight-scene" aria-hidden="true">
            <svg viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg">
              <!-- Cat (left, facing right) -->
              <g class="svg-fight-cat">
                <!-- Cat tail (long, curved) -->
                <path class="svg-fight-cat-tail" d="M8 38 Q2 30 4 22 Q5 19 7 21" stroke-width="1.8"/>
                <!-- Cat body -->
                <ellipse class="svg-fight-cat-body" cx="18" cy="38" rx="10" ry="7"/>
                <!-- Cat legs -->
                <path class="svg-fight-cat-leg" d="M12 44 L10 54 Q10 56 12 56 L13 56" stroke-width="0"/>
                <path class="svg-fight-cat-leg" d="M22 44 L24 54 Q24 56 22 56 L21 56" stroke-width="0"/>
                <!-- Cat head (round) -->
                <circle class="svg-fight-cat-head" cx="26" cy="24" r="8"/>
                <!-- Cat ears (pointy triangles) -->
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
                <!-- Dog tail (short, curly stub) -->
                <path class="svg-fight-dog-tail" d="M73 35 Q76 33 76 30 Q75 28 73 30" stroke-width="2"/>
                <!-- Dog body (longer, lower — corgi proportions) -->
                <ellipse class="svg-fight-dog-body" cx="62" cy="38" rx="11" ry="6.5"/>
                <!-- Dog legs (short, stubby — corgi style) -->
                <path class="svg-fight-dog-leg" d="M55 43 L54 52 Q54 54 56 54 L57 54" stroke-width="0"/>
                <path class="svg-fight-dog-leg" d="M67 43 L68 52 Q68 54 66 54 L65 54" stroke-width="0"/>
                <!-- Dog head (slightly wider, with snout protruding left) -->
                <ellipse class="svg-fight-dog-head" cx="53" cy="24" rx="8" ry="7.5"/>
                <!-- Dog snout (protruding, rounded) -->
                <ellipse class="svg-fight-dog-snout" cx="47" cy="27" rx="4" ry="3"/>
                <!-- Dog ears (large, rounded, upright — corgi style) -->
                <ellipse class="svg-fight-dog-ear" cx="48" cy="14" rx="3.5" ry="5.5" transform="rotate(-15 48 14)"/>
                <ellipse class="svg-fight-dog-ear" cx="59" cy="14" rx="3.5" ry="5.5" transform="rotate(15 59 14)"/>
                <!-- Dog eyes -->
                <ellipse class="svg-fight-dog-eye" cx="50.5" cy="22.5" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-dog-eye" cx="55.5" cy="22.5" rx="1.5" ry="1.8"/>
                <ellipse class="svg-fight-dog-pupil" cx="50" cy="22.8" rx="0.8" ry="1.0"/>
                <ellipse class="svg-fight-dog-pupil" cx="55" cy="22.8" rx="0.8" ry="1.0"/>
                <!-- Dog nose (bigger, dark, at tip of snout) -->
                <ellipse class="svg-fight-dog-nose" cx="45" cy="26.5" rx="1.8" ry="1.2"/>
                <!-- Dog mouth -->
                <path class="svg-fight-dog-mouth" d="M45 27.7 Q44 29 43 28.5" stroke-width="0.6"/>
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
