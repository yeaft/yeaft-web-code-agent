/**
 * PaneTopBar — top horizontal bar for each split-screen pane (~36px).
 * Replaces PaneSidebar. Contains:
 *   Left: current session title (clickable → session dropdown)
 *   Center: agent status indicator
 *   Right: new Chat, new Crew, close pane buttons
 *
 * Session dropdown: absolute-positioned list of Chat + Crew sessions.
 * Click a session → setPaneConversation(paneId, convId).
 */
export default {
  name: 'PaneTopBar',
  props: {
    paneId: { type: String, required: true },
    conversationId: { type: String, default: null }
  },
  emits: ['close-pane'],
  template: `
    <div class="pane-topbar">
      <!-- Left: session title / dropdown trigger -->
      <div class="ptb-left">
        <button class="ptb-session-trigger" @click.stop="dropdownOpen = !dropdownOpen">
          <span class="ptb-session-title">{{ currentTitle }}</span>
          <svg class="ptb-chevron" :class="{ open: dropdownOpen }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </button>

        <!-- Session dropdown -->
        <div class="ptb-session-dropdown" v-if="dropdownOpen" @click.stop>
          <!-- Chat sessions -->
          <div class="ptb-dropdown-group" v-if="chatConversations.length > 0">
            <div class="ptb-dropdown-label">{{ $t('chat.sidebar.recentChats') }}</div>
            <div
              v-for="conv in pinnedChatConversations"
              :key="conv.id"
              class="ptb-dropdown-item is-pinned"
              :class="{ active: conv.id === conversationId, 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <svg class="ptb-pin-icon" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              <span class="ptb-item-title">{{ getConversationTitle(conv) }}</span>
              <span class="ptb-item-time">{{ getConversationTime(conv) }}</span>
            </div>
            <div
              v-for="conv in unpinnedChatConversations"
              :key="conv.id"
              class="ptb-dropdown-item"
              :class="{ active: conv.id === conversationId, 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <span class="ptb-item-title">{{ getConversationTitle(conv) }}</span>
              <span class="ptb-item-time">{{ getConversationTime(conv) }}</span>
            </div>
          </div>

          <!-- Crew sessions -->
          <div class="ptb-dropdown-group" v-if="crewConversations.length > 0">
            <div class="ptb-dropdown-label">Crew Sessions</div>
            <div
              v-for="conv in pinnedCrewConversations"
              :key="conv.id"
              class="ptb-dropdown-item is-pinned"
              :class="{ active: conv.id === conversationId, 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <svg class="ptb-pin-icon" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              <svg class="ptb-crew-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              <span class="ptb-item-title">{{ getCrewTitle(conv) }}</span>
              <span class="ptb-item-time">{{ getConversationTime(conv) }}</span>
            </div>
            <div
              v-for="conv in unpinnedCrewConversations"
              :key="conv.id"
              class="ptb-dropdown-item"
              :class="{ active: conv.id === conversationId, 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <svg class="ptb-crew-icon" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              <span class="ptb-item-title">{{ getCrewTitle(conv) }}</span>
              <span class="ptb-item-time">{{ getConversationTime(conv) }}</span>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="chatConversations.length === 0 && crewConversations.length === 0" class="ptb-dropdown-empty">
            {{ $t('splitScreen.noSessions') }}
          </div>
        </div>
      </div>

      <!-- Center: agent status -->
      <div class="ptb-center">
        <span class="ptb-agent-dot" :class="{ online: onlineAgentCount > 0 }"></span>
        <span class="ptb-agent-label">{{ onlineAgentCount }} Agent</span>
      </div>

      <!-- Right: action buttons -->
      <div class="ptb-right">
        <button
          class="ptb-icon-btn"
          @click="newChat"
          :disabled="onlineAgentCount === 0"
          :title="$t('splitScreen.newChat')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button
          class="ptb-icon-btn"
          @click="newCrewSession"
          :title="$t('splitScreen.newCrew')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        </button>
        <button
          class="ptb-icon-btn ptb-close-btn"
          @click="$emit('close-pane')"
          :title="$t('splitScreen.closePane')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const dropdownOpen = Vue.ref(false);

    // Current conversation object
    const currentConv = Vue.computed(() => {
      if (!props.conversationId) return null;
      return store.conversations.find(c => c.id === props.conversationId) || null;
    });

    // Display title for current session
    const currentTitle = Vue.computed(() => {
      if (!currentConv.value) return '—';
      if (currentConv.value.type === 'crew') return getCrewTitle(currentConv.value);
      return getConversationTitle(currentConv.value);
    });

    const onlineAgentCount = Vue.computed(() => {
      return store.agents.filter(a => a.online).length;
    });

    const chatConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type !== 'crew'));
    });

    const crewConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type === 'crew'));
    });

    const pinnedChatConversations = Vue.computed(() => {
      const pinned = store.conversations.filter(c => c.type !== 'crew' && store.isSessionPinned(c.id));
      return pinned.sort((a, b) => store.pinnedSessions.indexOf(a.id) - store.pinnedSessions.indexOf(b.id));
    });

    const unpinnedChatConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type !== 'crew' && !store.isSessionPinned(c.id)));
    });

    const pinnedCrewConversations = Vue.computed(() => {
      const pinned = store.conversations.filter(c => c.type === 'crew' && store.isSessionPinned(c.id));
      return pinned.sort((a, b) => store.pinnedSessions.indexOf(a.id) - store.pinnedSessions.indexOf(b.id));
    });

    const unpinnedCrewConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type === 'crew' && !store.isSessionPinned(c.id)));
    });

    function sortByActivity(conversations) {
      return [...conversations].sort((a, b) => {
        const aTime = a.lastMessageAt || 0;
        const bTime = b.lastMessageAt || 0;
        return bTime - aTime;
      });
    }

    function getConversationTitle(conv) {
      if (conv.type === 'crew') return getCrewTitle(conv);
      const cachedTitle = store.getConversationTitle(conv.id);
      if (cachedTitle) {
        return cachedTitle.length > 30 ? cachedTitle.slice(0, 30) + '...' : cachedTitle;
      }
      if (conv.claudeSessionId) {
        return conv.claudeSessionId.slice(0, 8) + '...';
      }
      return conv.id.slice(0, 8) + '...';
    }

    function getCrewTitle(conv) {
      return conv.name || 'Crew Session';
    }

    function getConversationTime(conv) {
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

    function onSessionClick(conv) {
      if (conv.agentOnline === false) return;
      store.setPaneConversation(props.paneId, conv.id);
      dropdownOpen.value = false;
    }

    function newChat() {
      if (onlineAgentCount.value === 0) return;
      store._pendingPaneId = props.paneId;
      store.createConversation();
    }

    function newCrewSession() {
      store._pendingPaneId = props.paneId;
      store.enterCrewMode();
    }

    // Close dropdown on outside click
    function handleOutsideClick() {
      if (dropdownOpen.value) {
        dropdownOpen.value = false;
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
      dropdownOpen,
      currentTitle,
      onlineAgentCount,
      chatConversations,
      crewConversations,
      pinnedChatConversations,
      unpinnedChatConversations,
      pinnedCrewConversations,
      unpinnedCrewConversations,
      getConversationTitle,
      getCrewTitle,
      getConversationTime,
      onSessionClick,
      newChat,
      newCrewSession
    };
  }
};
