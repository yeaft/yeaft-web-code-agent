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
 *   featureId      — the run's id; looked up in `unifyFeatureMeta`.
 *   turns          — array of pre-aggregated turn items belonging to this feature
 *                    (assistant-turn / feature-message). MessageList builds these
 *                    in `turnGroups` so the same turn-aggregation logic that runs
 *                    outside the pill also runs inside it.
 *   subAgentCards  — PR-4: sub-agent cards whose stored `featureId` equals this
 *                    pill's; rendered inside the expanded body.
 *
 * Emits:
 *   open-vp-detail (vpId) — forwarded from inner AssistantTurn rows.
 *   cancel-feature (featureId) — PR-4: user clicked the in-header abort button.
 *                    Parent maps featureId → owning turnId via
 *                    `unifyFeatureMeta[fid].turnId` and calls cancelVpTurn.
 */
import AssistantTurn from './AssistantTurn.js';
import MessageItem from './MessageItem.js';
import SubAgentCard from './SubAgentCard.js';

export default {
  name: 'FeaturePill',
  components: { AssistantTurn, MessageItem, SubAgentCard },
  emits: ['open-vp-detail', 'cancel-feature'],
  props: {
    featureId: { type: String, required: true },
    turns: { type: Array, required: true },
    // PR-4: sub-agent cards spawned while this pill's owning turn was
    // running, identified via the `featureId` field that the sub-agent
    // event sink stamps on every emit (see web-bridge.js sink + chat.js
    // sub_agent_event handler). Rendered inside the expanded body so
    // sub-agent activity folds under the parent feature instead of
    // appearing as orphan cards below it.
    subAgentCards: { type: Array, default: () => [] },
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
          <span v-if="turnCount > 0" class="feature-pill-count">{{ turnCount }}</span>
        </span>
        <!--
          PR-4: per-feature abort affordance. Visible only while the feature
          is still in flight (statusClass === 'active'). Rendered as a
          <span role="button"> rather than <button> because the surrounding
          .feature-pill-header is already a <button> — nesting interactive
          elements is an a11y violation. .stop modifiers prevent the click
          / Enter / Space from also firing the header's toggle handler.
        -->
        <span
          v-if="statusClass === 'active'"
          class="feature-pill-abort"
          role="button"
          tabindex="0"
          :aria-label="$t('unify.featurePill.abort')"
          :title="$t('unify.featurePill.abort')"
          @click.stop="$emit('cancel-feature', featureId)"
          @keydown.enter.stop.prevent="$emit('cancel-feature', featureId)"
          @keydown.space.stop.prevent="$emit('cancel-feature', featureId)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
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
            <AssistantTurn
              v-else-if="turn.type === 'assistant-turn'"
              :turn="turn"
              @open-vp-detail="$emit('open-vp-detail', $event)"
            />
          </div>
        </template>

        <!--
          PR-4: sub-agent cards spawned during this feature run. The runner
          stamps each forwarded event with the parent's featureId (see
          agent/unify/sub-agent/runner.js wrapEvt + agent/unify/engine.js
          parentEngineDeps.getCurrentFeatureId), so chat.js latches it onto
          the card and MessageList groups them under the matching pill.
          Rendered after the inner turns and before the summary so the card
          reads as "this is a helper that ran inside the feature."
        -->
        <SubAgentCard
          v-for="card in subAgentCards"
          :key="card.key"
          :card="card"
        />

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
      // pillTitle falls back to a short featureId slice for visual density
      // (the badge area is narrow). The full id is preserved in
      // pillTooltip below so it stays copy/debug-friendly — the divergence
      // is intentional, not a bug.
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

    const turnCount = Vue.computed(() => {
      // Surface the count of folded items (turns + feature-message rows)
      // inside this pill, NOT the total inner-message count. An
      // assistant-turn item already aggregates many engine messages
      // under one bubble; "turns" is the unit the user actually sees,
      // so the badge speaks in that unit too.
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
      turnCount,
    };
  },
};
