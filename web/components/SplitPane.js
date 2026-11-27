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
import ExpertPanel from './ExpertPanel.js';
import SubAgentPanel from './SubAgentPanel.js';
import { appendTurnResponseSegment, finalizeTurnResponseSegments } from '../utils/turn-response.js';
import { readWaitClock } from '../utils/wait-clock.js';
import { workbenchRouteKey } from '../utils/workbench-route.js';
import { pickWaitingAnimation, waitingAnimation } from './waiting/index.js';

export default {
  name: 'SplitPane',
  components: { ChatHeader, MessageItem, AssistantTurn, ChatInput, ExpertPanel, SubAgentPanel },
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
          <div class="chat-body" :class="{ 'expert-panel-open': paneRightPanel }">
            <div class="chat-body-main">
              <!-- Inline message list (avoids modifying MessageList.js) -->
              <main class="chat-container split-pane-messages" ref="containerRef">
                <div class="messages">
                  <template v-for="item in turnGroups" :key="item.id">
                    <MessageItem v-if="item.type === 'user' || item.type === 'system' || item.type === 'error'" :message="item.message" />
                    <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" :conversationId="conversationId" />
                  </template>
                  <div v-if="previewShowTypingDots" class="typing-indicator" :class="[animation ? 'is-' + animation.layout : '', waitingStatus ? ('status-' + waitingStatus) : '']">
                    <component v-if="animation" :is="animation.component" :clock-key="waitClockKey" :status="waitingStatus || ''" />
                    <template v-else><span></span><span></span><span></span></template>
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
                :conversationId="conversationId"
                :canvas-route-key="paneRouteKey"
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

    // Exact Workbench route key for this pane's conversation (never falls back to global route)
    const paneRouteKey = Vue.computed(() => {
      const convId = conversationId.value;
      if (!convId) return '';
      const conv = store.conversations.find(c => c?.id === convId && c.type !== 'yeaft');
      if (!conv) return '';
      return workbenchRouteKey({
        runtimeProvider: conv.provider === 'copilot' ? 'copilot' : 'claude-code',
        agentId: conv.agentId || store.currentAgent || null,
        sessionId: convId,
      }) || '';
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

    // Animation showing in the indicator: an entry of components/waiting,
    // picked once per turn. With none, the indicator shows three dots.
    const animationType = Vue.ref('none');
    const animation = Vue.computed(() => waitingAnimation(animationType.value));
    const urlPreview = new URLSearchParams(window.location.search).get('preview');
    // Identity of the wait this pane shows; see wait-clock.js.
    const waitClockKey = Vue.computed(() => `pane\u001f${conversationId.value || ''}`);

    // Preview mode: ?preview=<animation id> (or "animation") keeps the indicator on.
    const isPreviewMode = urlPreview === 'animation' || !!waitingAnimation(urlPreview);
    const previewShowTypingDots = Vue.computed(() => {
      if (isPreviewMode) return true;
      return showTypingDots.value;
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
    Vue.watch(() => isProcessing.value, (processing) => { if (!processing) turnAnimation = null; });
    Vue.watch(waitClockKey, () => { turnAnimation = null; });
    // A change in Settings applies to the wait already on screen.
    Vue.watch(() => store.waitingAnimation, () => {
      turnAnimation = null;
      if (showTypingDots.value) startWaitingAnimation();
    });

    Vue.watch(showTypingDots, (show) => {
      if (show) {
        typingStartTime.value = Date.now();
        now.value = Date.now();
        if (!typingTimer) {
          typingTimer = setInterval(() => {
            now.value = Date.now();
          }, 1000);
        }
        startWaitingAnimation();
      } else {
        typingStartTime.value = 0;
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      }
    }, { immediate: true });

    // Preview mode initialization
    if (isPreviewMode) {
      typingStartTime.value = Date.now();
      now.value = Date.now();
      startWaitingAnimation();
    }

    Vue.onUnmounted(() => {
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    });

    // Event-driven waiting status
    const waitingStatus = Vue.computed(() => {
      if (!isProcessing.value) return null;
      if (store.connectionState !== 'connected' && store.connectionNoticeVisible !== false) return 'disconnected';
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
          currentTurn.isActive = currentTurn.isStreaming === true;
          finalizeTurnResponseSegments(currentTurn);
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
          textSegments: [],
          isStreaming: false,
          isActive: false,
          isHistory: false,
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
          appendTurnResponseSegment(currentTurn, msg);
          if (msg.isStreaming) currentTurn.isStreaming = true;
          if (msg.isHistory) currentTurn.isHistory = true;
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
      if (!conversationId.value) return false;
      const attachments = attachmentInfos || [];
      return store.sendMessageToConversation(conversationId.value, text, attachments);
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
      paneRouteKey,
      messages,
      isProcessing,
      showTypingDots,
      previewShowTypingDots,
      waitingStatus,
      animation,
      waitClockKey,
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
