/**
 * FeaturePill — PR-2 of the feature-pill double-track redesign.
 *
 * Renders a "feature run" as a single collapsible pill in the message stream.
 * A feature run is the contiguous block of VP-attributed messages tagged with
 * the same `featureId` (set by the agent's feature-arc once one of the three
 * triggers — quick-intent / turn-budget / tool-call — fires).
 *
 * States (driven by `unifyFeatureMeta[featureId].status`):
 *   - 'active'    — spinner + title, expanded by default while streaming.
 *   - 'completed' — green check + summary, collapsed by default.
 *   - 'aborted'   — grey ✕, collapsed by default.
 *   - 'error'     — red ✕, collapsed by default.
 *
 * Click the pill header to toggle. The inner body re-uses the standard
 * AssistantTurn / FeatureMessageItem / MessageItem rendering pipeline so
 * the messages inside the pill look identical to messages outside it.
 *
 * Props:
 *   featureId — the run's id; looked up in `unifyFeatureMeta`.
 *   turns     — array of pre-aggregated turn items belonging to this feature
 *               (assistant-turn / feature-message). MessageList builds these
 *               in `turnGroups` so the same turn-aggregation logic that runs
 *               outside the pill also runs inside it.
 *
 * Emits:
 *   open-vp-detail (vpId) — forwarded from inner AssistantTurn rows.
 */
import AssistantTurn from './AssistantTurn.js';
import FeatureMessageItem from './FeatureMessageItem.js';
import MessageItem from './MessageItem.js';

export default {
  name: 'FeaturePill',
  components: { AssistantTurn, FeatureMessageItem, MessageItem },
  emits: ['open-vp-detail'],
  props: {
    featureId: { type: String, required: true },
    turns: { type: Array, required: true },
  },
  template: `
    <div class="feature-pill" :class="['feature-pill-' + statusClass, { 'feature-pill-expanded': expanded }]" :data-feature-id="featureId">
      <button
        type="button"
        class="feature-pill-header"
        :aria-expanded="expanded ? 'true' : 'false'"
        :title="pillTooltip"
        @click="toggle"
      >
        <span class="feature-pill-icon" aria-hidden="true">
          <span v-if="statusClass === 'active'" class="feature-pill-spinner"></span>
          <span v-else-if="statusClass === 'completed'">✓</span>
          <span v-else-if="statusClass === 'error'">✕</span>
          <span v-else>·</span>
        </span>
        <span class="feature-pill-label">{{ $t('unify.featurePill.label') }}</span>
        <span class="feature-pill-title">{{ pillTitle }}</span>
        <span class="feature-pill-meta">
          <span v-if="triggerLabel" class="feature-pill-trigger">{{ triggerLabel }}</span>
          <span v-if="messageCount > 0" class="feature-pill-count">{{ messageCount }}</span>
        </span>
        <span class="feature-pill-toggle" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>

      <div v-if="expanded" class="feature-pill-body">
        <template v-for="turn in turns" :key="turn.id">
          <div class="msg-row feature-pill-row" :data-msg-id="turn.id">
            <MessageItem
              v-if="turn.type === 'user' || turn.type === 'system' || turn.type === 'error'"
              :message="turn.message"
            />
            <FeatureMessageItem
              v-else-if="turn.type === 'feature-message'"
              :message="turn.message"
            />
            <AssistantTurn
              v-else-if="turn.type === 'assistant-turn'"
              :turn="turn"
              @open-vp-detail="$emit('open-vp-detail', $event)"
            />
          </div>
        </template>

        <div v-if="summaryText" class="feature-pill-summary">
          <span class="feature-pill-summary-label">{{ $t('unify.featurePill.summaryLabel') }}</span>
          <span class="feature-pill-summary-body">{{ summaryText }}</span>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();

    const meta = Vue.computed(() => {
      const map = store.unifyFeatureMeta || {};
      return map[props.featureId] || null;
    });

    const statusClass = Vue.computed(() => {
      const m = meta.value;
      if (!m) return 'active';  // missing meta → assume in-flight (UI-only)
      const s = m.status || 'active';
      if (s === 'completed') return 'completed';
      if (s === 'aborted' || s === 'error') return 'error';
      return 'active';
    });

    // Expanded by default while active; collapsed once the feature finalises.
    // The user can override by clicking — `userToggled` latches their choice.
    const userToggled = Vue.ref(null);   // null | true | false
    const expanded = Vue.computed(() => {
      if (userToggled.value !== null) return userToggled.value;
      return statusClass.value === 'active';
    });
    const toggle = () => {
      userToggled.value = !expanded.value;
    };

    const pillTitle = Vue.computed(() => {
      const m = meta.value;
      if (!m) return props.featureId.slice(0, 8);
      return (m.title && m.title.trim()) || props.featureId.slice(0, 8);
    });

    const triggerLabel = Vue.computed(() => {
      const m = meta.value;
      if (!m || !m.trigger) return '';
      switch (m.trigger) {
        case 'quick': return 'quick';
        case 'turns': return 'multi-turn';
        case 'tool': return m.toolName || 'tool';
        default: return m.trigger;
      }
    });

    const summaryText = Vue.computed(() => {
      const m = meta.value;
      if (!m) return '';
      return (m.summary || '').trim();
    });

    const pillTooltip = Vue.computed(() => {
      const m = meta.value;
      if (!m) return props.featureId;
      const parts = [];
      if (m.title) parts.push(m.title);
      parts.push('id=' + props.featureId);
      if (m.trigger) parts.push('trigger=' + m.trigger);
      if (m.status) parts.push('status=' + m.status);
      return parts.join(' · ');
    });

    const messageCount = Vue.computed(() => {
      // Surface the count of inner turns so the user can see "this pill has
      // 4 messages folded inside" before deciding to expand.
      return Array.isArray(props.turns) ? props.turns.length : 0;
    });

    return {
      statusClass,
      expanded,
      toggle,
      pillTitle,
      triggerLabel,
      summaryText,
      pillTooltip,
      messageCount,
    };
  },
};
