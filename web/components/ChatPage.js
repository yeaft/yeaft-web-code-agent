import DigitalPersonPage from './DigitalPersonPage.js';
import ScheduledTaskNotifications from './ScheduledTaskNotifications.js';
import { folderPickerData, folderPickerMethods, folderPickerComputed } from './mixins/folder-picker-mixin.js';
import FolderPickerDialog from './FolderPickerDialog.js';
import { alertDialog, confirmDialog } from '../utils/dialog.js';
import ChatHeader from './ChatHeader.js';
import MessageList from './MessageList.js';
import ChatInput from './ChatInput.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import SettingsPanel from './SettingsPanel.js';
import AgentSettingsPanel from './AgentSettingsPanel.js';
import ExpertPanel from './ExpertPanel.js';
import SubAgentPanel from './SubAgentPanel.js';
import BtwOverlay from './BtwOverlay.js';
import SplitPane from './SplitPane.js';
import ModernSelect from './ModernSelect.js';
import SidebarAgentHeader from './SidebarAgentHeader.js';
import SidebarWorkCenter from './SidebarWorkCenter.js';
import SidebarDigitalPerson from './SidebarDigitalPerson.js';
import SessionSidebarShell from './SessionSidebarShell.js';
import SessionSidebarResizeHandle from './SessionSidebarResizeHandle.js';
import UnifiedSessionList from './UnifiedSessionList.js';
import SessionCreateModal from './SessionCreateModal.js';
import WorkCenterPage from './WorkCenterPage.js';
import PluginCenterPage from './PluginCenterPage.js';
import NavigationIcon from './NavigationIcon.js';
import { shortenPath as shortenPathUtil } from '../utils/path-display.js';
import { getLastPathSegment as _getLastPathSegment, formatResumeDate } from '../utils/path-segments.js';
import { sortSessionsByActivity } from '../stores/helpers/session-order.js';
import { useAuthStore } from '../stores/auth.js';
import { collapseSidebar } from '../utils/sidebar-collapse.js';

