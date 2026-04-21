/**
 * TaskMessageItem — task-334j §A/§C/§E.
 *
 * Renders a single `task-message` stream row: a VP/user-attributed text
 * bubble, carrying a `[task]` pill that visually distinguishes it from
 * regular group messages (which are rendered by MessageItem / AssistantTurn).
 *
 * The row carries a hover ↪ reply button (task-334j §E). Clicking it emits
 * `reply` with { msgId, vpId, textPreview } which the parent wires into
 * the store's `replyToMap` so ChatInput picks up `replyTo` on next send.
 *
 * Respects the "No horizontal dividers" ironclad rule (CLAUDE.md): no
 * `border-top` / `border-bottom` on this row; task vs group visual split
 * is carried by the avatar + pill + subtle background-tint only.
 *
 * Props:
 *   message — normalised stream row:
 *     { id, type: 'task-message', taskId, groupId, vpId, content,
 *       mentions: string[], replyTo: string|null, timestamp: number }
 *
 * Emits:
 *   reply (payload) — { msgId, vpId, textPreview }
 *   open-detail (vpId) — forward from VpBadge click-through
 */
import VpBadge from './VpBadge.js';

export default {
  name: 'TaskMessageItem',
  components: { VpBadge },
  emits: ['reply', 'open-detail'],
  props: {
    message: {
      type: Object,
      required: true,
    },
  },
  template: `
    <div class="task-message-row" :data-msg-id="message.id" :data-task-id="message.taskId">
      <div class="task-message-head">
        <VpBadge
          :vp-id="message.vpId"
          :size="24"
          :show-subtitle="false"
          :clickable="true"
          @open-detail="$emit('open-detail', $event)"
        />
        <span class="task-message-pill" :title="taskPillTitle">
          <span class="task-message-pill-label">{{ $t('unify.task.pill.label') }}</span>
          <span class="task-message-pill-id">{{ shortTaskId }}</span>
        </span>
        <span
          v-if="timestampText"
          class="task-message-time"
          :title="timestampFullText"
          :aria-label="$t('unify.task.messageTime.aria', { time: timestampFullText })"
        >{{ timestampText }}</span>
        <button
          class="task-message-reply-btn"
          :title="$t('unify.task.reply.aria')"
          :aria-label="$t('unify.task.reply.aria')"
          @click.stop="onReplyClick"
        >↪</button>
      </div>

      <div v-if="replyToPreviewText" class="task-message-quote">
        <span class="task-message-quote-arrow">↪</span>
        <span class="task-message-quote-body">{{ replyToPreviewText }}</span>
      </div>

      <div class="task-message-body">{{ message.content }}</div>

      <div v-if="mentionList.length > 0" class="task-message-mentions">
        <span
          v-for="vpId in mentionList"
          :key="vpId"
          class="task-message-mention-chip"
        >@{{ vpId }}</span>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const store = Pinia.useChatStore();

    const shortTaskId = Vue.computed(() => {
      const id = props.message.taskId || '';
      return id.length > 8 ? id.slice(0, 8) : id;
    });

    const taskPillTitle = Vue.computed(() => props.message.taskId || '');

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

    // When replyTo is set, look up the original msg in the taskMessagesMap
    // and render a short preview. Missing lookup → "(original removed)".
    const replyToPreviewText = Vue.computed(() => {
      const replyTo = props.message.replyTo;
      if (!replyTo) return '';
      const list = store.taskMessagesMap[props.message.taskId] || [];
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
      shortTaskId,
      taskPillTitle,
      timestampText,
      timestampFullText,
      mentionList,
      replyToPreviewText,
      onReplyClick,
    };
  },
};
