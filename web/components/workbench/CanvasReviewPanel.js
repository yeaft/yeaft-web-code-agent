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

function fastContentDigest(text) {
  const src = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${src.length}:${hash.toString(16)}`;
}

export default {
  name: 'CanvasReviewPanel',
  props: {
    visible: { type: Boolean, default: false },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    filePath: { type: String, default: '' },
    persistedDocPath: { type: String, default: '' },
    fileName: { type: String, default: '' },
    content: { type: String, default: '' },
    category: { type: String, default: 'book' },
    docStatus: { type: String, default: 'draft' },
    routeKey: { type: String, default: '' },
    quickReviewRequest: { type: Object, default: null },
    reopenedAnnotation: { type: Object, default: null },
    applyAnnotationFix: { type: Function, default: null },
    stageAnnotationsToSession: { type: Function, default: null },
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
      <header class="canvas-review-header">
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
      </header>

      <!-- Single Scrollable Body -->
      <div class="canvas-review-body">
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

        <!-- Action / Conflict / Partial-add banner -->
        <div v-if="actionError" class="canvas-inline-status" :class="{ 'canvas-review-conflict-banner': actionError.conflict }" role="alert">
          <span>{{ actionError.message }}</span>
          <button
            type="button"
            class="canvas-tool-btn canvas-tool-icon"
            :title="tr('common.close', 'Close')"
            :aria-label="tr('common.close', 'Close')"
            @click="actionError = ''"
          >×</button>
        </div>

        <!-- Truncation warning -->
        <div
          v-if="currentReview && currentReview.truncated === true"
          class="canvas-review-truncated-banner"
          role="status"
        >
          <span>{{ tr('creation.review.truncatedWarning', 'Document was truncated at line {end} for review.', { end: currentReview.reviewedLines?.end || 0 }) }}</span>
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
                  :disabled="actionsLocked || resolvingId === ann.id"
                  :title="actionsLocked ? tr('creation.review.waitComplete', 'Actions unlock once review completes') : undefined"
                  @click="acceptAnnotation(ann)"
                >{{ tr('creation.review.acceptFix', 'Accept fix') }}</button>
                <button
                  type="button"
                  class="btn-ghost"
                  :disabled="actionsLocked || resolvingId === ann.id"
                  :title="actionsLocked ? tr('creation.review.waitComplete', 'Actions unlock once review completes') : undefined"
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
      </div>

      <!-- Bulk action footer -->
      <footer v-if="checkedOpenAnnotations.length > 0 || canMarkFinal" class="canvas-review-bulk-bar">
        <button
          v-if="checkedOpenAnnotations.length > 0"
          type="button"
          class="btn-primary"
          @click="sendSelectedToSession"
        >✦ {{ tr('creation.review.sendToSession', 'Add to session draft (' + checkedOpenAnnotations.length + ')', { count: checkedOpenAnnotations.length }) }}</button>

        <button
          v-if="canMarkFinal"
          type="button"
          class="btn-secondary"
          @click="$emit('update:doc-status', 'final')"
        >✓ {{ tr('creation.docStatus.markFinal', 'Mark as Final') }}</button>
      </footer>
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

    let requestSeq = 0;
    const selectedLensIds = Vue.ref([]);
    const customPrompt = Vue.ref('');
    const showConfigurator = Vue.ref(true);
    const activeJobId = Vue.ref('');
    const activeJobMeta = Vue.ref(null);
    const pendingStart = Vue.ref(false);
    const localError = Vue.ref('');
    const actionError = Vue.ref('');
    const resolvingId = Vue.ref('');
    const severityFilter = Vue.ref('all');
    const lensFilter = Vue.ref('all');
    const checkedIds = Vue.ref([]);
    const localAnnotationStatuses = Vue.reactive({});
    const reviewedContentDigest = Vue.ref('');
    const reviewedBaselineJobId = Vue.ref('');

    const initDefaultLenses = () => {
      selectedLensIds.value = lenses.value
        .filter(l => l.defaultSelected !== false)
        .map(l => l.id);
    };

    Vue.watch(() => props.category, () => {
      initDefaultLenses();
    }, { immediate: true });

    const canPersistDocReview = Vue.computed(() => (
      Boolean(props.agentId && props.creationId && props.persistedDocPath)
    ));

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
      if (!canPersistDocReview.value) return null;
      if (typeof creationsStore?.getDocReview !== 'function') return null;
      return creationsStore.getDocReview(props.agentId, props.creationId, props.persistedDocPath) || null;
    });

    const currentReview = Vue.computed(() => activeJob.value || persistedReview.value || null);
    const isRunning = Vue.computed(() => pendingStart.value || activeJob.value?.status === 'running');
    const reviewScope = Vue.computed(() => (
      activeJob.value?.scope
      || activeJobMeta.value?.scope
      || persistedReview.value?.scope
      || 'document'
    ));

    const isDurableDocumentReview = Vue.computed(() => (
      canPersistDocReview.value
      && reviewScope.value === 'document'
      && Boolean(persistedReview.value)
      && (!activeJob.value || activeJob.value.scope === 'document')
    ));

    const actionsLocked = Vue.computed(() => isRunning.value && reviewScope.value === 'document');

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
      if (isDurableDocumentReview.value) {
        return raw;
      }
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

    const checkedOpenAnnotations = Vue.computed(() => (
      annotations.value.filter(ann => (ann.status || 'open') === 'open' && checkedIds.value.includes(ann.id))
    ));

    const persistedOpenBlockerCount = Vue.computed(() => {
      const list = persistedReview.value?.annotations;
      if (!Array.isArray(list)) return 0;
      return list.filter(ann => ann && ann.severity === 'blocker' && (ann.status || 'open') === 'open').length;
    });

    const currentContentDigest = Vue.computed(() => fastContentDigest(props.content || ''));
    const documentMatchesReviewedContent = Vue.computed(() => (
      Boolean(reviewedContentDigest.value) && currentContentDigest.value === reviewedContentDigest.value
    ));

    const canMarkFinal = Vue.computed(() => {
      if (!canPersistDocReview.value) return false;
      if (props.docStatus === 'final') return false;
      if (isRunning.value) return false;
      const persisted = persistedReview.value;
      if (!persisted) return false;
      if (persisted.status !== 'completed' && persisted.status !== 'partial') return false;
      if (persistedOpenBlockerCount.value > 0) return false;
      if (!documentMatchesReviewedContent.value) return false;
      return true;
    });

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

    const cancelAndClearCaptured = (capturedAgentId, capturedJobId) => {
      if (!capturedJobId) return;
      if (capturedAgentId && typeof creationsStore?.cancelAiJob === 'function') {
        try {
          Promise.resolve(creationsStore.cancelAiJob(capturedAgentId, capturedJobId)).catch(() => {});
        } catch {
          // ignore cancel errors
        }
      }
      if (typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(capturedJobId);
      }
    };

    const cancelReview = async () => {
      requestSeq += 1;
      const id = activeJobId.value;
      const ag = activeJobMeta.value?.agentId || props.agentId;
      activeJobId.value = '';
      activeJobMeta.value = null;
      pendingStart.value = false;
      if (id) {
        if (ag && typeof creationsStore?.cancelAiJob === 'function') {
          try {
            await creationsStore.cancelAiJob(ag, id);
          } catch {
            // ignore cancel errors
          }
        }
        if (typeof creationsStore?.clearAiJob === 'function') {
          creationsStore.clearAiJob(id);
        }
      }
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

      const capturedAgentId = props.agentId;
      const capturedCreationId = props.creationId;
      const capturedFilePath = props.filePath;
      const capturedPersistedDocPath = props.persistedDocPath;
      const capturedFileName = props.fileName;
      const capturedContent = props.content || '';
      const capturedDigest = fastContentDigest(capturedContent);

      // Cancel/clear any prior active review job using its own captured ownership
      const priorJobId = activeJobId.value;
      const priorAgentId = activeJobMeta.value?.agentId || capturedAgentId;
      activeJobId.value = '';
      if (priorJobId) {
        cancelAndClearCaptured(priorAgentId, priorJobId);
      }

      const token = ++requestSeq;
      activeJobMeta.value = {
        token,
        agentId: capturedAgentId,
        creationId: capturedCreationId,
        filePath: capturedFilePath,
        persistedDocPath: capturedPersistedDocPath,
        scope,
        contentDigest: capturedDigest,
      };
      pendingStart.value = true;
      localError.value = '';
      actionError.value = '';
      checkedIds.value = [];
      severityFilter.value = 'all';
      lensFilter.value = 'all';
      for (const key of Object.keys(localAnnotationStatuses)) {
        delete localAnnotationStatuses[key];
      }

      const persistThisReview = scope === 'document' && Boolean(capturedCreationId && capturedPersistedDocPath);

      try {
        const res = await creationsStore.startDocumentReview(capturedAgentId, {
          ...(persistThisReview ? { creationId: capturedCreationId } : {}),
          category: props.category || 'book',
          ...(persistThisReview
            ? { filePath: capturedPersistedDocPath }
            : (capturedFilePath ? { filePath: capturedFilePath } : {})),
          ...(capturedFileName ? { fileName: capturedFileName } : {}),
          content: capturedContent,
          scope,
          ...(overrides.selectedText ? { selectedText: overrides.selectedText } : {}),
          ...(overrides.lineStart > 0 ? { lineStart: overrides.lineStart } : {}),
          ...(overrides.lineEnd > 0 ? { lineEnd: overrides.lineEnd } : {}),
          lensIds,
          customPrompt: promptText || undefined,
          locale: getLocale(),
        });

        const stale = token !== requestSeq
          || props.agentId !== capturedAgentId
          || props.creationId !== capturedCreationId
          || props.filePath !== capturedFilePath;
        if (stale) {
          if (res?.jobId) {
            cancelAndClearCaptured(capturedAgentId, res.jobId);
          }
          return;
        }

        pendingStart.value = false;
        if (res?.jobId) {
          activeJobId.value = res.jobId;
          showConfigurator.value = false;
        } else {
          activeJobMeta.value = null;
          localError.value = res?.error || tr('creation.review.failed', 'Review failed');
        }
      } catch (err) {
        if (token !== requestSeq) return;
        pendingStart.value = false;
        activeJobMeta.value = null;
        localError.value = err?.message || tr('creation.review.failed', 'Review failed');
      }
    };

    const persistResolution = async (ann, status) => {
      if (!ann?.id) return false;
      if (isDurableDocumentReview.value) {
        if (typeof creationsStore?.resolveReviewAnnotation !== 'function') {
          actionError.value = { message: tr('creation.review.failed', 'Review failed') };
          return false;
        }
        resolvingId.value = ann.id;
        try {
          await creationsStore.resolveReviewAnnotation(
            props.agentId,
            props.creationId,
            props.persistedDocPath,
            ann.id,
            status,
          );
          checkedIds.value = checkedIds.value.filter(id => id !== ann.id);
          return true;
        } catch (err) {
          actionError.value = { message: err?.message || tr('creation.review.failed', 'Review failed') };
          return false;
        } finally {
          if (resolvingId.value === ann.id) resolvingId.value = '';
        }
      }

      // Non-durable (selection quick-review or standalone FilesTab): update local status only
      localAnnotationStatuses[ann.id] = status;
      checkedIds.value = checkedIds.value.filter(id => id !== ann.id);
      return true;
    };

    const acceptAnnotation = async (ann) => {
      if (!ann?.id || actionsLocked.value) return;
      actionError.value = '';
      const wasMatchingReviewed = documentMatchesReviewedContent.value;
      if (typeof props.applyAnnotationFix === 'function') {
        const result = props.applyAnnotationFix(ann);
        if (result && result.applied === false) {
          actionError.value = {
            conflict: true,
            message: tr('creation.canvas.applyConflict', 'Document changed since review; cannot safely apply this suggestion.'),
          };
          return;
        }
      } else {
        emit('apply-annotation', ann);
      }
      if (wasMatchingReviewed) {
        await Vue.nextTick();
        reviewedContentDigest.value = fastContentDigest(props.content || '');
      }
      await persistResolution(ann, 'accepted');
    };

    const dismissAnnotation = async (ann) => {
      if (!ann?.id || actionsLocked.value) return;
      actionError.value = '';
      await persistResolution(ann, 'dismissed');
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
      actionError.value = '';
      if (typeof props.stageAnnotationsToSession === 'function') {
        const res = props.stageAnnotationsToSession(list) || {};
        const stagedIds = Array.isArray(res.stagedIds) ? res.stagedIds : [];
        const remainingIds = Array.isArray(res.remainingIds) ? res.remainingIds : [];
        const stagedSet = new Set(stagedIds);
        checkedIds.value = checkedIds.value.filter(id => !stagedSet.has(id));
        if (remainingIds.length > 0) {
          actionError.value = { message: tr(
            'creation.review.addPartialWarning',
            '{count} items could not be added because the session draft is full.',
            { count: remainingIds.length },
          ) };
        }
        return;
      }
      emit('send-to-session', list);
      checkedIds.value = [];
    };

    const loadPersisted = async () => {
      if (!props.visible || !canPersistDocReview.value) return;
      if (typeof creationsStore?.loadDocReview !== 'function') return;
      const capturedAgentId = props.agentId;
      const capturedCreationId = props.creationId;
      const capturedDocPath = props.persistedDocPath;
      try {
        const res = await creationsStore.loadDocReview(capturedAgentId, capturedCreationId, capturedDocPath);
        if (
          props.agentId !== capturedAgentId
          || props.creationId !== capturedCreationId
          || props.persistedDocPath !== capturedDocPath
        ) {
          return;
        }
        if (res?.review && !activeJobId.value) {
          showConfigurator.value = false;
          const revId = res.review.jobId || String(res.review.updatedAt || 'loaded');
          if (reviewedBaselineJobId.value !== revId) {
            reviewedBaselineJobId.value = revId;
            reviewedContentDigest.value = fastContentDigest(props.content || '');
          }
        }
      } catch {
        // non-fatal
      }
    };

    Vue.watch(
      () => [props.visible, props.agentId, props.creationId, props.persistedDocPath],
      () => { loadPersisted(); },
      { immediate: true },
    );

    Vue.watch(
      () => [props.agentId, props.creationId, props.filePath, props.persistedDocPath],
      () => {
        requestSeq += 1;
        const priorJobId = activeJobId.value;
        const priorAgentId = activeJobMeta.value?.agentId || props.agentId;
        activeJobId.value = '';
        activeJobMeta.value = null;
        pendingStart.value = false;
        if (priorJobId) {
          cancelAndClearCaptured(priorAgentId, priorJobId);
        }
        localError.value = '';
        actionError.value = '';
        resolvingId.value = '';
        checkedIds.value = [];
        severityFilter.value = 'all';
        lensFilter.value = 'all';
        reviewedContentDigest.value = '';
        reviewedBaselineJobId.value = '';
        for (const key of Object.keys(localAnnotationStatuses)) {
          delete localAnnotationStatuses[key];
        }
        showConfigurator.value = !persistedReview.value;
      },
    );

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

    Vue.watch(() => props.reopenedAnnotation?.nonce, (nonce) => {
      if (!nonce || !props.reopenedAnnotation?.id) return;
      delete localAnnotationStatuses[props.reopenedAnnotation.id];
    });

    // Single source of truth handoff: once durable document review completes and persistedReview matches,
    // clear activeJobId so persistedReview (updated by cross-tab doc_review_updated) drives the UI.
    Vue.watch(
      () => [activeJob.value?.status, activeJob.value?.jobId, persistedReview.value?.jobId],
      ([status, jobId, persistedJobId]) => {
        if (status === 'completed' || status === 'partial') {
          showConfigurator.value = false;
          if (activeJob.value?.scope === 'document') {
            reviewedContentDigest.value = activeJobMeta.value?.contentDigest || fastContentDigest(props.content || '');
            reviewedBaselineJobId.value = jobId || '';
            if (jobId && persistedJobId && persistedJobId === jobId) {
              activeJobId.value = '';
              activeJobMeta.value = null;
              if (typeof creationsStore?.clearAiJob === 'function') {
                creationsStore.clearAiJob(jobId);
              }
            }
          }
        }
      },
    );

    // Track baseline digest when persistedReview arrives directly from store
    Vue.watch(
      () => persistedReview.value?.jobId || persistedReview.value?.updatedAt || '',
      (revId) => {
        if (!revId) return;
        if (reviewedBaselineJobId.value !== String(revId)) {
          reviewedBaselineJobId.value = String(revId);
          reviewedContentDigest.value = fastContentDigest(props.content || '');
        }
      },
      { immediate: true },
    );

    Vue.onBeforeUnmount(() => {
      requestSeq += 1;
      const priorJobId = activeJobId.value;
      const priorAgentId = activeJobMeta.value?.agentId || props.agentId;
      activeJobId.value = '';
      activeJobMeta.value = null;
      pendingStart.value = false;
      if (priorJobId) {
        cancelAndClearCaptured(priorAgentId, priorJobId);
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
      actionsLocked,
      resolvingId,
      errorMessage,
      actionError,
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