export default {
  name: 'ChatPage',
  components: { NavigationIcon, DigitalPersonPage, ScheduledTaskNotifications, FolderPickerDialog, ChatHeader, MessageList, ChatInput, WorkbenchPanel, WorkCenterPage, PluginCenterPage, SettingsPanel, AgentSettingsPanel, ExpertPanel, SubAgentPanel, BtwOverlay, SplitPane, ModernSelect, SidebarAgentHeader, SidebarWorkCenter, SidebarDigitalPerson, SessionSidebarShell, SessionSidebarResizeHandle, UnifiedSessionList, SessionCreateModal },
  template: `
    <div class="chat-page" :class="{ 'show-sidebar': store.sessionSidebarOpen }">

      <!-- Sidebar Overlay -->
      <div :inert="store.digitalPersonOpen && digitalPersonModalOpen ? true : undefined" class="sidebar-overlay" v-if="store.sessionSidebarOpen && !store.workCenterOpen" @click="store.closeSessionSidebar()"></div>

      <!-- Left Sidebar -->
      <SessionSidebarShell id="session-sidebar" v-show="!store.workCenterOpen" class="sidebar" :inert="store.digitalPersonOpen && digitalPersonModalOpen ? true : undefined" :collapsed="effectiveSidebarCollapsed">
        <template #collapsed>
        <!-- Collapsed Icon Bar -->
        <div class="sidebar-collapsed-bar" v-if="effectiveSidebarCollapsed">
          <button v-if="!store.isSplitMode || store.digitalPersonOpen" class="collapsed-icon-btn" @click="store.toggleSidebar()" :title="$t('chat.sidebar.expand')">
            <NavigationIcon name="menu" :size="18" />
          </button>
          <button class="collapsed-icon-btn" @click="store.addPanel()" :title="$t('splitScreen.split')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
            </svg>
          </button>
          <SidebarDigitalPerson :collapsed="true" />
          <button class="collapsed-icon-btn" @click="onUnifiedCreate" :disabled="onlineAgentCount === 0" :title="$t('chat.sidebar.newConv')">
            <NavigationIcon name="add" :size="18" />
          </button>
          <SidebarWorkCenter
            v-if="store.workCenterUiEnabled"
            :agents="store.agents"
            :active-agent-id="store.workCenterAgentId"
            :collapsed="true"
            @open="store.enterWorkCenter"
          />
          <div class="collapsed-spacer"></div>
          <button class="collapsed-icon-btn" @click="store.toggleTheme()" :title="store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode')">
            <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
          </button>
        </div>
        </template>
        <!-- Agent Status -->
        <div class="sidebar-top">
          <!-- Header Row: Agent status + action icons (Copilot style) -->
          <div class="sidebar-header-row">
            <SidebarAgentHeader
              :online-agents="onlineAgents"
              :online-agent-count="onlineAgentCount"
              :restarting-agents="restartingAgents"
              :upgrading-agents="upgradingAgents"
              :show-agent-actions="true"
              :can-upgrade-all="bulkUpgradableAgents.length > 0"
              :upgrading-all="!!store.agentUpgradeBatch?.pending"
              @open-agent-settings="openAgentSettings(store.currentAgent || null)"
              @restart-agent="restartAgent"
              @upgrade-agent="upgradeAgent"
              @upgrade-all-agents="upgradeAllAgents"
            />
            <div class="sidebar-header-actions">
              <SidebarWorkCenter
                v-if="store && store.workCenterUiEnabled"
                :agents="store.agents"
                :active-agent-id="store.workCenterAgentId"
                @open="store.enterWorkCenter"
              />
              <button class="sidebar-icon-btn" @click="onSidebarCollapse" :title="$t('chat.sidebar.collapse')">
                <NavigationIcon name="collapse" :size="18" />
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

        <UnifiedSessionList
          :sessions="store.sidebarSessionCatalog || store.sessionCatalog"
          :loading="store.sidebarSessionCatalogLoading ?? !store.sessionCatalogLoaded"
          :project-store="store"
          :active-route="store.activeSessionRoute"
          :is-session-unread="isCatalogSessionUnread"
          :processing-conversations="store.processingConversations"
          :is-yeaft-session-processing="store.isYeaftSessionProcessing"
          :agents="store.agents"
          :work-center-open="store.workCenterOpen"
          @select="store.openCatalogSession"
          @create="onUnifiedCreate"
          @create-task="onUnifiedCreateTask"
          @create-in-project="onUnifiedCreateInProject"
          @close-work-center="store.leaveWorkCenter"
          @action="onUnifiedSessionAction"
        />

        <div class="sidebar-bottom">
          <button class="sidebar-nav-item" @click="showSettingsPanel = true">
            <NavigationIcon name="settings" :size="18" />
            <span>{{ $t('chat.sidebar.settings') }}</span>
            <span v-if="serverVersion" class="sidebar-version">{{ serverVersion }}</span>
          </button>
        </div>
      </SessionSidebarShell>
      <SessionSidebarResizeHandle v-if="!store.workCenterOpen && !effectiveSidebarCollapsed && !isMobileView"
        :inert="store.digitalPersonOpen && digitalPersonModalOpen ? true : undefined" controls="session-sidebar" />

      <ScheduledTaskNotifications :store="store" />
      <DigitalPersonPage v-if="store.digitalPersonOpen" @toggle-sidebar="store.toggleSessionSidebar()" @interaction-blocked="digitalPersonModalOpen = $event" />
      <WorkCenterPage v-else-if="store.workCenterOpen" />
      <PluginCenterPage v-else-if="store.pluginCenterOpen" @close="store.closePluginCenter()" @toggle-sidebar="store.toggleSessionSidebar()" />

      <!-- Single-panel Main Chat Area -->
      <main v-else-if="!store.isSplitMode" class="main-content" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
          <ChatHeader :can-use-workbench="canUseWorkbench" @toggle-sidebar="store.toggleSessionSidebar()" />
          <div class="chat-body" :class="{ 'expert-panel-open': store.activeRightPanel }">
            <div class="chat-body-main">
              <MessageList
                @new-conversation="onUnifiedCreate"
                @resume-conversation="openConversationModalResume"
                @open-settings="showSettingsPanel = true"
              />
              <BtwOverlay />
              <ChatInput v-if="store.activeConversationId || onlineAgents.length > 0" :conversation-id="store.activeConversationId" />
            </div>
            <!-- Right Panel overlay (mobile only) -->
            <div class="expert-panel-overlay" v-if="store.activeRightPanel" @click="store.activeRightPanel = null"></div>
            <SubAgentPanel
              v-if="store.activeRightPanel === 'subagents'"
              :visible="true"
              @close="store.activeRightPanel = null"
            />
            <ExpertPanel
              v-else-if="store.activeRightPanel === 'experts'"
              :visible="true"
              :modelValue="store.expertSelections"
              @update:modelValue="store.expertSelections = $event"
              @close="store.activeRightPanel = null"
            />
            <WorkbenchPanel v-if="canUseWorkbench && !store.isSplitMode" />
          </div>
      </main>

      <!-- Multi-panel mode: SplitPane ×N -->
      <div v-else-if="!store.workCenterOpen && !store.pluginCenterOpen && !store.digitalPersonOpen" class="panels-container" :class="'panes-' + store.panels.length">
        <SplitPane
          v-for="(panel, idx) in store.panels"
          :key="panel.id"
          :paneId="panel.id"
          :paneIndex="idx"
          :paneCount="store.panels.length"
        />
      </div>

      <!-- Settings (floating modal) -->
      <SettingsPanel :visible="showSettingsPanel" @close="showSettingsPanel = false" />
      <AgentSettingsPanel v-if="showAgentSettings" :initial-agent-id="agentSettingsAgentId" @close="showAgentSettings = false" />



      <SessionCreateModal
        v-if="unifiedSessionCreateOpen"
        :task-mode="unifiedSessionCreateTaskMode"
        :initial-provider="unifiedSessionCreateProvider"
        :initial-agent-id="unifiedSessionCreateProject?.legacyAgentId || null"
        @close="closeUnifiedSessionCreate"
        @created="onUnifiedSessionCreated"
      />

      <!-- Legacy Conversation Modal (resume and pre-catalog fallback) -->
      <div class="modal-overlay" v-if="showConversationModal" @click.self="closeConversationModal">
        <div class="modal resume-modal">
          <!-- Top Controls -->
          <div class="resume-modal-controls">
            <button class="resume-close-btn" @click="closeConversationModal">
              <NavigationIcon name="close" :size="18" />
            </button>
            <div class="resume-control-row">
              <label class="resume-control-label">Agent</label>
              <div class="resume-select-wrapper">
                <select v-model="convModalAgent" @change="onConvModalAgentChange" class="resume-select">
                  <option value="">{{ $t('chat.agent.select') }}</option>
                  <option v-for="agent in onlineAgents" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>
            <div class="resume-control-row" v-if="convModalAgent">
              <label class="resume-control-label">{{ $t('modal.newConv.provider') }}</label>
              <div class="resume-select-wrapper">
                <select v-model="convModalProvider" @change="onConvModalProviderChange" class="resume-select">
                  <option value="claude-code">{{ $t('provider.claudeCode') }}</option>
                  <option value="copilot">{{ $t('provider.copilot') }}</option>
                </select>
                <svg class="select-arrow" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
              </div>
            </div>
            <div class="resume-control-row" v-if="convModalAgent">
              <label class="resume-control-label">{{ $t('modal.newConv.workDir') }}</label>
              <div class="workdir-input-group">
                <input
                  type="text"
                  v-model="convModalWorkDir"
                  @input="onConvModalWorkDirInput"
                  :placeholder="selectedConvModalAgentWorkDir || $t('modal.newConv.inputOrSelect')"
                  @keypress.enter="createNewConversation()"
                  class="resume-input"
                >
                <button class="workdir-browse-btn" @click="openFolderPicker('convModal')" :title="$t('modal.newConv.browse')">
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                </button>
              </div>
            </div>
          </div>


          <!-- Content Area -->
          <div class="resume-modal-content" v-if="convModalAgent">
            <!-- Folder list (shown when no folder selected) -->
            <div class="resume-panel" v-if="!convModalWorkDir">
              <div class="resume-panel-header">
                <span>{{ $t('modal.newConv.folderLabel') }}</span>
                <button class="refresh-btn-mini" @click="loadConvModalFolders" :disabled="store.foldersLoading" :title="$t('common.refresh')">
                  <svg v-if="!store.foldersLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list">
                <div class="resume-panel-loading" v-if="store.foldersLoading">
                  <span class="mini-spinner"></span>
                </div>
                <template v-else>
                  <button
                    v-for="folder in store.folders"
                    :key="folder.name"
                    type="button"
                    class="resume-list-item folder-item-compact"
                    :title="folder.path"
                    @click="selectConvModalFolder(folder.path)"
                  >
                    <span class="item-path">{{ folder.path }}</span>
                    <span class="item-badge">{{ folder.sessionCount }}</span>
                  </button>
                  <div class="resume-panel-empty" v-if="store.folders.length === 0">
                    {{ $t('modal.newConv.noWorkDirs') }}
                  </div>
                </template>
              </div>
            </div>

            <!-- Session list (shown after folder selected, with back button) -->
            <div class="resume-panel" v-else>
              <div class="resume-panel-header">
                <div class="resume-panel-header-left">
                  <button type="button" class="refresh-btn-mini" @click="convModalWorkDir = ''; selectedResumeSession = null; historyLoaded = false;" :title="$t('common.back')" :aria-label="$t('common.back')">
                    <NavigationIcon name="back" :size="14" />
                  </button>
                  <span>{{ $t('modal.resume.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(convModalWorkDir) }}</span></span>
                </div>
                <button class="refresh-btn-mini" @click="loadConvModalSessions" :disabled="store.historySessionsLoading" :title="$t('common.refresh')">
                  <svg v-if="!store.historySessionsLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list" v-if="historyLoaded">
                <button
                  v-for="session in store.historySessions"
                  :key="session.sessionId"
                  type="button"
                  class="resume-list-item session-item-compact"
                  @click="resumeSession(session)"
                >
                  <span class="item-name">{{ session.title || $t('modal.resume.untitled') }}</span>
                  <span class="item-time">{{ formatDate(session.lastModified) }}</span>
                </button>
                <div class="resume-panel-empty" v-if="store.historySessions.length === 0 && !store.historySessionsLoading">
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
          <div class="resume-modal-footer" v-if="convModalAgent">
            <button
              class="modern-btn"
              @click="createNewConversation"
              :disabled="!convModalAgent"
            >
              <NavigationIcon name="add" :size="16" />
              {{ $t('modal.newConv.create') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Settings Panel -->

      <!-- Folder Picker Dialog -->
        <FolderPickerDialog v-if="folderPickerOpen" :state="folderPickerState"
          @navigate="loadFolderPickerDir" @edit-path="folderPickerEditPath"
          @confirm="confirmFolderPicker" @close="closeFolderPicker" />
    </div>
  `,
  data() {
    return {
      digitalPersonModalOpen: false,
      showAgentDropdown: false,
      showSettingsPanel: false,
      showAgentSettings: false,
      agentSettingsAgentId: null,
      // Unified conversation modal state
      showConversationModal: false,
      unifiedSessionCreateOpen: false,
      unifiedSessionCreateTaskMode: false,
      unifiedSessionCreateProvider: 'yeaft',
      unifiedSessionCreateProject: null,
      convModalAgent: '',
      convModalWorkDir: '',
      convModalProvider: 'claude-code',
      selectedResumeSession: null,
      historyLoaded: false,
      windowWidth: window.innerWidth,
      // Folder picker state
      ...folderPickerData(),
      serverVersion: '',
      chatGroupCollapsed: false,
      sidebarTab: 'chat',
      // Inline rename state
      editingChatId: null,
      editingChatName: '',
      activeSessionMenu: null
    };
  },
  computed: {
    ...folderPickerComputed,
    chat() { return this.store; },
    folderPickerAgentId() { return this.convModalAgent; },
    store() {
      return Pinia.useChatStore();
    },
    restartingAgents() {
      return Object.fromEntries(Object.entries(this.store.agentOperations || {}).filter(([, value]) => value.restart?.pending));
    },
    upgradingAgents() {
      return Object.fromEntries(Object.entries(this.store.agentOperations || {}).filter(([, value]) => value.upgrade?.pending));
    },
    bulkUpgradableAgents() {
      return typeof this.store.getUpgradableAgents === 'function' ? this.store.getUpgradableAgents() : [];
    },
    providerOptions() {
      return [
        { value: 'claude-code', label: this.$t('provider.claudeCode') },
        { value: 'copilot',     label: this.$t('provider.copilot')    },
      ];
    },
    agentOptions() {
      return this.store.agents.filter(a => a.online).map(a => ({
        value: a.id,
        label: `${a.name}${a.latency ? ` (${a.latency}ms)` : ''}`,
      }));
    },
    canUseWorkbench() {
      const role = useAuthStore().role;
      return role === 'admin' || role === 'pro';
    },
    selectedConvModalAgentWorkDir() {
      if (!this.convModalAgent) return '';
      const agent = this.store.agents.find(a => a.id === this.convModalAgent);
      return agent?.workDir || '';
    },
    onlineAgents() {
      return this.store.agents.filter(a => a.online);
    },
    onlineAgentCount() {
      return this.onlineAgents.length;
    },
    isMobileView() {
      return this.windowWidth <= 768;
    },
    effectiveSidebarCollapsed() {
      return this.isMobileView ? !this.store.sessionSidebarOpen : this.store.sidebarCollapsed;
    },
    normalConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => (
        c.agentOnline !== false && !this.isConversationHidden(c)
      )));
    },
    pinnedChatConversations() {
      const pinned = this.store.conversations.filter(c => (
        c.agentOnline !== false
        && !this.isConversationHidden(c)
        && this.store.isSessionPinned(c.id)
      ));
      return this.sortByActivity(pinned);
    },
    unpinnedChatConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => (
        c.agentOnline !== false
        && !this.isConversationHidden(c)
        && !this.store.isSessionPinned(c.id)
      )));
    },
    chatSessionCount() {
      return this.store.conversations.filter(c => (
        c.agentOnline !== false && !this.isConversationHidden(c)
      )).length;
    },
  },
  methods: {
    isConversationHidden(conv) {
      if (!conv?.id) return false;
      return (this.store.hiddenSessionCatalog || []).some(row => (
        row?.runtimeProvider === (conv.provider || 'claude-code')
        && row?.routeRef?.sessionId === conv.id
        && row?.routeRef?.agentId === (conv.agentId || this.store.currentAgent || null)
      ));
    },
    onSidebarCollapse() {
      collapseSidebar({
        isMobileView: this.isMobileView,
        showMobileSidebar: this.store.sessionSidebarOpen,
        closeMobileSidebar: () => this.store.closeSessionSidebar(),
        toggleSidebar: () => this.store.toggleSidebar(),
      });
    },
    onModeFlip(target) {
      if (target === 'yeaft') {
        this.store.enterYeaft();
      } else {
        this.store.leaveYeaft();
      }
    },
    sortByActivity(conversations) {
      return sortSessionsByActivity(conversations);
    },
    isCatalogSessionUnread(row) {
      if (row?.runtimeProvider !== 'yeaft') return false;
      return this.store.isYeaftSessionUnread(row.routeRef?.sessionId, row.routeRef?.agentId);
    },
    onUnifiedCreateTask() {
      this.onUnifiedCreate();
      this.unifiedSessionCreateTaskMode = true;
    },
    onUnifiedCreate(provider = 'yeaft') {
      this.store.leaveDigitalPerson();
      this.store.closePluginCenter();
      this.store.leaveWorkCenter();
      this.unifiedSessionCreateTaskMode = false;
      this.unifiedSessionCreateProject = null;
      this.unifiedSessionCreateProvider = ['yeaft', 'copilot', 'claude-code'].includes(provider) ? provider : 'yeaft';
      this.unifiedSessionCreateOpen = true;
    },
    onUnifiedCreateInProject({ project, taskMode = false } = {}) {
      if (!project?.id) return;
      this.store.leaveDigitalPerson();
      this.store.closePluginCenter();
      this.store.leaveWorkCenter();
      this.unifiedSessionCreateTaskMode = taskMode === true;
      this.unifiedSessionCreateProject = project;
      this.unifiedSessionCreateProvider = 'yeaft';
      this.unifiedSessionCreateOpen = true;
    },
    closeUnifiedSessionCreate() {
      this.unifiedSessionCreateOpen = false;
      this.unifiedSessionCreateProject = null;
    },
    async onUnifiedSessionCreated(session) {
      const project = this.unifiedSessionCreateProject;
      this.closeUnifiedSessionCreate();
      if (!project || !session?.id) return;
      const agentId = session.agentId || project.legacyAgentId || this.store.currentAgent || null;
      const result = await this.store.mutateProject?.('move_session', {
        sessionId: session.id,
        projectId: project.legacyProjectId || project.id,
      }, agentId);
      if (!result?.ok) {
        const message = result?.error?.message || result?.error?.code || 'unknown';
        await alertDialog(this.$t('sidebar.projects.assignFailed', { name: project.name, message }));
      }
    },
    async onUnifiedSessionAction({ action, row, title, sessions } = {}) {
      if (!row?.routeRef) return;
      const { runtimeProvider, agentId, sessionId } = row.routeRef;
      if (action === 'rename') {
        this.store.renameCatalogSession({ row, title });
      } else if (action === 'reorder') {
        this.store.reorderCatalogSessions(sessions);
      } else if (action === 'pin') {
        this.store.toggleCatalogSessionPin(row);
      } else if (action === 'remove') {
        this.store.hideCatalogSession(row);
      } else if (runtimeProvider === 'yeaft' && action === 'merge') {
        this.store.openSessionMerge(row);
      } else if (runtimeProvider === 'yeaft' && action === 'copy') {
        const result = await this.store.copyCatalogSession(row);
        if (!result?.ok) {
          const code = result?.error?.code || 'unknown';
          const key = `yeaft.session.error.${code}`;
          const translated = this.$t(key);
          const message = translated === key ? (result?.error?.message || code) : translated;
          await alertDialog(this.$t('yeaft.session.copyFailed', { message }));
        }
      } else if (runtimeProvider === 'yeaft' && action === 'settings') {
        this.store.pendingUnifiedSessionSettings = { sessionId, agentId, section: 'session' };
        this.store.openCatalogSession(row);
      }
    },
    openConversationModal({ preserveProvider = false } = {}) {
      this.showConversationModal = true;
      if (!preserveProvider) this.convModalProvider = 'claude-code';
      this.convModalAgent = '';
      this.convModalWorkDir = '';
      this.selectedResumeSession = null;
      this.historyLoaded = false;
      this._foldersRetried = false;
      // 优先选择当前 agent（如果在线），否则选第一个在线 agent
      const onlineAgents = this.store.agents.filter(a => a.online);
      const currentAgentOnline = onlineAgents.find(a => a.id === this.store.currentAgent);
      const selectedAgent = currentAgentOnline || onlineAgents[0];
      if (selectedAgent) {
        this.convModalAgent = selectedAgent.id;
        this.store.listFoldersForAgent(this.convModalAgent, this.convModalProvider).then(() => {
          // 如果首次加载结果为空且 modal 仍然打开，自动重试一次
          if (this.showConversationModal && this.store.folders.length === 0 && !this._foldersRetried) {
            this._foldersRetried = true;
            setTimeout(() => {
              if (this.showConversationModal && this.convModalAgent) {
                this.store.listFoldersForAgent(this.convModalAgent, this.convModalProvider);
              }
            }, 1500);
          }
        });
      }
    },
    openConversationModalResume() {
      this.openConversationModal();
    },
    closeConversationModal() {
      this.showConversationModal = false;
      this.convModalAgent = '';
      this.convModalWorkDir = '';
      this.selectedResumeSession = null;
      this.historyLoaded = false;
    },
    onConvModalAgentChange() {
      if (this.convModalAgent) {
        this.convModalWorkDir = '';
        this.selectedResumeSession = null;
        this.historyLoaded = false;
        this.store.listFoldersForAgent(this.convModalAgent, this.convModalProvider);
      }
    },
    onConvModalProviderChange() {
      // Switching provider invalidates the folder/session lists — reload.
      this.convModalWorkDir = '';
      this.selectedResumeSession = null;
      this.historyLoaded = false;
      if (this.convModalAgent) {
        this.store.listFoldersForAgent(this.convModalAgent, this.convModalProvider);
      }
    },
    onConvModalWorkDirInput() {
      this.historyLoaded = false;
      this.selectedResumeSession = null;
      if (this._workDirInputTimer) {
        clearTimeout(this._workDirInputTimer);
      }
      this._workDirInputTimer = setTimeout(() => {
        if (this.convModalWorkDir.trim() && this.convModalAgent) {
          this.store.listHistorySessionsForAgent(this.convModalAgent, this.convModalWorkDir.trim(), this.convModalProvider);
          this.historyLoaded = true;
        }
      }, 500);
    },
    selectConvModalFolder(path) {
      this.convModalWorkDir = path;
      this.selectedResumeSession = null;
      // 自动加载该 folder 下的 sessions
      if (this.convModalAgent) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, path, this.convModalProvider);
        this.historyLoaded = true;
      }
    },
    loadConvModalFolders() {
      if (this.convModalAgent) {
        this.store.listFoldersForAgent(this.convModalAgent, this.convModalProvider);
      }
    },
    loadConvModalSessions() {
      if (this.convModalAgent && this.convModalWorkDir.trim()) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, this.convModalWorkDir.trim(), this.convModalProvider);
        this.historyLoaded = true;
      }
    },
    toggleAgentDropdown() {
      this.showAgentDropdown = !this.showAgentDropdown;
      if (this.showAgentDropdown) {
        this.store.refreshAgents();
      }
    },
    selectAgent(agentId) {
      this.store.selectAgent(agentId);
      this.showAgentDropdown = false;
    },
    createNewConversation() {
      if (!this.convModalAgent) return;
      this.store.selectAgent(this.convModalAgent);
      const workDir = this.convModalWorkDir.trim() || this.selectedConvModalAgentWorkDir;
      this.store.createConversation(workDir, this.convModalAgent, null, this.buildConvOpts());
      this.closeConversationModal();
    },
    // Build the { provider, providerOptions } payload shared by the create
    // and resume paths. Copilot CLI owns model selection, so the web UI must
    // not send a model override that can make ACP startup fail or hang.
    buildConvOpts() {
      const opts = { provider: this.convModalProvider };
      if (this.convModalProvider === 'copilot') {
        opts.providerOptions = { allowAllTools: true };
      }
      return opts;
    },
    resumeSession(session) {
      if (!this.convModalAgent) return;
      this.store.selectAgent(this.convModalAgent);
      this.store._pendingSessionTitle = session.title;
      const workDir = session.workDir || this.convModalWorkDir.trim() || this.selectedConvModalAgentWorkDir;
      this.store.resumeConversation(session.sessionId, workDir, this.convModalAgent, this.buildConvOpts());
      this.closeConversationModal();
    },
    resumeSelectedSession() {
      if (!this.convModalAgent || !this.selectedResumeSession) return;
      this.store.selectAgent(this.convModalAgent);
      this.store._pendingSessionTitle = this.selectedResumeSession.title;
      const workDir = this.selectedResumeSession.workDir || this.convModalWorkDir.trim() || this.selectedConvModalAgentWorkDir;
      this.store.resumeConversation(this.selectedResumeSession.sessionId, workDir, this.convModalAgent, this.buildConvOpts());
      this.closeConversationModal();
    },
    formatDate(timestamp) {
      return formatResumeDate(timestamp, this.$t.bind(this));
    },
    selectConversation(conversationId, agentId) {
      this.store.leaveWorkCenter();
      this.store.selectConversation(conversationId, agentId, { refresh: true });
      this.store.closeSessionSidebar();
    },
    onSessionClick(conv) {
      if (conv.agentOnline === false) {
        this.store.addMessage({ type: 'system', content: this.$t('chat.session.agentOffline') });
        return;
      }
      // In multi-panel mode, route to the active panel
      if (this.store.isSplitMode && this.store.activePanelId) {
        this.store.leaveWorkCenter();
        this.store.setPanelConversation(this.store.activePanelId, conv.id, { refresh: true });
        this.store.closeSessionSidebar();
        return;
      }
      this.selectConversation(conv.id, conv.agentId);
    },
    hideSessionFromSidebar(conv) {
      if (!conv?.id) return;
      const runtimeProvider = conv.provider || 'claude-code';
      this.store.hideCatalogSession({
        catalogKey: `chat:${conv.id}`,
        runtimeProvider,
        routeRef: {
          runtimeProvider,
          agentId: conv.agentId || this.store.currentAgent || null,
          sessionId: conv.id,
        },
        title: this.getConversationTitle(conv),
        workDir: conv.workDir || '',
        agentName: conv.agentName || '',
        availability: conv.agentOnline === false ? 'offline' : 'online',
        pinned: this.store.isSessionPinned(conv.id),
      });
    },
    closeSession(conversationId, agentId) {
      this.store.closeSession(conversationId, agentId);
    },
    async deleteConversation(conversationId, agentId) {
      if (await confirmDialog(this.$t('chat.delete.confirm'), { destructive: true })) {
        this.store.deleteConversation(conversationId, agentId);
      }
    },
    getConversationTitle(conv) {
      // 优先使用 store 中缓存的标题（最新用户消息）
      const cachedTitle = this.store.getConversationTitle(conv.id);
      if (cachedTitle) {
        return cachedTitle.length > 30 ? cachedTitle.slice(0, 30) + '...' : cachedTitle;
      }
      // 其次显示简短的 session ID
      if (conv.claudeSessionId) {
        return conv.claudeSessionId.slice(0, 8) + '...';
      }
      return conv.id.slice(0, 8) + '...';
    },
    getConversationFullTitle(conv) {
      const cachedTitle = this.store.getConversationTitle(conv.id);
      if (cachedTitle && cachedTitle.length > 30) {
        return cachedTitle;
      }
      return undefined;
    },
    startChatRename(conv) {
      this.editingChatId = conv.id;
      this.editingChatName = this.store.customConversationTitles[conv.id] || this.store.conversationTitles[conv.id] || '';
      this.$nextTick(() => {
        const input = this.$refs.chatRenameInput;
        if (input) {
          const el = Array.isArray(input) ? input[0] : input;
          el.focus();
          el.select();
        }
      });
    },
    commitChatRename() {
      if (!this.editingChatId) return;
      const convId = this.editingChatId;
      const title = this.editingChatName.trim();
      this.editingChatId = null;
      this.editingChatName = '';
      this.store.renameChatSession(convId, title);
    },
    cancelChatRename() {
      this.editingChatId = null;
      this.editingChatName = '';
    },
    toggleSessionMenu(convId) {
      this.activeSessionMenu = this.activeSessionMenu === convId ? null : convId;
    },
    closeSessionMenu() {
      this.activeSessionMenu = null;
    },
    getConversationTime(conv) {
      // 优先显示最后活动时间，其次创建时间
      const execStatus = this.store.executionStatusMap[conv.id];
      const ts = execStatus?.lastActivity || conv.createdAt;
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      const diffMs = now - date;
      if (diffMs < 60000) return this.$t('chat.time.justNow');
      if (diffMs < 3600000) return this.$t('chat.time.minutesAgo', { count: Math.floor(diffMs / 60000) });
      // 今天内显示时间
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    },
    providerLabel(p) {
      if (p === 'copilot') return this.$t('provider.copilot');
      if (p === 'claude-code') return this.$t('provider.claudeCode');
      return p || '';
    },
    shortenPath(path) {
      return shortenPathUtil(path);
    },
    formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    getLastPathSegment(path) {
      return _getLastPathSegment(path);
    },
    getParentPath(path) {
      if (!path) return '';
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return '';
      return parts.slice(0, -1).join('/');
    },
    handleResize() {
      this.windowWidth = window.innerWidth;
    },
    openAgentSettings(agentId) {
      this.agentSettingsAgentId = agentId || null;
      this.showAgentSettings = true;
    },
    async restartAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!await confirmDialog(this.$t('chat.agent.restartConfirm', { name }))) return;
      this.store.restartAgent(agentId);
    },
    async upgradeAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!await confirmDialog(this.$t('chat.agent.upgradeConfirm', { name }))) return;
      this.store.upgradeAgent(agentId);
    },
    async upgradeAllAgents() {
      const candidates = this.bulkUpgradableAgents;
      if (candidates.length === 0) return;
      const skipped = Math.max(0, (this.store.agents || []).length - candidates.length);
      if (!await confirmDialog(this.$t('chat.agent.upgradeAllConfirm', { count: candidates.length, skipped }))) return;
      this.store.upgradeAllAgents();
    },
    showAgentUpgradeBatchSummary(batch) {
      const results = Object.values(batch?.results || {});
      const upgraded = results.filter(result => result.status === 'upgraded').length;
      const latest = results.filter(result => result.status === 'already_latest').length;
      const failed = results.filter(result => result.status === 'failed').length;
      alertDialog(this.$t('chat.agent.upgradeAllSummary', { upgraded, latest, failed, skipped: batch?.skippedCount || 0 }));
    },
    ...folderPickerMethods,
    folderPickerInitialDir() {
      return this.convModalWorkDir || this.store.agents.find(a => a.id === this.convModalAgent)?.workDir || '';
    },
    folderPickerSetWorkDir(path) {
      this.convModalWorkDir = path;
      this.selectedResumeSession = null;
      if (this.convModalAgent) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, path, this.convModalProvider);
        this.historyLoaded = true;
      }
    },
  },
  watch: {
    folderPickerAgentId() { this.closeFolderPicker(); },
  },
  mounted() {
    if (this.store.openUnifiedChatCreate) {
      const provider = this.store.openUnifiedChatCreate;
      this.store.openUnifiedChatCreate = false;
      this.convModalProvider = provider === 'copilot' ? 'copilot' : 'claude-code';
      this.openConversationModal({ preserveProvider: true });
    }
    this._clickOutsideHandler = (e) => {
      if (!e.target.closest('.agent-selector')) {
        this.showAgentDropdown = false;
      }
      if (!e.target.closest('.session-dots-btn') && !e.target.closest('.session-menu')) {
        this.activeSessionMenu = null;
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);

    // Fetch server version
    fetch('/api/version').then(r => r.json()).then(d => { this.serverVersion = d.version; }).catch(() => {});

    this._agentUpgradeAckHandler = (event) => {
      const { success, error, alreadyLatest, version, reason, currentNode, requiredNode, batchId } = event.detail || {};
      if (batchId) return;
      if (!success) {
        if (reason === 'node_incompatible') {
          alertDialog(this.$t('chat.agent.nodeIncompatible', {
            current: currentNode || '?',
            required: requiredNode || '?',
            version: version || '',
          }));
        } else if (reason === 'container_image_upgrade_required') {
          alertDialog(this.$t('chat.agent.containerImageUpgradeRequired', { version: version || '?' }));
        } else if (reason === 'manual_upgrade_required') {
          alertDialog(this.$t('chat.agent.manualUpgradeRequired', { version: version || '?' }));
        } else {
          alertDialog(`Agent upgrade failed: ${error || 'Unknown error'}`);
        }
      } else if (alreadyLatest) {
        alertDialog(this.$t('chat.agent.alreadyLatest', { version: version || '' }));
      }
    };
    this._agentUpgradeBatchHandler = (event) => this.showAgentUpgradeBatchSummary(event.detail || {});
    window.addEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    window.addEventListener('agent-upgrade-batch-complete', this._agentUpgradeBatchHandler);
  },
  beforeUnmount() {
    document.removeEventListener('click', this._clickOutsideHandler);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    window.removeEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    window.removeEventListener('agent-upgrade-batch-complete', this._agentUpgradeBatchHandler);
    this.invalidateFolderPickerRequest();
  }
};
