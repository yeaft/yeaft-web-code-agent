import ChatInput from './ChatInput.js';
import MessageList from './MessageList.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput, MessageList },
  template: `
    <div class="unify-page">
      <!-- Top Bar -->
      <div class="unify-topbar">
        <button class="unify-back-btn" @click="goBack" :title="$t('unify.back')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          <span class="unify-back-text">{{ $t('unify.back') }}</span>
        </button>

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

        <div class="unify-topbar-right">
          <span class="unify-model-badge" v-if="store.unifyModel">{{ store.unifyModel }}</span>
          <span class="unify-status-badge" v-if="store.unifyStatus && store.unifyStatus.tools > 0">
            {{ store.unifyStatus.tools }} tools
          </span>
          <button
            class="unify-clear-btn"
            @click="clearMessages"
            v-if="hasMessages"
            :title="$t('unify.clearConfirm')"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
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
  `,
  setup() {
    const store = Pinia.useChatStore();

    // Watch for conversationId changes (session_ready migrates local → agent ID)
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
      if (confirm('Clear all messages?')) {
        store.clearUnifyMessages();
      }
    };

    return {
      store,
      hasMessages,
      isProcessing,
      goBack,
      sendMessage,
      setMode,
      clearMessages,
    };
  }
};
