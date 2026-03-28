/**
 * SessionSelector — dropdown session picker for split-screen panes.
 * Replaces the sidebar's session list in split-screen mode.
 * Shows Chat and Crew conversations, plus quick-create buttons.
 */
export default {
  name: 'SessionSelector',
  props: {
    /** The pane ID this selector belongs to */
    paneId: { type: String, required: true },
    /** Currently selected conversation ID for this pane */
    conversationId: { type: String, default: null }
  },
  emits: ['select'],
  template: `
    <div class="session-selector" ref="selectorRef">
      <!-- Trigger button -->
      <button class="session-selector-trigger" @click.stop="toggleOpen">
        <span class="ss-icon">{{ currentIcon }}</span>
        <span class="ss-name" :class="{ placeholder: !conversationId }">{{ currentLabel }}</span>
        <svg class="ss-chevron" :class="{ open: isOpen }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>

      <!-- Dropdown panel (overlay) -->
      <div class="session-selector-dropdown" v-if="isOpen" @click.stop>
        <!-- Chat sessions -->
        <div class="ss-group" v-if="chatConversations.length > 0">
          <div class="session-group-header ss-group-header-compact">
            <span class="session-group-icon">💬</span>
            Chat
          </div>
          <div
            v-for="conv in chatConversations"
            :key="conv.id"
            class="session-item ss-session-item"
            :class="{ active: conv.id === conversationId, 'in-other-pane': isInOtherPane(conv.id) }"
            @click="selectConv(conv.id)"
          >
            <div class="session-item-header">
              <span class="title">{{ getConvTitle(conv) }}</span>
              <span class="ss-option-badge" v-if="isInOtherPane(conv.id)">{{ getPaneBadge(conv.id) }}</span>
            </div>
          </div>
        </div>

        <!-- Crew sessions -->
        <div class="ss-group" v-if="crewConversations.length > 0">
          <div class="session-group-header ss-group-header-compact">
            <span class="session-group-icon">👥</span>
            Crew
          </div>
          <div
            v-for="conv in crewConversations"
            :key="conv.id"
            class="session-item ss-session-item"
            :class="{ active: conv.id === conversationId, 'in-other-pane': isInOtherPane(conv.id) }"
            @click="selectConv(conv.id)"
          >
            <div class="session-item-header">
              <span class="title">{{ conv.name || 'Crew Session' }}</span>
              <span class="ss-option-badge" v-if="isInOtherPane(conv.id)">{{ getPaneBadge(conv.id) }}</span>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div class="ss-empty" v-if="chatConversations.length === 0 && crewConversations.length === 0">
          {{ $t('splitScreen.noSessions') }}
        </div>

        <!-- Quick actions -->
        <div class="ss-actions">
          <button class="ss-action-btn" @click="newChat" :disabled="!hasOnlineAgent">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            {{ $t('splitScreen.newChat') }}
          </button>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');
    const isOpen = Vue.ref(false);
    const selectorRef = Vue.ref(null);

    const chatConversations = Vue.computed(() => {
      return store.conversations
        .filter(c => c.type !== 'crew')
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    const crewConversations = Vue.computed(() => {
      return store.conversations
        .filter(c => c.type === 'crew')
        .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    });

    const hasOnlineAgent = Vue.computed(() => {
      return store.agents.some(a => a.online);
    });

    const currentIcon = Vue.computed(() => {
      if (!props.conversationId) return '📋';
      const conv = store.conversations.find(c => c.id === props.conversationId);
      return conv?.type === 'crew' ? '👥' : '💬';
    });

    const currentLabel = Vue.computed(() => {
      if (!props.conversationId) return t('splitScreen.selectSession');
      const conv = store.conversations.find(c => c.id === props.conversationId);
      if (!conv) return props.conversationId.substring(0, 8);
      if (conv.type === 'crew') return conv.name || 'Crew Session';
      return store.getConversationTitle(conv.id) || getDefaultTitle(conv);
    });

    function getDefaultTitle(conv) {
      if (conv.workDir) {
        const parts = conv.workDir.split(/[/\\]/);
        return parts[parts.length - 1] || parts[parts.length - 2] || conv.workDir;
      }
      return 'Chat';
    }

    function getConvTitle(conv) {
      if (conv.type === 'crew') return conv.name || 'Crew Session';
      return store.getConversationTitle(conv.id) || getDefaultTitle(conv);
    }

    function isInOtherPane(convId) {
      return store.splitPanes.some(p => p.id !== props.paneId && p.conversationId === convId);
    }

    function getPaneBadge(convId) {
      const idx = store.splitPanes.findIndex(p => p.conversationId === convId);
      if (idx < 0) return '';
      return 'P' + (idx + 1);
    }

    function toggleOpen() {
      isOpen.value = !isOpen.value;
    }

    function selectConv(convId) {
      emit('select', convId);
      isOpen.value = false;
    }

    function newChat() {
      store.createConversation();
      isOpen.value = false;
    }

    // Close on outside click
    function handleOutsideClick(e) {
      if (isOpen.value && selectorRef.value && !selectorRef.value.contains(e.target)) {
        isOpen.value = false;
      }
    }

    Vue.onMounted(() => {
      document.addEventListener('click', handleOutsideClick);
    });
    Vue.onUnmounted(() => {
      document.removeEventListener('click', handleOutsideClick);
    });

    return {
      store,
      isOpen,
      selectorRef,
      chatConversations,
      crewConversations,
      hasOnlineAgent,
      currentIcon,
      currentLabel,
      getConvTitle,
      isInOtherPane,
      getPaneBadge,
      toggleOpen,
      selectConv,
      newChat
    };
  }
};
