import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput, MessageList },
  template: `
    <div class="unify-page">
      <!-- Mobile sidebar overlay -->
      <div class="unify-sidebar-overlay" v-if="!sidebarCollapsed && isMobile" @click="sidebarCollapsed = true"></div>

      <!-- Left Sidebar -->
      <aside class="unify-sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="unify-sidebar-header">
          <button class="unify-back-btn" @click="goBack" :title="$t('unify.back')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            <span class="unify-back-text">{{ $t('unify.back') }}</span>
          </button>
        </div>

        <!-- Mode Toggle -->
        <div class="unify-sidebar-section">
          <div class="unify-section-label">{{ $t('unify.mode') }}</div>
          <div class="unify-mode-toggle">
            <button
              class="unify-mode-btn"
              :class="{ active: store.unifyMode === 'chat' }"
              @click="setMode('chat')"
            >{{ $t('unify.chat') }}</button>
            <button
              class="unify-mode-btn"
              :class="{ active: store.unifyMode === 'work' }"
              @click="setMode('work')"
            >{{ $t('unify.work') }}</button>
          </div>
        </div>

        <!-- Agent Info -->
        <div class="unify-sidebar-section" v-if="store.unifyModel || (store.unifyStatus && store.unifyStatus.tools > 0)">
          <div class="unify-section-label">{{ $t('unify.agent') }}</div>
          <div class="unify-agent-info">
            <div class="unify-agent-row" v-if="store.unifyModel">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.5-9.11 0-12.58 3.51-3.47 9.14-3.49 12.65-.06L21 3v7.12z"/></svg>
              <span>{{ store.unifyModel }}</span>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.tools > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
              <span>{{ store.unifyStatus.tools }} {{ $t('unify.tools') }}</span>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.skills > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              <span>{{ store.unifyStatus.skills }} {{ $t('unify.skills') }}</span>
            </div>
            <div class="unify-agent-row" v-if="store.unifyStatus && store.unifyStatus.mcpServers > 0">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              <span>{{ store.unifyStatus.mcpServers }} {{ $t('unify.mcp') }}</span>
            </div>
          </div>
        </div>
      </aside>

      <!-- Center Conversation -->
      <div class="unify-main">
        <!-- Conversation Header -->
        <div class="unify-topbar">
          <button class="unify-sidebar-toggle" @click="toggleSidebar" :title="sidebarCollapsed ? $t('unify.showSidebar') : $t('unify.hideSidebar')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <span class="unify-model-badge" v-if="store.unifyModel">{{ store.unifyModel }}</span>
          <div class="unify-topbar-right">
            <button
              class="unify-clear-btn"
              @click="clearMessages"
              v-if="hasMessages"
              :title="$t('unify.clearConfirm')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
            <button
              class="unify-detail-toggle"
              @click="toggleDetail"
              :title="detailCollapsed ? $t('unify.showDetail') : $t('unify.hideDetail')"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
            </button>
          </div>
        </div>

        <!-- Messages Area — reuse standard MessageList for identical rendering -->
        <MessageList />

        <!-- Input Area -->
        <ChatInput
          :send-fn="sendMessage"
          :show-stop="isProcessing"
          placeholder-key="unify.placeholder"
        />
      </div>

      <!-- Right Detail Panel (placeholder for future Tasks/Memory) -->
      <aside class="unify-detail" :class="{ collapsed: detailCollapsed }">
        <div class="unify-detail-placeholder">
          <svg viewBox="0 0 24 24" width="24" height="24" opacity="0.3"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          <span>{{ $t('unify.tasksMemory') }}</span>
          <span class="unify-detail-hint">{{ $t('unify.comingSoon') }}</span>
        </div>
      </aside>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();

    const sidebarCollapsed = Vue.ref(false);
    const detailCollapsed = Vue.ref(false);

    // Detect mobile for overlay behavior
    const isMobile = Vue.ref(window.innerWidth <= 768);
    const onResize = () => { isMobile.value = window.innerWidth <= 768; };
    Vue.onMounted(() => window.addEventListener('resize', onResize));
    Vue.onUnmounted(() => window.removeEventListener('resize', onResize));

    // Watch for conversationId changes (session_ready migrates local -> agent ID)
    Vue.watch(() => store.unifyConversationId, (newId) => {
      if (newId && store.activeConversations[0] !== newId) {
        store.activeConversations = [newId];
      }
    });

    const hasMessages = Vue.computed(() => {
      const convId = store.unifyConversationId;
      if (!convId) return false;
      const msgs = store.messagesMap[convId];
      return msgs && msgs.length > 0;
    });

    const isProcessing = Vue.computed(() => {
      const convId = store.unifyConversationId;
      return convId ? !!store.processingConversations[convId] : false;
    });

    const goBack = () => {
      store.leaveUnify();
    };

    const sendMessage = (text) => {
      store.sendUnifyChat(text);
    };

    const setMode = (mode) => {
      store.setUnifyMode(mode);
    };

    const clearMessages = () => {
      const { t } = Vue.getCurrentInstance().appContext.config.globalProperties;
      if (confirm(t('unify.clearConfirm'))) {
        store.clearUnifyMessages();
      }
    };

    const toggleSidebar = () => {
      sidebarCollapsed.value = !sidebarCollapsed.value;
    };

    const toggleDetail = () => {
      detailCollapsed.value = !detailCollapsed.value;
    };

    return {
      store,
      sidebarCollapsed,
      detailCollapsed,
      isMobile,
      hasMessages,
      isProcessing,
      goBack,
      sendMessage,
      setMode,
      clearMessages,
      toggleSidebar,
      toggleDetail,
    };
  }
};
