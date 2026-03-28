/**
 * PaneSidebar — simplified sidebar for split-screen panes.
 * Replicates ChatPage's sidebar HTML/CSS but uses pane-local state.
 *
 * Key differences from ChatPage sidebar:
 * - Session click → setPaneConversation(paneId, convId) instead of selectConversation
 * - Active highlighting uses pane's conversationId prop (not global current conversation)
 * - localCollapsed defaults to true (pane-local, not shared with global sidebar state)
 * - Simplified agent dropdown (no upgrade/restart)
 * - No workbench/proxy buttons
 * - No split button (already in split mode)
 */
import SettingsPanel from './SettingsPanel.js';

export default {
  name: 'PaneSidebar',
  components: { SettingsPanel },
  props: {
    paneId: { type: String, required: true },
    conversationId: { type: String, default: null }
  },
  emits: ['close-pane'],
  template: `
    <aside class="sidebar pane-sidebar" :class="{ collapsed: localCollapsed }">
      <!-- Collapsed Icon Bar -->
      <div class="sidebar-collapsed-bar" v-if="localCollapsed">
        <button class="collapsed-icon-btn" @click="localCollapsed = false" :title="$t('chat.sidebar.expand')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>
        <button class="collapsed-icon-btn" @click="newChat" :disabled="onlineAgentCount === 0" :title="$t('chat.sidebar.newConv')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button class="collapsed-icon-btn" @click="newCrewSession" title="Crew">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        </button>
        <div class="collapsed-spacer"></div>
        <button class="collapsed-icon-btn" @click="$emit('close-pane')" :title="$t('splitScreen.closePane')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <button class="collapsed-icon-btn" @click="store.toggleTheme()" :title="store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode')">
          <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
        </button>
      </div>

      <!-- Expanded sidebar -->
      <div class="sidebar-top">
        <div class="sidebar-header-row">
          <!-- Agent status (simplified) -->
          <div class="sidebar-brand agent-dropdown-trigger" @click.stop="agentDropdownOpen = !agentDropdownOpen" style="cursor: pointer;" :title="$t('chat.agent.manage')">
            <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
            <span class="brand-label">{{ onlineAgentCount }} Agent</span>
            <svg class="dropdown-chevron" :class="{ open: agentDropdownOpen }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
            <!-- Agent dropdown (simplified: no upgrade/restart) -->
            <div class="agent-dropdown" v-if="agentDropdownOpen" @click.stop>
              <div v-for="agent in store.agents.filter(a => a.online)" :key="agent.id" class="agent-dropdown-item">
                <span class="status-dot online"></span>
                <span class="agent-dropdown-name">{{ agent.name }}</span>
                <span class="agent-dropdown-version" v-if="agent.version">v{{ agent.version }}</span>
              </div>
              <div v-if="store.agents.filter(a => a.online).length === 0" class="agent-dropdown-empty">{{ $t('chat.agent.none') }}</div>
            </div>
          </div>
          <div class="sidebar-header-actions">
            <button class="sidebar-icon-btn" @click="localCollapsed = true" :title="$t('chat.sidebar.collapse')">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/></svg>
            </button>
          </div>
        </div>
        <!-- Connection warning -->
        <div v-if="store.connectionState !== 'connected'" class="connection-status" :class="store.connectionState">
          <span v-if="store.connectionState === 'updating'" class="status-text">
            <span class="spinner-mini"></span> {{ $t('chat.connection.updating') }}
          </span>
          <span v-else-if="store.connectionState === 'connecting'" class="status-text">
            <span class="spinner-mini"></span> {{ $t('chat.connection.connecting') }}
          </span>
          <span v-else-if="store.connectionState === 'reconnecting'" class="status-text">
            <span class="spinner-mini"></span> {{ $t('chat.connection.reconnecting', { current: store.reconnectAttempts, max: store.maxReconnectAttempts }) }}
          </span>
          <span v-else class="status-text">
            {{ $t('chat.connection.disconnected') }}
            <button class="reconnect-btn" @click="store.manualReconnect()">{{ $t('chat.connection.reconnect') }}</button>
          </span>
        </div>
      </div>

      <!-- Session Panels -->
      <div class="session-panels">
        <!-- Chat Sessions Panel -->
        <div class="session-panel" :class="{ collapsed: chatGroupCollapsed }">
          <div class="session-group-header">
            <div class="session-group-title-area" @click="chatGroupCollapsed = !chatGroupCollapsed">
              <svg class="session-collapse-arrow" :class="{ collapsed: chatGroupCollapsed }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              <svg class="session-group-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
              <span>{{ $t('chat.sidebar.recentChats') }}</span>
            </div>
            <button class="session-header-add-btn" @click.stop="onlineAgentCount > 0 && newChat()" :class="{ disabled: onlineAgentCount === 0 }" :title="$t('chat.sidebar.newConv')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
          <div class="session-panel-list" v-show="!chatGroupCollapsed">
            <div
              v-for="conv in chatConversations"
              :key="conv.id"
              class="session-item"
              :class="{ active: conv.id === conversationId, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <div class="session-item-header">
                <div class="title" :title="getConversationFullTitle(conv)">
                  <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                  {{ getConversationTitle(conv) }}
                </div>
                <span class="session-time">{{ getConversationTime(conv) }}</span>
                <button class="session-delete-btn" @click.stop="closeSession(conv.id, conv.agentId)" :title="$t('chat.sidebar.closeConv')">
                  <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
              <div class="session-info">
                <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Crew Sessions Panel -->
        <div class="session-panel" :class="{ collapsed: crewGroupCollapsed }">
          <div class="session-group-header">
            <div class="session-group-title-area" @click="crewGroupCollapsed = !crewGroupCollapsed">
              <svg class="session-collapse-arrow" :class="{ collapsed: crewGroupCollapsed }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              <svg class="session-group-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              <span>Crew Sessions</span>
            </div>
            <button class="session-header-add-btn" @click.stop="newCrewSession" :title="$t('chat.sidebar.newCrew')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
          <div class="session-panel-list" v-show="!crewGroupCollapsed">
            <div
              v-for="conv in crewConversations"
              :key="conv.id"
              class="session-item session-item-crew"
              :class="{ active: conv.id === conversationId, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
              @click="onSessionClick(conv)"
            >
              <div class="session-item-header">
                <div class="title" :title="getConversationFullTitle(conv)">
                  <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                  <svg class="crew-conv-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                  {{ getCrewTitle(conv) }}
                </div>
                <span class="session-time">{{ getConversationTime(conv) }}</span>
                <button class="session-delete-btn" @click.stop="closeSession(conv.id, conv.agentId)" :title="$t('chat.sidebar.closeConv')">
                  <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
              <div class="session-info">
                <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sidebar Bottom -->
      <div class="sidebar-bottom">
        <button class="sidebar-nav-item" @click="settingsOpen = true">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
          <span>{{ $t('chat.sidebar.settings') }}</span>
        </button>
      </div>

      <!-- Settings panel overlay -->
      <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
    </aside>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();

    // Pane-local sidebar state — defaults to collapsed
    const localCollapsed = Vue.ref(true);
    const chatGroupCollapsed = Vue.ref(false);
    const crewGroupCollapsed = Vue.ref(false);
    const agentDropdownOpen = Vue.ref(false);
    const settingsOpen = Vue.ref(false);

    // Computed
    const onlineAgentCount = Vue.computed(() => {
      return store.agents.filter(a => a.online).length;
    });

    const chatConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type !== 'crew'));
    });

    const crewConversations = Vue.computed(() => {
      return sortByActivity(store.conversations.filter(c => c.type === 'crew'));
    });

    // Helper functions (same logic as ChatPage)
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

    function getConversationFullTitle(conv) {
      if (conv.type === 'crew') return conv.name || 'Crew Session';
      const cachedTitle = store.getConversationTitle(conv.id);
      if (cachedTitle && cachedTitle.length > 30) return cachedTitle;
      return undefined;
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

    function shortenPath(path) {
      if (!path) return '-';
      if (path.length <= 25) return path;
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return path;
      return '...' + parts.slice(-2).join('/');
    }

    // Session click → setPaneConversation (not selectConversation)
    function onSessionClick(conv) {
      if (conv.agentOnline === false) return;
      store.setPaneConversation(props.paneId, conv.id);
    }

    function closeSession(conversationId, agentId) {
      store.closeSession(conversationId, agentId);
    }

    // New Chat: create conversation and assign to this pane
    function newChat() {
      if (onlineAgentCount.value === 0) return;
      store.createConversation();
      // After creation, the newest conversation will be the last added.
      // We need to assign it to this pane once it appears.
      Vue.nextTick(() => {
        const newest = store.conversations
          .filter(c => c.type !== 'crew')
          .sort((a, b) => (b.lastMessageAt || b.createdAt || 0) - (a.lastMessageAt || a.createdAt || 0))[0];
        if (newest) {
          store.setPaneConversation(props.paneId, newest.id);
        }
      });
    }

    function newCrewSession() {
      store.enterCrewMode();
      Vue.nextTick(() => {
        const newest = store.conversations
          .filter(c => c.type === 'crew')
          .sort((a, b) => (b.lastMessageAt || b.createdAt || 0) - (a.lastMessageAt || a.createdAt || 0))[0];
        if (newest) {
          store.setPaneConversation(props.paneId, newest.id);
        }
      });
    }

    // Close dropdowns on outside click
    function handleOutsideClick() {
      if (agentDropdownOpen.value) {
        agentDropdownOpen.value = false;
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
      localCollapsed,
      chatGroupCollapsed,
      crewGroupCollapsed,
      agentDropdownOpen,
      settingsOpen,
      onlineAgentCount,
      chatConversations,
      crewConversations,
      getConversationTitle,
      getConversationFullTitle,
      getCrewTitle,
      getConversationTime,
      shortenPath,
      onSessionClick,
      closeSession,
      newChat,
      newCrewSession
    };
  }
};
