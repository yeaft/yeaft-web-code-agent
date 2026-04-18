/**
 * UnifyTaskDetailView — task-315
 *
 * Replaces the main chat pane when a task is selected from the sidebar.
 * Shows every message whose owning thread carries the active taskId,
 * sorted by creation time ascending, with a per-message source-thread
 * pill so the user can see which thread originated each message.
 *
 * View state machine (owned by the Unify store):
 *   main                ──click sidebar task──▶ task-detail
 *   task-detail         ──Esc / breadcrumb────▶ main
 *   task-detail         ──click another task──▶ task-detail (switched)
 *
 * Top-of-pane breadcrumb is `← {mainStream} | Task #{id} / {title}`,
 * click-through returns to the main stream. A thread-selector above
 * the input lets the user pick which thread their reply routes to
 * (defaults to the task's most-recently-active thread). When the task
 * has no live thread attached, the component surfaces a fork hint
 * instead of enabling the Send button — the PM-mandated "无则提示 fork"
 * branch.
 *
 * This component renders its own lightweight message list (no reuse of
 * MessageList.js) so the per-message thread pill + cross-thread sort
 * are trivial to express. Rendering fidelity for rich content (tool
 * calls / images) is intentionally simplified to `text` only — the full
 * fidelity view is accessible by clicking the pill, which switches to
 * that thread's detail via the existing task-303 dual view.
 */
export default {
  name: 'UnifyTaskDetailView',
  emits: ['back', 'switch-to-thread'],
  template: `
    <div class="unify-task-detail" role="region" :aria-label="ariaLabel">
      <!-- Breadcrumb: ← 主流 | Task #id / title -->
      <div class="unify-task-detail-breadcrumb" role="navigation">
        <button
          type="button"
          class="unify-breadcrumb-back"
          @click="$emit('back')"
          :title="backHint"
        >
          <span class="unify-breadcrumb-arrow" aria-hidden="true">&larr;</span>
          <span class="unify-breadcrumb-back-label">{{ mainStreamLabel }}</span>
        </button>
        <span class="unify-breadcrumb-sep" aria-hidden="true">|</span>
        <span class="unify-task-detail-crumb">
          <span class="unify-task-detail-crumb-id">Task #{{ displayTaskId }}</span>
          <span class="unify-task-detail-crumb-slash" aria-hidden="true">/</span>
          <span class="unify-task-detail-crumb-title">{{ displayTitle }}</span>
        </span>
        <span class="unify-task-detail-crumb-status" v-if="status">{{ status }}</span>
      </div>

      <!-- Aggregated messages with source thread pills -->
      <div class="unify-task-detail-messages" ref="messagesEl">
        <div v-if="!messages.length" class="unify-task-detail-empty">
          <span>{{ emptyLabel }}</span>
        </div>
        <div
          v-else
          v-for="m in messages"
          :key="messageKey(m)"
          class="unify-task-detail-msg"
          :class="'unify-task-detail-msg-' + (m.type || 'assistant')"
        >
          <div class="unify-task-detail-msg-head">
            <span class="unify-task-detail-msg-role">{{ roleLabel(m) }}</span>
            <button
              type="button"
              class="unify-task-detail-thread-pill"
              :title="threadPillHint(m)"
              @click="$emit('switch-to-thread', m._sourceThreadId)"
            >
              #{{ m._sourceThreadName }}
            </button>
            <span class="unify-task-detail-msg-time" v-if="m.createdAt">{{ formatTime(m.createdAt) }}</span>
          </div>
          <div class="unify-task-detail-msg-body">{{ messageText(m) }}</div>
        </div>
      </div>

      <!-- Thread selector + fork hint -->
      <div class="unify-task-detail-reply">
        <span class="unify-task-detail-reply-label">{{ replyLabel }}</span>
        <select
          v-if="replyThreadOptions.length"
          class="unify-task-detail-thread-select"
          :value="selectedReplyThreadId || ''"
          @change="onChangeReplyThread($event.target.value)"
        >
          <option
            v-for="opt in replyThreadOptions"
            :key="opt.id"
            :value="opt.id"
          >#{{ opt.name }}</option>
        </select>
        <span v-else class="unify-task-detail-fork-hint">{{ forkHintLabel }}</span>
      </div>
    </div>
  `,
  setup(_, { emit }) {
    const store = Pinia.useChatStore();
    const messagesEl = Vue.ref(null);

    const messages = Vue.computed(() => store.unifyTaskDetailMessages || []);
    const replyThreadOptions = Vue.computed(() => store.unifyTaskDetailThreads || []);
    const selectedReplyThreadId = Vue.computed(() => store.unifyTaskReplyThreadId);

    const meta = Vue.computed(() => store.unifyActiveTaskMeta);
    const displayTaskId = Vue.computed(() => meta.value?.id || '');
    const displayTitle = Vue.computed(() => meta.value?.title || displayTaskId.value);
    const status = Vue.computed(() => meta.value?.status || '');

    const i18n = (key, fallback) => {
      try {
        const inst = Vue.getCurrentInstance();
        const t = inst?.appContext?.config?.globalProperties?.$t;
        if (typeof t === 'function') {
          const v = t(key);
          if (v && v !== key) return v;
        }
      } catch (_) { /* fallthrough */ }
      return fallback;
    };

    const backHint = Vue.computed(() => i18n('unify.breadcrumb.backHint', 'Return to full stream (Esc)'));
    const mainStreamLabel = Vue.computed(() => i18n('unify.breadcrumb.mainStream', 'Main stream'));
    const replyLabel = Vue.computed(() => i18n('unify.taskDetail.replyTo', 'Reply in:'));
    const forkHintLabel = Vue.computed(() => i18n('unify.taskDetail.forkHint', 'No active thread — fork a new one to reply.'));
    const emptyLabel = Vue.computed(() => i18n('unify.taskDetail.empty', 'No messages for this task yet.'));
    const ariaLabel = Vue.computed(() => `${i18n('unify.taskDetail.ariaLabel', 'Task detail')} ${displayTaskId.value}`);

    const onChangeReplyThread = (id) => {
      store.setUnifyTaskReplyThreadId(id);
    };

    // Auto-scroll to the bottom when new messages arrive.
    Vue.watch(() => messages.value.length, () => {
      Vue.nextTick(() => {
        const el = messagesEl.value;
        if (el && typeof el.scrollTo === 'function') {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        } else if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });

    const roleLabel = (m) => {
      if (!m) return '';
      if (m.type === 'user') return 'You';
      if (m.type === 'system') return 'System';
      return 'Assistant';
    };

    const messageText = (m) => {
      if (!m) return '';
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b && b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      return '';
    };

    const messageKey = (m) => {
      if (m && m.id) return m.id;
      return `${m?._sourceThreadId}:${m?.createdAt || 0}:${Math.random()}`;
    };

    const threadPillHint = (m) => {
      return `${i18n('unify.taskDetail.threadPillHint', 'Open thread')} #${m._sourceThreadName}`;
    };

    const formatTime = (ts) => {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    };

    return {
      messages,
      messagesEl,
      replyThreadOptions,
      selectedReplyThreadId,
      displayTaskId,
      displayTitle,
      status,
      backHint,
      mainStreamLabel,
      replyLabel,
      forkHintLabel,
      emptyLabel,
      ariaLabel,
      onChangeReplyThread,
      roleLabel,
      messageText,
      messageKey,
      threadPillHint,
      formatTime,
    };
  },
};
