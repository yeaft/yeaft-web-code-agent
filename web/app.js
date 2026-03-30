import { useChatStore } from './stores/chat.js';
import { useAuthStore } from './stores/auth.js';
import { createI18n } from './utils/i18n.js';
import zhCN from './i18n/zh-CN.js';
import en from './i18n/en.js';
import LoginPage from './components/LoginPage.js';
import ChatPage from './components/ChatPage.js';
import GlobalSidebar from './components/GlobalSidebar.js';
import SplitPane from './components/SplitPane.js';
import ToolLine from './components/ToolLine.js';
import CrewConfigPanel from './components/CrewConfigPanel.js';

// Make stores globally available for components
window.Pinia = {
  ...Pinia,
  useChatStore: null,
  useAuthStore: null
};

const App = {
  components: { LoginPage, ChatPage, GlobalSidebar, SplitPane, CrewConfigPanel },
  template: `
    <LoginPage v-if="!authStore.isAuthenticated" />
    <template v-else>
      <!-- Single-screen mode: unchanged ChatPage -->
      <ChatPage v-if="!chatStore.isSplitMode" />

      <!-- Split-screen mode: GlobalSidebar (left) + SplitPane ×N (right) -->
      <div v-else class="split-screen-layout">
        <GlobalSidebar />
        <div class="split-panes-container" :class="'panes-' + chatStore.splitPanes.length">
          <SplitPane
            v-for="(pane, idx) in chatStore.splitPanes"
            :key="pane.id"
            :paneId="pane.id"
            :paneIndex="idx"
            :paneCount="chatStore.splitPanes.length"
          />
        </div>

        <!-- Split-mode: Conversation Modal (global overlay) -->
        <div class="modal-overlay" v-if="chatStore.splitConvModalOpen" @click.self="closeSplitConvModal">
          <div class="modal resume-modal">
            <div class="resume-modal-controls">
              <button class="resume-close-btn" @click="closeSplitConvModal">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
              <div class="resume-control-row">
                <label class="resume-control-label">Agent</label>
                <div class="resume-select-wrapper">
                  <select v-model="splitConvAgent" @change="onSplitConvAgentChange" class="resume-select">
                    <option value="">{{ $t('chat.agent.select') }}</option>
                    <option v-for="agent in onlineAgents" :key="agent.id" :value="agent.id">
                      {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                    </option>
                  </select>
                  <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                </div>
              </div>
              <div class="resume-control-row" v-if="splitConvAgent">
                <label class="resume-control-label">{{ $t('modal.newConv.workDir') }}</label>
                <input
                  type="text"
                  v-model="splitConvWorkDir"
                  @input="onSplitConvWorkDirInput"
                  :placeholder="splitDefaultWorkDir || $t('modal.newConv.inputOrSelect')"
                  @keypress.enter="createSplitConversation"
                  class="resume-input"
                >
              </div>
            </div>

            <!-- Content Area -->
            <div class="resume-modal-content" v-if="splitConvAgent">
              <!-- Folder list (shown when no workDir typed) -->
              <div class="resume-panel" v-if="!splitConvWorkDir">
                <div class="resume-panel-header">
                  <span>{{ $t('modal.newConv.folderLabel') }}</span>
                  <button class="refresh-btn-mini" @click="loadSplitFolders" :disabled="chatStore.foldersLoading" :title="$t('common.refresh')">
                    <svg v-if="!chatStore.foldersLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                    <span v-else class="mini-spinner"></span>
                  </button>
                </div>
                <div class="resume-panel-list">
                  <div class="resume-panel-loading" v-if="chatStore.foldersLoading">
                    <span class="mini-spinner"></span>
                  </div>
                  <template v-else>
                    <div
                      v-for="folder in chatStore.folders"
                      :key="folder.name"
                      class="resume-list-item folder-item-compact"
                      @click="selectSplitFolder(folder.path)"
                    >
                      <div class="item-path">{{ folder.path }}</div>
                      <span class="item-badge">{{ folder.sessionCount }}</span>
                    </div>
                    <div class="resume-panel-empty" v-if="chatStore.folders.length === 0">
                      {{ $t('modal.newConv.noWorkDirs') }}
                    </div>
                  </template>
                </div>
              </div>

              <!-- Session list (shown after folder selected) -->
              <div class="resume-panel" v-else>
                <div class="resume-panel-header">
                  <div class="resume-panel-header-left">
                    <button class="refresh-btn-mini" @click="splitConvWorkDir = ''; splitHistoryLoaded = false;" title="Back">
                      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                    </button>
                    <span>{{ $t('modal.resume.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(splitConvWorkDir) }}</span></span>
                  </div>
                  <button class="refresh-btn-mini" @click="loadSplitSessions" :disabled="chatStore.historySessionsLoading" :title="$t('common.refresh')">
                    <svg v-if="!chatStore.historySessionsLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                    <span v-else class="mini-spinner"></span>
                  </button>
                </div>
                <div class="resume-panel-list" v-if="splitHistoryLoaded">
                  <div
                    v-for="session in chatStore.historySessions"
                    :key="session.sessionId"
                    class="resume-list-item session-item-compact"
                    @click="resumeSplitSession(session)"
                  >
                    <div class="item-name">{{ session.title || $t('modal.resume.untitled') }}</div>
                    <div class="item-time">{{ formatDate(session.lastModified) }}</div>
                  </div>
                  <div class="resume-panel-empty" v-if="chatStore.historySessions.length === 0 && !chatStore.historySessionsLoading">
                    {{ $t('modal.resume.noSessions') }}
                  </div>
                </div>
              </div>
            </div>

            <!-- Empty state when no agent -->
            <div class="resume-modal-empty" v-else>
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
              </div>
              <div class="empty-text">{{ $t('modal.newConv.selectAgent') }}</div>
            </div>

            <!-- Footer with action button -->
            <div class="resume-modal-footer" v-if="splitConvAgent">
              <button
                class="modern-btn"
                @click="createSplitConversation"
                :disabled="!splitConvAgent"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                {{ $t('modal.newConv.create') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Split-mode: CrewConfigPanel (global overlay) -->
        <CrewConfigPanel
          v-if="chatStore.crewConfigOpen"
          :mode="chatStore.crewConfigMode"
          :session="chatStore.currentCrewSession"
          :status="chatStore.currentCrewStatus"
          :defaultWorkDir="chatStore.currentAgentInfo?.workDir || ''"
          @close="chatStore.crewConfigOpen = false"
          @start="startSplitCrewSession"
        />
      </div>
    </template>
  `,
  setup() {
    const chatStore = useChatStore();
    const authStore = useAuthStore();

    // --- Split-mode conversation modal state ---
    const splitConvAgent = Vue.ref('');
    const splitConvWorkDir = Vue.ref('');
    const splitHistoryLoaded = Vue.ref(false);
    let _workDirInputTimer = null;
    let _foldersRetried = false;

    const onlineAgents = Vue.computed(() => chatStore.agents.filter(a => a.online));

    const splitDefaultWorkDir = Vue.computed(() => {
      if (!splitConvAgent.value) return '';
      const agent = chatStore.agents.find(a => a.id === splitConvAgent.value);
      return agent?.workDir || '';
    });

    // Watch modal open → auto-select agent + load folders
    Vue.watch(() => chatStore.splitConvModalOpen, (open) => {
      if (open) {
        splitConvAgent.value = '';
        splitConvWorkDir.value = '';
        splitHistoryLoaded.value = false;
        _foldersRetried = false;
        const currentOnline = onlineAgents.value.find(a => a.id === chatStore.currentAgent);
        const selected = currentOnline || onlineAgents.value[0];
        if (selected) {
          splitConvAgent.value = selected.id;
          chatStore.listFoldersForAgent(selected.id).then(() => {
            if (chatStore.splitConvModalOpen && chatStore.folders.length === 0 && !_foldersRetried) {
              _foldersRetried = true;
              setTimeout(() => {
                if (chatStore.splitConvModalOpen && splitConvAgent.value) {
                  chatStore.listFoldersForAgent(splitConvAgent.value);
                }
              }, 1500);
            }
          });
        }
      }
    });

    function closeSplitConvModal() {
      chatStore.splitConvModalOpen = false;
      chatStore._pendingPaneId = null;
      splitConvAgent.value = '';
      splitConvWorkDir.value = '';
      splitHistoryLoaded.value = false;
    }

    function onSplitConvAgentChange() {
      if (splitConvAgent.value) {
        splitConvWorkDir.value = '';
        splitHistoryLoaded.value = false;
        chatStore.listFoldersForAgent(splitConvAgent.value);
      }
    }

    function onSplitConvWorkDirInput() {
      splitHistoryLoaded.value = false;
      if (_workDirInputTimer) clearTimeout(_workDirInputTimer);
      _workDirInputTimer = setTimeout(() => {
        if (splitConvWorkDir.value.trim() && splitConvAgent.value) {
          chatStore.listHistorySessionsForAgent(splitConvAgent.value, splitConvWorkDir.value.trim());
          splitHistoryLoaded.value = true;
        }
      }, 500);
    }

    function selectSplitFolder(path) {
      splitConvWorkDir.value = path;
      splitHistoryLoaded.value = false;
      if (splitConvAgent.value) {
        chatStore.listHistorySessionsForAgent(splitConvAgent.value, path);
        splitHistoryLoaded.value = true;
      }
    }

    function loadSplitFolders() {
      if (splitConvAgent.value) {
        chatStore.listFoldersForAgent(splitConvAgent.value);
      }
    }

    function loadSplitSessions() {
      if (splitConvAgent.value && splitConvWorkDir.value) {
        chatStore.listHistorySessionsForAgent(splitConvAgent.value, splitConvWorkDir.value);
      }
    }

    function createSplitConversation() {
      if (!splitConvAgent.value) return;
      chatStore.selectAgent(splitConvAgent.value);
      const workDir = splitConvWorkDir.value.trim() || splitDefaultWorkDir.value;
      chatStore.createConversation(workDir, splitConvAgent.value);
      closeSplitConvModal();
    }

    function resumeSplitSession(session) {
      if (!splitConvAgent.value) return;
      chatStore.selectAgent(splitConvAgent.value);
      chatStore._pendingSessionTitle = session.title;
      const workDir = session.workDir || splitConvWorkDir.value.trim() || splitDefaultWorkDir.value;
      chatStore.resumeConversation(session.sessionId, workDir, splitConvAgent.value);
      closeSplitConvModal();
    }

    function startSplitCrewSession(config) {
      chatStore.createCrewSession(config);
    }

    function getLastPathSegment(path) {
      if (!path) return '';
      const parts = path.replace(/\/+$/, '').split('/');
      return parts[parts.length - 1] || path;
    }

    function formatDate(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now - date;
      if (diffMs < 60000) return 'now';
      if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Initialize theme
    chatStore.initTheme();

    // Setup visibility handler for mobile app switching
    chatStore.setupVisibilityHandler();

    // Check auth mode and try to restore session
    Vue.onMounted(async () => {
      await authStore.checkAuthMode();

      // Try to restore session from stored token (if not already authenticated via skip auth)
      if (!authStore.isAuthenticated) {
        await authStore.restoreSession();
      }

      // If authenticated (skip auth mode or restored session), connect WebSocket
      if (authStore.isAuthenticated) {
        console.log('[App] Authenticated, connecting WebSocket...');
        chatStore.connect();
      }
    });

    // Watch for authentication changes
    Vue.watch(() => authStore.isAuthenticated, (isAuth) => {
      if (isAuth) {
        chatStore.connect();
      }
    });

    return {
      authStore,
      chatStore,
      // Split conv modal
      splitConvAgent,
      splitConvWorkDir,
      splitHistoryLoaded,
      onlineAgents,
      splitDefaultWorkDir,
      closeSplitConvModal,
      onSplitConvAgentChange,
      onSplitConvWorkDirInput,
      selectSplitFolder,
      loadSplitFolders,
      loadSplitSessions,
      createSplitConversation,
      resumeSplitSession,
      startSplitCrewSession,
      getLastPathSegment,
      formatDate
    };
  }
};

// Create and mount Vue app
const app = Vue.createApp(App);
const pinia = Pinia.createPinia();
app.use(pinia);

// Install i18n
createI18n(app, { 'zh-CN': zhCN, en });

// Set up the store references after pinia is installed
window.Pinia.useChatStore = useChatStore;
window.Pinia.useAuthStore = useAuthStore;

// Register global components
app.component('ToolLine', ToolLine);

app.mount('#app');
