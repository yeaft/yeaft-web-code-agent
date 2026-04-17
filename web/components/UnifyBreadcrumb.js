// UnifyBreadcrumb — top breadcrumb shown when an active thread filter is applied.
// Renders "← 主流 | #thread-name" and emits `@back` when the back link is clicked.
//
// Props:
//   threadId   (string, required) — the currently filtered thread id
//   threadName (string, optional) — human-readable thread label, falls back to threadId
//
// Emits:
//   back — user asked to return to the full stream (no filter)
export default {
  name: 'UnifyBreadcrumb',
  props: {
    threadId: { type: String, required: true },
    threadName: { type: String, default: '' },
  },
  emits: ['back'],
  template: `
    <div class="unify-breadcrumb" role="navigation" :aria-label="$t ? $t('unify.breadcrumb.label') : 'thread filter'">
      <button
        type="button"
        class="unify-breadcrumb-back"
        @click="$emit('back')"
        :title="$t ? $t('unify.breadcrumb.backHint') : 'Return to full stream (Esc)'"
      >
        <span class="unify-breadcrumb-arrow" aria-hidden="true">&larr;</span>
        <span class="unify-breadcrumb-back-label">{{ $t ? $t('unify.breadcrumb.mainStream') : '主流' }}</span>
      </button>
      <span class="unify-breadcrumb-sep" aria-hidden="true">|</span>
      <span class="unify-breadcrumb-thread">
        <span class="unify-breadcrumb-hash">#</span>{{ displayName }}
      </span>
    </div>
  `,
  computed: {
    displayName() {
      return this.threadName || this.threadId;
    },
  },
};
