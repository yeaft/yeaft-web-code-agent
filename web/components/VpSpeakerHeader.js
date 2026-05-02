/**
 * VpSpeakerHeader — speaker attribution strip above a VP assistant bubble.
 * task-334-ui-b §A.
 *
 * This is a consumer component for 334-ui-a VP primitives; it does NOT
 * introduce new avatar / badge visuals. It arranges:
 *   [VpBadge (avatar 24px + displayName + role subtitle)]  [state-cause dot]  [time]
 *
 * Wired into AssistantTurn when the enclosing turn carries a `speakerVpId`
 * field. The collapse-on-consecutive rule (same speaker → hide header) is
 * computed upstream in MessageList and passed in via `turn.showSpeakerHeader`.
 *
 * O2 consumption (334c follow-up): when the agent surfaces
 * `lastStateChangeCause` on the assistant message, we render a small dot
 * with the reason as a native `title` tooltip. Until 334h wires that field,
 * the component safely renders nothing extra.
 *
 * Props:
 *   vpId       — required; lookup key into vp store (used by VpBadge).
 *   timestamp  — optional epoch ms; renders short HH:MM when present.
 *   stateCause — optional short string ("reason" payload for tooltip).
 */
import VpBadge from './VpBadge.js';
import { useChatStore } from '../stores/chat.js';
import { getVpTyping } from '../stores/helpers/vp-typing.js';

export default {
  name: 'VpSpeakerHeader',
  components: { VpBadge },
  emits: ['open-detail', 'stop-turn'],
  props: {
    vpId: { type: String, required: true },
    timestamp: { type: Number, default: 0 },
    stateCause: { type: String, default: '' },
    turnId: { type: String, default: '' },
    showStop: { type: Boolean, default: false },
  },
  template: `
    <div class="vp-speaker-header" :data-vp-id="vpId">
      <VpBadge
        :vp-id="vpId"
        :size="24"
        :show-subtitle="true"
        :clickable="true"
        @open-detail="$emit('open-detail', $event)"
      />
      <span
        v-if="isTyping"
        class="vp-speaker-typing"
        :aria-label="$t ? $t('unify.vp.speaker.typingAria', { name: vpId }) : 'typing'"
        role="status"
      ><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
      <span
        v-if="stateCause"
        class="vp-speaker-state-cause"
        :title="stateCause"
        :aria-label="$t('unify.vp.speaker.stateCauseAria', { cause: stateCause })"
        role="img"
      >●</span>
      <span
        v-if="timestampText"
        class="vp-speaker-time"
        :title="timestampFullText"
      >{{ timestampText }}</span>
      <button
        v-if="showStop"
        class="vp-speaker-stop-btn"
        @click.stop="$emit('stop-turn', turnId)"
        :title="$t ? $t('unify.vp.speaker.stop') : 'Stop'"
      ><svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>
    </div>
  `,
  setup(props) {
    const chat = useChatStore();
    const isTyping = Vue.computed(() => {
      // unifyVpTyping is keyed by conversationId so cross-mode state
      // doesn't leak (Chat view never sees Unify typing). Look up the
      // current conversation's slice — when in Chat, this yields 0 and
      // isTyping is false.
      return getVpTyping(chat.unifyVpTyping, chat.currentConversation, props.vpId) > 0;
    });
    const timestampText = Vue.computed(() => {
      if (!props.timestamp) return '';
      try {
        return new Date(props.timestamp).toLocaleTimeString(undefined, {
          hour: '2-digit', minute: '2-digit',
        });
      } catch { return ''; }
    });
    const timestampFullText = Vue.computed(() => {
      if (!props.timestamp) return '';
      try { return new Date(props.timestamp).toLocaleString(); } catch { return ''; }
    });
    return { isTyping, timestampText, timestampFullText };
  },
};
