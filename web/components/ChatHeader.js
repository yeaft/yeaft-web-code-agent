export default {
  name: 'ChatHeader',
  emits: ['toggle-sidebar', 'close-pane'],
  props: {
    conversationId: { type: String, default: null },
    paneId: { type: String, default: null },
    showClosePane: { type: Boolean, default: false }
  },
  template: `
    <header class="chat-header">
      <!-- Mobile sidebar toggle — hidden on desktop and in split mode -->
      <button class="header-sidebar-toggle" v-if="!store.isSplitMode"
              @click="$emit('toggle-sidebar')">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
        </svg>
      </button>
      <div class="chat-title-group" :title="folderPath">
        <div class="chat-title">{{ headerTitle }}</div>
        <div v-if="folderPath || (store.isSplitMode && agentName)" class="chat-title-path">
          <span v-if="store.isSplitMode && agentName" class="chat-title-agent">{{ agentName }}</span>
          <span class="chat-title-path-text">{{ folderPath }}</span>
        </div>
      </div>
      <!-- Compact / Clear Status Banner -->
      <div v-if="showStatusBanner" class="compact-status-banner" :class="statusBannerClass">
        <span v-if="statusBannerSpinner" class="compact-spinner"></span>
        <svg v-else class="compact-icon" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span class="compact-message">{{ statusBannerMessage }}</span>
      </div>
      <div class="header-right" v-if="effectiveConvId && !isCrew">
        <!-- Page reload — always visible top-right, full window.location.reload() -->
        <button class="header-action-btn" @click="reloadPage" :title="$t('chatHeader.reloadPage')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 20 23 14 17 14"/><polyline points="1 4 1 10 7 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
        <span class="context-usage-hint" v-if="contextUsage" :class="contextColorClass" :title="contextLabel">
          {{ contextUsage.percentage }}%
        </span>
        <!-- Expert panel button — hidden in Crew mode -->
        <button class="header-action-btn" :class="{ active: effectiveRightPanel === 'subagents' }" @click="toggleSubAgentPanel" :title="$t('chatHeader.subAgentPanel')" v-if="runningSubagentCount > 0 || effectiveRightPanel === 'subagents'">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span class="subagent-count-badge" v-if="runningSubagentCount > 0">{{ runningSubagentCount }}</span>
        </button>
        <button class="header-action-btn" :class="{ active: effectiveRightPanel === 'experts' }" @click="toggleExpertPanel" :title="$t('chatHeader.expertPanel')" v-if="!isCrew">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span class="mcp-count-badge" v-if="store.expertSelections && store.expertSelections.length > 0">{{ store.expertSelections.length }}</span>
        </button>
        <!-- MCP Config Button -->
        <div class="mcp-config-wrapper" v-if="store.currentMcpServers.length > 0">
          <button ref="mcpBtnRef" class="header-action-btn" :class="{ active: store.mcpPanelOpen }" @click="toggleMcpPanel" :title="$t('chatHeader.mcpConfig')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span class="mcp-count-badge" v-if="mcpEnabledCount > 0">{{ mcpEnabledCount }}</span>
          </button>
        </div>
        <!-- MCP Dropdown Panel — Teleported to body to escape transform containing block -->
        <Teleport to="body">
          <div class="mcp-dropdown" v-if="store.mcpPanelOpen" :style="mcpDropdownStyle" @click.stop>
            <div class="mcp-dropdown-header">
              <span class="mcp-dropdown-title">MCP Servers</span>
              <button class="mcp-dropdown-close" @click="store.mcpPanelOpen = false">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <div class="mcp-dropdown-body">
              <div class="mcp-server-item" v-for="server in store.currentMcpServers" :key="server.name">
                <span class="mcp-server-name">{{ server.name }}</span>
                <span class="mcp-server-badge" :class="server.source === 'Built-in' ? 'mcp-badge-builtin' : 'mcp-badge-mcp'">{{ server.source }}</span>
                <button
                  class="mcp-toggle"
                  :class="{ active: server.enabled }"
                  @click="toggleMcpServer(server.name, !server.enabled)"
                  role="switch"
                  :aria-checked="server.enabled"
                >
                  <span class="mcp-toggle-knob"></span>
                </button>
              </div>
            </div>
            <div class="mcp-dropdown-footer" v-if="currentConvNeedRestart">
              <span class="mcp-restart-hint">{{ $t('chatHeader.mcpNeedRestart') }}</span>
            </div>
          </div>
        </Teleport>
        <button class="header-action-btn" :class="{ 'btn-loading': isRefreshing }" @click="refreshSession" :disabled="!canRefresh || isRefreshing" :title="$t('chatHeader.refresh')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button class="header-action-btn" :class="{ 'btn-loading': isCompacting }" @click="compactContext" :disabled="isCompacting" :title="$t('chatHeader.compact')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8 4 12 8 16 4"/><line x1="4" y1="12" x2="20" y2="12"/><polyline points="8 20 12 16 16 20"/>
          </svg>
        </button>
        <button class="header-action-btn" :class="{ 'btn-loading': isClearing }" @click="clearMessages" :disabled="isClearing" :title="$t('chatHeader.clear')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
        <!-- Close pane button (split mode only) -->
        <button class="header-action-btn" v-if="showClosePane" @click="$emit('close-pane')" :title="$t('splitScreen.closePane')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="crew-header-actions" v-if="isCrew">
        <button class="crew-header-nav-btn" @click="reloadPage" :title="$t('chatHeader.reloadPage')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 20 23 14 17 14"/><polyline points="1 4 1 10 7 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
        <button v-if="isCrew" class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('roles') }"
                @click="onCrewPanelToggle('roles')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          <span v-if="hasStreamingRoles" class="active-dot"></span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('features') }"
                @click="onCrewPanelToggle('features')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
          <span v-if="crewInProgress > 0" class="nav-badge">{{ crewInProgress }}</span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ 'btn-loading': isRefreshing }"
                @click="refreshSession"
                :disabled="isRefreshing"
                :title="$t('chatHeader.refresh')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button class="crew-header-nav-btn"
                @click="openCrewEdit"
                :title="$t('chatHeader.editCrew')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <!-- Close pane button (split mode only) -->
        <button class="crew-header-nav-btn" v-if="showClosePane" @click="$emit('close-pane')" :title="$t('splitScreen.closePane')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </header>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // ★ Core: effectiveConvId — prop takes priority over store.currentConversation
    const effectiveConvId = Vue.computed(() => {
      return props.conversationId || store.currentConversation;
    });

    // ★ Local isCrew check — replaces store.currentConversationIsCrew
    const isCrew = Vue.computed(() => {
      if (!effectiveConvId.value) return false;
      const conv = store.conversations.find(c => c.id === effectiveConvId.value);
      return conv?.type === 'crew';
    });

    const headerTitle = Vue.computed(() => {
      if (!effectiveConvId.value) {
        return 'Claude Web Chat';
      }

      // Crew conversation — use renamed session name if available
      if (isCrew.value) {
        const conv = store.conversations.find(c => c.id === effectiveConvId.value);
        return conv?.name || 'Crew Session';
      }

      const title = store.getConversationTitle(effectiveConvId.value);
      if (title) {
        return title;
      }

      // For non-prop mode, use currentWorkDir; for prop mode, look up conv.workDir
      const conv = store.conversations.find(c => c.id === effectiveConvId.value);
      const workDir = conv?.workDir || store.currentWorkDir;
      if (workDir) {
        const parts = workDir.split(/[/\\]/);
        return parts[parts.length - 1] || parts[parts.length - 2] || workDir;
      }

      return t('chatHeader.newConv');
    });

    const agentName = Vue.computed(() => {
      if (!effectiveConvId.value) return '';
      const conv = store.conversations.find(c => c.id === effectiveConvId.value);
      const aid = conv?.agentId;
      if (!aid) return '';
      const agent = store.agents.find(a => a.id === aid);
      return agent?.name || '';
    });

    // Unified status banner: shows compact or clear status
    const showStatusBanner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === effectiveConvId.value) return true;
      if (!store.compactStatus) return false;
      return store.compactStatus.conversationId === effectiveConvId.value;
    });

    const statusBannerClass = Vue.computed(() => {
      // Clear status takes priority when active
      if (store.clearStatus?.conversationId === effectiveConvId.value) {
        return store.clearStatus.status === 'clearing' ? 'compacting' : 'completed';
      }
      if (!store.compactStatus) return '';
      return store.compactStatus.status === 'compacting' ? 'compacting' : 'completed';
    });

    const statusBannerSpinner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === effectiveConvId.value) {
        return store.clearStatus.status === 'clearing';
      }
      return store.compactStatus?.status === 'compacting';
    });

    const statusBannerMessage = Vue.computed(() => {
      if (store.clearStatus?.conversationId === effectiveConvId.value) {
        if (store.clearStatus.status === 'clearing') {
          return t('chatHeader.clearing');
        }
        return t('chatHeader.clearDone');
      }
      if (!store.compactStatus) return '';
      if (store.compactStatus.status === 'compacting') {
        return store.compactStatus.message || t('chatHeader.compacting');
      }
      return store.compactStatus.message || t('chatHeader.compactDone');
    });

    const folderPath = Vue.computed(() => {
      if (!effectiveConvId.value) return '';
      const conv = store.conversations.find(c => c.id === effectiveConvId.value);
      return conv?.workDir || store.currentWorkDir || '';
    });

    const contextUsage = Vue.computed(() => {
      if (!store.contextUsage) return null;
      if (store.contextUsage.conversationId !== effectiveConvId.value) return null;
      return store.contextUsage;
    });
    const contextColorClass = Vue.computed(() => {
      const pct = contextUsage.value?.percentage || 0;
      if (pct >= 80) return 'context-danger';
      if (pct >= 50) return 'context-warn';
      return 'context-ok';
    });
    const contextLabel = Vue.computed(() => {
      if (!contextUsage.value) return '';
      const used = (contextUsage.value.inputTokens / 1000).toFixed(0);
      const total = (contextUsage.value.maxTokens / 1000).toFixed(0);
      return `Context: ${used}k / ${total}k`;
    });

    // Crew header: roles streaming dot
    const hasStreamingRoles = Vue.computed(() => {
      const activeRoles = store.currentCrewStatus?.activeRoles;
      return activeRoles && activeRoles.length > 0;
    });

    // Per-conversation refresh state (split-pane safe)
    const isRefreshing = Vue.computed(() => store.isRefreshingSession(effectiveConvId.value));
    // Per-conversation crew in-progress count (split-pane safe)
    const crewInProgress = Vue.computed(() => store.getCrewInProgressCount(effectiveConvId.value));

    const isCompacting = Vue.computed(() => {
      return store.compactStatus?.status === 'compacting'
        && store.compactStatus?.conversationId === effectiveConvId.value;
    });

    const isClearing = Vue.computed(() => {
      return store.clearStatus?.status === 'clearing'
        && store.clearStatus?.conversationId === effectiveConvId.value;
    });

    const canRefresh = Vue.computed(() => {
      if (!effectiveConvId.value) return false;
      // task-712: refresh is allowed even while a turn is streaming.
      // The user wants "刷历史,不动正在 streaming 的 turn" — handled in
      // refreshSession by skipping the destructive messagesMap blank
      // when a turn is in flight. Sync results dedup by dbMessageId,
      // and the streaming partial has none, so it survives the merge.
      return !store.isRefreshingSession(effectiveConvId.value);
    });

    const refreshSession = () => {
      if (store.isRefreshingSession(effectiveConvId.value) || !effectiveConvId.value) return;
      store.setRefreshingSession(effectiveConvId.value, true);
      store.startRefreshTimeout(effectiveConvId.value);
      if (isCrew.value) {
        // Crew: resume session to reload roles + messages
        store.sendWsMessage({
          type: 'resume_crew_session',
          sessionId: effectiveConvId.value,
          agentId: store.currentAgent
        });
      } else {
        // Mid-turn: keep the in-memory partial so streaming text isn't
        // wiped. sync_messages_result dedups by dbMessageId (orphans are
        // reconciled by content). Idle: blank for a clean reload.
        if (!store.processingConversations[effectiveConvId.value]) {
          store.messagesMap[effectiveConvId.value] = [];
        }
        store.sendWsMessage({
          type: 'sync_messages',
          conversationId: effectiveConvId.value,
          turns: 5
        });
      }
    };

    const compactContext = () => {
      if (isCompacting.value) return;
      store.sendMessage('/compact');
    };

    const reloadPage = () => {
      window.location.reload();
    };

    const clearMessages = () => {
      if (isClearing.value) return;
      if (!confirm(t('chatHeader.confirmClear'))) return;
      store.clearStatus = {
        conversationId: effectiveConvId.value,
        status: 'clearing'
      };
      store.sendMessage('/clear');
    };

    const openCrewEdit = () => {
      store.openCrewConfig();
    };

    // ★ Pane-local panel state: reads from pane in split mode, global store otherwise
    const effectiveRightPanel = Vue.computed(() => {
      return store.getPaneRightPanel(props.paneId);
    });

    const onCrewPanelToggle = (panel) => {
      if (window.innerWidth < 768 || store.isSplitMode) {
        store.toggleCrewMobilePanel(panel, props.paneId);
      } else {
        store.toggleCrewPanel(panel, props.paneId);
      }
    };

    const isCrewPanelActive = (panel) => {
      if (window.innerWidth < 768 || store.isSplitMode) {
        return store.getPaneMobilePanel(props.paneId) === panel;
      }
      return store.getPanelVisible(props.paneId)[panel];
    };

    // MCP panel
    const mcpBtnRef = Vue.ref(null);

    const mcpDropdownStyle = Vue.computed(() => {
      if (!store.mcpPanelOpen || !mcpBtnRef.value) return null;
      const rect = mcpBtnRef.value.getBoundingClientRect();
      const style = { top: `${rect.bottom + 6}px`, right: `${window.innerWidth - rect.right}px` };
      return style;
    });

    const mcpEnabledCount = Vue.computed(() => {
      return store.currentMcpServers.filter(s => s.enabled).length;
    });

    const currentConvNeedRestart = Vue.computed(() => {
      const conv = store.conversations.find(c => c.id === effectiveConvId.value);
      return !!conv?.needRestart;
    });

    const toggleMcpPanel = () => {
      store.mcpPanelOpen = !store.mcpPanelOpen;
    };

    const toggleExpertPanel = () => {
      store.togglePaneRightPanel('experts', props.paneId);
    };

    const toggleSubAgentPanel = () => {
      store.togglePaneRightPanel('subagents', props.paneId);
    };

    const runningSubagentCount = Vue.computed(() => {
      return store.runningSubagentCount;
    });

    const toggleMcpServer = (serverName, enabled) => {
      store.toggleConversationMcp(serverName, enabled);
    };

    // Close MCP panel on click outside (dropdown is teleported to body)
    const closeMcpOnOutsideClick = (e) => {
      if (store.mcpPanelOpen && !e.target.closest('.mcp-dropdown') && !e.target.closest('.mcp-config-wrapper')) {
        store.mcpPanelOpen = false;
      }
    };

    Vue.onMounted(() => {
      document.addEventListener('click', closeMcpOnOutsideClick);
    });
    Vue.onUnmounted(() => {
      document.removeEventListener('click', closeMcpOnOutsideClick);
    });

    return { store, effectiveConvId, effectiveRightPanel, isCrew, headerTitle, agentName, folderPath, showStatusBanner, statusBannerClass, statusBannerSpinner, statusBannerMessage, contextUsage, contextColorClass, contextLabel, hasStreamingRoles, isRefreshing, crewInProgress, isCompacting, isClearing, canRefresh, refreshSession, reloadPage, compactContext, clearMessages, openCrewEdit, onCrewPanelToggle, isCrewPanelActive, mcpBtnRef, mcpDropdownStyle, mcpEnabledCount, currentConvNeedRestart, toggleMcpPanel, toggleMcpServer, toggleExpertPanel, toggleSubAgentPanel, runningSubagentCount };
  }
};
