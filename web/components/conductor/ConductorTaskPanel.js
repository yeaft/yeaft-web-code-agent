/**
 * ConductorTaskPanel — Push-in panel showing task details.
 *
 * Sections:
 *   1. Plan steps (✅/🔵/⬜ status)
 *   2. Active actor list
 *   3. Task conversation flow (Orchestrator + Actor messages)
 */
import ActorCard from './ActorCard.js';
import { renderMarkdown } from './utils.js';

export default {
  name: 'ConductorTaskPanel',
  components: { ActorCard },
  props: {
    store: { type: Object, required: true },
    taskId: { type: String, required: true },
    task: { type: Object, default: null },
    actors: { type: Array, default: () => [] },
    messages: { type: Array, default: () => [] }
  },
  emits: ['close', 'send-message'],
  data() {
    return {
      inputText: '',
      visibleMessageCount: 30
    };
  },
  template: `
    <div class="conductor-task-panel" :class="{ 'is-open': !!taskId }">
      <!-- Header -->
      <div class="conductor-task-panel-header">
        <button class="conductor-task-panel-close" @click="$emit('close')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <div class="conductor-task-panel-title-area">
          <span class="conductor-task-panel-title">{{ task?.title || taskId }}</span>
          <span class="conductor-task-panel-status" :class="'is-' + (task?.status || 'active')">
            {{ taskStatusLabel }}
          </span>
        </div>
      </div>

      <!-- Plan Steps -->
      <div v-if="planSteps.length > 0" class="conductor-task-plan">
        <div class="conductor-task-plan-title">{{ $t('conductor.plan') }}</div>
        <div v-for="(step, idx) in planSteps" :key="idx"
             class="conductor-task-plan-step"
             :class="'step-' + (step.status || 'pending')">
          <span class="conductor-task-plan-icon">{{ stepIcon(step) }}</span>
          <span class="conductor-task-plan-text">{{ step.title || step.description || ('Step ' + (idx + 1)) }}</span>
          <span v-if="step.assignee" class="conductor-task-plan-assignee">{{ step.assignee }}</span>
        </div>
      </div>

      <!-- Active Actors -->
      <div v-if="actors.length > 0" class="conductor-task-actors-section">
        <div class="conductor-task-actors-title">
          {{ $t('conductor.activeInstances') }}
          <span class="conductor-task-actors-count">{{ actors.length }}</span>
        </div>
        <div class="conductor-task-actors-list">
          <actor-card
            v-for="actor in actors"
            :key="actor.key"
            :actor="actor"
          />
        </div>
      </div>

      <!-- Task Messages -->
      <div class="conductor-task-messages" ref="messagesRef">
        <div v-if="hasMoreMessages" class="conductor-task-load-more" @click="visibleMessageCount += 30">
          {{ $t('conductor.loadOlder') }}
        </div>
        <template v-for="msg in visibleMessages" :key="msg.id">
          <!-- System / Actor Spawn / Release -->
          <div v-if="msg.type === 'system' || msg.type === 'actor_spawn' || msg.type === 'actor_release' || msg.type === 'task_created' || msg.type === 'task_completed'"
               class="conductor-task-msg-system">
            <span class="conductor-task-msg-system-text">{{ msg.content }}</span>
          </div>

          <!-- Tool use (compact) -->
          <div v-else-if="msg.type === 'tool'"
               class="conductor-task-msg-tool"
               :class="{ 'has-result': msg.hasResult }">
            <span class="conductor-task-msg-tool-icon">⚡</span>
            <span class="conductor-task-msg-tool-name">{{ msg.toolName }}</span>
            <span class="conductor-task-msg-tool-detail">{{ toolDetail(msg) }}</span>
          </div>

          <!-- Error -->
          <div v-else-if="msg.type === 'error'" class="conductor-task-msg-error">
            {{ msg.content }}
          </div>

          <!-- Text message (conductor / orchestrator / actor) -->
          <div v-else class="conductor-task-msg"
               :class="[
                 'role-' + (msg.role || 'unknown'),
                 { 'is-streaming': msg._streaming }
               ]">
            <div class="conductor-task-msg-header">
              <span v-if="msg.persona" class="conductor-task-msg-persona">{{ msg.persona }}</span>
              <span v-else class="conductor-task-msg-role">{{ msg.role }}</span>
              <span v-if="msg.specialty" class="conductor-task-msg-specialty">{{ msg.specialty }}</span>
            </div>
            <div class="conductor-task-msg-content" v-html="renderMarkdown(msg.content)"></div>
            <span v-if="msg._streaming" class="conductor-task-msg-streaming">
              <span class="conductor-typing-dot"></span>
              <span class="conductor-typing-dot"></span>
              <span class="conductor-typing-dot"></span>
            </span>
          </div>
        </template>
      </div>

      <!-- Task Input -->
      <div class="conductor-task-input">
        <textarea
          v-model="inputText"
          @keydown="handleKeydown"
          :placeholder="$t('conductor.taskInputPlaceholder')"
          rows="1"
        ></textarea>
        <button class="conductor-task-send" @click="send" :disabled="!inputText.trim()">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `,
  computed: {
    planSteps() {
      return this.task?.plan || [];
    },
    taskStatusLabel() {
      const KEYS = {
        active: 'conductor.statusExecuting',
        executing: 'conductor.statusExecuting',
        planning: 'conductor.statusPlanning',
        waiting: 'conductor.statusWaiting',
        completed: 'conductor.statusCompleted',
        error: 'conductor.statusError'
      };
      const key = KEYS[this.task?.status];
      return key ? this.$t(key) : (this.task?.status || 'Active');
    },
    visibleMessages() {
      if (this.messages.length <= this.visibleMessageCount) return this.messages;
      return this.messages.slice(this.messages.length - this.visibleMessageCount);
    },
    hasMoreMessages() {
      return this.messages.length > this.visibleMessageCount;
    }
  },
  watch: {
    taskId() {
      this.visibleMessageCount = 30;
      this.$nextTick(() => this.scrollToBottom());
    },
    'messages.length'() {
      this.$nextTick(() => this.scrollToBottom());
    }
  },
  methods: {
    stepIcon(step) {
      if (step.status === 'done' || step.status === 'completed') return '✅';
      if (step.status === 'active' || step.status === 'in_progress') return '🔵';
      return '⬜';
    },
    toolDetail(msg) {
      if (msg.toolInput?.file_path) return msg.toolInput.file_path;
      if (msg.toolInput?.command) return msg.toolInput.command.substring(0, 60);
      return '';
    },
    renderMarkdown,
    handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    },
    send() {
      const text = this.inputText.trim();
      if (!text) return;
      this.$emit('send-message', text, this.taskId);
      this.inputText = '';
    },
    scrollToBottom() {
      const el = this.$refs.messagesRef;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }
};
