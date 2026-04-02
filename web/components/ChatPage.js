import ChatHeader from './ChatHeader.js';
import MessageList from './MessageList.js';
import ChatInput from './ChatInput.js';
import WorkbenchPanel from './WorkbenchPanel.js';
import SettingsPanel from './SettingsPanel.js';
import CrewConfigPanel from './CrewConfigPanel.js';
import CrewChatView from './CrewChatView.js';
import ExpertPanel from './ExpertPanel.js';
import SubAgentPanel from './SubAgentPanel.js';
import BtwOverlay from './BtwOverlay.js';
import SplitPane from './SplitPane.js';
import { useAuthStore } from '../stores/auth.js';

export default {
  name: 'ChatPage',
  components: { ChatHeader, MessageList, ChatInput, WorkbenchPanel, SettingsPanel, CrewConfigPanel, CrewChatView, ExpertPanel, SubAgentPanel, BtwOverlay, SplitPane },
  template: `
    <div class="chat-page" :class="{ 'show-sidebar': showMobileSidebar }">

      <!-- Sidebar Overlay -->
      <div class="sidebar-overlay" v-if="showMobileSidebar" @click="showMobileSidebar = false"></div>

      <!-- Left Sidebar -->
      <aside class="sidebar" :class="{ collapsed: store.sidebarCollapsed }">
        <!-- Collapsed Icon Bar -->
        <div class="sidebar-collapsed-bar" v-if="store.sidebarCollapsed">
          <button class="collapsed-icon-btn" @click="store.toggleSidebar()" :title="$t('chat.sidebar.expand')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <button v-if="canUseWorkbench" class="collapsed-icon-btn" :class="{ active: store.workbenchExpanded }" @click="store.toggleWorkbench()" :title="$t('chat.sidebar.workbench')">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
          </button>
          <button class="collapsed-icon-btn" @click="store.addPanel()" :title="$t('splitScreen.split')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
            </svg>
          </button>
          <button class="collapsed-icon-btn" @click="openConversationModal" :disabled="onlineAgentCount === 0" :title="$t('chat.sidebar.newConv')">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>
          <button class="collapsed-icon-btn" @click="newCrewSession" title="Crew">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </button>
          <div class="collapsed-spacer"></div>
          <button class="collapsed-icon-btn" @click="store.toggleTheme()" :title="store.theme === 'dark' ? $t('chat.sidebar.lightMode') : $t('chat.sidebar.darkMode')">
            <svg v-if="store.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
          </button>
        </div>
        <!-- Mobile Sidebar Header -->
        <div class="sidebar-header-mobile">
          <span class="sidebar-title">Claude Web Chat</span>
          <button class="sidebar-close-btn" @click="showMobileSidebar = false">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <!-- Agent Status -->
        <div class="sidebar-top">
          <!-- Header Row: Agent status + action icons (Copilot style) -->
          <div class="sidebar-header-row">
            <div class="sidebar-brand agent-dropdown-trigger" @click.stop="agentManagerOpen = !agentManagerOpen" style="cursor: pointer;" :title="$t('chat.agent.manage')">
              <span class="status-dot" :class="{ online: onlineAgentCount > 0 }"></span>
              <span class="brand-label">{{ onlineAgentCount }} Agent</span>
              <span class="latency-indicator" v-if="currentAgentLatency" :class="getLatencyClass(currentAgentLatency)" :title="currentAgentLatency + 'ms'">
                <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                {{ currentAgentLatency }}ms
              </span>
              <svg class="dropdown-chevron" :class="{ open: agentManagerOpen }" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              <!-- Agent Dropdown Menu -->
              <div class="agent-dropdown" v-if="agentManagerOpen" @click.stop>
                <div v-for="agent in onlineAgents" :key="agent.id" class="agent-dropdown-item">
                  <span class="status-dot" :class="{ online: agent.online, restarting: restartingAgents[agent.id], upgrading: upgradingAgents[agent.id] }"></span>
                  <span class="agent-dropdown-name">{{ agent.name }}</span>
                  <span class="agent-dropdown-version" v-if="agent.version">v{{ agent.version }}</span>
                  <span class="agent-dropdown-latency" v-if="agent.online && agent.latency" :class="getLatencyClass(agent.latency)">{{ agent.latency }}ms</span>
                  <span class="agent-dropdown-status" v-if="restartingAgents[agent.id]">{{ $t('chat.agent.restarting') }}</span>
                  <span class="agent-dropdown-status" v-else-if="upgradingAgents[agent.id]">{{ $t('chat.agent.upgrading') }}</span>
                  <button
                    class="agent-dropdown-upgrade-btn"
                    @click.stop="upgradeAgent(agent.id)"
                    :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                    :title="$t('chat.agent.upgrade')"
                  >
                    <span v-if="upgradingAgents[agent.id]" class="spinner-mini"></span>
                    <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>
                  </button>
                  <button
                    class="agent-dropdown-restart-btn"
                    @click.stop="restartAgent(agent.id)"
                    :disabled="!agent.online || restartingAgents[agent.id] || upgradingAgents[agent.id]"
                    :title="$t('chat.agent.restart')"
                  >
                    <span v-if="restartingAgents[agent.id]" class="spinner-mini"></span>
                    <svg v-else viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  </button>
                </div>
                <div v-if="onlineAgents.length === 0" class="agent-dropdown-empty">{{ $t('chat.agent.none') }}</div>
              </div>
            </div>
            <div class="sidebar-header-actions">
              <button class="sidebar-icon-btn" @click="store.toggleSidebar()" :title="$t('chat.sidebar.collapse')">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/></svg>
              </button>
              <button v-if="canUseWorkbench" class="sidebar-icon-btn" :class="{ active: store.workbenchExpanded }" @click="store.toggleWorkbench()" :title="$t('chat.sidebar.workbench')">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v2H6V7zm0 4h5v2H6v-2zm0 4h5v2H6v-2zm7-8h5v10h-5V7z"/></svg>
                <span class="action-badge" v-if="store.runningSubagentCount > 0">{{ store.runningSubagentCount }}</span>
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

        <!-- Session Panels — adaptive scroll layout -->
        <div class="session-panels">
          <!-- Chat Sessions Panel -->
          <div class="session-panel" :class="{ collapsed: chatGroupCollapsed }">
            <div class="session-group-header">
              <div class="session-group-title-area" @click="chatGroupCollapsed = !chatGroupCollapsed">
                <svg class="session-collapse-arrow" :class="{ collapsed: chatGroupCollapsed }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                <svg class="session-group-icon" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                <span>{{ $t('chat.sidebar.recentChats') }}</span>
              </div>
              <button class="session-header-add-btn" @click.stop="onlineAgentCount > 0 && openConversationModal()" :class="{ disabled: onlineAgentCount === 0 }" :title="$t('chat.sidebar.newConv')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              </button>
            </div>
            <div class="session-panel-list" v-show="!chatGroupCollapsed">
              <div
                v-for="conv in pinnedChatConversations"
                :key="conv.id"
                class="session-item"
                :class="{ active: conv.id === store.currentConversation, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
                @click="editingChatId !== conv.id && onSessionClick(conv)"
              >
                <div class="session-item-header">
                  <span class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                  <div class="title" :title="getConversationFullTitle(conv)">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <span v-else-if="store.isSplitMode && store.isInAnyPanel(conv.id)" class="pane-active-dot"></span>
                    <input
                      v-if="editingChatId === conv.id"
                      ref="chatRenameInput"
                      class="chat-rename-input"
                      v-model="editingChatName"
                      @keydown.enter="commitChatRename"
                      @keydown.escape="cancelChatRename"
                      @blur="commitChatRename"
                      @click.stop
                    />
                    <span v-else>{{ getConversationTitle(conv) }}</span>
                  </div>
                  <span class="session-time">{{ getConversationTime(conv) }}</span>
                  <button class="session-dots-btn" :class="{ 'menu-open': activeSessionMenu === conv.id }" @click.stop="toggleSessionMenu(conv.id)">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <div class="session-menu" v-if="activeSessionMenu === conv.id" @click.stop>
                    <button class="session-menu-item" @click.stop="store.togglePin(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                      {{ $t('chat.sidebar.unpin') }}
                    </button>
                    <button class="session-menu-item" v-if="!store.isInAnyPanel(conv.id)" @click.stop="splitToPanel(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                      {{ $t('splitScreen.splitToPanel') }}
                    </button>
                    <button class="session-menu-item" @click.stop="startChatRename(conv); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                      {{ $t('chat.sidebar.renameConv') }}
                    </button>
                    <button class="session-menu-item danger" @click.stop="closeSession(conv.id, conv.agentId); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      {{ $t('chat.sidebar.closeConv') }}
                    </button>
                  </div>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="latency-indicator" v-if="getAgentLatency(conv.agentId)" :class="getLatencyClass(getAgentLatency(conv.agentId))" :title="getAgentLatency(conv.agentId) + 'ms'">
                    <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                    {{ getAgentLatency(conv.agentId) }}ms
                  </span>
                </div>
              </div>
              <div
                v-for="conv in unpinnedChatConversations"
                :key="conv.id"
                class="session-item"
                :class="{ active: conv.id === store.currentConversation, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
                @click="editingChatId !== conv.id && onSessionClick(conv)"
              >
                <div class="session-item-header">
                  <div class="title" :title="getConversationFullTitle(conv)">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <span v-else-if="store.isSplitMode && store.isInAnyPanel(conv.id)" class="pane-active-dot"></span>
                    <input
                      v-if="editingChatId === conv.id"
                      ref="chatRenameInput"
                      class="chat-rename-input"
                      v-model="editingChatName"
                      @keydown.enter="commitChatRename"
                      @keydown.escape="cancelChatRename"
                      @blur="commitChatRename"
                      @click.stop
                    />
                    <span v-else>{{ getConversationTitle(conv) }}</span>
                  </div>
                  <span class="session-time">{{ getConversationTime(conv) }}</span>
                  <button class="session-dots-btn" :class="{ 'menu-open': activeSessionMenu === conv.id }" @click.stop="toggleSessionMenu(conv.id)">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <div class="session-menu" v-if="activeSessionMenu === conv.id" @click.stop>
                    <button class="session-menu-item" @click.stop="store.togglePin(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                      {{ $t('chat.sidebar.pin') }}
                    </button>
                    <button class="session-menu-item" v-if="!store.isInAnyPanel(conv.id)" @click.stop="splitToPanel(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                      {{ $t('splitScreen.splitToPanel') }}
                    </button>
                    <button class="session-menu-item" @click.stop="startChatRename(conv); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                      {{ $t('chat.sidebar.renameConv') }}
                    </button>
                    <button class="session-menu-item danger" @click.stop="closeSession(conv.id, conv.agentId); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      {{ $t('chat.sidebar.closeConv') }}
                    </button>
                  </div>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="latency-indicator" v-if="getAgentLatency(conv.agentId)" :class="getLatencyClass(getAgentLatency(conv.agentId))" :title="getAgentLatency(conv.agentId) + 'ms'">
                    <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                    {{ getAgentLatency(conv.agentId) }}ms
                  </span>
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
                v-for="conv in pinnedCrewConversations"
                :key="conv.id"
                class="session-item session-item-crew"
                :class="{ active: conv.id === store.currentConversation, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
                @click="editingCrewId !== conv.id && onSessionClick(conv)"
              >
                <div class="session-item-header">
                  <span class="session-pin-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></span>
                  <div class="title" :title="getConversationFullTitle(conv)">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <span v-else-if="store.isSplitMode && store.isInAnyPanel(conv.id)" class="pane-active-dot"></span>
                    <svg class="crew-conv-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                    <input
                      v-if="editingCrewId === conv.id"
                      ref="crewRenameInput"
                      class="crew-rename-input"
                      v-model="editingCrewName"
                      @keydown.enter="commitCrewRename"
                      @keydown.escape="cancelCrewRename"
                      @blur="commitCrewRename"
                      @click.stop
                    />
                    <span
                      v-else
                      class="crew-title-text"
                      @dblclick.stop="startCrewRename(conv)"
                    >{{ getCrewTitle(conv) }}</span>
                  </div>
                  <span class="session-time">{{ getConversationTime(conv) }}</span>
                  <button class="session-dots-btn" :class="{ 'menu-open': activeSessionMenu === conv.id }" @click.stop="toggleSessionMenu(conv.id)">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <div class="session-menu" v-if="activeSessionMenu === conv.id" @click.stop>
                    <button class="session-menu-item" @click.stop="store.togglePin(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                      {{ $t('chat.sidebar.unpin') }}
                    </button>
                    <button class="session-menu-item" v-if="!store.isInAnyPanel(conv.id)" @click.stop="splitToPanel(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                      {{ $t('splitScreen.splitToPanel') }}
                    </button>
                    <button class="session-menu-item danger" @click.stop="closeSession(conv.id, conv.agentId); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      {{ $t('chat.sidebar.closeConv') }}
                    </button>
                  </div>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="latency-indicator" v-if="getAgentLatency(conv.agentId)" :class="getLatencyClass(getAgentLatency(conv.agentId))" :title="getAgentLatency(conv.agentId) + 'ms'">
                    <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                    {{ getAgentLatency(conv.agentId) }}ms
                  </span>
                </div>
              </div>
              <div
                v-for="conv in unpinnedCrewConversations"
                :key="conv.id"
                class="session-item session-item-crew"
                :class="{ active: conv.id === store.currentConversation, processing: store.isConversationProcessing(conv.id), 'agent-offline': conv.agentOnline === false }"
                @click="editingCrewId !== conv.id && onSessionClick(conv)"
              >
                <div class="session-item-header">
                  <div class="title" :title="getConversationFullTitle(conv)">
                    <span v-if="store.isConversationProcessing(conv.id)" class="processing-dot"></span>
                    <span v-else-if="store.isSplitMode && store.isInAnyPanel(conv.id)" class="pane-active-dot"></span>
                    <svg class="crew-conv-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                    <input
                      v-if="editingCrewId === conv.id"
                      ref="crewRenameInput"
                      class="crew-rename-input"
                      v-model="editingCrewName"
                      @keydown.enter="commitCrewRename"
                      @keydown.escape="cancelCrewRename"
                      @blur="commitCrewRename"
                      @click.stop
                    />
                    <span
                      v-else
                      class="crew-title-text"
                      @dblclick.stop="startCrewRename(conv)"
                    >{{ getCrewTitle(conv) }}</span>
                  </div>
                  <span class="session-time">{{ getConversationTime(conv) }}</span>
                  <button class="session-dots-btn" :class="{ 'menu-open': activeSessionMenu === conv.id }" @click.stop="toggleSessionMenu(conv.id)">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                  </button>
                  <div class="session-menu" v-if="activeSessionMenu === conv.id" @click.stop>
                    <button class="session-menu-item" @click.stop="store.togglePin(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                      {{ $t('chat.sidebar.pin') }}
                    </button>
                    <button class="session-menu-item" v-if="!store.isInAnyPanel(conv.id)" @click.stop="splitToPanel(conv.id); closeSessionMenu()">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                      {{ $t('splitScreen.splitToPanel') }}
                    </button>
                    <button class="session-menu-item danger" @click.stop="closeSession(conv.id, conv.agentId); closeSessionMenu()">
                      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      {{ $t('chat.sidebar.closeConv') }}
                    </button>
                  </div>
                </div>
                <div class="session-info">
                  <span class="session-path">{{ shortenPath(conv.workDir) }}</span>
                  <span class="session-agent" v-if="conv.agentName">{{ conv.agentName }}</span>
                  <span class="latency-indicator" v-if="getAgentLatency(conv.agentId)" :class="getLatencyClass(getAgentLatency(conv.agentId))" :title="getAgentLatency(conv.agentId) + 'ms'">
                    <svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>
                    {{ getAgentLatency(conv.agentId) }}ms
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="sidebar-bottom">
          <button class="sidebar-nav-item" @click="showSettingsPanel = true">
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
            <span>{{ $t('chat.sidebar.settings') }}</span>
            <span v-if="serverVersion" class="sidebar-version">{{ serverVersion }}</span>
          </button>
        </div>
      </aside>

      <!-- Sidebar / Workbench 分隔线 -->
      <div class="sidebar-workbench-divider" v-if="canUseWorkbench && store.workbenchExpanded && !store.sidebarCollapsed && !store.isSplitMode"></div>

      <!-- Workbench Panel (Middle) — only in single mode -->
      <WorkbenchPanel v-if="canUseWorkbench && !store.isSplitMode" />

      <!-- Single-panel Main Chat Area -->
      <main v-if="!store.isSplitMode" class="main-content" :class="{ 'workbench-active': canUseWorkbench && store.workbenchExpanded, 'workbench-maximized': canUseWorkbench && store.workbenchMaximized && store.workbenchExpanded }">
        <!-- Crew Conversation -->
        <template v-if="isCurrentCrewConversation">
          <ChatHeader @toggle-sidebar="showMobileSidebar = !showMobileSidebar" />
          <CrewChatView />
        </template>
        <!-- Normal Chat Mode -->
        <template v-else>
          <ChatHeader @toggle-sidebar="showMobileSidebar = !showMobileSidebar" />
          <div class="chat-body" :class="{ 'expert-panel-open': store.activeRightPanel }">
            <div class="chat-body-main">
              <MessageList
                @new-conversation="openConversationModal"
                @resume-conversation="openConversationModalResume"
                @open-settings="showSettingsPanel = true"
              />
              <BtwOverlay />
              <ChatInput />
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
          </div>
        </template>
      </main>

      <!-- Multi-panel mode: SplitPane ×N -->
      <div v-else class="panels-container" :class="'panes-' + store.panels.length">
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

      <!-- Crew Config Panel -->
      <CrewConfigPanel
        v-if="store.crewConfigOpen"
        ref="crewPanel"
        :mode="store.crewConfigMode"
        :session="store.currentCrewSession"
        :status="store.currentCrewStatus"
        :defaultWorkDir="store.currentAgentInfo?.workDir || ''"
        @close="store.crewConfigOpen = false"
        @start="startCrewSession"
        @browse="openCrewFolderPicker"
      />


      <!-- Unified Conversation Modal (New + Resume) -->
      <div class="modal-overlay" v-if="showConversationModal" @click.self="closeConversationModal">
        <div class="modal resume-modal">
          <!-- Top Controls -->
          <div class="resume-modal-controls">
            <button class="resume-close-btn" @click="closeConversationModal">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
            <div class="resume-control-row">
              <label class="resume-control-label">Agent</label>
              <div class="resume-select-wrapper">
                <select v-model="convModalAgent" @change="onConvModalAgentChange" class="resume-select">
                  <option value="">{{ $t('chat.agent.select') }}</option>
                  <option v-for="agent in store.agents.filter(a => a.online)" :key="agent.id" :value="agent.id">
                    {{ agent.name }}{{ agent.latency ? ' (' + agent.latency + 'ms)' : '' }}
                  </option>
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
                  <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
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
                  <div
                    v-for="folder in store.folders"
                    :key="folder.name"
                    class="resume-list-item folder-item-compact"
                    @click="selectConvModalFolder(folder.path)"
                  >
                    <div class="item-path">{{ folder.path }}</div>
                    <span class="item-badge">{{ folder.sessionCount }}</span>
                  </div>
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
                  <button class="refresh-btn-mini" @click="convModalWorkDir = ''; selectedResumeSession = null; historyLoaded = false;" title="返回">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                  </button>
                  <span>{{ $t('modal.resume.sessionLabel') }} <span class="header-tag">{{ getLastPathSegment(convModalWorkDir) }}</span></span>
                </div>
                <button class="refresh-btn-mini" @click="loadConvModalSessions" :disabled="store.historySessionsLoading" :title="$t('common.refresh')">
                  <svg v-if="!store.historySessionsLoading" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                  <span v-else class="mini-spinner"></span>
                </button>
              </div>
              <div class="resume-panel-list" v-if="historyLoaded">
                <div
                  v-for="session in store.historySessions"
                  :key="session.sessionId"
                  class="resume-list-item session-item-compact"
                  @click="resumeSession(session)"
                >
                  <div class="item-name">{{ session.title || $t('modal.resume.untitled') }}</div>
                  <div class="item-time">{{ formatDate(session.lastModified) }}</div>
                </div>
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
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              {{ $t('modal.newConv.create') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Settings Panel -->

      <!-- Folder Picker Dialog -->
      <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="folderPickerOpen = false">
        <div class="folder-picker-dialog">
          <div class="folder-picker-header">
            <span>{{ $t('modal.folderPicker.title') }}</span>
            <button class="wb-btn-sm" @click="folderPickerOpen = false">&times;</button>
          </div>
          <div class="folder-picker-path">
            <button class="wb-btn-sm" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :title="$t('modal.folderPicker.parentDir')">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            </button>
            <span class="folder-picker-current">{{ folderPickerPath || $t('common.rootDir') }}</span>
          </div>
          <div class="folder-picker-list">
            <div class="git-loading" v-if="folderPickerLoading" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
            <template v-else>
              <div
                v-for="entry in folderPickerEntries"
                :key="entry.name"
                class="tree-item tree-dir folder-picker-item"
                :class="{ 'folder-picker-selected': folderPickerSelected === entry.name }"
                @click="folderPickerSelectItem(entry)"
                @dblclick="folderPickerEnter(entry)"
              >
                <span class="tree-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
                <span class="tree-name">{{ entry.name }}</span>
              </div>
              <div class="tree-empty" v-if="folderPickerEntries.length === 0">{{ $t('common.noSubdirectories') }}</div>
            </template>
          </div>
          <div class="folder-picker-footer">
            <button class="modern-btn primary" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ $t('common.confirm') }}</button>
          </div>
        </div>
      </div>
  `,
  data() {
    return {
      showAgentDropdown: false,
      showMobileSidebar: false,
      showSettingsPanel: false,
      agentManagerOpen: false,
      restartingAgents: {},
      upgradingAgents: {},
      // Unified conversation modal state
      showConversationModal: false,
      convModalAgent: '',
      convModalWorkDir: '',
      selectedResumeSession: null,
      historyLoaded: false,
      windowWidth: window.innerWidth,
      // Folder picker state
      folderPickerOpen: false,
      folderPickerPath: '',
      folderPickerEntries: [],
      folderPickerLoading: false,
      folderPickerSelected: '',
      folderPickerTarget: '', // 'convModal'
      serverVersion: '',
      chatGroupCollapsed: false,
      crewGroupCollapsed: false,
      // Inline rename state
      editingCrewId: null,
      editingCrewName: '',
      editingChatId: null,
      editingChatName: '',
      activeSessionMenu: null
    };
  },
  computed: {
    store() {
      return Pinia.useChatStore();
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
    crewCapableAgentCount() {
      return this.store.agents.filter(a => a.online && a.capabilities?.includes('crew')).length;
    },
    isCurrentCrewConversation() {
      return this.store.currentConversationIsCrew;
    },
    currentAgentLatency() {
      if (!this.store.currentAgent) return null;
      const agent = this.store.agents.find(a => a.id === this.store.currentAgent);
      return agent?.latency || null;
    },
    isMobileView() {
      return this.windowWidth < 640;
    },
    crewConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => c.type === 'crew'));
    },
    normalConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => c.type !== 'crew'));
    },
    pinnedChatConversations() {
      const pinned = this.store.conversations.filter(c => c.type !== 'crew' && this.store.isSessionPinned(c.id));
      return pinned.sort((a, b) => this.store.pinnedSessions.indexOf(a.id) - this.store.pinnedSessions.indexOf(b.id));
    },
    unpinnedChatConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => c.type !== 'crew' && !this.store.isSessionPinned(c.id)));
    },
    pinnedCrewConversations() {
      const pinned = this.store.conversations.filter(c => c.type === 'crew' && this.store.isSessionPinned(c.id));
      return pinned.sort((a, b) => this.store.pinnedSessions.indexOf(a.id) - this.store.pinnedSessions.indexOf(b.id));
    },
    unpinnedCrewConversations() {
      return this.sortByActivity(this.store.conversations.filter(c => c.type === 'crew' && !this.store.isSessionPinned(c.id)));
    }
  },
  methods: {
    sortByActivity(conversations) {
      return [...conversations].sort((a, b) => {
        // Sort by lastMessageAt (set when user sends a message), descending
        const aTime = a.lastMessageAt || 0;
        const bTime = b.lastMessageAt || 0;
        return bTime - aTime;
      });
    },
    // Crew mode methods
    newCrewSession() {
      this.store.enterCrewMode();
    },
    startCrewSession(config) {
      this.store.createCrewSession(config);
    },
    openCrewFolderPicker() {
      const crewPanel = this.$refs.crewPanel;
      const agentId = crewPanel?.selectedAgent;
      if (!agentId) return;
      this.folderPickerTarget = 'crew';
      this.folderPickerOpen = true;
      this.folderPickerSelected = '';
      this.folderPickerLoading = true;
      const agent = this.store.agents.find(a => a.id === agentId);
      const defaultDir = crewPanel?.projectDir || agent?.workDir || '';
      this.folderPickerPath = defaultDir;
      this.folderPickerEntries = [];
      const sendRequest = () => {
        this.store.sendWsMessage({
          type: 'list_directory',
          conversationId: '_workdir_picker',
          agentId: agentId,
          dirPath: defaultDir,
          workDir: agent?.workDir || ''
        });
      };
      sendRequest();
      if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = setTimeout(() => {
        if (this.folderPickerLoading && this.folderPickerOpen) {
          console.log('[FolderPicker] Retrying crew directory request for:', defaultDir);
          sendRequest();
        }
      }, 5000);
    },

    openConversationModal() {
      this.showConversationModal = true;
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
        this.store.listFoldersForAgent(this.convModalAgent).then(() => {
          // 如果首次加载结果为空且 modal 仍然打开，自动重试一次
          if (this.showConversationModal && this.store.folders.length === 0 && !this._foldersRetried) {
            this._foldersRetried = true;
            setTimeout(() => {
              if (this.showConversationModal && this.convModalAgent) {
                this.store.listFoldersForAgent(this.convModalAgent);
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
        this.store.listFoldersForAgent(this.convModalAgent);
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
          this.store.listHistorySessionsForAgent(this.convModalAgent, this.convModalWorkDir.trim());
          this.historyLoaded = true;
        }
      }, 500);
    },
    selectConvModalFolder(path) {
      this.convModalWorkDir = path;
      this.selectedResumeSession = null;
      // 自动加载该 folder 下的 sessions
      if (this.convModalAgent) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, path);
        this.historyLoaded = true;
      }
    },
    loadConvModalFolders() {
      if (this.convModalAgent) {
        this.store.listFoldersForAgent(this.convModalAgent);
      }
    },
    loadConvModalSessions() {
      if (this.convModalAgent && this.convModalWorkDir.trim()) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, this.convModalWorkDir.trim());
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
      this.store.createConversation(workDir, this.convModalAgent);
      this.closeConversationModal();
    },
    resumeSession(session) {
      if (!this.convModalAgent) return;
      this.store.selectAgent(this.convModalAgent);
      this.store._pendingSessionTitle = session.title;
      const workDir = session.workDir || this.convModalWorkDir.trim() || this.selectedConvModalAgentWorkDir;
      this.store.resumeConversation(session.sessionId, workDir, this.convModalAgent);
      this.closeConversationModal();
    },
    resumeSelectedSession() {
      if (!this.convModalAgent || !this.selectedResumeSession) return;
      this.store.selectAgent(this.convModalAgent);
      this.store._pendingSessionTitle = this.selectedResumeSession.title;
      const workDir = this.selectedResumeSession.workDir || this.convModalWorkDir.trim() || this.selectedConvModalAgentWorkDir;
      this.store.resumeConversation(this.selectedResumeSession.sessionId, workDir, this.convModalAgent);
      this.closeConversationModal();
    },
    formatDate(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      const now = new Date();
      const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return this.$t('chat.time.today') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } else if (diffDays === 1) {
        return this.$t('chat.time.yesterday') + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } else if (diffDays < 7) {
        return this.$t('chat.time.daysAgo', { count: diffDays });
      } else {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
    },
    selectConversation(conversationId, agentId) {
      this.store.selectConversation(conversationId, agentId);
      this.showMobileSidebar = false;
    },
    onSessionClick(conv) {
      if (conv.agentOnline === false) {
        this.store.addMessage({ type: 'system', content: this.$t('chat.session.agentOffline') });
        return;
      }
      // In multi-panel mode, route to the active panel
      if (this.store.isSplitMode && this.store.activePanelId) {
        this.store.setPanelConversation(this.store.activePanelId, conv.id);
        this.showMobileSidebar = false;
        return;
      }
      this.selectConversation(conv.id, conv.agentId);
    },
    splitToPanel(conversationId) {
      this.store.splitToPanel(conversationId);
    },
    closeSession(conversationId, agentId) {
      this.store.closeSession(conversationId, agentId);
    },
    deleteConversation(conversationId, agentId) {
      const conv = this.store.conversations.find(c => c.id === conversationId);
      const confirmMsg = conv?.type === 'crew' ? '终止并关闭此 Crew Session？' : this.$t('chat.delete.confirm');
      if (confirm(confirmMsg)) {
        // Crew conversation 需要先终止 session
        if (conv?.type === 'crew' && this.store.crewSessions[conversationId]) {
          this.store.sendWsMessage({
            type: 'crew_control',
            sessionId: conversationId,
            action: 'stop_all',
            agentId
          });
          // 清理 crew 数据
          delete this.store.crewSessions[conversationId];
          delete this.store.crewMessagesMap[conversationId];
          delete this.store.crewOlderMessages[conversationId];
          delete this.store.crewStatuses[conversationId];
        }
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
      if (conv.type === 'crew') {
        return conv.name || 'Crew Session';
      }
      const cachedTitle = this.store.getConversationTitle(conv.id);
      if (cachedTitle && cachedTitle.length > 30) {
        return cachedTitle;
      }
      return undefined;
    },
    getCrewTitle(conv) {
      return conv.name || 'Crew Session';
    },
    startCrewRename(conv) {
      this.editingCrewId = conv.id;
      this.editingCrewName = conv.name || '';
      this.$nextTick(() => {
        const input = this.$refs.crewRenameInput;
        if (input) {
          const el = Array.isArray(input) ? input[0] : input;
          el.focus();
          el.select();
        }
      });
    },
    commitCrewRename() {
      if (!this.editingCrewId) return;
      const sessionId = this.editingCrewId;
      const name = this.editingCrewName.trim() || 'Crew Session';
      this.editingCrewId = null;
      this.editingCrewName = '';
      // Find current name to avoid unnecessary WS call
      const conv = this.store.conversations.find(c => c.id === sessionId);
      const currentName = conv?.name || '';
      if (name !== currentName) {
        this.store.renameCrewSession(sessionId, name === 'Crew Session' ? '' : name);
      }
    },
    cancelCrewRename() {
      this.editingCrewId = null;
      this.editingCrewName = '';
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
    shortenPath(path) {
      if (!path) return '-';
      if (path.length <= 25) return path;
      const parts = path.split(/[/\\]/);
      if (parts.length <= 2) return path;
      return '...' + parts.slice(-2).join('/');
    },
    formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    getLastPathSegment(path) {
      if (!path) return '';
      const parts = path.split(/[/\\]/);
      return parts[parts.length - 1] || parts[parts.length - 2] || path;
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
    getAgentLatency(agentId) {
      if (!agentId) return null;
      const agent = this.store.agents.find(a => a.id === agentId);
      return agent?.latency || null;
    },
    getLatencyClass(latency) {
      if (!latency) return '';
      if (latency < 100) return 'latency-good';
      if (latency < 300) return 'latency-warn';
      return 'latency-bad';
    },
    restartAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.restartConfirm', { name }))) return;
      this.restartingAgents[agentId] = true;
      // 2 分钟后强制清除重启状态（兜底）
      setTimeout(() => { delete this.restartingAgents[agentId]; }, 120000);
      this.store.restartAgent(agentId);
    },
    upgradeAgent(agentId) {
      const agent = this.store.agents.find(a => a.id === agentId);
      const name = agent?.name || agentId;
      if (!confirm(this.$t('chat.agent.upgradeConfirm', { name }))) return;
      this.upgradingAgents[agentId] = { since: Date.now(), oldVersion: agent?.version || null };
      // 2 分钟后强制清除升级状态（兜底）
      setTimeout(() => { delete this.upgradingAgents[agentId]; }, 120000);
      this.store.upgradeAgent(agentId);
    },
    // Folder picker methods
    openFolderPicker(target) {
      const agentId = this.convModalAgent;
      if (!agentId) return;
      this.folderPickerTarget = target;
      this.folderPickerOpen = true;
      this.folderPickerSelected = '';
      this.folderPickerLoading = true;
      const currentWorkDir = this.convModalWorkDir;
      const agent = this.store.agents.find(a => a.id === agentId);
      const defaultDir = currentWorkDir || agent?.workDir || '';
      this.folderPickerPath = defaultDir;
      this.folderPickerEntries = [];
      const sendRequest = () => {
        this.store.sendWsMessage({
          type: 'list_directory',
          conversationId: '_workdir_picker',
          agentId: agentId,
          dirPath: defaultDir,
          workDir: agent?.workDir || ''
        });
      };
      sendRequest();
      if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = setTimeout(() => {
        if (this.folderPickerLoading && this.folderPickerOpen) {
          console.log('[FolderPicker] Retrying initial directory request for:', defaultDir);
          sendRequest();
        }
      }, 5000);
    },
    loadFolderPickerDir(dirPath) {
      let agentId = this.convModalAgent;
      if (this.folderPickerTarget === 'crew') {
        agentId = this.$refs.crewPanel?.selectedAgent;
      }
      if (!agentId) return;
      this.folderPickerLoading = true;
      this.folderPickerSelected = '';
      this.folderPickerEntries = [];
      const agent = this.store.agents.find(a => a.id === agentId);
      const sendRequest = () => {
        this.store.sendWsMessage({
          type: 'list_directory',
          conversationId: '_workdir_picker',
          agentId: agentId,
          dirPath: dirPath,
          workDir: agent?.workDir || ''
        });
      };
      sendRequest();
      // Retry once if no response within 5 seconds
      if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = setTimeout(() => {
        if (this.folderPickerLoading && this.folderPickerOpen) {
          console.log('[FolderPicker] Retrying directory request for:', dirPath);
          sendRequest();
        }
      }, 5000);
    },
    folderPickerNavigateUp() {
      if (!this.folderPickerPath) return;
      const isWin = this.folderPickerPath.includes('\\');
      const sep = isWin ? '\\' : '/';
      const parts = this.folderPickerPath.replace(/[/\\]$/, '').split(/[/\\]/);
      parts.pop();
      if (parts.length === 0) {
        this.folderPickerPath = '';
        this.loadFolderPickerDir('');
      } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
        this.folderPickerPath = parts[0] + '\\';
        this.loadFolderPickerDir(parts[0] + '\\');
      } else {
        const parent = parts.join(sep);
        this.folderPickerPath = parent;
        this.loadFolderPickerDir(parent);
      }
    },
    folderPickerSelectItem(entry) {
      this.folderPickerSelected = entry.name;
    },
    folderPickerEnter(entry) {
      const isWin = this.folderPickerPath.includes('\\') || /^[A-Z]:/.test(entry.name);
      const sep = isWin ? '\\' : '/';
      let newPath;
      if (!this.folderPickerPath) {
        // At root level: Windows drive (C:) or Unix root (/)
        if (/^[A-Z]:$/.test(entry.name)) {
          newPath = entry.name + '\\';
        } else {
          newPath = '/' + entry.name;
        }
      } else {
        newPath = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
      }
      this.folderPickerPath = newPath;
      this.loadFolderPickerDir(newPath);
    },
    confirmFolderPicker() {
      let path = this.folderPickerPath;
      if (!path) return;
      if (this.folderPickerSelected) {
        const sep = path.includes('\\') ? '\\' : '/';
        path = path.replace(/[/\\]$/, '') + sep + this.folderPickerSelected;
      }
      if (this.folderPickerTarget === 'crew') {
        const crewPanel = this.$refs.crewPanel;
        if (crewPanel) {
          crewPanel.projectDir = path;
          crewPanel.onWorkDirChange();
        }
        this.folderPickerOpen = false;
        return;
      }
      this.convModalWorkDir = path;
      this.selectedResumeSession = null;
      if (this.convModalAgent) {
        this.store.listHistorySessionsForAgent(this.convModalAgent, path);
        this.historyLoaded = true;
      }
      this.folderPickerOpen = false;
    },
    handleFolderPickerMessage(event) {
      const msg = event.detail;
      if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
      if (this._folderPickerTimer) {
        clearTimeout(this._folderPickerTimer);
        this._folderPickerTimer = null;
      }
      this.folderPickerLoading = false;
      this.folderPickerEntries = (msg.entries || [])
        .filter(e => e.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));
      if (msg.dirPath != null) this.folderPickerPath = msg.dirPath;
    }
  },
  mounted() {
    this._clickOutsideHandler = (e) => {
      if (!e.target.closest('.agent-selector')) {
        this.showAgentDropdown = false;
      }
      if (!e.target.closest('.agent-dropdown-trigger') && !e.target.closest('.agent-dropdown')) {
        this.agentManagerOpen = false;
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

    // 监听 agent 重启确认
    this._agentRestartAckHandler = (e) => {
      const { agentId } = e.detail;
      // ack 已收到，agent 即将退出，保持 restarting 状态
      // 等 agent 重新上线后再清除
    };
    window.addEventListener('agent-restart-ack', this._agentRestartAckHandler);

    // 监听 agent 升级结果
    this._agentUpgradeAckHandler = (e) => {
      const { agentId, success, error, alreadyLatest, version } = e.detail;
      if (!success) {
        delete this.upgradingAgents[agentId];
        alert(`Agent upgrade failed: ${error || 'Unknown error'}`);
      } else if (alreadyLatest) {
        delete this.upgradingAgents[agentId];
        alert(this.$t('chat.agent.alreadyLatest', { version: version || '' }));
      }
      // success && !alreadyLatest 时 agent 会重启，等上线后由 watcher 清除状态
    };
    window.addEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);

    // 监听 agent 列表更新，检查重启中/升级中的 agent 是否已恢复
    this._checkRestartingAgents = this.$watch(
      () => this.store.agents.map(a => a.id + ':' + a.online),
      () => {
        for (const agentId of Object.keys(this.restartingAgents)) {
          const agent = this.store.agents.find(a => a.id === agentId);
          // agent 上线了，或者 agent 已消失（可能以新 ID 重连）则清除
          if (agent?.online || !agent) {
            delete this.restartingAgents[agentId];
          }
        }
        for (const agentId of Object.keys(this.upgradingAgents)) {
          const agent = this.store.agents.find(a => a.id === agentId);
          const info = this.upgradingAgents[agentId];
          const elapsed = Date.now() - (info?.since || 0);
          // agent 已消失（可能以新 ID 重连），或超过 2 分钟，强制清除
          if (!agent || elapsed > 120000) {
            delete this.upgradingAgents[agentId];
          } else if (agent.online) {
            // Agent came back online — delay clearing to ensure user sees the status
            const minDisplayMs = 3000;
            if (elapsed < minDisplayMs) {
              setTimeout(() => {
                const ag = this.store.agents.find(a => a.id === agentId);
                if (ag?.online) delete this.upgradingAgents[agentId];
              }, minDisplayMs - elapsed);
            } else {
              delete this.upgradingAgents[agentId];
            }
          }
        }
      }
    );
  },
  beforeUnmount() {
    document.removeEventListener('click', this._clickOutsideHandler);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    window.removeEventListener('agent-restart-ack', this._agentRestartAckHandler);
    window.removeEventListener('agent-upgrade-ack', this._agentUpgradeAckHandler);
    if (this._checkRestartingAgents) this._checkRestartingAgents();
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
  }
};
