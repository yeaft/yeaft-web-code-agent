/**
 * ConductorChatView — Main Conductor V2 conversation page.
 *
 * Layout:
 *   Left:  Conductor conversation message flow
 *   Right: ConductorActivePanel (task list, 240px)
 *
 * Header: Current work dir (switchable) + session info
 *
 * Push-in: ConductorTaskPanel slides in from right when a task is selected
 */
import ConductorActivePanel from './ConductorActivePanel.js';
import ConductorTaskPanel from './ConductorTaskPanel.js';
import { renderMarkdown } from './utils.js';

export default {
  name: 'ConductorChatView',
  components: { ConductorActivePanel, ConductorTaskPanel },
  template: `
    <div class="conductor-chat-view">
      <!-- Header: Work dir + session info -->
      <div class="conductor-header">
        <div class="conductor-header-left">
          <span class="conductor-header-icon">🎼</span>
          <span class="conductor-header-name">{{ sessionName }}</span>
          <span class="conductor-header-scenario" v-if="session?.scenario">{{ session.scenario }}</span>
        </div>
        <div class="conductor-header-center">
          <div class="conductor-workdir" @click="showWorkDirMenu = !showWorkDirMenu">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            <span class="conductor-workdir-path">{{ currentWorkDir || 'No path' }}</span>
            <svg class="conductor-workdir-chevron" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
          </div>
          <!-- Work dir dropdown -->
          <div v-if="showWorkDirMenu" class="conductor-workdir-menu" @click.stop>
            <div class="conductor-workdir-menu-title">Switch work directory</div>
            <div v-for="folder in folders" :key="folder"
                 class="conductor-workdir-menu-item"
                 :class="{ active: folder === currentWorkDir }"
                 @click="switchWorkDir(folder)">
              {{ folder }}
            </div>
            <div class="conductor-workdir-menu-input">
              <input v-model="customWorkDir" placeholder="Custom path..." @keydown.enter="switchToCustom" />
            </div>
          </div>
        </div>
        <div class="conductor-header-right">
          <span class="conductor-header-cost" v-if="statusInfo?.costUsd">
            \${{ (statusInfo.costUsd || 0).toFixed(2) }}
          </span>
          <button class="conductor-header-panel-toggle" @click="showActivePanel = !showActivePanel"
                  :class="{ active: showActivePanel }">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
            <span v-if="activeTaskCount > 0" class="conductor-header-badge">{{ activeTaskCount }}</span>
          </button>
        </div>
      </div>

      <!-- Main workspace: Chat + Active Panel -->
      <div class="conductor-workspace" :class="{ 'hide-active-panel': !showActivePanel, 'task-panel-open': !!selectedTaskId }">
        <!-- Mobile overlay -->
        <div class="conductor-mobile-overlay" v-if="showActivePanel && isMobile" @click="showActivePanel = false"></div>

        <!-- Center: Chat Messages -->
        <div class="conductor-panel-center">
          <div class="conductor-messages" ref="messagesRef" @scroll="onScroll">
            <!-- Empty state -->
            <div v-if="conductorMessages.length === 0" class="conductor-empty">
              <div class="conductor-empty-icon">🎼</div>
              <div class="conductor-empty-text">Conductor is ready</div>
              <div class="conductor-empty-hint">Describe what you need, and I'll create tasks and assign actors</div>
            </div>

            <!-- Messages -->
            <template v-for="msg in conductorMessages" :key="msg.id">
              <!-- Human messages -->
              <div v-if="msg.role === 'human'" class="conductor-msg conductor-msg-human">
                <div class="conductor-msg-content">{{ msg.content }}</div>
              </div>

              <!-- System messages (compact) -->
              <div v-else-if="msg.type === 'system' || msg.type === 'actor_spawn' || msg.type === 'actor_release' || msg.type === 'task_created' || msg.type === 'task_completed'"
                   class="conductor-msg conductor-msg-system"
                   :class="'msg-' + msg.type">
                <span class="conductor-msg-system-text">{{ msg.content }}</span>
              </div>

              <!-- Error messages -->
              <div v-else-if="msg.type === 'error'" class="conductor-msg conductor-msg-error">
                {{ msg.content }}
              </div>

              <!-- Tool use (compact) -->
              <div v-else-if="msg.type === 'tool'" class="conductor-msg conductor-msg-tool">
                <span class="conductor-msg-tool-icon">⚡</span>
                <span class="conductor-msg-tool-name">{{ msg.toolName }}</span>
              </div>

              <!-- Conductor / Orchestrator / Actor text -->
              <div v-else class="conductor-msg conductor-msg-assistant"
                   :class="{ 'is-streaming': msg._streaming, 'role-conductor': msg.role === 'conductor', 'role-orchestrator': msg.role === 'orchestrator', 'role-actor': msg.role === 'actor' }">
                <div class="conductor-msg-header">
                  <span v-if="msg.persona" class="conductor-msg-persona">{{ msg.persona }}</span>
                  <span v-else class="conductor-msg-role-label">{{ roleLabel(msg) }}</span>
                  <span v-if="msg.specialty" class="conductor-msg-specialty">{{ msg.specialty }}</span>
                  <span v-if="msg.taskId" class="conductor-msg-task-link" @click="openTask(msg.taskId)">
                    → {{ getTaskTitle(msg.taskId) }}
                  </span>
                </div>
                <div class="conductor-msg-text" v-html="renderMarkdown(msg.content)"></div>
                <span v-if="msg._streaming" class="conductor-typing-dots">
                  <span class="conductor-typing-dot"></span>
                  <span class="conductor-typing-dot"></span>
                  <span class="conductor-typing-dot"></span>
                </span>
              </div>
            </template>

            <!-- Typing indicator -->
            <div v-if="isWaitingResponse" class="typing-indicator">
              <span></span><span></span><span></span>
            </div>

            <!-- Scroll to bottom -->
            <div class="conductor-scroll-bottom"
                 :class="{ 'is-hidden': isAtBottom }"
                 @click="scrollToBottom">
              ↓ Latest
            </div>
          </div>

          <!-- Input -->
          <div class="conductor-input-area">
            <div class="conductor-input-hints" v-if="statusInfo">
              <span class="conductor-hint-meta" v-if="activeTaskCount > 0">{{ activeTaskCount }} tasks</span>
              <span class="conductor-hint-sep" v-if="activeTaskCount > 0">&middot;</span>
              <span class="conductor-hint-meta" v-if="activeActorCount > 0">{{ activeActorCount }} actors</span>
            </div>
            <div class="conductor-input-wrapper">
              <textarea
                ref="inputRef"
                v-model="inputText"
                @keydown="handleKeydown"
                @input="autoResize"
                placeholder="Talk to the Conductor..."
                rows="1"
              ></textarea>
              <button class="conductor-send-btn" @click="sendMessage" :disabled="!inputText.trim()">
                <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Right: Active Panel -->
        <conductor-active-panel
          v-if="showActivePanel"
          :store="store"
          :session-id="store.currentConversation"
          :tasks="currentTasks"
          :actors="currentActors"
          :selected-task-id="selectedTaskId"
          @open-task="openTask"
        />

        <!-- Push-in: Task Panel -->
        <conductor-task-panel
          v-if="selectedTaskId"
          :store="store"
          :task-id="selectedTaskId"
          :task="selectedTask"
          :actors="selectedTaskActors"
          :messages="selectedTaskMessages"
          @close="closeTask"
          @send-message="sendTaskMessage"
        />
      </div>

      <!-- Click-away for workdir menu -->
      <div v-if="showWorkDirMenu" class="conductor-backdrop" @click="showWorkDirMenu = false"></div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  data() {
    return {
      inputText: '',
      selectedTaskId: null,
      showActivePanel: true,
      showWorkDirMenu: false,
      customWorkDir: '',
      isAtBottom: true,
      isMobile: window.innerWidth < 768,
      folders: []
    };
  },

  computed: {
    session() {
      const sid = this.store.currentConversation;
      return sid ? this.store.conductorSessions[sid] : null;
    },
    sessionName() {
      return this.session?.name || 'Conductor';
    },
    currentWorkDir() {
      return this.session?.currentWorkDir || this.store.currentWorkDir || '';
    },
    conductorMessages() {
      const sid = this.store.currentConversation;
      if (!sid) return [];
      return this.store.conductorMessages[sid] || [];
    },
    currentTasks() {
      const sid = this.store.currentConversation;
      if (!sid) return {};
      return this.store.conductorTasks[sid] || {};
    },
    currentActors() {
      const sid = this.store.currentConversation;
      if (!sid) return {};
      return this.store.conductorActors[sid] || {};
    },
    statusInfo() {
      const sid = this.store.currentConversation;
      if (!sid) return null;
      return this.store.conductorStatuses[sid] || null;
    },
    activeTaskCount() {
      return Object.values(this.currentTasks).filter(
        t => t.status === 'active' || t.status === 'executing' || t.status === 'planning'
      ).length;
    },
    activeActorCount() {
      return Object.keys(this.currentActors).length;
    },
    selectedTask() {
      if (!this.selectedTaskId) return null;
      return this.currentTasks[this.selectedTaskId] || null;
    },
    selectedTaskActors() {
      if (!this.selectedTaskId) return [];
      return Object.values(this.currentActors).filter(a => a.taskId === this.selectedTaskId);
    },
    selectedTaskMessages() {
      if (!this.selectedTaskId) return [];
      return this.conductorMessages.filter(m => m.taskId === this.selectedTaskId);
    },
    isWaitingResponse() {
      const msgs = this.conductorMessages;
      if (!msgs || msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      return last.role === 'human' && !last._sendFailed;
    }
  },

  watch: {
    'store.currentConversation'() {
      this.selectedTaskId = null;
      this.isAtBottom = true;
      this.$nextTick(() => this.scrollToBottom());
    },
    'conductorMessages.length'() {
      if (this.isAtBottom) {
        this.$nextTick(() => this.scrollToBottom());
      }
    }
  },

  methods: {
    roleLabel(msg) {
      if (msg.role === 'conductor') return 'Conductor';
      if (msg.role === 'orchestrator') return 'Orchestrator';
      if (msg.role === 'actor') return 'Actor';
      return msg.role || 'System';
    },
    getTaskTitle(taskId) {
      const task = this.currentTasks[taskId];
      return task?.title || taskId;
    },
    renderMarkdown,
    openTask(taskId) {
      this.selectedTaskId = this.selectedTaskId === taskId ? null : taskId;
    },
    closeTask() {
      this.selectedTaskId = null;
    },
    sendMessage() {
      const text = this.inputText.trim();
      if (!text) return;
      this.store.sendConductorMessage(text);
      this.inputText = '';
      this.isAtBottom = true;
      this.$nextTick(() => this.scrollToBottom());
    },
    sendTaskMessage(text, taskId) {
      this.store.sendConductorMessage(text, taskId);
    },
    switchWorkDir(folder) {
      this.store.switchConductorWorkDir(folder);
      this.showWorkDirMenu = false;
    },
    switchToCustom() {
      if (this.customWorkDir.trim()) {
        this.store.switchConductorWorkDir(this.customWorkDir.trim());
        this.customWorkDir = '';
        this.showWorkDirMenu = false;
      }
    },
    handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    },
    autoResize() {
      const el = this.$refs.inputRef;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    },
    onScroll() {
      const el = this.$refs.messagesRef;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      this.isAtBottom = scrollHeight - scrollTop - clientHeight <= 50;
    },
    scrollToBottom() {
      const el = this.$refs.messagesRef;
      if (el) {
        el.scrollTop = el.scrollHeight;
        this.isAtBottom = true;
      }
    },
    async loadFolders() {
      await this.store.listFolders();
      this.folders = this.store.folders.map(f => f.path || f);
    }
  },

  mounted() {
    this.scrollToBottom();
    this.loadFolders();
    this._resizeHandler = () => { this.isMobile = window.innerWidth < 768; };
    window.addEventListener('resize', this._resizeHandler);
  },

  beforeUnmount() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
  }
};
