export default {
  name: 'ChatHeader',
  emits: ['toggle-sidebar'],
  template: `
    <header class="chat-header">
      <!-- Mobile sidebar toggle — hidden on desktop, shown for all modes -->
      <button class="header-sidebar-toggle"
              @click="$emit('toggle-sidebar')">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
        </svg>
      </button>
      <!-- Mobile page reload — hidden on desktop -->
      <button class="header-reload-btn"
              @click="reloadPage"
              title="Reload page">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
        </svg>
      </button>
      <div class="chat-title-group">
        <div class="chat-title">{{ headerTitle }}</div>
        <div v-if="folderPath" class="chat-title-path">{{ folderPath }}</div>
      </div>
      <!-- Compact / Clear Status Banner -->
      <div v-if="showStatusBanner" class="compact-status-banner" :class="statusBannerClass">
        <span v-if="statusBannerSpinner" class="compact-spinner"></span>
        <svg v-else class="compact-icon" viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span class="compact-message">{{ statusBannerMessage }}</span>
      </div>
      <div class="header-right" v-if="store.currentConversation && !store.currentConversationIsCrew">
        <span class="context-usage-hint" v-if="contextUsage" :class="contextColorClass" :title="contextLabel">
          {{ contextUsage.percentage }}%
        </span>
        <button class="header-action-btn" :class="{ active: store.expertPanelOpen }" @click="toggleExpertPanel" :title="$t('chatHeader.expertPanel')" v-if="!store.currentConversationIsCrew">
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
        <button class="header-action-btn" :class="{ 'btn-loading': store.refreshingSession }" @click="refreshSession" :disabled="!canRefresh || store.refreshingSession" :title="$t('chatHeader.refresh')" v-if="canRefresh">
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
      </div>
      <div class="crew-header-actions" v-if="store.currentConversationIsCrew">
        <button v-if="store.currentConversationIsCrew" class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('roles') }"
                @click="onCrewPanelToggle('roles')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          <span v-if="hasStreamingRoles" class="active-dot"></span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ active: isCrewPanelActive('features') }"
                @click="onCrewPanelToggle('features')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
          <span v-if="store.crewInProgressCount > 0" class="nav-badge">{{ store.crewInProgressCount }}</span>
        </button>
        <button class="crew-header-nav-btn"
                :class="{ 'btn-loading': store.refreshingSession }"
                @click="refreshSession"
                :disabled="store.refreshingSession"
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
      </div>
      <div class="conductor-header-actions" v-if="store.currentConversationIsConductor">
        <button class="conductor-workdir-btn" :class="{ 'is-empty': !store.conductorWorkDir, 'is-open': showWorkDirPicker }" @click="toggleWorkDirPicker" :title="store.conductorWorkDir || 'Select work directory'" aria-haspopup="dialog" :aria-expanded="showWorkDirPicker">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span class="conductor-workdir-name">{{ conductorWorkDirLabel || 'Select folder...' }}</span>
          <svg class="conductor-workdir-chevron" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <!-- Folder Picker panel -->
        <div class="conductor-workdir-picker" v-if="showWorkDirPicker" @click.stop role="dialog" aria-label="Select work directory">
          <!-- Path bar -->
          <div class="conductor-picker-path-bar">
            <input type="text" v-model="pickerPathInput" :placeholder="$t('conductor.enterPath')" class="conductor-picker-path-input" :class="{ 'is-invalid': pickerPathInvalid }" @keydown.enter="pickerNavigateToInput" aria-label="Directory path" ref="pickerPathInputRef" />
            <button class="conductor-picker-up-btn" @click="pickerNavigateUp" :disabled="!pickerPathInput" aria-label="Navigate to parent directory" :title="$t('conductor.parentDir')">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
          </div>
          <!-- Recent directories -->
          <div class="conductor-picker-recent" v-if="recentWorkDirs.length > 0">
            <div class="conductor-picker-recent-title">{{ $t('conductor.recentDirs') }}</div>
            <div class="conductor-picker-recent-item" v-for="dir in recentWorkDirs" :key="dir" @click="pickerSelectRecent(dir)">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>
              <span>{{ dir }}</span>
            </div>
          </div>
          <!-- Folder browsing area -->
          <div class="conductor-picker-list" role="listbox">
            <div v-if="pickerLoading" class="conductor-picker-loading">
              <span class="compact-spinner"></span>
              {{ $t('conductor.loading') }}
            </div>
            <div v-else-if="pickerFolders.length === 0" class="conductor-picker-empty">
              {{ $t('conductor.noSubdirs') }}
            </div>
            <template v-else>
              <div class="conductor-picker-folder" v-for="folder in pickerFolders" :key="folder.name" :class="{ 'is-selected': pickerSelectedFolder === folder.name }" role="option" :aria-selected="pickerSelectedFolder === folder.name" @click="pickerSelectFolder(folder.name)" @dblclick="pickerEnterFolder(folder.name)">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="conductor-picker-folder-name">{{ folder.name }}</span>
              </div>
            </template>
          </div>
          <!-- Footer actions -->
          <div class="conductor-picker-footer">
            <button class="conductor-picker-cancel" @click="showWorkDirPicker = false">{{ $t('common.cancel') }}</button>
            <button class="conductor-picker-select" @click="pickerConfirm" :disabled="!pickerPathInput.trim()">{{ $t('common.select') }}</button>
          </div>
        </div>
        <!-- Mobile overlay for picker -->
        <div class="conductor-picker-overlay" v-if="showWorkDirPicker && isMobilePicker" @click="showWorkDirPicker = false"></div>
        <span class="conductor-cost-sep" v-if="conductorCost">&middot;</span>
        <span class="conductor-cost-label" v-if="conductorCost">
          \${{ conductorCost }}
        </span>
        <button class="crew-header-nav-btn"
                :class="{ active: store.conductorActivePanelVisible }"
                @click="store.conductorActivePanelVisible = !store.conductorActivePanelVisible"
                title="Tasks">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
          <span v-if="conductorActiveTaskCount > 0" class="nav-badge">{{ conductorActiveTaskCount }}</span>
        </button>
      </div>
    </header>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    const headerTitle = Vue.computed(() => {
      if (!store.currentConversation) {
        return 'Claude Web Chat';
      }

      // Conductor conversation
      if (store.currentConversationIsConductor) {
        const agent = store.agents.find(a => a.id === store.currentAgent);
        return (agent?.name || 'Agent') + ' · Conductor';
      }

      // Crew conversation — use renamed session name if available
      if (store.currentConversationIsCrew) {
        const conv = store.conversations.find(c => c.id === store.currentConversation);
        return conv?.name || 'Crew Session';
      }

      const title = store.getConversationTitle(store.currentConversation);
      if (title) {
        return title;
      }

      if (store.currentWorkDir) {
        const parts = store.currentWorkDir.split(/[/\\]/);
        return parts[parts.length - 1] || parts[parts.length - 2] || store.currentWorkDir;
      }

      return t('chatHeader.newConv');
    });

    // Unified status banner: shows compact or clear status
    const showStatusBanner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) return true;
      if (!store.compactStatus) return false;
      return store.compactStatus.conversationId === store.currentConversation;
    });

    const statusBannerClass = Vue.computed(() => {
      // Clear status takes priority when active
      if (store.clearStatus?.conversationId === store.currentConversation) {
        return store.clearStatus.status === 'clearing' ? 'compacting' : 'completed';
      }
      if (!store.compactStatus) return '';
      return store.compactStatus.status === 'compacting' ? 'compacting' : 'completed';
    });

    const statusBannerSpinner = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) {
        return store.clearStatus.status === 'clearing';
      }
      return store.compactStatus?.status === 'compacting';
    });

    const statusBannerMessage = Vue.computed(() => {
      if (store.clearStatus?.conversationId === store.currentConversation) {
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
      if (!store.currentConversation || !store.currentWorkDir) return '';
      return store.currentWorkDir;
    });

    const contextUsage = Vue.computed(() => {
      if (!store.contextUsage) return null;
      if (store.contextUsage.conversationId !== store.currentConversation) return null;
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

    const isCompacting = Vue.computed(() => {
      return store.compactStatus?.status === 'compacting'
        && store.compactStatus?.conversationId === store.currentConversation;
    });

    const isClearing = Vue.computed(() => {
      return store.clearStatus?.status === 'clearing'
        && store.clearStatus?.conversationId === store.currentConversation;
    });

    const canRefresh = Vue.computed(() => {
      if (!store.currentConversation) return false;
      return !store.processingConversations[store.currentConversation]
        && !store.refreshingSession;
    });

    const refreshSession = () => {
      if (store.refreshingSession || !store.currentConversation) return;
      store.refreshingSession = true;
      store.startRefreshTimeout();
      if (store.currentConversationIsCrew) {
        // Crew: resume session to reload roles + messages
        store.sendWsMessage({
          type: 'resume_crew_session',
          sessionId: store.currentConversation,
          agentId: store.currentAgent
        });
      } else {
        store.messages = [];
        store.sendWsMessage({
          type: 'sync_messages',
          conversationId: store.currentConversation,
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
        conversationId: store.currentConversation,
        status: 'clearing'
      };
      store.sendMessage('/clear');
    };

    const openCrewEdit = () => {
      store.openCrewConfig();
    };

    const onCrewPanelToggle = (panel) => {
      if (window.innerWidth < 768) {
        store.toggleCrewMobilePanel(panel);
      } else {
        store.toggleCrewPanel(panel);
      }
    };

    const isCrewPanelActive = (panel) => {
      if (window.innerWidth < 768) {
        return store.crewMobilePanel === panel;
      }
      return store.crewPanelVisible[panel];
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
      const conv = store.conversations.find(c => c.id === store.currentConversation);
      return !!conv?.needRestart;
    });

    const toggleMcpPanel = () => {
      store.mcpPanelOpen = !store.mcpPanelOpen;
    };

    const toggleExpertPanel = () => {
      store.expertPanelOpen = !store.expertPanelOpen;
    };

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

    // Conductor header data
    const conductorCost = Vue.computed(() => {
      const sid = store.currentConversation;
      if (!sid || !store.currentConversationIsConductor) return null;
      const status = store.conductorStatuses[sid];
      return status?.costUsd ? status.costUsd.toFixed(2) : null;
    });

    const conductorActiveTaskCount = Vue.computed(() => {
      const sid = store.currentConversation;
      if (!sid) return 0;
      const tasks = store.conductorTasks[sid];
      if (!tasks) return 0;
      return Object.values(tasks).filter(
        t => t.status === 'active' || t.status === 'executing' || t.status === 'planning'
      ).length;
    });

    // Conductor workDir picker — upgraded to Folder Picker
    const showWorkDirPicker = Vue.ref(false);
    const pickerPathInput = Vue.ref('');
    const pickerPathInputRef = Vue.ref(null);
    const pickerFolders = Vue.ref([]);
    const pickerLoading = Vue.ref(false);
    const pickerSelectedFolder = Vue.ref('');
    const pickerPathInvalid = Vue.ref(false);
    const isMobilePicker = Vue.computed(() => window.innerWidth <= 768);

    const RECENT_DIRS_KEY = 'conductor-recent-workdirs';
    const MAX_RECENT = 5;

    const recentWorkDirs = Vue.ref([]);
    const loadRecentDirs = () => {
      try {
        const raw = localStorage.getItem(RECENT_DIRS_KEY);
        recentWorkDirs.value = raw ? JSON.parse(raw).slice(0, MAX_RECENT) : [];
      } catch { recentWorkDirs.value = []; }
    };
    const saveRecentDir = (dir) => {
      if (!dir) return;
      const list = recentWorkDirs.value.filter(d => d !== dir);
      list.unshift(dir);
      recentWorkDirs.value = list.slice(0, MAX_RECENT);
      try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(recentWorkDirs.value)); } catch {}
    };
    loadRecentDirs();

    const conductorWorkDirLabel = Vue.computed(() => {
      const dir = store.conductorWorkDir;
      if (!dir) return '';
      const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts[parts.length - 1] || dir;
    });

    const pickerLoadDir = (dirPath) => {
      pickerLoading.value = true;
      pickerSelectedFolder.value = '';
      pickerPathInvalid.value = false;
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: '_conductor_picker',
        agentId: store.currentAgent,
        dirPath,
        workDir: store.conductorWorkDir || store.currentAgentInfo?.workDir || '',
        _clientId: store.clientId
      });
    };

    const toggleWorkDirPicker = () => {
      showWorkDirPicker.value = !showWorkDirPicker.value;
      if (showWorkDirPicker.value) {
        const defaultDir = store.conductorWorkDir || store.currentAgentInfo?.workDir || '';
        pickerPathInput.value = defaultDir;
        pickerFolders.value = [];
        pickerSelectedFolder.value = '';
        pickerPathInvalid.value = false;
        loadRecentDirs();
        if (defaultDir) pickerLoadDir(defaultDir);
        Vue.nextTick(() => pickerPathInputRef.value?.focus());
      }
    };

    const pickerNavigateToInput = () => {
      const val = pickerPathInput.value.trim();
      if (!val) return;
      pickerLoadDir(val);
    };

    const pickerNavigateUp = () => {
      if (!pickerPathInput.value) return;
      const isWin = pickerPathInput.value.includes('\\');
      const parts = pickerPathInput.value.replace(/[/\\]$/, '').split(/[/\\]/);
      parts.pop();
      if (parts.length === 0) {
        pickerPathInput.value = '/';
        pickerLoadDir('/');
      } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
        pickerPathInput.value = parts[0] + '\\';
        pickerLoadDir(parts[0] + '\\');
      } else {
        const sep = isWin ? '\\' : '/';
        const parent = parts.join(sep);
        pickerPathInput.value = parent;
        pickerLoadDir(parent);
      }
    };

    const pickerSelectFolder = (name) => {
      pickerSelectedFolder.value = pickerSelectedFolder.value === name ? '' : name;
    };

    const pickerEnterFolder = (name) => {
      const base = pickerPathInput.value.replace(/[/\\]$/, '');
      const sep = base.includes('\\') ? '\\' : '/';
      const newPath = base + sep + name;
      pickerPathInput.value = newPath;
      pickerLoadDir(newPath);
    };

    const pickerSelectRecent = (dir) => {
      store.conductorWorkDir = dir;
      saveRecentDir(dir);
      showWorkDirPicker.value = false;
    };

    const pickerConfirm = () => {
      let path = pickerPathInput.value.trim();
      if (!path) return;
      if (pickerSelectedFolder.value) {
        const sep = path.includes('\\') ? '\\' : '/';
        path = path.replace(/[/\\]$/, '') + sep + pickerSelectedFolder.value;
      }
      store.conductorWorkDir = path;
      saveRecentDir(path);
      showWorkDirPicker.value = false;
    };

    // Listen for directory_listing responses for conductor picker
    const handlePickerListing = (e) => {
      const msg = e.detail;
      if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_conductor_picker') return;
      pickerLoading.value = false;
      if (msg.error) {
        pickerPathInvalid.value = true;
        pickerFolders.value = [];
        return;
      }
      pickerPathInvalid.value = false;
      pickerFolders.value = (msg.entries || [])
        .filter(entry => entry.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));
      if (msg.dirPath != null) pickerPathInput.value = msg.dirPath;
    };

    // Close picker on outside click
    const closePickerOnOutsideClick = (e) => {
      if (!showWorkDirPicker.value) return;
      const pickerEl = document.querySelector('.conductor-workdir-picker');
      const btnEl = document.querySelector('.conductor-workdir-btn');
      if (pickerEl && !pickerEl.contains(e.target) && btnEl && !btnEl.contains(e.target)) {
        showWorkDirPicker.value = false;
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handlePickerListing);
      document.addEventListener('click', closePickerOnOutsideClick);
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', handlePickerListing);
      document.removeEventListener('click', closePickerOnOutsideClick);
    });

    // Initialize conductorWorkDir from agent's workDir when opening conductor
    Vue.watch(() => store.currentConversationIsConductor, (isConductor) => {
      if (isConductor && !store.conductorWorkDir) {
        store.conductorWorkDir = store.currentAgentInfo?.workDir || '';
      }
    }, { immediate: true });

    // Watch for external trigger to open picker (e.g. from ConductorChatView empty state)
    Vue.watch(() => store.conductorPickerOpen, (open) => {
      if (open && !showWorkDirPicker.value) {
        toggleWorkDirPicker();
        store.conductorPickerOpen = false;
      }
    });

    return { store, headerTitle, folderPath, showStatusBanner, statusBannerClass, statusBannerSpinner, statusBannerMessage, contextUsage, contextColorClass, contextLabel, hasStreamingRoles, isCompacting, isClearing, canRefresh, refreshSession, reloadPage, compactContext, clearMessages, openCrewEdit, onCrewPanelToggle, isCrewPanelActive, mcpBtnRef, mcpDropdownStyle, mcpEnabledCount, currentConvNeedRestart, toggleMcpPanel, toggleMcpServer, toggleExpertPanel, conductorCost, conductorActiveTaskCount, showWorkDirPicker, conductorWorkDirLabel, toggleWorkDirPicker, pickerPathInput, pickerPathInputRef, pickerFolders, pickerLoading, pickerSelectedFolder, pickerPathInvalid, isMobilePicker, recentWorkDirs, pickerNavigateToInput, pickerNavigateUp, pickerSelectFolder, pickerEnterFolder, pickerSelectRecent, pickerConfirm };
  }
};
