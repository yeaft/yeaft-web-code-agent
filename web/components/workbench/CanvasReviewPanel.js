import {
  reviewLensesForCategory,
  computeInlineDiff,
} from '../../utils/creation-categories.js';
import { useCreationsStore } from '../../stores/creations.js';
import { useChatStore } from '../../stores/chat.js';
import { getLocale } from '../../utils/i18n.js';

function useSafeCreationsStore() {
  try {
    return useCreationsStore();
  } catch {
    return null;
  }
}

function useSafeChatStore() {
  try {
    return useChatStore();
  } catch {
    return null;
  }
}

function isAgentAiCapable(chatStore, agentId) {
  if (!agentId) return false;
  if (!chatStore) return true;
  const agents = Array.isArray(chatStore.agents) ? chatStore.agents : [];
  const agent = agents.find(candidate => candidate?.id === agentId)
    || (chatStore.currentAgentInfo?.id === agentId ? chatStore.currentAgentInfo : null);
  if (!agent) return true;
  if (agent.online === false || agent.status === 'offline') return false;
  const caps = agent.capabilities;
  if (Array.isArray(caps) && caps.length > 0) {
    return caps.includes('creation_workbench_files')
      || caps.includes('creations')
      || caps.includes('creation_ai');
  }
  return true;
}

