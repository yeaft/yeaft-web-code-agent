/**
 * PaneHeader — compact header for each split-screen pane.
 * Shows mode (Chat/Crew), action buttons, context usage, and pane controls.
 */
export default {
  name: 'PaneHeader',
  props: {
    paneId: { type: String, required: true },
    conversationId: { type: String, default: null },
    paneCount: { type: Number, default: 2 }
  },
  emits: ['close-pane', 'add-pane'],
  template: `
    <div class="pane-header" v-if="conversationId">
      <!-- Left: mode label + context usage -->
      <div class="pane-header-left">
        <span class="pane-mode" :class="{ crew: isCrew }">{{ isCrew ? 'Crew' : 'Chat' }}</span>
        <span class="pane-context-usage" v-if="contextUsage" :class="contextColorClass" :title="contextUsage.percentage + '%'">
          {{ contextUsage.percentage }}%
        </span>
      </div>

      <!-- Center: action buttons -->
      <div class="pane-header-actions">
        <!-- Chat mode actions -->
        <template v-if="!isCrew">
          <button class="ph-action-btn" @click="toggleExpertPanel" :title="$t('chatHeader.expertPanel')" v-if="!isCrew">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </button>
          <button class="ph-action-btn" @click="compactContext" :title="$t('chatHeader.compact')">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="8 4 12 8 16 4"/><line x1="4" y1="12" x2="20" y2="12"/><polyline points="8 20 12 16 16 20"/>
            </svg>
          </button>
        </template>
        <!-- Crew mode actions -->
        <template v-if="isCrew">
          <button class="ph-action-btn" @click="toggleCrewRoles" title="Roles">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </button>
        </template>
        <!-- Refresh (shared) -->
        <button class="ph-action-btn" @click="refreshConversation" :title="$t('chatHeader.refresh')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>

      <!-- Right: pane controls -->
      <div class="pane-header-right">
        <button class="ph-action-btn ph-add-btn" v-if="paneCount < 3" @click="$emit('add-pane')" :title="$t('splitScreen.addPane')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button class="ph-action-btn ph-close-btn" @click="$emit('close-pane')" :title="$t('splitScreen.closePane')">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();

    const isCrew = Vue.computed(() => {
      if (!props.conversationId) return false;
      const conv = store.conversations.find(c => c.id === props.conversationId);
      return conv?.type === 'crew';
    });

    const contextUsage = Vue.computed(() => {
      if (!store.contextUsage || store.contextUsage.conversationId !== props.conversationId) return null;
      return store.contextUsage;
    });

    const contextColorClass = Vue.computed(() => {
      if (!contextUsage.value) return '';
      const pct = contextUsage.value.percentage;
      if (pct >= 80) return 'context-danger';
      if (pct >= 50) return 'context-warn';
      return 'context-ok';
    });

    function toggleExpertPanel() {
      // Toggle expert panel — reuse store's existing mechanism
      store.activeRightPanel = store.activeRightPanel === 'experts' ? null : 'experts';
    }

    function toggleCrewRoles() {
      store.activeCrewPanel = store.activeCrewPanel === 'roles' ? null : 'roles';
    }

    function compactContext() {
      if (!props.conversationId) return;
      store.sendWsMessage({
        type: 'compact_context',
        conversationId: props.conversationId
      });
    }

    function refreshConversation() {
      if (!props.conversationId) return;
      // Re-sync messages
      store.messagesMap[props.conversationId] = [];
      store.sendWsMessage({
        type: 'sync_messages',
        conversationId: props.conversationId,
        turns: 5
      });
    }

    return {
      store,
      isCrew,
      contextUsage,
      contextColorClass,
      toggleExpertPanel,
      toggleCrewRoles,
      compactContext,
      refreshConversation
    };
  }
};
