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
              <path class="svg-dog-leash svg-dog-leash-l" :d="leashPathL" stroke-width="0.8"/>
              <!-- Spike (left, big dog, faces right) -->
              <g :transform="'translate(' + spikeX + ', 0)'">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group"><path class="svg-dog-tail" d="M-1 13 Q-3 9 -1 6" stroke-width="2.2"/></g>
                  <g class="svg-dog-leg-bl"><path class="svg-dog-leg" d="M2 18 L1 24 Q1 25.5 2.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br"><path class="svg-dog-leg" d="M4 18 L3 24 Q3 25.5 4.5 25.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="8" cy="14" rx="7" ry="5"/>
                  <g class="svg-dog-leg-fl"><path class="svg-dog-leg" d="M13 18 L14 24 Q14 25.5 12.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr"><path class="svg-dog-leg" d="M11 18 L12 24 Q12 25.5 10.5 25.5" stroke-width="0"/></g>
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
              <!-- Snap FX (center) -->
              <g class="svg-dog-snap-fx">
                <line class="svg-dog-snap-line" x1="56" y1="8" x2="64" y2="18"/>
                <line class="svg-dog-snap-line" x1="64" y1="8" x2="56" y2="18"/>
              </g>
              <!-- Right post -->
              <rect class="svg-dog-post" x="117" y="18" width="2" height="8" rx="0.5"/>
              <!-- Right leash (Teddy) -->
              <path class="svg-dog-leash svg-dog-leash-r" :d="leashPathR" stroke-width="0.8"/>
              <!-- Teddy (right, small dog, faces left = scaleX -1) -->
              <g :transform="'translate(' + teddyX + ', 2) scale(-1, 1)'">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group"><path class="svg-dog-tail" d="M-1 11 Q-3 7 -1 5 Q1 3 0 6" stroke-width="1.5"/></g>
                  <g class="svg-dog-leg-bl"><path class="svg-dog-leg" d="M2 14 L1.5 22 Q1.5 23.5 3 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br"><path class="svg-dog-leg" d="M3.5 14 L3 22 Q3 23.5 4.5 23.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="6" cy="12" rx="5" ry="3.5"/>
                  <g class="svg-dog-leg-fl"><path class="svg-dog-leg" d="M10 14 L10.5 22 Q10.5 23.5 9 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr"><path class="svg-dog-leg" d="M8.5 14 L9 22 Q9 23.5 7.5 23.5" stroke-width="0"/></g>
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
    const dogPhase = Vue.ref('bark');
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
      const elapsed = (now.value - typingStartTime.value) % 14000;

      if (elapsed < 3000) {
        // 0-3s: bark at edges
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark';
      } else if (elapsed < 8000) {
        // 3-8s: approach center
        const t = (elapsed - 3000) / 5000;
        dogPosL.value = 5 + t * 37; dogPosR.value = 95 - t * 37;
        dogPhase.value = 'approach';
      } else if (elapsed < 9000) {
        // 8-9s: leash snaps, stumble forward
        const t = (elapsed - 8000) / 1000;
        dogPosL.value = 42 + t * 6; dogPosR.value = 58 - t * 6;
        dogPhase.value = 'snap';
      } else if (elapsed < 11000) {
        // 9-11s: stunned
        dogPosL.value = 48; dogPosR.value = 52; dogPhase.value = 'stunned';
      } else {
        // 11-14s: retreat to edges
        const t = (elapsed - 11000) / 3000;
        dogPosL.value = 48 - t * 43; dogPosR.value = 52 + t * 43;
        dogPhase.value = 'retreat';
      }
      dogRafId = requestAnimationFrame(updateDogWalk);
    }

    // Dog computed properties — map 0-100% position to SVG viewBox x coordinates
    const spikeX = Vue.computed(() => dogPosL.value * 1.14);
    const teddyX = Vue.computed(() => dogPosR.value * 1.14 + 16);
    const leashPathL = Vue.computed(() => {
      const dx = dogPosL.value * 1.14 + 13;
      const sag = Math.max(0, (dx - 3) * 0.15);
      return `M3,22 Q${(3 + dx) / 2},${22 + sag} ${dx},10`;
    });
    const leashPathR = Vue.computed(() => {
      const dx = dogPosR.value * 1.14 + 3;
      const sag = Math.max(0, (118 - dx) * 0.15);
      return `M118,22 Q${(118 + dx) / 2},${22 + sag} ${dx},10`;
    });
    const questionLX = Vue.computed(() => dogPosL.value * 1.14 + 10);
    const questionRX = Vue.computed(() => dogPosR.value * 1.14 + 6);

    // Preview mode: ?preview=cat|dog|animation forces typing indicator permanently
    const previewShowTypingDots = Vue.computed(() => {
      if (urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation') return true;
      return showTypingDots.value;
    });

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        typingStartTime.value = Date.now();
        now.value = Date.now();
        // Randomly choose animation type
        animationType.value = Math.random() < 0.5 ? 'cat' : 'dog';
        catPosition.value = 0;
        catDirection.value = 1;
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark';
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
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark';
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
    Vue.watch(previewShowTypingDots, (show) => { if (show) smartScrollToBottom(); });
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
      if (catRafId) { cancelAnimationFrame(catRafId); catRafId = null; }
      if (dogRafId) { cancelAnimationFrame(dogRafId); dogRafId = null; }
    });

    return {
      store,
      containerRef,
      hasStreamingMessage,
      showTypingDots,
      previewShowTypingDots,
      waitingStatus,
      animationType,
      catSpeed,
      catStyle,
      dogPhase,
      spikeX,
      teddyX,
      leashPathL,
      leashPathR,
      questionLX,
      questionRX,
      refreshSession,
      onlineAgents,
      turnGroups
    };
  }
};
