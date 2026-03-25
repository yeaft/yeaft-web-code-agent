/**
 * ConductorChatView — Main Conductor V5 conversation view.
 *
 * Reuses ChatHeader (via ChatPage parent) for consistent visual language.
 * Layout:
 *   Left:  Conductor conversation message flow (chat-like)
 *   Right: ConductorActivePanel (task list + actor status)
 *
 * Header is provided by ChatPage (ChatHeader component), same as Crew mode.
 * ConductorChatView handles: messages + input + active panel.
 */
import ConductorActivePanel from './ConductorActivePanel.js';
import ConductorTaskPanel from './ConductorTaskPanel.js';
import { renderMarkdown } from './utils.js';

export default {
  name: 'ConductorChatView',
  components: { ConductorActivePanel, ConductorTaskPanel },
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
                <span class="conductor-msg-tool-icon">&#9889;</span>
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
                    &rarr; {{ getTaskTitle(msg.taskId) }}
                  </span>
                </div>
                <div class="conductor-msg-text" v-html="renderMarkdown(msg.content)"></div>
                <span v-if="msg._streaming" class="typing-indicator conductor-streaming-dots">
                  <span></span><span></span><span></span>
                </span>
              </div>
            </template>

            <!-- Waiting for response indicator -->
            <div v-if="isWaitingResponse" class="typing-indicator">
              <span></span><span></span><span></span>
            </div>

            <!-- Scroll to bottom fab -->
            <div class="conductor-scroll-bottom"
                 :class="{ 'is-hidden': isAtBottom }"
                 @click="scrollToBottom">
              &#8595; Latest
            </div>
          </div>

          <!-- Input area — conductor-specific (sends via store.sendConductorMessage) -->
          <div class="conductor-input-area">
            <div class="conductor-input-hints" v-if="activeTaskCount > 0 || activeActorCount > 0">
              <span class="conductor-hint-meta" v-if="activeTaskCount > 0">{{ activeTaskCount }} tasks</span>
              <span class="conductor-hint-sep" v-if="activeTaskCount > 0 && activeActorCount > 0">&middot;</span>
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
      return sid ? this.store.conductorSessions[sid] : null;
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
      this.$nextTick(() => {
        this.scrollToBottom();
        this.autoResize();
      });
    },
    sendTaskMessage(text, taskId) {
      this.store.sendConductorMessage(text, taskId);
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
