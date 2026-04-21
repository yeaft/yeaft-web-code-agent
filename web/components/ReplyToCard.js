/**
 * ReplyToCard — task-334j §E.
 *
 * Compact quote card rendered above the ChatInput textarea when the user
 * clicks the ↪ reply button on a task-message row. Shows a VP attribution
 * + text preview, with an X button to cancel the reply.
 *
 * Props:
 *   vpId        — VP id of the original message author.
 *   textPreview — first ~80 chars of the original message.
 *
 * Emits:
 *   cancel — user clicked the X dismiss button.
 */
export default {
  name: 'ReplyToCard',
  emits: ['cancel'],
  props: {
    vpId: { type: String, default: '' },
    textPreview: { type: String, default: '' },
  },
  template: `
    <div class="reply-to-card">
      <span class="reply-to-arrow">↪</span>
      <span class="reply-to-label">{{ $t('unify.task.reply.to', { vpId: vpId || '?' }) }}</span>
      <span class="reply-to-preview">{{ preview }}</span>
      <button
        class="reply-to-cancel"
        :title="$t('unify.task.reply.cancel')"
        :aria-label="$t('unify.task.reply.cancel')"
        @click.stop="$emit('cancel')"
      >&times;</button>
    </div>
  `,
  setup(props) {
    const preview = Vue.computed(() => {
      if (!props.textPreview) return '';
      return props.textPreview.length > 60
        ? props.textPreview.slice(0, 60) + '...'
        : props.textPreview;
    });
    return { preview };
  },
};
