/**
 * SubAgentCard — PR-M3: a collapsible card showing one sub-agent's
 * activity stream within a Yeaft conversation.
 *
 * Backed by `chatStore.yeaftSubAgentCards[key]` where key = `${convId}:${agentId}`.
 * The card aggregates per-agent state populated by the `sub_agent_event`
 * dispatcher in chat.js: status badge, assistant text, compact tool-call
 * count, and turn count.
 *
 * Per CLAUDE.md "Yeaft UI Design Rules": no horizontal dividers, soft
 * surface, spacing-only separation.
 */
export default {
  name: 'SubAgentCard',
  props: {
    card: { type: Object, required: true },
  },
  computed: {
    statusLabel() {
      const map = {
        running: 'Running',
        idle: 'Idle (awaiting parent)',
        completed: 'Completed',
        closed: 'Closed',
        failed: 'Failed',
      };
      return map[this.card.status] || this.card.status || 'unknown';
    },
    statusClass() {
      return `sub-agent-status-${this.card.status || 'running'}`;
    },
    isFailed() {
      return this.card.status === 'failed';
    },
    isExpanded() {
      return Boolean(this.card.expanded);
    },
    truncatedText() {
      const t = (this.card.text || '').trim();
      if (t.length <= 160) return t;
      return t.slice(0, 160) + '…';
    },
  },
  methods: {
    toggle() {
      const store = (typeof Pinia !== 'undefined' && Pinia.useChatStore)
        ? Pinia.useChatStore()
        : null;
      if (store && typeof store.toggleSubAgentCardExpand === 'function') {
        store.toggleSubAgentCardExpand(this.card.key);
      }
    },
  },
  template: `
    <div class="sub-agent-card" :class="{ 'is-failed': isFailed }">
      <div class="sub-agent-head" @click="toggle">
        <span class="sub-agent-icon">⚙</span>
        <span class="sub-agent-name">{{ card.agentName }}</span>
        <span class="sub-agent-status-badge" :class="statusClass">{{ statusLabel }}</span>
        <span v-if="card.turns" class="sub-agent-meta">{{ card.turns }} turn{{ card.turns === 1 ? '' : 's' }}</span>
        <span v-if="card.toolCallCount" class="sub-agent-meta">
          {{ $t('subAgentPanel.toolCount', { count: card.toolCallCount }) }}
        </span>
        <span class="sub-agent-caret">{{ isExpanded ? '▾' : '▸' }}</span>
      </div>

      <div v-if="isFailed && card.error" class="sub-agent-error">
        Error: {{ card.error }}
      </div>

      <div v-if="!isExpanded && card.text" class="sub-agent-preview">
        {{ truncatedText }}
      </div>

      <div v-if="isExpanded" class="sub-agent-body">
        <div v-if="card.text" class="sub-agent-text">{{ card.text }}</div>
        <div v-if="card.toolCallCount" class="sub-agent-tool-summary">
          {{ $t('subAgentPanel.toolSummary', { count: card.toolCallCount }) }}
        </div>
      </div>
    </div>
  `,
};
