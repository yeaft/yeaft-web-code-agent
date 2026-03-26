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

export default {
  name: 'ConductorChatView',
  components: { ConductorActivePanel, ConductorTaskPanel, MessageItem, AssistantTurn },
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
              <div class="conductor-empty-hint">{{ $t('conductor.emptyHint') }}</div>
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

          <!-- Input area — conductor-specific (sends via store.sendConductorMessage) -->
          <div class="conductor-input-area">
            <div class="conductor-input-hints" v-if="activeTaskCount > 0 || activeActorCount > 0">
              <span class="conductor-hint-meta" v-if="activeTaskCount > 0">{{ $t('conductor.tasks', { count: activeTaskCount }) }}</span>
              <span class="conductor-hint-sep" v-if="activeTaskCount > 0 && activeActorCount > 0">&middot;</span>
              <span class="conductor-hint-meta" v-if="activeActorCount > 0">{{ $t('conductor.actors', { count: activeActorCount }) }}</span>
            </div>
            <div class="conductor-input-wrapper">
              <textarea
                ref="inputRef"
                v-model="inputText"
                @keydown="handleKeydown"
                @input="autoResize"
                :placeholder="$t('conductor.inputPlaceholder')"
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
