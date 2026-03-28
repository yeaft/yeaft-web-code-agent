/**
 * GlobalToolbar — thin top bar shown only in split-screen mode.
 * Contains only split-screen controls: add pane, merge panes.
 * Agent status, session selection, theme, and settings are now in each PaneSidebar.
 */
export default {
  name: 'GlobalToolbar',
  template: `
    <div class="global-toolbar">
      <div class="gt-left">
        <!-- Connection warning -->
        <span class="gt-connection-warn" v-if="store.connectionState !== 'connected'">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          {{ connectionLabel }}
        </span>
      </div>

      <div class="gt-right">
        <!-- Split controls -->
        <button class="sidebar-icon-btn gt-btn-add" v-if="store.splitPanes.length < 3" @click="store.addPane()" :title="$t('splitScreen.addPane')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button class="sidebar-icon-btn gt-btn-merge" @click="mergePanes" :title="$t('splitScreen.merge')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5 15H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg>
        </button>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();

    const connectionLabel = Vue.computed(() => {
      const state = store.connectionState;
      if (state === 'connecting') return 'Connecting...';
      if (state === 'reconnecting') return 'Reconnecting...';
      if (state === 'disconnected') return 'Disconnected';
      if (state === 'updating') return 'Updating...';
      return '';
    });

    function mergePanes() {
      const first = store.splitPanes[0];
      if (first?.conversationId) {
        store.activeConversations = [first.conversationId];
      }
      store.splitPanes = [];
    }

    return {
      store,
      connectionLabel,
      mergePanes
    };
  }
};
