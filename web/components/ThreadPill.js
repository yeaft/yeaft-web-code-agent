/**
 * ThreadPill — tiny grey `#thread-name` pill rendered on Unify assistant
 * messages whose threadId !== 'main'.
 *
 * task-302 / design-unify-multi-thread.md §4, §7:
 *   When the user is in the all-stream view and an assistant reply comes
 *   from a non-main thread, show a subtle visual marker so the user can
 *   see where the reply belongs — without any border, colored bar, or
 *   divider (per Unify UI rules in CLAUDE.md / task-264).
 *
 * Props:
 *   threadId   — the message's thread id (null/undefined/'main' → skip)
 *   threadName — optional display name; falls back to threadId
 *
 * Rendering contract:
 *   - Not rendered at all when threadId is falsy or equals 'main'
 *   - Only a single inline <span class="unify-thread-pill"> element
 *   - No border-* / no ::before colored bar / no divider
 */
export default {
  name: 'ThreadPill',
  props: {
    threadId: {
      type: String,
      default: null,
    },
    threadName: {
      type: String,
      default: null,
    },
  },
  template: `
    <span
      v-if="shouldRender"
      class="unify-thread-pill"
      :title="'thread: ' + displayName"
    >#{{ displayName }}</span>
  `,
  setup(props) {
    const shouldRender = Vue.computed(() => {
      if (!props.threadId) return false;
      if (props.threadId === 'main') return false;
      return true;
    });

    const displayName = Vue.computed(() => {
      return props.threadName || props.threadId || '';
    });

    return { shouldRender, displayName };
  },
};
