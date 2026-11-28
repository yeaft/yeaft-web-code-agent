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

// FIPS 180-4 SHA-256 round constants. The Agent hashes the same UTF-8 bytes.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (word, bits) => (word >>> bits) | (word << (32 - bits));

function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = h + s1 + choose + SHA256_K[i] + w[i];
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + s0 + majority) >>> 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
  return Array.from(state, word => word.toString(16).padStart(8, '0')).join('');
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
    reopenedAnnotationEvent: { type: Object, default: null },
    rollbackAnnotationFix: { type: Function, default: null },
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

        <div v-if="isReviewRefreshing" class="canvas-inline-status" role="status">
          {{ tr('creation.review.refreshing', 'Syncing latest review state…') }}
        </div>
        <div v-if="supersededNotice" class="canvas-review-superseded-banner" role="status">
          {{ tr('creation.review.supersededNotice', 'A newer review superseded this run.') }}
        </div>

        <!-- Error banner -->
        <div v-if="errorMessage" class="canvas-inline-status" role="alert">
          <span>{{ errorMessage }}</span>
        </div>

        <!-- Action / Conflict / Partial-add banner -->
        <div v-if="actionError" class="canvas-inline-status" :class="{ 'canvas-review-conflict-banner': staleConflict }" role="alert">
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
          <span>{{ tr('creation.review.truncatedWarning', 'Document was truncated at line {end} for review.', { end: truncatedEndLine }) }}</span>
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
                  :disabled="actionsLocked || Boolean(resolvingId)"
                  :title="actionsLocked ? tr('creation.review.waitComplete', 'Actions unlock once review completes') : undefined"
                  @click="acceptAnnotation(ann)"
                >{{ tr('creation.review.acceptFix', 'Accept fix') }}</button>
                <button
                  type="button"
                  class="btn-ghost"
                  :disabled="actionsLocked || Boolean(resolvingId)"
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
    const acceptedPostFixDigest = Vue.ref(null);
    const supersededNotice = Vue.ref(false);
    const staleConflict = Vue.computed(() => Boolean(actionError.value?.conflict));
    let fileVersion = 0;

    const initDefaultLenses = () => {
      selectedLensIds.value = lenses.value
        .filter(l => l.defaultSelected !== false)
        .map(l => l.id);
    };

    Vue.watch(() => props.category, () => {
      initDefaultLenses();
    }, { immediate: true });

    const effectivePersistedDocPath = Vue.computed(() => props.persistedDocPath);

    const canPersistDocReview = Vue.computed(() => (
      Boolean(props.agentId && props.creationId && effectivePersistedDocPath.value)
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
      return creationsStore.getDocReview(props.agentId, props.creationId, effectivePersistedDocPath.value) || null;
    });

    const currentReview = Vue.computed(() => (
      (activeJob.value?.superseded ? null : activeJob.value) || persistedReview.value
    ));
    const truncatedEndLine = Vue.computed(() => (
      currentReview.value?.reviewedLines?.end || currentReview.value?.truncatedEndLine || 0
    ));
    const isRunning = Vue.computed(() => pendingStart.value || activeJob.value?.status === 'running');
    const reviewScope = Vue.computed(() => (
      activeJob.value?.scope
      || activeJobMeta.value?.scope
      || persistedReview.value?.scope
      || 'document'
    ));

    const isCurrentDurableReview = Vue.computed(() => Boolean(
      canPersistDocReview.value && persistedReview.value
      && (!activeJob.value || activeJob.value.superseded || activeJob.value.jobId === persistedReview.value.jobId)
    ));
    const isReviewRefreshing = Vue.computed(() => Boolean(
      canPersistDocReview.value
      && creationsStore?.isDocReviewRefreshing?.(props.agentId, props.creationId, effectivePersistedDocPath.value)
    ));
    const actionsLocked = Vue.computed(() => isRunning.value || isReviewRefreshing.value);

    const errorMessage = Vue.computed(() => {
      const failedJob = activeJob.value?.status === 'failed' ? activeJob.value : null;
      const code = localError.value || failedJob?.errorCode || failedJob?.error;
      if (code === 'client_timeout') return tr('creation.ai.timeout', 'AI request timed out; please retry.');
      if (code === 'connection_interrupted') return tr('creation.ai.reconnected', 'Connection interrupted; please retry.');
      return localError.value || (failedJob ? failedJob.error || tr('creation.review.failed', 'Review failed') : '');
    });

    const annotations = Vue.computed(() => {
      const raw = currentReview.value?.annotations;
      if (!Array.isArray(raw)) return [];
      if (isCurrentDurableReview.value) {
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

    const currentContentSha256 = Vue.computed(() => sha256Hex(props.content || ''));
    const contentMatchesDurableReview = Vue.computed(() => {
      const rev = persistedReview.value;
      if (!rev || typeof rev.contentHash !== 'string' || !rev.contentHash) return false;
      const cur = currentContentSha256.value;
      if (cur === rev.contentHash) return true;
      const accepted = acceptedPostFixDigest.value;
      return Boolean(accepted && accepted.reviewJobId === rev.jobId && accepted.hash === cur);
    });

    const canMarkFinal = Vue.computed(() => (
      Boolean(props.creationId && effectivePersistedDocPath.value)
      && props.docStatus !== 'final'
      && !isRunning.value
      && !isReviewRefreshing.value
      && Boolean(persistedReview.value)
      && ['completed', 'partial'].includes(persistedReview.value.status)
      && persistedOpenBlockerCount.value === 0
      && contentMatchesDurableReview.value
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
      showConfigurator.value = !persistedReview.value;
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
      const capturedPersistedDocPath = effectivePersistedDocPath.value;
      const capturedFileName = props.fileName;
      const capturedContent = props.content || '';

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
      };
      pendingStart.value = true;
      supersededNotice.value = false;
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

    const uncheckAnnotation = (id) => {
      checkedIds.value = checkedIds.value.filter(checkedId => checkedId !== id);
    };

    const persistResolution = async (ann, status, result = null, wasReviewedContent = false) => {
      if (!isCurrentDurableReview.value) {
        localAnnotationStatuses[ann.id] = status;
        uncheckAnnotation(ann.id);
        return;
      }

      const capturedFileVersion = fileVersion;
      const reviewJobId = persistedReview.value.jobId;
      resolvingId.value = ann.id;
      try {
        await creationsStore.resolveReviewAnnotation(
          props.agentId, props.creationId, effectivePersistedDocPath.value, ann.id, status,
        );
        if (fileVersion !== capturedFileVersion || persistedReview.value?.jobId !== reviewJobId) return;
        // A fix can extend a reviewed revision, but cannot bless unrelated edits already present.
        if (status === 'accepted' && wasReviewedContent && typeof result?.nextContent === 'string') {
          acceptedPostFixDigest.value = { reviewJobId, hash: sha256Hex(result.nextContent) };
        }
        uncheckAnnotation(ann.id);
      } catch (err) {
        if (fileVersion !== capturedFileVersion) return;
        const rb = status === 'accepted' && props.rollbackAnnotationFix?.({
          prevContent: result?.prevContent,
          expectedPostContent: result?.nextContent,
          annotationId: ann.id,
        });
        actionError.value = { message: rb?.rolledBack === false
          ? tr('creation.review.rollbackFailed', 'Failed to save annotation status and document changed; please verify manually.')
          : err?.message || tr('creation.review.failed', 'Review failed') };
      } finally {
        if (fileVersion === capturedFileVersion) resolvingId.value = '';
      }
    };

    const acceptAnnotation = async (ann) => {
      if (!ann?.id || actionsLocked.value || resolvingId.value) return;
      actionError.value = '';
      const wasReviewedContent = isCurrentDurableReview.value && contentMatchesDurableReview.value;
      const result = props.applyAnnotationFix ? props.applyAnnotationFix(ann, {
        isDurable: isCurrentDurableReview.value,
        reviewJobId: currentReview.value?.jobId || '',
      }) : null;
      if (result?.applied === false) {
        actionError.value = {
          conflict: true,
          message: tr('creation.canvas.applyConflict', 'Document changed since review; cannot safely apply this suggestion.'),
        };
        return;
      }
      if (!props.applyAnnotationFix) emit('apply-annotation', ann);
      await persistResolution(ann, 'accepted', result, wasReviewedContent);
    };

    const dismissAnnotation = async (ann) => {
      if (!ann?.id || actionsLocked.value || resolvingId.value) return;
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
      const capturedDocPath = effectivePersistedDocPath.value;
      try {
        const res = await creationsStore.loadDocReview(capturedAgentId, capturedCreationId, capturedDocPath);
        if (
          props.agentId !== capturedAgentId
          || props.creationId !== capturedCreationId
          || effectivePersistedDocPath.value !== capturedDocPath
        ) {
          return;
        }
        if (res?.review && !activeJobId.value) {
          showConfigurator.value = false;
        }
      } catch {
        // non-fatal
      }
    };

    Vue.watch(
      () => [props.visible, props.agentId, props.creationId, effectivePersistedDocPath.value],
      () => { loadPersisted(); },
      { immediate: true },
    );

    Vue.watch(
      () => [props.agentId, props.creationId, props.filePath, effectivePersistedDocPath.value],
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
        fileVersion += 1;
        supersededNotice.value = false;
        acceptedPostFixDigest.value = null;
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

    Vue.watch(() => props.reopenedAnnotationEvent, (ev) => {
      if (ev?.annotationId) localAnnotationStatuses[ev.annotationId] = 'open';
    });

    Vue.watch(activeJob, (job) => {
      if (job?.superseded !== true) return;
      const supersededId = activeJobId.value;
      supersededNotice.value = true;
      activeJobId.value = '';
      activeJobMeta.value = null;
      showConfigurator.value = !persistedReview.value;
      creationsStore.clearAiJob?.(supersededId);
    });

    // Once a completed run is durable, the cached review (including cross-tab updates) drives the UI.
    Vue.watch(
      () => [activeJob.value?.status, activeJob.value?.jobId, persistedReview.value?.jobId],
      ([status, jobId, persistedJobId]) => {
        if (status !== 'completed' && status !== 'partial') return;
        showConfigurator.value = false;
        if (jobId && jobId === persistedJobId) {
          activeJobId.value = '';
          activeJobMeta.value = null;
          creationsStore.clearAiJob?.(jobId);
        }
      },
    );

    Vue.watch(() => persistedReview.value?.jobId, () => {
      acceptedPostFixDigest.value = null;
    }, { flush: 'sync' });

    Vue.onBeforeUnmount(() => {
      requestSeq += 1;
      fileVersion += 1;
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
      truncatedEndLine,
      isReviewRefreshing,
      supersededNotice,
      staleConflict,
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
