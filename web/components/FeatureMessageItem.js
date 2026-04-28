/**
 * FeatureMessageItem — task-334j §A/§C/§E (renamed from TaskMessageItem).
 *
 * Renders a single `feature-message` stream row: a VP/user-attributed text
 * bubble, carrying a `[feature]` pill that visually distinguishes it from
 * regular group messages (which are rendered by MessageItem / AssistantTurn).
 *
 * The row carries a hover ↪ reply button. Clicking it emits `reply` with
 * { msgId, vpId, textPreview } which the parent wires into the store's
 * `replyToMap` so ChatInput picks up `replyTo` on next send.
 *
 * Respects the "No horizontal dividers" ironclad rule (CLAUDE.md): no
 * `border-top` / `border-bottom` on this row; feature vs group visual split
 * is carried by the avatar + pill + subtle background-tint only.
 *
 * Props:
 *   message — normalised stream row:
 *     { id, type: 'feature-message', featureId, groupId, vpId, content,
 *       mentions: string[], replyTo: string|null, timestamp: number }
 *
 * Emits:
 *   reply (payload) — { msgId, vpId, textPreview }
 *   open-detail (vpId) — forward from VpBadge click-through
 */
import VpBadge from './VpBadge.js';

export default {
  name: 'FeatureMessageItem',
  components: { VpBadge },
  emits: ['reply', 'open-detail'],
  props: {
    message: {
      type: Object,
      required: true,
    },
  },
  template: `
    <div class="feature-message-row" :data-msg-id="message.id" :data-feature-id="message.featureId">
      <div class="feature-message-head">
        <VpBadge
          :vp-id="message.vpId"
          :size="24"
          :show-subtitle="false"
          :clickable="true"
          @open-detail="$emit('open-detail', $event)"
        />
        <span class="feature-message-pill" :title="featurePillTitle">
          <span class="feature-message-pill-label">{{ $t('unify.feature.pill.label') }}</span>
          <span class="feature-message-pill-id">{{ shortFeatureId }}</span>
        </span>
        <span
          v-if="timestampText"
          class="feature-message-time"
          :title="timestampFullText"
          :aria-label="$t('unify.feature.messageTime.aria', { time: timestampFullText })"
        >{{ timestampText }}</span>
        <button
          class="feature-message-reply-btn"
          :title="$t('unify.feature.reply.aria')"
          :aria-label="$t('unify.feature.reply.aria')"
          @click.stop="onReplyClick"
        >↪</button>
      </div>

      <div v-if="replyToPreviewText" class="feature-message-quote">
        <span class="feature-message-quote-arrow">↪</span>
        <span class="feature-message-quote-body">{{ replyToPreviewText }}</span>
      </div>

      <div class="feature-message-body">{{ message.content }}</div>

      <div v-if="mentionList.length > 0" class="feature-message-mentions">
        <span
          v-for="vpId in mentionList"
          :key="vpId"
          class="feature-message-mention-chip"
        >@{{ vpId }}</span>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();

    const shortFeatureId = Vue.computed(() => {
      const id = props.message.featureId || '';
      return id.length > 8 ? id.slice(0, 8) : id;
    });

    const featurePillTitle = Vue.computed(() => props.message.featureId || '');

    const timestampText = Vue.computed(() => {
      const ts = props.message.timestamp;
      if (!ts || typeof ts !== 'number') return '';
      try {
        return new Date(ts).toLocaleTimeString(undefined, {
          hour: '2-digit', minute: '2-digit',
        });
      } catch { return ''; }
    });

    const timestampFullText = Vue.computed(() => {
      const ts = props.message.timestamp;
      if (!ts || typeof ts !== 'number') return '';
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    });

    const mentionList = Vue.computed(() => {
      const arr = props.message.mentions;
      return Array.isArray(arr) ? arr : [];
    });

    // When replyTo is set, look up the original msg in the featureMessagesMap
    // and render a short preview. Missing lookup → "(original removed)".
    const replyToPreviewText = Vue.computed(() => {
      const replyTo = props.message.replyTo;
      if (!replyTo) return '';
      const list = store.featureMessagesMap[props.message.featureId] || [];
      const orig = list.find(m => m.msgId === replyTo);
      if (!orig) return '';  // Hidden entirely when the original isn't in cache
      const preview = (orig.text || '').slice(0, 80);
      const vp = orig.vpId ? '@' + orig.vpId + ': ' : '';
      return vp + preview;
    });

    const onReplyClick = () => {
      emit('reply', {
        msgId: props.message.id,
        vpId: props.message.vpId,
        textPreview: (props.message.content || '').slice(0, 80),
      });
    };

    return {
      shortFeatureId,
      featurePillTitle,
      timestampText,
      timestampFullText,
      mentionList,
      replyToPreviewText,
      onReplyClick,
    };
  },
};