export default {
  name: 'CanvasReviewPanel',
  props: {
    visible: { type: Boolean, default: false },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    filePath: { type: String, default: '' },
    fileName: { type: String, default: '' },
    content: { type: String, default: '' },
    category: { type: String, default: 'book' },
    docStatus: { type: String, default: 'draft' },
    routeKey: { type: String, default: '' },
    quickReviewRequest: { type: Object, default: null },
  },
  emits: ['close', 'apply-annotation', 'jump-to-line', 'send-to-session', 'update:doc-status'],
  template: `
    <aside
      v-if="visible"
      class="canvas-review-panel"
      role="complementary"
      :aria-label="tr('creation.review.panelTitle', 'Review Team')"
    >
      <!-- Header -->
      <div class="canvas-review-header">
        <div class="canvas-review-header-title">
          <span>{{ tr('creation.review.panelTitle', 'Review Team') }}</span>
          <span class="canvas-badge">
            {{ reviewScope === 'selection'
              ? tr('creation.review.scopeSelection', 'Selection')
              : tr('creation.review.scopeDocument', 'Document') }}
          </span>
        </div>
        <div class="canvas-review-header-actions">
          <button
            v-if="currentReview && !isRunning"
            type="button"
            class="canvas-tool-btn"
            @click="showConfigurator = !showConfigurator"
          >{{ tr('creation.review.reRun', 'Re-run') }}</button>
          <button
            type="button"
            class="canvas-tool-btn canvas-tool-icon"
            :title="tr('common.close', 'Close')"
            :aria-label="tr('common.close', 'Close')"
            @click="$emit('close')"
          >×</button>
        </div>
      </div>

      <!-- Lens Configurator -->
      <div v-if="showConfigurator && !isRunning" class="canvas-review-lenses">
        <div class="canvas-review-section-label">{{ tr('creation.review.selectLenses', 'Review lenses') }}</div>
        <div class="canvas-review-lens-grid">
          <button
            v-for="lens in lenses"
            :key="lens.id"
            type="button"
            class="canvas-review-lens-chip"
            :class="{ active: selectedLensIds.includes(lens.id) }"
            :aria-pressed="selectedLensIds.includes(lens.id)"
            :title="tr(lens.descKey, '')"
            @click="toggleLens(lens.id)"
          >{{ tr(lens.labelKey, lens.id) }}</button>
        </div>

        <input
          v-model="customPrompt"
          type="text"
          class="canvas-review-custom-input"
          :disabled="!aiAvailable"
          :placeholder="tr('creation.review.customPromptPlaceholder', 'Optional custom reviewer perspective...')"
          @keydown.enter.prevent="startReview()"
        />

        <div v-if="!aiAvailable" class="canvas-inline-status">
          <span>{{ tr('creation.review.unavailable', 'AI review is unavailable for this agent.') }}</span>
        </div>

        <button
          type="button"
          class="btn-primary"
          :disabled="!canStartReview"
          @click="startReview()"
        >{{ tr('creation.review.start', 'Start Review') }}</button>
      </div>

      <!-- Running progress strip -->
      <div v-if="isRunning" class="canvas-review-lenses">
        <div class="canvas-inline-status" role="status" aria-live="polite">
          <span class="spinner-mini" aria-hidden="true"></span>
          <span>{{ tr('creation.review.running', 'Reviewing...') }}</span>
          <button
            type="button"
            class="btn-ghost"
            @click="cancelReview"
          >{{ tr('creation.review.cancel', 'Cancel') }}</button>
        </div>

        <div v-if="progressLenses.length > 0" class="canvas-review-progress-chips">
          <span
            v-for="item in progressLenses"
            :key="item.id"
            class="canvas-review-lens-chip"
            :class="{
              active: item.status === 'done' || item.status === 'completed',
              'is-failed': item.status === 'failed'
            }"
          >
            {{ item.label }}
            <span v-if="item.status === 'done' || item.status === 'completed'">✓</span>
            <span v-else-if="item.status === 'failed'">!</span>
            <span v-else>…</span>
          </span>
        </div>
      </div>

      <!-- Error banner -->
      <div v-if="errorMessage" class="canvas-inline-status" role="alert">
        <span>{{ errorMessage }}</span>
      </div>

      <!-- Partial failure warning -->
      <div v-if="currentReview && currentReview.status === 'partial'" class="canvas-inline-status" role="status">
        <span>{{ tr('creation.review.partialWarning', 'Some reviewers failed; showing completed feedback.') }}</span>
      </div>

      <!-- Overall summary -->
      <div v-if="currentReview && currentReview.overallSummary && !isRunning" class="canvas-review-summary">
        <div class="canvas-review-section-label">{{ tr('creation.review.summaryTitle', 'Summary') }}</div>
        <p>{{ currentReview.overallSummary }}</p>
      </div>

      <!-- Filter tabs -->
      <div v-if="annotations.length > 0" class="canvas-review-filters">
        <button
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: severityFilter === 'all' }"
          @click="severityFilter = 'all'"
        >{{ tr('creation.review.filterAll', 'All') }} ({{ annotations.length }})</button>
        <button
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: severityFilter === 'blocker' }"
          @click="severityFilter = 'blocker'"
        >{{ tr('creation.review.severityBlocker', 'Blocker') }} ({{ severityCounts.blocker }})</button>
        <button
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: severityFilter === 'suggestion' }"
          @click="severityFilter = 'suggestion'"
        >{{ tr('creation.review.severitySuggestion', 'Suggestion') }} ({{ severityCounts.suggestion }})</button>
        <button
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: severityFilter === 'praise' }"
          @click="severityFilter = 'praise'"
        >{{ tr('creation.review.severityPraise', 'Praise') }} ({{ severityCounts.praise }})</button>
      </div>

      <div v-if="ranLensIds.length > 1" class="canvas-review-filters">
        <button
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: lensFilter === 'all' }"
          @click="lensFilter = 'all'"
        >{{ tr('creation.review.filterAll', 'All') }}</button>
        <button
          v-for="lid in ranLensIds"
          :key="lid"
          type="button"
          class="canvas-review-lens-chip"
          :class="{ active: lensFilter === lid }"
          @click="lensFilter = lid"
        >{{ lensDisplayName(lid) }}</button>
      </div>

      <!-- Annotation Cards -->
      <div class="canvas-review-list">
        <div
          v-if="!isRunning && !currentReview"
          class="canvas-inline-status"
        >{{ tr('creation.review.emptyHint', 'Select lenses above to start reviewing this document.') }}</div>

        <div
          v-else-if="!isRunning && currentReview && annotations.length === 0 && !errorMessage"
          class="canvas-inline-status"
        >{{ tr('creation.review.noIssues', 'No issues found.') }}</div>

        <article
          v-for="ann in filteredAnnotations"
          :key="ann.id"
          class="canvas-review-card"
          :class="'is-' + (ann.status || 'open')"
        >
          <div class="canvas-review-card-head">
            <input
              v-if="(ann.status || 'open') === 'open'"
              type="checkbox"
              :checked="checkedIds.includes(ann.id)"
              :aria-label="ann.title || ann.id"
              @change="toggleCheck(ann.id)"
            />
            <span class="canvas-badge">{{ lensDisplayName(ann.lensId) }}</span>
            <span
              class="canvas-review-severity"
              :class="'is-' + (ann.severity || 'suggestion')"
            >{{ severityLabel(ann.severity) }}</span>
            <strong class="canvas-review-card-title">{{ ann.title }}</strong>
            <button
              v-if="ann.lineStart"
              type="button"
              class="canvas-tool-btn canvas-tool-compact"
              @click="$emit('jump-to-line', ann.lineStart)"
            >{{ tr('creation.review.lineRef', 'L{line}', { line: ann.lineStart }) }}</button>
          </div>

          <blockquote v-if="ann.quote" class="canvas-review-quote">{{ ann.quote }}</blockquote>
          <p v-if="ann.comment" class="canvas-review-comment">{{ ann.comment }}</p>

          <div v-if="ann.suggestedReplacement" class="canvas-review-suggestion">
            <template v-for="(hunk, idx) in getSuggestionDiff(ann)" :key="idx">
              <span v-if="hunk.type === 'del'" class="canvas-diff-del">{{ hunk.text }}</span>
              <span v-else-if="hunk.type === 'add'" class="canvas-diff-add">{{ hunk.text }}</span>
              <span v-else>{{ hunk.text }}</span>
            </template>
          </div>

          <div class="canvas-review-card-actions">
            <template v-if="(ann.status || 'open') === 'open'">
              <button
                v-if="ann.suggestedReplacement"
                type="button"
                class="btn-primary"
                @click="acceptAnnotation(ann)"
              >{{ tr('creation.review.acceptFix', 'Accept fix') }}</button>
              <button
                type="button"
                class="btn-ghost"
                @click="dismissAnnotation(ann)"
              >{{ tr('creation.review.dismiss', 'Dismiss') }}</button>
            </template>
            <span v-else-if="ann.status === 'accepted'" class="canvas-badge">
              ✓ {{ tr('creation.review.accepted', 'Accepted') }}
            </span>
            <span v-else-if="ann.status === 'dismissed'" class="canvas-badge">
              {{ tr('creation.review.dismissed', 'Dismissed') }}
            </span>
          </div>
        </article>
      </div>

      <!-- Bulk action footer -->
      <div v-if="checkedOpenAnnotations.length > 0 || canMarkFinal" class="canvas-review-bulk-bar">
        <button
          v-if="checkedOpenAnnotations.length > 0"
          type="button"
          class="btn-primary"
          @click="sendSelectedToSession"
        >✦ {{ tr('creation.review.sendToSession', 'Send to session ({count})', { count: checkedOpenAnnotations.length }) }}</button>

        <button
          v-if="canMarkFinal"
          type="button"
          class="btn-secondary"
          @click="$emit('update:doc-status', 'final')"
        >✓ {{ tr('creation.docStatus.markFinal', 'Mark as Final') }}</button>
      </div>
    </aside>
  `,
  setup(props, { emit }) {
    const t = Vue.inject('t', key => key);
    const tr = (key, fallback, params) => {
      const translated = typeof t === 'function' ? t(key, params) : key;
      if (translated && translated !== key) return translated;
      let text = fallback ?? key;
      if (params && typeof text === 'string') {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    };

    const creationsStore = useSafeCreationsStore();
    const chatStore = useSafeChatStore();

    const lenses = Vue.computed(() => {
      const list = typeof reviewLensesForCategory === 'function'
        ? reviewLensesForCategory(props.category)
        : [];
      return Array.isArray(list) ? list : [];
    });

    const selectedLensIds = Vue.ref([]);
    const customPrompt = Vue.ref('');
    const showConfigurator = Vue.ref(true);
    const activeJobId = Vue.ref('');
    const localError = Vue.ref('');
    const severityFilter = Vue.ref('all');
    const lensFilter = Vue.ref('all');
    const checkedIds = Vue.ref([]);
    const localAnnotationStatuses = Vue.reactive({});

    const initDefaultLenses = () => {
      selectedLensIds.value = lenses.value
        .filter(l => l.defaultSelected !== false)
        .map(l => l.id);
    };

    Vue.watch(() => props.category, () => {
      initDefaultLenses();
    }, { immediate: true });

    const aiAvailable = Vue.computed(() => (
      Boolean(props.agentId)
      && typeof creationsStore?.startDocumentReview === 'function'
      && isAgentAiCapable(chatStore, props.agentId)
    ));

    const activeJob = Vue.computed(() => (
      activeJobId.value && creationsStore?.reviewJobs
        ? (creationsStore.reviewJobs[activeJobId.value] || null)
        : null
    ));

    const persistedReview = Vue.computed(() => {
      if (!props.agentId || !props.creationId || !props.filePath) return null;
      if (typeof creationsStore?.getDocReview !== 'function') return null;
      return creationsStore.getDocReview(props.agentId, props.creationId, props.filePath) || null;
    });

    const currentReview = Vue.computed(() => activeJob.value || persistedReview.value || null);
    const isRunning = Vue.computed(() => activeJob.value?.status === 'running');
    const reviewScope = Vue.computed(() => currentReview.value?.scope || 'document');

    const errorMessage = Vue.computed(() => {
      if (localError.value) return localError.value;
      if (activeJob.value?.status === 'failed') {
        return activeJob.value.error || tr('creation.review.failed', 'Review failed');
      }
      return '';
    });

    const annotations = Vue.computed(() => {
      const raw = currentReview.value?.annotations;
      if (!Array.isArray(raw)) return [];
      return raw.map(ann => {
        const override = localAnnotationStatuses[ann.id];
        return override ? { ...ann, status: override } : ann;
      });
    });

    const severityCounts = Vue.computed(() => {
      const counts = { blocker: 0, suggestion: 0, praise: 0 };
      for (const ann of annotations.value) {
        if (ann.severity === 'blocker') counts.blocker += 1;
        else if (ann.severity === 'praise') counts.praise += 1;
        else counts.suggestion += 1;
      }
      return counts;
    });

    const ranLensIds = Vue.computed(() => {
      const seen = new Set();
      for (const ann of annotations.value) {
        if (ann.lensId) seen.add(ann.lensId);
      }
      return Array.from(seen);
    });

    const filteredAnnotations = Vue.computed(() => annotations.value.filter(ann => {
      if (severityFilter.value !== 'all' && (ann.severity || 'suggestion') !== severityFilter.value) {
        return false;
      }
      if (lensFilter.value !== 'all' && ann.lensId !== lensFilter.value) {
        return false;
      }
      return true;
    }));

    const openBlockerCount = Vue.computed(() => (
      annotations.value.filter(ann => ann.severity === 'blocker' && (ann.status || 'open') === 'open').length
    ));

    const checkedOpenAnnotations = Vue.computed(() => (
      annotations.value.filter(ann => (ann.status || 'open') === 'open' && checkedIds.value.includes(ann.id))
    ));

    const canMarkFinal = Vue.computed(() => (
      Boolean(props.creationId)
      && props.docStatus !== 'final'
      && !isRunning.value
      && Boolean(currentReview.value)
      && currentReview.value.status !== 'failed'
      && currentReview.value.status !== 'cancelled'
      && openBlockerCount.value === 0
    ));

    const canStartReview = Vue.computed(() => (
      aiAvailable.value
      && !isRunning.value
      && (selectedLensIds.value.length > 0 || customPrompt.value.trim().length > 0)
    ));

    const lensDisplayName = (lensId) => {
      if (!lensId) return '';
      if (lensId === 'custom') return tr('creation.review.customLens', 'Custom');
      const found = lenses.value.find(l => l.id === lensId);
      if (found) return tr(found.labelKey, found.id);
      return tr(`creation.review.lens.${lensId}`, lensId);
    };

    const progressLenses = Vue.computed(() => {
      const job = activeJob.value;
      if (!job) return [];
      const list = Array.isArray(job.lenses) ? job.lenses : [];
      const rawResults = job.lensResults;
      const resultsById = {};
      if (Array.isArray(rawResults)) {
        for (const item of rawResults) {
          if (item?.lensId) resultsById[item.lensId] = item;
        }
      } else if (rawResults && typeof rawResults === 'object') {
        Object.assign(resultsById, rawResults);
      }
      return list.map(entry => {
        const id = typeof entry === 'string' ? entry : entry.id;
        const result = resultsById[id];
        const status = result?.status || (typeof entry === 'object' ? entry.status : '') || 'pending';
        return {
          id,
          label: (typeof entry === 'object' && entry.label) || lensDisplayName(id),
          status,
        };
      });
    });

    const severityLabel = (sev) => {
      if (sev === 'blocker') return tr('creation.review.severityBlocker', 'Blocker');
      if (sev === 'praise') return tr('creation.review.severityPraise', 'Praise');
      return tr('creation.review.severitySuggestion', 'Suggestion');
    };

    const getSuggestionDiff = (ann) => {
      if (!ann?.suggestedReplacement) return [];
      if (typeof computeInlineDiff === 'function') {
        return computeInlineDiff(ann.quote || '', ann.suggestedReplacement || '');
      }
      return [{ type: 'add', text: ann.suggestedReplacement }];
    };

    const toggleLens = (lensId) => {
      if (selectedLensIds.value.includes(lensId)) {
        selectedLensIds.value = selectedLensIds.value.filter(id => id !== lensId);
      } else {
        selectedLensIds.value = [...selectedLensIds.value, lensId];
      }
    };

    const cancelReview = async () => {
      const id = activeJobId.value;
      if (id && props.agentId && typeof creationsStore?.cancelAiJob === 'function') {
        try {
          await creationsStore.cancelAiJob(props.agentId, id);
        } catch {
          // ignore cancel errors
        }
      }
      if (id && typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(id);
      }
      activeJobId.value = '';
      showConfigurator.value = !persistedReview.value;
    };

    const startReview = async (overrides = {}) => {
      if (!aiAvailable.value) {
        localError.value = tr('creation.review.unavailable', 'AI review is unavailable.');
        return;
      }
      const scope = overrides.scope || 'document';
      const lensIds = Array.isArray(overrides.lensIds) ? overrides.lensIds : [...selectedLensIds.value];
      const promptText = scope === 'selection' ? '' : customPrompt.value.trim();
      if (lensIds.length === 0 && !promptText) return;

      localError.value = '';
      checkedIds.value = [];
      severityFilter.value = 'all';
      lensFilter.value = 'all';
      for (const key of Object.keys(localAnnotationStatuses)) {
        delete localAnnotationStatuses[key];
      }

      if (activeJobId.value && typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(activeJobId.value);
        activeJobId.value = '';
      }

      try {
        const res = await creationsStore.startDocumentReview(props.agentId, {
          ...(props.creationId ? { creationId: props.creationId } : {}),
          category: props.category || 'book',
          ...(props.filePath ? { filePath: props.filePath } : {}),
          ...(props.fileName ? { fileName: props.fileName } : {}),
          content: props.content || '',
          scope,
          ...(overrides.selectedText ? { selectedText: overrides.selectedText } : {}),
          ...(overrides.lineStart > 0 ? { lineStart: overrides.lineStart } : {}),
          ...(overrides.lineEnd > 0 ? { lineEnd: overrides.lineEnd } : {}),
          lensIds,
          customPrompt: promptText || undefined,
          locale: getLocale(),
        });
        if (res?.jobId) {
          activeJobId.value = res.jobId;
          showConfigurator.value = false;
        } else {
          localError.value = res?.error || tr('creation.review.failed', 'Review failed');
        }
      } catch (err) {
        localError.value = err?.message || tr('creation.review.failed', 'Review failed');
      }
    };

    const resolveAnnotation = async (ann, status) => {
      if (!ann?.id) return;
      localAnnotationStatuses[ann.id] = status;
      checkedIds.value = checkedIds.value.filter(id => id !== ann.id);
      if (props.agentId && props.creationId && props.filePath
        && typeof creationsStore?.resolveReviewAnnotation === 'function') {
        try {
          await creationsStore.resolveReviewAnnotation(
            props.agentId,
            props.creationId,
            props.filePath,
            ann.id,
            status,
          );
        } catch {
          // keep local status even if persistence fails
        }
      }
    };

    const acceptAnnotation = async (ann) => {
      emit('apply-annotation', ann);
      await resolveAnnotation(ann, 'accepted');
    };

    const dismissAnnotation = async (ann) => {
      await resolveAnnotation(ann, 'dismissed');
    };

    const toggleCheck = (annId) => {
      if (checkedIds.value.includes(annId)) {
        checkedIds.value = checkedIds.value.filter(id => id !== annId);
      } else {
        checkedIds.value = [...checkedIds.value, annId];
      }
    };

    const sendSelectedToSession = () => {
      const list = checkedOpenAnnotations.value;
      if (list.length === 0) return;
      emit('send-to-session', list);
      checkedIds.value = [];
    };

    const loadPersisted = async () => {
      if (!props.visible || !props.agentId || !props.creationId || !props.filePath) return;
      if (typeof creationsStore?.loadDocReview !== 'function') return;
      try {
        const res = await creationsStore.loadDocReview(props.agentId, props.creationId, props.filePath);
        if (res?.review && !activeJobId.value) {
          showConfigurator.value = false;
        }
      } catch {
        // non-fatal
      }
    };

    Vue.watch(
      () => [props.visible, props.agentId, props.creationId, props.filePath],
      () => { loadPersisted(); },
      { immediate: true },
    );

    Vue.watch(() => props.filePath, () => {
      if (isRunning.value) {
        cancelReview();
      } else if (activeJobId.value && typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(activeJobId.value);
        activeJobId.value = '';
      }
      localError.value = '';
      checkedIds.value = [];
      severityFilter.value = 'all';
      lensFilter.value = 'all';
      for (const key of Object.keys(localAnnotationStatuses)) {
        delete localAnnotationStatuses[key];
      }
      showConfigurator.value = !persistedReview.value;
    });

    Vue.watch(() => props.quickReviewRequest?.nonce, (nonce) => {
      if (!nonce || !props.quickReviewRequest?.selectedText) return;
      const req = props.quickReviewRequest;
      const lensIds = req.lensId ? [req.lensId] : [...selectedLensIds.value];
      startReview({
        scope: 'selection',
        lensIds,
        selectedText: req.selectedText,
        lineStart: req.lineStart,
        lineEnd: req.lineEnd,
      });
    });

    Vue.watch(() => activeJob.value?.status, (status) => {
      if (status === 'completed' || status === 'partial') {
        showConfigurator.value = false;
      }
    });

    Vue.onBeforeUnmount(() => {
      if (isRunning.value) {
        cancelReview();
      }
    });

    return {
      tr,
      lenses,
      selectedLensIds,
      customPrompt,
      showConfigurator,
      aiAvailable,
      currentReview,
      isRunning,
      reviewScope,
      errorMessage,
      annotations,
      severityCounts,
      ranLensIds,
      filteredAnnotations,
      checkedIds,
      checkedOpenAnnotations,
      canMarkFinal,
      canStartReview,
      progressLenses,
      severityFilter,
      lensFilter,
      lensDisplayName,
      severityLabel,
      getSuggestionDiff,
      toggleLens,
      startReview,
      cancelReview,
      acceptAnnotation,
      dismissAnnotation,
      toggleCheck,
      sendSelectedToSession,
    };
  },
};
