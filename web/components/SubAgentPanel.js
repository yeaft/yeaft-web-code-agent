import { renderMarkdown, renderMermaidIn } from '../utils/markdown.js';

export default {
  name: 'SubAgentPanel',
  props: {
    visible: { type: Boolean, default: false }
  },
  emits: ['close'],
  template: `
    <div class="subagent-panel" :class="{ open: visible, expanded: store.activeSubagentId }" role="complementary" aria-label="Sub-Agents">
      <!-- Expanded Mode: Full message thread for a subagent -->
      <template v-if="store.activeSubagentId && activeAgent">
        <div class="subagent-panel-header subagent-expanded-header">
          <button class="subagent-back-btn" @click="closeExpanded" :aria-label="$t('subAgentPanel.back')">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <span class="subagent-expanded-slug">{{ activeAgent.slug }}</span>
          <span class="subagent-type-badge">{{ activeAgent.type }}</span>
          <span v-if="activeAgent.toolCallCount" class="subagent-type-badge">{{ $t('subAgentPanel.toolCount', { count: activeAgent.toolCallCount }) }}</span>
          <span class="subagent-status-dot" :class="{ 'is-running': activeAgent.status === 'running' }"></span>
          <button class="subagent-panel-close" @click="$emit('close')" :aria-label="$t('common.close')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="subagent-messages" ref="messagesRef">
          <template v-if="activeMessages.length > 0">
            <div v-for="(msg, idx) in activeMessages" :key="idx"
                 class="subagent-msg" :class="'is-' + msg.type">
              <div v-if="msg.type === 'text'" class="subagent-msg-text markdown-body" v-html="renderMd(msg.content)"></div>
            </div>
          </template>
          <div v-else class="subagent-msg-empty">
            <div class="subagent-msg-dots">
              <span class="subagent-dot"></span>
              <span class="subagent-dot"></span>
              <span class="subagent-dot"></span>
            </div>
            <span>{{ $t('subAgentPanel.waitingMessages') }}</span>
          </div>
        </div>
      </template>

      <!-- List Mode: Subagent cards -->
      <template v-else>
        <div class="subagent-panel-header">
          <span class="subagent-panel-title">
            {{ $t('subAgentPanel.title') }}
            <span class="subagent-panel-count" v-if="allSubagents.length > 0">({{ allSubagents.length }})</span>
          </span>
          <button class="subagent-panel-close" @click="$emit('close')" :aria-label="$t('common.close')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <div class="subagent-list" v-if="allSubagents.length > 0" role="list">
          <div v-for="agent in sortedSubagents" :key="agent.id" role="listitem"
               class="subagent-card" :class="{ 'is-completed': agent.status === 'completed' }"
               @click="expandAgent(agent.id)">
            <div class="subagent-card-header">
              <span class="subagent-card-icon">&#x1F916;</span>
              <span class="subagent-card-slug">{{ agent.slug }}</span>
              <span class="subagent-type-badge">{{ agent.type }}</span>
              <span v-if="agent.toolCallCount" class="subagent-type-badge">{{ $t('subAgentPanel.toolCount', { count: agent.toolCallCount }) }}</span>
              <span class="subagent-status-dot" :class="{ 'is-running': agent.status === 'running' }"></span>
            </div>
            <div v-if="getLastMessage(agent)" class="subagent-card-preview">
              {{ truncate(getLastMessage(agent).content, 120) }}
            </div>
            <div v-else-if="agent.status === 'running'" class="subagent-card-preview is-waiting">
              {{ $t('subAgentPanel.waitingMessages') }}
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-else class="subagent-empty">
          <div class="subagent-empty-icon">&#x1F4A4;</div>
          <div class="subagent-empty-text">{{ $t('subAgentPanel.empty') }}</div>
          <div class="subagent-empty-hint">{{ $t('subAgentPanel.emptyHint') }}</div>
        </div>
      </template>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const messagesRef = Vue.ref(null);

    // Close on Escape
    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.visible) {
        if (store.activeSubagentId) {
          store.activeSubagentId = null;
        } else {
          emit('close');
        }
      }
    };
    Vue.onMounted(() => {
      document.addEventListener('keydown', onKeydown);
      Vue.nextTick(() => renderMermaidIn(messagesRef.value));
    });
    Vue.onUnmounted(() => document.removeEventListener('keydown', onKeydown));

    const allSubagents = Vue.computed(() => store.currentSubagents);

    const sortedSubagents = Vue.computed(() => {
      return [...allSubagents.value].sort((a, b) => {
        // Running first, then completed
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (b.startTime || 0) - (a.startTime || 0);
      });
    });

    const activeAgent = Vue.computed(() => {
      if (!store.activeSubagentId) return null;
      return allSubagents.value.find(a => a.id === store.activeSubagentId) || null;
    });

    const activeMessages = Vue.computed(() => store.activeSubagentMessages);

    const expandAgent = (agentId) => {
      store.activeSubagentId = agentId;
    };

    const closeExpanded = () => {
      store.activeSubagentId = null;
    };

    const getLastMessage = (agent) => {
      if (!agent.messages || agent.messages.length === 0) return null;
      // Find the last assistant text message for preview. Tool calls are only
      // summarized as counts, not rendered as messages.
      for (let i = agent.messages.length - 1; i >= 0; i--) {
        if (agent.messages[i].type === 'text') return agent.messages[i];
      }
      return null;
    };

    const truncate = (text, maxLen) => {
      if (!text) return '';
      // Strip markdown for preview
      const plain = text.replace(/[#*_`~\[\]()>|\\]/g, '').replace(/\n+/g, ' ').trim();
      return plain.length > maxLen ? plain.substring(0, maxLen) + '...' : plain;
    };

    const renderMd = (content) => {
      if (!content) return '';
      return renderMarkdown(content);
    };

    const subagentMessageSignature = Vue.computed(() => {
      return activeMessages.value
        .map((msg) => `${msg.type || ''}:${msg.content || ''}`)
        .join('\u0000');
    });

    const renderActiveMessages = () => {
      Vue.nextTick(() => {
        const el = messagesRef.value;
        if (el) {
          renderMermaidIn(el);
          el.scrollTop = el.scrollHeight;
        }
      });
    };

    // Auto-scroll and render diagrams when switching agents, receiving new
    // messages, or updating streaming text in-place.
    Vue.watch(
      () => [store.activeSubagentId, activeMessages.value.length, subagentMessageSignature.value],
      renderActiveMessages
    );

    return {
      store, allSubagents, sortedSubagents, activeAgent, activeMessages,
      expandAgent, closeExpanded, getLastMessage, truncate, renderMd, messagesRef
    };
  }
};
