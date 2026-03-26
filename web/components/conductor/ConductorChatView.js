/**
 * ConductorChatView — Main Conductor V5 conversation view.
 *
 * Reuses MessageItem + AssistantTurn from Chat mode for consistent message
 * rendering. System/task lifecycle messages use compact inline display.
 *
 * Layout:
 *   Left:  Conductor conversation message flow (reusing Chat components)
 *   Right: ConductorActivePanel (task list + actor status)
 */
import ConductorActivePanel from './ConductorActivePanel.js';
import ConductorTaskPanel from './ConductorTaskPanel.js';
import MessageItem from '../MessageItem.js';
import AssistantTurn from '../AssistantTurn.js';
import ChatInput from '../ChatInput.js';

export default {
  name: 'ConductorChatView',
  components: { ConductorActivePanel, ConductorTaskPanel, MessageItem, AssistantTurn, ChatInput },
  template: `
    <div class="conductor-chat-view" :class="{ 'active-panel-visible': showActivePanel }">
      <!-- Main workspace: Chat + Active Panel -->
      <div class="conductor-workspace" :class="{ 'task-panel-open': !!selectedTaskId }">
        <!-- Mobile overlay for active panel -->
        <div class="conductor-mobile-overlay" v-if="showActivePanel && isMobile" @click="store.conductorActivePanelVisible = false"></div>

        <!-- Center: Chat Messages -->
        <div class="conductor-panel-center">
          <div class="conductor-messages" ref="messagesRef" @scroll="onScroll">
            <!-- Empty state -->
            <div v-if="conductorMessages.length === 0" class="conductor-empty">
              <div class="conductor-empty-icon">
                <svg viewBox="0 0 24 24" width="40" height="40"><path fill="var(--text-muted)" d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>
              </div>
              <div class="conductor-empty-text">{{ $t('conductor.ready') }}</div>
              <template v-if="!store.conductorWorkDir">
                <div class="conductor-empty-hint">{{ $t('conductor.selectDirHint') }}</div>
                <button class="conductor-empty-action" @click="openFolderPicker">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  {{ $t('conductor.chooseDir') }}
                </button>
                <div class="conductor-empty-subtitle">{{ $t('conductor.orTypeBelow') }}</div>
              </template>
              <template v-else>
                <div class="conductor-empty-hint">{{ $t('conductor.emptyHint') }}</div>
              </template>
            </div>

            <!-- Messages rendered via Chat components -->
            <div v-else class="messages">
              <template v-for="item in turnGroups" :key="item.id">
                <!-- Human messages: reuse MessageItem -->
                <MessageItem v-if="item.type === 'user'" :message="item.message" />

                <!-- Assistant turns: reuse AssistantTurn -->
                <AssistantTurn v-else-if="item.type === 'assistant-turn'" :turn="item" />

                <!-- System / task lifecycle messages (compact inline) -->
                <div v-else-if="item.type === 'system'" class="conductor-msg conductor-msg-system" :class="'msg-' + (item.message.type || 'system')">
                  <span class="conductor-msg-system-text">{{ item.message.content }}</span>
                </div>

                <!-- Error messages -->
                <div v-else-if="item.type === 'error'" class="conductor-msg conductor-msg-error">
                  {{ item.message.content }}
                </div>
              </template>

              <!-- Waiting for response indicator -->
              <div v-if="isWaitingResponse" class="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>

            <!-- Scroll to bottom fab -->
            <div class="conductor-scroll-bottom"
                 :class="{ 'is-hidden': isAtBottom }"
                 @click="scrollToBottom">
              {{ $t('conductor.scrollLatest') }}
            </div>
          </div>

          <!-- Input area: workDir selector + ChatInput -->
          <div class="conductor-input-area">
            <!-- workDir selector above input -->
            <div class="conductor-workdir-bar">
              <button class="conductor-workdir-btn" :class="{ 'is-empty': !store.conductorWorkDir, 'is-open': showWorkDirPicker }" @click="toggleWorkDirPicker" :title="store.conductorWorkDir || 'Select work directory'" aria-haspopup="dialog" :aria-expanded="showWorkDirPicker">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="conductor-workdir-name">{{ conductorWorkDirLabel || $t('conductor.chooseDir') }}</span>
                <svg class="conductor-workdir-chevron" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <!-- Folder Picker panel -->
              <div class="conductor-workdir-picker" v-if="showWorkDirPicker" @click.stop role="dialog" aria-label="Select work directory">
                <div class="conductor-picker-path-bar">
                  <input type="text" v-model="pickerPathInput" :placeholder="$t('conductor.enterPath')" class="conductor-picker-path-input" :class="{ 'is-invalid': pickerPathInvalid }" @keydown.enter="pickerNavigateToInput" aria-label="Directory path" ref="pickerPathInputRef" />
                  <button class="conductor-picker-up-btn" @click="pickerNavigateUp" :disabled="!pickerPathInput" aria-label="Navigate to parent directory" :title="$t('conductor.parentDir')">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="18 15 12 9 6 15"/>
                    </svg>
                  </button>
                </div>
                <div class="conductor-picker-recent" v-if="recentWorkDirs.length > 0">
                  <div class="conductor-picker-recent-title">{{ $t('conductor.recentDirs') }}</div>
                  <div class="conductor-picker-recent-item" v-for="dir in recentWorkDirs" :key="dir" @click="pickerSelectRecent(dir)">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>
                    <span>{{ dir }}</span>
                  </div>
                </div>
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
                <div class="conductor-picker-footer">
                  <button class="conductor-picker-cancel" @click="showWorkDirPicker = false">{{ $t('common.cancel') }}</button>
                  <button class="conductor-picker-select" @click="pickerConfirm" :disabled="!pickerPathInput.trim()">{{ $t('common.select') }}</button>
                </div>
              </div>
              <!-- Mobile overlay for picker -->
              <div class="conductor-picker-overlay" v-if="showWorkDirPicker && isMobile" @click="showWorkDirPicker = false"></div>
            </div>

            <ChatInput
              :send-fn="conductorSendFn"
              :cancel-fn="conductorCancelFn"
              placeholder-key="conductor.inputPlaceholder"
              :show-stop="isWaitingResponse"
            />
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
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();

    // workDir picker state
    const showWorkDirPicker = Vue.ref(false);
    const pickerPathInput = Vue.ref('');
    const pickerPathInputRef = Vue.ref(null);
    const pickerFolders = Vue.ref([]);
    const pickerLoading = Vue.ref(false);
    const pickerSelectedFolder = Vue.ref('');
    const pickerPathInvalid = Vue.ref(false);

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

    return { store, showWorkDirPicker, conductorWorkDirLabel, toggleWorkDirPicker, pickerPathInput, pickerPathInputRef, pickerFolders, pickerLoading, pickerSelectedFolder, pickerPathInvalid, recentWorkDirs, pickerNavigateToInput, pickerNavigateUp, pickerSelectFolder, pickerEnterFolder, pickerSelectRecent, pickerConfirm };
  },

  data() {
    return {
      selectedTaskId: null,
      isAtBottom: true,
      isMobile: window.innerWidth < 768
    };
  },

  computed: {
    showActivePanel() {
      return this.store.conductorActivePanelVisible;
    },
    session() {
      const sid = this.store.currentConversation;
      if (!sid) return null;
      return this.store.conversations.find(c => c.id === sid) || null;
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
      // TODO: V5 actors are managed per-task on the Agent side and not yet
      // exposed as a separate UI state. The ConductorActivePanel actors prop
      // will remain empty until actor-level status is surfaced in V5 protocol.
      return {};
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
    },
    /**
     * Transform conductor messages into turn groups compatible with
     * MessageItem and AssistantTurn components.
     */
    turnGroups() {
      const msgs = this.conductorMessages;
      const result = [];
      let currentTurn = null;
      let turnCounter = 0;

      const finishTurn = () => {
        if (currentTurn) {
          if (currentTurn.textContent || currentTurn.toolMsgs.length > 0) {
            result.push(currentTurn);
          }
          currentTurn = null;
        }
      };

      const startTurn = () => {
        turnCounter++;
        currentTurn = {
          type: 'assistant-turn',
          id: 'cturn_' + turnCounter,
          textContent: '',
          isStreaming: false,
          todoMsg: null,
          toolMsgs: [],
          askMsg: null,
          messages: []
        };
      };

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];

        // Human → MessageItem as user
        if (msg.role === 'human') {
          finishTurn();
          result.push({
            type: 'user',
            id: msg.id || 'hu_' + i,
            message: { type: 'user', content: msg.content, id: msg.id }
          });
          continue;
        }

        // System / task lifecycle → compact inline
        if (msg.type === 'system' || msg.type === 'task_created' || msg.type === 'task_completed'
            || msg.type === 'actor_spawn' || msg.type === 'actor_release' || msg.type === 'task_message') {
          finishTurn();
          result.push({ type: 'system', id: msg.id || 'cs_' + i, message: msg });
          continue;
        }

        // Error → compact inline
        if (msg.type === 'error') {
          finishTurn();
          result.push({ type: 'error', id: msg.id || 'ce_' + i, message: msg });
          continue;
        }

        // Tool → aggregate into AssistantTurn
        if (msg.type === 'tool') {
          if (!currentTurn) startTurn();
          currentTurn.toolMsgs.push({
            toolName: msg.toolName,
            toolInput: msg.toolInput || {},
            toolResult: msg.toolResult || null,
            hasResult: msg.hasResult || false
          });
          currentTurn.messages.push(msg);
          continue;
        }

        // Text (conductor / orchestrator / actor) → aggregate into AssistantTurn
        if (!currentTurn) startTurn();
        if (msg.content) {
          currentTurn.textContent += msg.content;
        }
        if (msg._streaming) {
          currentTurn.isStreaming = true;
        }
        currentTurn.messages.push(msg);
      }

      finishTurn();
      return result;
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
    openTask(taskId) {
      this.selectedTaskId = this.selectedTaskId === taskId ? null : taskId;
    },
    closeTask() {
      this.selectedTaskId = null;
    },
    /** Open the local workDir Folder Picker. */
    openFolderPicker() {
      this.toggleWorkDirPicker();
    },
    /** Send function passed to ChatInput — delegates to store.sendConductorMessage. */
    conductorSendFn(text, attachments) {
      if (!text) return;
      this.store.sendConductorMessage(text, null, attachments);
      this.isAtBottom = true;
      this.$nextTick(() => this.scrollToBottom());
    },
    /** Cancel function passed to ChatInput — sends stop_conductor. */
    conductorCancelFn() {
      this.store.sendConductorControl('stop');
    },
    sendTaskMessage(text, taskId) {
      this.store.sendConductorMessage(text, taskId);
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
    }
  },

  mounted() {
    this.scrollToBottom();
    this._resizeHandler = () => { this.isMobile = window.innerWidth < 768; };
    window.addEventListener('resize', this._resizeHandler);
  },

  beforeUnmount() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
  }
};
