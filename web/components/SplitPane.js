/**
 * SplitPane — one pane in split-screen mode.
 * Each pane has: ChatHeader + content area (column layout).
 *
 * Key design: SplitPane does NOT modify global store.currentConversation.
 * Instead, it reads its own conversation from store.splitPanes and passes
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
    <div class="split-pane">
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
                    <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />
                  </template>
                  <div v-if="showTypingDots" class="typing-indicator">
                    <span></span><span></span><span></span>
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

      <!-- Empty state: no conversation selected — inline session list -->
      <div v-else class="pane-empty-state">
        <div class="pane-empty-icon">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <rect width="48" height="48" rx="12" fill="var(--accent)" opacity="0.15"/>
            <path d="M12 16l6 6-6 6" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <path d="M21 28h15" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round"/>
          </svg>
        </div>
        <p class="pane-empty-text">{{ $t('splitScreen.selectSession') }}</p>

        <!-- Inline session list -->
        <div class="pane-session-list" v-if="emptyChatConvs.length > 0 || emptyCrewConvs.length > 0">
          <div class="pane-session-group" v-if="emptyChatConvs.length > 0">
            <div class="pane-session-label">{{ $t('chat.sidebar.recentChats') }}</div>
            <div
              v-for="conv in emptyChatConvs"
              :key="conv.id"
              class="pane-session-item"
              @click="onEmptySessionClick(conv)"
            >
              <svg class="pane-session-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
              <span class="pane-session-title">{{ getEmptyConvTitle(conv) }}</span>
              <span class="pane-session-time">{{ getEmptyConvTime(conv) }}</span>
            </div>
          </div>
          <div class="pane-session-group" v-if="emptyCrewConvs.length > 0">
            <div class="pane-session-label">Crew Sessions</div>
            <div
              v-for="conv in emptyCrewConvs"
              :key="conv.id"
              class="pane-session-item"
              @click="onEmptySessionClick(conv)"
            >
              <svg class="pane-session-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              <span class="pane-session-title">{{ conv.name || 'Crew Session' }}</span>
              <span class="pane-session-time">{{ getEmptyConvTime(conv) }}</span>
            </div>
          </div>
        </div>

        <!-- No sessions at all -->
        <p v-else class="pane-empty-hint">{{ $t('splitScreen.noSessions') }}</p>
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const containerRef = Vue.ref(null);

    // Current pane's conversation ID
    const conversationId = Vue.computed(() => {
      const pane = store.splitPanes.find(p => p.id === props.paneId);
      return pane?.conversationId || null;
    });

    // Is this a crew conversation?
    const isCrew = Vue.computed(() => {
      if (!conversationId.value) return false;
      const conv = store.conversations.find(c => c.id === conversationId.value);
      return conv?.type === 'crew';
    });

    // Messages for this pane
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

    // Per-pane send function
    const sendFn = (text, attachmentInfos) => {
      if (!conversationId.value) return;
      const attachments = attachmentInfos || [];
      store.sendMessageToConversation(conversationId.value, text, attachments);
    };

    // Per-pane cancel function
    const cancelFn = () => {
      if (!conversationId.value) return;
      store.cancelExecutionForConversation(conversationId.value);
    };

    // Close this pane
    function closePane() {
      store.removePane(props.paneId);
    }

    // Right panel state for this pane
    const paneRightPanel = Vue.computed(() => {
      return store.getPaneRightPanel(props.paneId);
    });

    function closePanePanel() {
      store.setPaneRightPanel(props.paneId, null);
    }

    // Session lists for empty state
    const emptyChatConvs = Vue.computed(() => {
      return [...store.conversations.filter(c => c.type !== 'crew')]
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    const emptyCrewConvs = Vue.computed(() => {
      return [...store.conversations.filter(c => c.type === 'crew')]
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    function getEmptyConvTitle(conv) {
      if (conv.type === 'crew') return conv.name || 'Crew Session';
      const cachedTitle = store.getConversationTitle(conv.id);
      if (cachedTitle) return cachedTitle.length > 40 ? cachedTitle.slice(0, 40) + '...' : cachedTitle;
      if (conv.claudeSessionId) return conv.claudeSessionId.slice(0, 8) + '...';
      return conv.id.slice(0, 8) + '...';
    }

    function getEmptyConvTime(conv) {
      const execStatus = store.executionStatusMap[conv.id];
      const ts = execStatus?.lastActivity || conv.createdAt;
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      const diffMs = now - date;
      if (diffMs < 60000) return 'now';
      if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm';
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    }

    function onEmptySessionClick(conv) {
      store.setPaneConversation(props.paneId, conv.id);
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
      conversationId,
      isCrew,
      messages,
      isProcessing,
      showTypingDots,
      turnGroups,
      sendFn,
      cancelFn,
      closePane,
      paneRightPanel,
      closePanePanel,
      emptyChatConvs,
      emptyCrewConvs,
      getEmptyConvTitle,
      getEmptyConvTime,
      onEmptySessionClick
    };
  }
};
