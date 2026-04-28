/**
 * UnifyFeatureDetailView — task-315
 *
 * Replaces the main chat pane when a task is selected from the sidebar.
 * Shows every message whose owning thread carries the active featureId,
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
  name: 'UnifyFeatureDetailView',
  emits: ['back', 'switch-to-thread', 'switch-to-task'],
  template: `
    <div class="unify-feature-detail" role="region" :aria-label="ariaLabel">
      <!-- Breadcrumb: ← 主流 | Task #id / title -->
      <div class="unify-feature-detail-breadcrumb" role="navigation">
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
        <span class="unify-feature-detail-crumb">
          <span class="unify-feature-detail-crumb-id">Task #{{ displayTaskId }}</span>
          <span class="unify-feature-detail-crumb-slash" aria-hidden="true">/</span>
          <span class="unify-feature-detail-crumb-title">{{ displayTitle }}</span>
        </span>
        <span class="unify-feature-detail-crumb-status" v-if="status">{{ status }}</span>
      </div>

      <!-- Aggregated messages with source thread pills -->
      <div class="unify-feature-detail-messages" ref="messagesEl">
        <div v-if="!messages.length" class="unify-feature-detail-empty">
          <span>{{ emptyLabel }}</span>
        </div>
        <div
          v-else
          v-for="m in messages"
          :key="messageKey(m)"
          class="unify-feature-detail-msg"
          :class="'unify-feature-detail-msg-' + (m.type || 'assistant')"
        >
          <div class="unify-feature-detail-msg-head">
            <span class="unify-feature-detail-msg-role">{{ roleLabel(m) }}</span>
            <button
              type="button"
              class="unify-feature-detail-thread-pill"
              :title="threadPillHint(m)"
              @click="$emit('switch-to-thread', m._sourceThreadId)"
            >
              #{{ m._sourceThreadName }}
            </button>
            <span class="unify-feature-detail-msg-time" v-if="m.createdAt">{{ formatTime(m.createdAt) }}</span>
          </div>
          <div class="unify-feature-detail-msg-body">{{ messageText(m) }}</div>
        </div>
      </div>

      <!-- R6 G1a: Summary timeline (revisions + Show archived). -->
      <section class="unify-feature-detail-summary" :aria-label="$t('unify.featureDetail.summary.aria')">
        <div class="unify-feature-detail-summary-head">
          <h3>{{ $t('unify.featureDetail.summary.title') }}</h3>
          <button
            type="button"
            class="unify-feature-detail-summary-toggle"
            v-if="!archivedShown"
            @click="onShowArchived"
          >{{ $t('unify.featureDetail.summary.showArchived') }}</button>
        </div>
        <p v-if="summaryLoading" class="unify-feature-detail-empty">
          {{ $t('unify.featureDetail.summary.loading') }}
        </p>
        <p v-else-if="summaryError" class="unify-feature-detail-empty">
          {{ $t('unify.featureDetail.summary.error', { error: summaryError }) }}
        </p>
        <p v-else-if="!summaryRevisions.length" class="unify-feature-detail-empty">
          {{ $t('unify.featureDetail.summary.empty') }}
        </p>
        <ol v-else class="unify-feature-detail-summary-list">
          <li
            v-for="s in summaryRevisions"
            :key="s.id"
            class="unify-feature-detail-summary-item"
          >
            <span class="unify-feature-detail-summary-time">{{ formatTime(s.ts) }}</span>
            <span class="unify-feature-detail-summary-from">@{{ s.from }}</span>
            <p class="unify-feature-detail-summary-body">{{ summaryBody(s) }}</p>
          </li>
        </ol>
        <ol v-if="archivedShown && archivedRevisions.length" class="unify-feature-detail-summary-archived">
          <li
            v-for="s in archivedRevisions"
            :key="'arch-' + s.id"
            class="unify-feature-detail-summary-archived-item"
          >
            <span class="unify-feature-detail-summary-time">{{ formatTime(s.ts) }}</span>
            <span class="unify-feature-detail-summary-from">@{{ s.from }}</span>
            <p class="unify-feature-detail-summary-body">{{ summaryBody(s) }}</p>
          </li>
        </ol>
      </section>

      <!-- R6 G1a: relatedFeatureIds folded section (Δ27.3). -->
      <section
        v-if="relatedFeatureIds.length"
        class="unify-feature-detail-related"
        :class="{ collapsed: !relatedOpen }"
        :aria-label="$t('unify.featureDetail.related.aria')"
      >
        <button
          type="button"
          class="unify-feature-detail-related-head"
          @click="relatedOpen = !relatedOpen"
        >
          <span class="unify-feature-detail-related-chevron" :class="{ open: relatedOpen }">▸</span>
          <span>{{ $t('unify.featureDetail.related.title') }} ({{ relatedFeatureIds.length }})</span>
        </button>
        <ul v-show="relatedOpen" class="unify-feature-detail-related-list">
          <li
            v-for="rid in relatedFeatureIds"
            :key="rid"
            class="unify-feature-detail-related-item"
          >
            <button
              type="button"
              class="unify-feature-detail-related-link"
              @click="$emit('switch-to-task', rid)"
            >#{{ rid }}</button>
            <button
              type="button"
              class="unify-feature-detail-related-unlink"
              :title="$t('unify.featureDetail.related.unlink')"
              @click="onUnrelate(rid)"
            >×</button>
          </li>
        </ul>
      </section>

      <!-- R6 G1a: per-VP abort/kick action menu (members of this task). -->
      <section
        v-if="featureMembers.length > 1"
        class="unify-feature-detail-members"
        :aria-label="$t('unify.featureDetail.members.aria')"
      >
        <h3>{{ $t('unify.featureDetail.members.title') }}</h3>
        <ul class="unify-feature-detail-members-list">
          <li
            v-for="vp in featureMembers"
            :key="vp"
            class="unify-feature-detail-member-row"
          >
            <span class="unify-feature-detail-member-id">@{{ vp }}</span>
            <button
              type="button"
              class="unify-feature-detail-member-abort"
              :title="$t('unify.featureDetail.members.abort')"
              @click="onAbortVp(vp)"
            >{{ $t('unify.featureDetail.members.abort') }}</button>
            <button
              type="button"
              class="unify-feature-detail-member-kick"
              :title="$t('unify.featureDetail.members.kick')"
              @click="onKickVp(vp)"
            >{{ $t('unify.featureDetail.members.kick') }}</button>
          </li>
        </ul>
      </section>

      <!-- Thread selector + fork hint -->
      <div class="unify-feature-detail-reply">
        <span class="unify-feature-detail-reply-label">{{ replyLabel }}</span>
        <select
          v-if="replyThreadOptions.length"
          class="unify-feature-detail-thread-select"
          :value="selectedReplyThreadId || ''"
          @change="onChangeReplyThread($event.target.value)"
        >
          <option
            v-for="opt in replyThreadOptions"
            :key="opt.id"
            :value="opt.id"
          >#{{ opt.name }}</option>
        </select>
        <span v-else class="unify-feature-detail-fork-hint">{{ forkHintLabel }}</span>
      </div>
    </div>
  `,
  setup(_, { emit }) {
    const store = Pinia.useChatStore();
    const messagesEl = Vue.ref(null);

    const messages = Vue.computed(() => store.unifyFeatureDetailMessages || []);
    const replyThreadOptions = Vue.computed(() => store.unifyFeatureDetailThreads || []);
    const selectedReplyThreadId = Vue.computed(() => store.unifyFeatureReplyThreadId);

    const meta = Vue.computed(() => store.unifyActiveFeatureMeta);
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
    const replyLabel = Vue.computed(() => i18n('unify.featureDetail.replyTo', 'Reply in:'));
    const forkHintLabel = Vue.computed(() => i18n('unify.featureDetail.forkHint', 'No active thread — fork a new one to reply.'));
    const emptyLabel = Vue.computed(() => i18n('unify.featureDetail.empty', 'No messages for this task yet.'));
    const ariaLabel = Vue.computed(() => `${i18n('unify.featureDetail.ariaLabel', 'Task detail')} ${displayTaskId.value}`);

    const onChangeReplyThread = (id) => {
      store.setUnifyFeatureReplyThreadId(id);
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
      return `${i18n('unify.featureDetail.threadPillHint', 'Open thread')} #${m._sourceThreadName}`;
    };

    const formatTime = (ts) => {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    };

    // ── R6 G1a — summary timeline + relatedFeatureIds + per-VP abort/kick ──
    const tasksStore = (window.Pinia && window.Pinia.useFeaturesStore)
      ? window.Pinia.useFeaturesStore()
      : null;

    const archivedShown = Vue.ref(false);

    const summaryEntry = Vue.computed(() => {
      if (!tasksStore || !displayTaskId.value) return null;
      return tasksStore.summaryFor(displayTaskId.value);
    });
    const summaryRevisions = Vue.computed(() => {
      const e = summaryEntry.value;
      return e && Array.isArray(e.revisions) ? e.revisions : [];
    });
    const archivedRevisions = Vue.computed(() => {
      const e = summaryEntry.value;
      return e && Array.isArray(e.archived) ? e.archived : [];
    });
    const summaryLoading = Vue.computed(() => {
      if (!tasksStore || !displayTaskId.value) return false;
      return tasksStore.isSummaryLoading(displayTaskId.value);
    });
    const summaryError = Vue.computed(() => {
      const e = summaryEntry.value;
      return e ? e.error : null;
    });

    // Auto-fetch summary history when the active task changes.
    Vue.watch(() => displayTaskId.value, (id) => {
      if (id && tasksStore) tasksStore.fetchSummaryHistory(id, false);
    }, { immediate: true });

    function onShowArchived() {
      const id = displayTaskId.value;
      if (!id || !tasksStore) return;
      archivedShown.value = true;
      tasksStore.fetchSummaryHistory(id, true);
    }

    function summaryBody(s) {
      if (!s) return '';
      if (typeof s.text === 'string') return s.text;
      if (s.body) return s.body;
      return '';
    }

    const relatedOpen = Vue.ref(false);
    const relatedFeatureIds = Vue.computed(() => {
      const m = meta.value || {};
      return Array.isArray(m.relatedFeatureIds) ? m.relatedFeatureIds : [];
    });

    const featureMembers = Vue.computed(() => {
      const m = meta.value || {};
      return Array.isArray(m.members) ? m.members : [];
    });

    function onUnrelate(relatedFeatureId) {
      if (!tasksStore || !displayTaskId.value || !relatedFeatureId) return;
      tasksStore.featureCrudRequest('unrelate', {
        featureId: displayTaskId.value,
        relatedFeatureId,
      });
    }
    function onAbortVp(vpId) {
      if (!tasksStore || !displayTaskId.value || !vpId) return;
      tasksStore.featureCrudRequest('abort_vp', { featureId: displayTaskId.value, vpId });
    }
    function onKickVp(vpId) {
      if (!tasksStore || !displayTaskId.value || !vpId) return;
      tasksStore.featureCrudRequest('kick_vp', { featureId: displayTaskId.value, vpId });
    }

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
      // R6 G1a additions
      summaryRevisions,
      archivedRevisions,
      summaryLoading,
      summaryError,
      archivedShown,
      onShowArchived,
      summaryBody,
      relatedFeatureIds,
      relatedOpen,
      featureMembers,
      onUnrelate,
      onAbortVp,
      onKickVp,
    };
  },
};
