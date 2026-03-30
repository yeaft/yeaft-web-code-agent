/**
 * GlobalSidebar — narrow left sidebar shown only in split-screen mode (~40px).
 * Replaces GlobalToolbar. Contains global split-screen controls:
 *   Top: add pane, exit split (merge)
 *   Bottom: settings, theme toggle, connection indicator
 */
import SettingsPanel from './SettingsPanel.js';

export default {
  name: 'GlobalSidebar',
  components: { SettingsPanel },
  template: `
    <aside class="global-sidebar">
      <!-- Top controls -->
      <div class="gs-top">
        <button
          class="gs-icon-btn"
          @click="newChat"
          :disabled="onlineAgentCount === 0"
          :title="$t('splitScreen.newChat')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
        </button>
        <button
          class="gs-icon-btn"
          @click="newCrew"
          :title="$t('splitScreen.newCrew')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        </button>
        <div class="gs-divider"></div>
        <button
          class="gs-icon-btn"
          v-if="store.splitPanes.length < 3"
          @click="store.addPane()"
          :title="$t('splitScreen.addPane')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button
          class="gs-icon-btn"
          @click="mergePanes"
          :title="$t('splitScreen.merge')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 15H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg>
        </button>
      </div>

      <!-- Bottom controls -->
      <div class="gs-bottom">
        <!-- Connection warning indicator -->
        <div
          v-if="store.connectionState !== 'connected'"
          class="gs-icon-btn gs-connection-warn"
          :title="connectionLabel"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        </div>

        <button
          class="gs-icon-btn"
          @click="settingsOpen = true"
          :title="$t('chat.sidebar.settings')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        </button>
        <button
          class="gs-icon-btn"
          @click="store.toggleTheme()"
          :title="store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode')"
        >
          <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
        </button>
      </div>

      <!-- Settings panel overlay -->
      <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
    </aside>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const settingsOpen = Vue.ref(false);

    const onlineAgentCount = Vue.computed(() => store.agents.filter(a => a.online).length);

    const connectionLabel = Vue.computed(() => {
      const state = store.connectionState;
      if (state === 'connecting') return 'Connecting...';
      if (state === 'reconnecting') return 'Reconnecting...';
      if (state === 'disconnected') return 'Disconnected';
      if (state === 'updating') return 'Updating...';
      return '';
    });

    function newChat() {
      if (onlineAgentCount.value === 0) return;
      // Assign to first empty pane, or first pane
      const emptyPane = store.splitPanes.find(p => !p.conversationId);
      store._pendingPaneId = emptyPane?.id || store.splitPanes[0]?.id || null;
      store.splitConvModalOpen = true;
    }

    function newCrew() {
      const emptyPane = store.splitPanes.find(p => !p.conversationId);
      store._pendingPaneId = emptyPane?.id || store.splitPanes[0]?.id || null;
      store.enterCrewMode();
    }

    function mergePanes() {
      const first = store.splitPanes[0];
      if (first?.conversationId) {
        store.activeConversations = [first.conversationId];
      }
      store.splitPanes = [];
    }

    return {
      store,
      settingsOpen,
      onlineAgentCount,
      connectionLabel,
      newChat,
      newCrew,
      mergePanes
    };
  }
};
