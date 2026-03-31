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
        @toggle-pane-sidebar="paneSidebarOpen = !paneSidebarOpen"
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
                      <button class="typing-refresh-btn" @click="refreshSession">{{ $t('chat.waiting.refresh') }}</button>
                    </span>
                    <span v-else-if="waitingStatus === 'cli-exited'" class="typing-status-text typing-status-warn">
                      {{ $t('chat.waiting.cliExited') }}
                      <button class="typing-refresh-btn" @click="refreshSession">{{ $t('chat.waiting.refresh') }}</button>
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
        <p class="pane-empty-text">{{ $t('splitScreen.selectSession') }}</p>
        <button class="pane-empty-open-btn" @click="paneSidebarOpen = true">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          {{ $t('splitScreen.openSessionList') }}
        </button>
      </div>

      <!-- Pane sidebar overlay -->
      <div class="pane-sidebar-overlay" v-if="paneSidebarOpen" @click="paneSidebarOpen = false"></div>

      <!-- Pane sidebar panel -->
      <div class="pane-sidebar" :class="{ open: paneSidebarOpen }">
        <div class="pane-sidebar-header">
          <span>{{ $t('splitScreen.selectSession') }}</span>
          <button class="pane-sidebar-close" @click="paneSidebarOpen = false">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="pane-sidebar-body">
          <!-- Chat Sessions -->
          <div class="session-panel" v-if="paneChatConvs.length > 0">
            <div class="session-group-header">
              <div class="session-group-title-area">
                <svg class="session-group-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                <span>{{ $t('chat.sidebar.recentChats') }}</span>
              </div>
            </div>
            <div class="session-panel-list">
              <div
                v-for="conv in paneChatConvs"
                :key="conv.id"
                class="session-item"
                :class="{ active: conv.id === conversationId, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false, occupied: isOccupiedByOtherPane(conv.id) }"
                @click="editingChatId !== conv.id && onSidebarSessionClick(conv)"
              >
                <div class="session-item-header">
                  <div class="title">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <input
                      v-if="editingChatId === conv.id"
                      ref="chatRenameInput"
                      class="chat-rename-input"
                      v-model="editingChatName"
                      @keydown.enter="commitChatRename"
                      @keydown.escape="cancelChatRename"
                      @blur="commitChatRename"
                      @click.stop
                    />
                    <span v-else>{{ getConvTitle(conv) }}</span>
                  </div>
                  <span class="session-time">{{ getConvTime(conv) }}</span>
                  <button class="session-rename-btn" @click.stop="startChatRename(conv)">
                    <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                  </button>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="pane-occupied-tag" v-if="isOccupiedByOtherPane(conv.id)">{{ $t('splitScreen.occupied') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Crew Sessions -->
          <div class="session-panel" v-if="paneCrewConvs.length > 0">
            <div class="session-group-header">
              <div class="session-group-title-area">
                <svg class="session-group-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                <span>Crew Sessions</span>
              </div>
            </div>
            <div class="session-panel-list">
              <div
                v-for="conv in paneCrewConvs"
                :key="conv.id"
                class="session-item session-item-crew"
                :class="{ active: conv.id === conversationId, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false, occupied: isOccupiedByOtherPane(conv.id) }"
                @click="onSidebarSessionClick(conv)"
              >
                <div class="session-item-header">
                  <div class="title">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <svg class="crew-conv-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                    {{ conv.name || 'Crew Session' }}
                  </div>
                  <span class="session-time">{{ getConvTime(conv) }}</span>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="pane-occupied-tag" v-if="isOccupiedByOtherPane(conv.id)">{{ $t('splitScreen.occupied') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="paneChatConvs.length === 0 && paneCrewConvs.length === 0" class="pane-sidebar-empty">
            {{ $t('splitScreen.noSessions') }}
          </div>
        </div>
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

    // Event-driven waiting status (replaces time-based waitingPhase)
    const waitingStatus = Vue.computed(() => {
      if (!isProcessing.value) return null;
      if (store.connectionState !== 'connected') return 'disconnected';
      const convId = conversationId.value;
      if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'compacting') return 'compacting';
      const health = store.sessionHealth?.[convId];
      if (health) return health.status;
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

    // Pane sidebar state
    const paneSidebarOpen = Vue.ref(false);

    // Inline rename state
    const editingChatId = Vue.ref(null);
    const editingChatName = Vue.ref('');
    const chatRenameInput = Vue.ref(null);

    // Session lists (shared between sidebar and empty state)
    const paneChatConvs = Vue.computed(() => {
      return [...store.conversations.filter(c => c.type !== 'crew')]
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    const paneCrewConvs = Vue.computed(() => {
      return [...store.conversations.filter(c => c.type === 'crew')]
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    function getConvTitle(conv) {
      if (conv.type === 'crew') return conv.name || 'Crew Session';
      const cachedTitle = store.getConversationTitle(conv.id);
      if (cachedTitle) return cachedTitle.length > 30 ? cachedTitle.slice(0, 30) + '...' : cachedTitle;
      if (conv.claudeSessionId) return conv.claudeSessionId.slice(0, 8) + '...';
      return conv.id.slice(0, 8) + '...';
    }

    function getConvTime(conv) {
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

    function shortenPath(path) {
      if (!path) return '-';
      if (path.length <= 25) return path;
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return path;
      return '...' + parts.slice(-2).join('/');
    }

    function isOccupiedByOtherPane(convId) {
      return store.splitPanes.some(p => p.id !== props.paneId && p.conversationId === convId);
    }

    function onSidebarSessionClick(conv) {
      if (conv.agentOnline === false) return;
      if (isOccupiedByOtherPane(conv.id)) return;
      store.setPaneConversation(props.paneId, conv.id);
      paneSidebarOpen.value = false;
    }

    function startChatRename(conv) {
      editingChatId.value = conv.id;
      editingChatName.value = store.customConversationTitles[conv.id] || store.conversationTitles[conv.id] || '';
      Vue.nextTick(() => {
        const input = chatRenameInput.value;
        if (input) {
          const el = Array.isArray(input) ? input[0] : input;
          el.focus();
          el.select();
        }
      });
    }

    function commitChatRename() {
      if (!editingChatId.value) return;
      const convId = editingChatId.value;
      const title = editingChatName.value.trim();
      editingChatId.value = null;
      editingChatName.value = '';
      store.renameChatSession(convId, title);
    }

    function cancelChatRename() {
      editingChatId.value = null;
      editingChatName.value = '';
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
      closePane,
      paneRightPanel,
      closePanePanel,
      paneSidebarOpen,
      paneChatConvs,
      paneCrewConvs,
      getConvTitle,
      getConvTime,
      shortenPath,
      isOccupiedByOtherPane,
      onSidebarSessionClick,
      editingChatId,
      editingChatName,
      chatRenameInput,
      startChatRename,
      commitChatRename,
      cancelChatRename
    };
  }
};
