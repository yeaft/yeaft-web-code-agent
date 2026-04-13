import ChatInput from './ChatInput.js';
import { renderMarkdown } from '../utils/markdown.js';

export default {
  name: 'UnifyPage',
  components: { ChatInput },
  template: `
    <div class="unify-page">
      <!-- Top Bar -->
      <div class="unify-topbar">
        <button class="unify-back-btn" @click="goBack" :title="$t('unify.back')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          <span class="unify-back-text">{{ $t('unify.back') }}</span>
        </button>

        <div class="unify-mode-toggle">
          <button class="unify-mode-btn active">{{ $t('unify.chat') }}</button>
          <button class="unify-mode-btn" disabled :title="'Coming soon'">{{ $t('unify.work') }}</button>
        </div>

        <div class="unify-topbar-right">
          <span class="unify-model-badge" v-if="store.unifyModel">{{ store.unifyModel }}</span>
          <button
            class="unify-clear-btn"
            @click="clearMessages"
            v-if="store.unifyMessages.length > 0"
            :title="$t('unify.clearConfirm')"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>

      <!-- Messages Area -->
      <div class="unify-messages" ref="messagesRef">
        <!-- Welcome when empty -->
        <div class="unify-welcome" v-if="store.unifyMessages.length === 0 && !store.unifyProcessing">
          <div class="unify-welcome-icon">
            <svg viewBox="0 0 48 48" width="56" height="56">
              <rect width="48" height="48" rx="12" fill="#d97706"/>
              <path d="M14 15l5 5-5 5" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              <path d="M22 25h12" stroke="white" stroke-width="3" stroke-linecap="round"/>
            </svg>
          </div>
          <h2 class="unify-welcome-title">Yeaft Unify</h2>
          <p class="unify-welcome-sub">{{ $t('unify.placeholder') }}</p>
        </div>

        <!-- Message list -->
        <template v-for="(msg, index) in store.unifyMessages" :key="index">
          <div :class="['unify-msg', 'unify-msg-' + msg.role, msg.isError && 'unify-msg-error']">
            <div class="unify-msg-avatar">
              <span v-if="msg.role === 'user'" class="unify-avatar-user">U</span>
              <span v-else class="unify-avatar-assistant">A</span>
            </div>
            <div class="unify-msg-body">
              <div v-if="msg.role === 'user'" class="unify-msg-content">{{ msg.content }}</div>
              <div v-else class="unify-msg-content unify-md" v-html="renderMd(msg.content)"></div>
            </div>
          </div>
        </template>

        <!-- Streaming message -->
        <div class="unify-msg unify-msg-assistant unify-msg-streaming" v-if="store.unifyCurrentText">
          <div class="unify-msg-avatar">
            <span class="unify-avatar-assistant">A</span>
          </div>
          <div class="unify-msg-body">
            <div class="unify-msg-content unify-md" v-html="renderMd(store.unifyCurrentText)"></div>
          </div>
        </div>

        <!-- Typing dots when processing but no text yet -->
        <div class="unify-msg unify-msg-assistant" v-if="store.unifyProcessing && !store.unifyCurrentText">
          <div class="unify-msg-avatar">
            <span class="unify-avatar-assistant">A</span>
          </div>
          <div class="unify-msg-body">
            <div class="unify-typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Input Area -->
      <ChatInput
        :send-fn="sendMessage"
        :show-stop="store.unifyProcessing"
        placeholder-key="unify.placeholder"
      />
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const messagesRef = Vue.ref(null);

    const goBack = () => {
      store.leaveUnify();
    };

    const sendMessage = (text) => {
      store.sendUnifyChat(text);
    };

    const clearMessages = () => {
      if (confirm(store.$t?.('unify.clearConfirm') || 'Clear all messages?')) {
        store.clearUnifyMessages();
      }
    };

    const renderMd = (text) => {
      if (!text) return '';
      return renderMarkdown(text);
    };

    // Auto-scroll to bottom when messages change
    const scrollToBottom = () => {
      Vue.nextTick(() => {
        const el = messagesRef.value;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    };

    Vue.watch(() => store.unifyMessages.length, scrollToBottom);
    Vue.watch(() => store.unifyCurrentText, scrollToBottom);

    return {
      store,
      messagesRef,
      goBack,
      sendMessage,
      clearMessages,
      renderMd
    };
  }
};
