import {
  quickEditPresetsForCategory,
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
  name: 'CanvasInlineEditPopover',
  props: {
    visible: { type: Boolean, default: false },
    top: { type: Number, default: 0 },
    left: { type: Number, default: 0 },
    selectedText: { type: String, default: '' },
    fullContent: { type: String, default: '' },
    rawStart: { type: Number, default: null },
    rawEnd: { type: Number, default: null },
    ambiguous: { type: Boolean, default: false },
    canPersist: { type: Boolean, default: true },
    lineStart: { type: Number, default: undefined },
    lineEnd: { type: Number, default: undefined },
    filePath: { type: String, default: '' },
    fileName: { type: String, default: '' },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    category: { type: String, default: 'book' },
    routeKey: { type: String, default: '' },
  },
  emits: ['close', 'apply-replacement', 'quote-to-session', 'quick-review', 'busy-change'],
  template: `
    <div
      v-if="visible"
      class="canvas-inline-popover"
      :style="{ top: top + 'px', left: left + 'px' }"
      role="dialog"
      tabindex="-1"
      :aria-label="tr('creation.inlineEdit.placeholder', 'How should this passage change?')"
      @mousedown.stop
      @keydown.esc.stop="handleEscape"
    >
      <!-- Running state -->
      <template v-if="isRunning">
        <div class="canvas-inline-status" role="status" aria-live="polite">
          <span class="spinner-mini" aria-hidden="true"></span>
          <span>{{ tr('creation.inlineEdit.running', 'Revising...') }}</span>
          <span class="canvas-inline-hint">{{ tr('creation.inlineEdit.isolatedHint', 'Does not pollute session chat') }}</span>
          <button
            type="button"
            class="btn-ghost"
            @click="cancelEdit"
          >{{ tr('creation.inlineEdit.cancel', 'Cancel') }}</button>
        </div>
        <div v-if="job && job.revisedText" class="canvas-inline-diff-box">{{ job.revisedText }}</div>
      </template>

      <!-- Completed / Diff Review state -->
      <template v-else-if="isCompleted">
        <div v-if="isNoChange" class="canvas-inline-status">
          <span>{{ tr('creation.inlineEdit.noChange', 'No changes suggested.') }}</span>
          <button
            type="button"
            class="btn-ghost"
            @click="discardEdit"
          >{{ tr('creation.inlineEdit.discard', 'Discard') }}</button>
        </div>
        <template v-else>
          <div class="canvas-inline-diff-box" role="region" :aria-label="tr('creation.inlineEdit.replace', 'Replace')">
            <template v-for="(hunk, idx) in diffHunks" :key="idx">
              <span v-if="hunk.type === 'del'" class="canvas-diff-del">{{ hunk.text }}</span>
              <span v-else-if="hunk.type === 'add'" class="canvas-diff-add">{{ hunk.text }}</span>
              <span v-else>{{ hunk.text }}</span>
            </template>
          </div>

          <div v-if="refineMode" class="canvas-inline-input-row">
            <input
              ref="inputRef"
              v-model="instruction"
              type="text"
              class="canvas-inline-input"
              :placeholder="tr('creation.inlineEdit.refinePlaceholder', 'Tweak one more thing...')"
              @keydown.enter.prevent="submitInstruction"
            />
            <button
              type="button"
              class="canvas-inline-preset-btn"
              :disabled="!instruction.trim()"
              :title="tr('creation.inlineEdit.submit', 'Submit')"
              :aria-label="tr('creation.inlineEdit.submit', 'Submit')"
              @click="submitInstruction"
            >↵</button>
          </div>

          <div class="canvas-inline-actions">
            <button
              type="button"
              class="btn-primary"
              @click="applyReplacement"
            >✓ {{ tr('creation.inlineEdit.replace', 'Replace') }}</button>
            <button
              type="button"
              class="btn-secondary"
              v-if="effectiveCandidate !== ''"
              @click="startRefine"
            >↻ {{ tr('creation.inlineEdit.refine', 'Refine') }}</button>
            <button
              type="button"
              class="btn-ghost"
              @click="discardEdit"
            >✕ {{ tr('creation.inlineEdit.discard', 'Discard') }}</button>
          </div>
        </template>
      </template>

      <!-- Idle / Error state -->
      <template v-else>
        <div class="canvas-inline-presets">
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="canvas-inline-preset-btn"
            :disabled="!aiAvailable || ambiguous"
            :title="ambiguous
              ? tr('creation.canvas.ambiguousSelection', 'Multiple matches found. Switch to Edit mode to select an exact range.')
              : (aiAvailable ? tr(preset.labelKey, preset.id) : tr('creation.inlineEdit.unavailable', 'AI unavailable'))"
            @mousedown.prevent
            @click="runEdit({ preset: preset.id })"
          >{{ tr(preset.labelKey, preset.id) }}</button>

          <div v-if="lenses.length > 0" class="canvas-popover-wrap">
            <button
              type="button"
              class="canvas-inline-preset-btn"
              :class="{ active: reviewMenuOpen }"
              :disabled="!aiAvailable || ambiguous"
              :aria-expanded="reviewMenuOpen && !ambiguous"
              :title="aiAvailable ? tr('creation.inlineEdit.quickReview', 'Quick review') : tr('creation.inlineEdit.unavailable', 'AI unavailable')"
              @mousedown.prevent
              @click="reviewMenuOpen = !reviewMenuOpen"
            >{{ tr('creation.inlineEdit.quickReview', 'Quick review') }} ▾</button>

            <div v-if="reviewMenuOpen && !ambiguous" class="canvas-inline-review-menu" role="menu">
              <button
                v-for="lens in lenses"
                :key="lens.id"
                type="button"
                role="menuitem"
                class="canvas-inline-preset-btn"
                :title="tr(lens.descKey, '')"
                @mousedown.prevent
                @click="triggerQuickReview(lens.id)"
              >{{ tr(lens.labelKey, lens.id) }}</button>
            </div>
          </div>

          <span class="canvas-inline-divider" aria-hidden="true"></span>

          <button
            type="button"
            class="canvas-inline-preset-btn canvas-selection-btn canvas-ref-btn"
            @mousedown.prevent
            @click="$emit('quote-to-session')"
          >✦ {{ tr('creation.canvas.quoteToSession', 'Quote to session') }}</button>
        </div>

        <div v-if="ambiguous" class="canvas-inline-status" role="status">
          <span>{{ tr('creation.canvas.ambiguousSelection', 'Multiple matches found. Switch to Edit mode to select an exact range.') }}</span>
        </div>

        <div class="canvas-inline-input-row">
          <input
            ref="inputRef"
            v-model="instruction"
            type="text"
            class="canvas-inline-input"
            :disabled="!aiAvailable || ambiguous"
            :placeholder="ambiguous
              ? tr('creation.canvas.ambiguousSelection', 'Multiple matches found. Switch to Edit mode to select an exact range.')
              : (aiAvailable
                ? tr('creation.inlineEdit.placeholder', 'How should this passage change?')
                : tr('creation.inlineEdit.unavailable', 'AI unavailable'))"
            @keydown.enter.prevent="submitInstruction"
          />
          <button
            type="button"
            class="canvas-inline-preset-btn"
            :disabled="!aiAvailable || ambiguous || !instruction.trim()"
            :title="tr('creation.inlineEdit.submit', 'Submit')"
            :aria-label="tr('creation.inlineEdit.submit', 'Submit')"
            @click="submitInstruction"
          >↵</button>
        </div>

        <div v-if="errorMessage" class="canvas-inline-status" role="alert">
          <span>{{ errorMessage }}</span>
          <button
            v-if="lastRequest"
            type="button"
            class="btn-ghost"
            @click="retryLastEdit"
          >{{ tr('creation.inlineEdit.retry', 'Retry') }}</button>
          <button
            type="button"
            class="btn-ghost"
            @click="clearError"
          >{{ tr('creation.inlineEdit.discard', 'Dismiss') }}</button>
        </div>
      </template>
    </div>
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

    let requestSeq = 0;
    const activeJobId = Vue.ref('');
    const activeRequest = Vue.ref(null);
    const pendingStart = Vue.ref(false);
    const anchorOriginalText = Vue.ref('');
    const lastCandidateText = Vue.ref('');
    const hasCandidate = Vue.ref(false);
    const instruction = Vue.ref('');
    const refineMode = Vue.ref(false);
    const reviewMenuOpen = Vue.ref(false);
    const localError = Vue.ref('');
    const lastRequest = Vue.ref(null);
    const inputRef = Vue.ref(null);

    const presets = Vue.computed(() => {
      const list = typeof quickEditPresetsForCategory === 'function'
        ? quickEditPresetsForCategory(props.category)
        : [];
      return Array.isArray(list) ? list : [];
    });

    const lenses = Vue.computed(() => {
      const list = typeof reviewLensesForCategory === 'function'
        ? reviewLensesForCategory(props.category)
        : [];
      return Array.isArray(list) ? list : [];
    });

    const aiAvailable = Vue.computed(() => (
      Boolean(props.agentId)
      && typeof creationsStore?.startInlineEdit === 'function'
      && isAgentAiCapable(chatStore, props.agentId)
    ));

    const job = Vue.computed(() => (
      activeJobId.value && creationsStore?.inlineEditJobs
        ? (creationsStore.inlineEditJobs[activeJobId.value] || null)
        : null
    ));

    const isRunning = Vue.computed(() => pendingStart.value || job.value?.status === 'running');

    const errorMessage = Vue.computed(() => {
      const failedJob = job.value?.status === 'failed' ? job.value : null;
      const code = localError.value || failedJob?.errorCode || failedJob?.error;
      if (code === 'client_timeout') return tr('creation.ai.timeout', 'AI request timed out; please retry.');
      if (code === 'connection_interrupted') return tr('creation.ai.reconnected', 'Connection interrupted; please retry.');
      return localError.value || (failedJob ? failedJob.error || tr('creation.inlineEdit.failed', 'Quick edit failed') : '');
    });

    const effectiveCandidate = Vue.computed(() => (
      job.value?.status === 'completed' && typeof job.value.revisedText === 'string'
        ? job.value.revisedText
        : (hasCandidate.value ? lastCandidateText.value : null)
    ));

    const isCompleted = Vue.computed(() => (
      !isRunning.value && !errorMessage.value && effectiveCandidate.value !== null
    ));

    const diffHunks = Vue.computed(() => {
      const orig = anchorOriginalText.value || props.selectedText || '';
      const rev = effectiveCandidate.value || '';
      if (!orig && !rev) return [];
      if (
        job.value
        && Array.isArray(job.value.diffHunks)
        && job.value.diffHunks.length > 0
        && job.value.originalText === orig
        && job.value.revisedText === rev
      ) {
        return job.value.diffHunks;
      }
      if (typeof computeInlineDiff === 'function') {
        return computeInlineDiff(orig, rev);
      }
      return rev ? [{ type: 'add', text: rev }] : [];
    });

    const isNoChange = Vue.computed(() => (
      effectiveCandidate.value !== null && effectiveCandidate.value === anchorOriginalText.value
    ));

    Vue.watch(
      () => [job.value?.status, job.value?.revisedText],
      ([status, revisedText]) => {
        if (status === 'completed' && typeof revisedText === 'string') {
          hasCandidate.value = true;
          lastCandidateText.value = revisedText;
        }
      },
    );

    const isBusy = Vue.computed(() => Boolean(pendingStart.value || isRunning.value || isCompleted.value));
    Vue.watch(isBusy, (val) => {
      emit('busy-change', val);
    }, { immediate: true });

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

    const resetSessionState = () => {
      activeRequest.value = null;
      anchorOriginalText.value = '';
      hasCandidate.value = false;
      lastCandidateText.value = '';
      lastRequest.value = null;
      instruction.value = '';
      refineMode.value = false;
      reviewMenuOpen.value = false;
      localError.value = '';
    };

    const cancelEdit = async () => {
      requestSeq += 1;
      const id = activeJobId.value;
      const ag = activeRequest.value?.agentId || props.agentId;
      activeJobId.value = '';
      pendingStart.value = false;
      refineMode.value = false;
      localError.value = '';
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

    const runEdit = async ({ preset = '', instruction: customInstruction = '', isRetry = false } = {}) => {
      if (props.ambiguous) {
        localError.value = tr(
          'creation.canvas.ambiguousSelection',
          'Multiple matches found. Switch to Edit mode to select an exact range.',
        );
        return;
      }
      if (!aiAvailable.value) {
        localError.value = tr('creation.inlineEdit.unavailable', 'AI unavailable');
        return;
      }
      const trimmedInstruction = String(customInstruction || '').trim();
      if (!preset && !trimmedInstruction) return;

      const isRefining = refineMode.value && hasCandidate.value;
      const reuseFrozenAnchor = (isRefining || isRetry) && Boolean(activeRequest.value?.anchor);
      const originalAnchor = reuseFrozenAnchor
        ? { ...activeRequest.value.anchor }
        : {
          originalText: props.selectedText || '',
          rawStart: Number.isInteger(props.rawStart) ? props.rawStart : null,
          rawEnd: Number.isInteger(props.rawEnd) ? props.rawEnd : null,
          lineStart: props.lineStart,
          lineEnd: props.lineEnd,
        };

      if (!reuseFrozenAnchor) {
        anchorOriginalText.value = originalAnchor.originalText;
        hasCandidate.value = false;
        lastCandidateText.value = '';
      }

      const baseText = (isRefining || isRetry) && hasCandidate.value
        ? lastCandidateText.value : anchorOriginalText.value;
      if (!hasCandidate.value && !baseText.trim()) return;

      const capturedAgentId = props.agentId;
      const capturedCreationId = props.creationId;
      const capturedFilePath = props.filePath;
      const capturedFileName = props.fileName;

      // Cancel/clear any prior active job using its own captured ownership BEFORE launching
      const priorJobId = activeJobId.value;
      const priorAgentId = activeRequest.value?.agentId || capturedAgentId;
      activeJobId.value = '';
      if (priorJobId) {
        cancelAndClearCaptured(priorAgentId, priorJobId);
      }

      const token = ++requestSeq;
      activeRequest.value = {
        token,
        agentId: capturedAgentId,
        creationId: capturedCreationId,
        filePath: capturedFilePath,
        anchor: originalAnchor,
        baseText,
        preset,
        instruction: trimmedInstruction,
      };
      lastRequest.value = { preset, instruction: trimmedInstruction, baseText };
      pendingStart.value = true;
      reviewMenuOpen.value = false;
      localError.value = '';
      refineMode.value = false;

      try {
        const res = await creationsStore.startInlineEdit(capturedAgentId, {
          ...(capturedCreationId && props.canPersist ? { creationId: capturedCreationId } : {}),
          category: props.category || 'book',
          ...(capturedFilePath ? { filePath: capturedFilePath } : {}),
          ...(capturedFileName ? { fileName: capturedFileName } : {}),
          fullContent: props.fullContent || '',
          selectedText: baseText,
          ...(originalAnchor.lineStart > 0 ? { lineStart: originalAnchor.lineStart } : {}),
          ...(originalAnchor.lineEnd > 0 ? { lineEnd: originalAnchor.lineEnd } : {}),
          preset: preset || undefined,
          instruction: trimmedInstruction || undefined,
          locale: getLocale(),
        });

        const stale = token !== requestSeq
          || !props.visible
          || props.agentId !== capturedAgentId
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
          instruction.value = '';
        } else {
          localError.value = res?.error || tr('creation.inlineEdit.failed', 'Quick edit failed');
        }
      } catch (err) {
        if (token !== requestSeq) return;
        pendingStart.value = false;
        localError.value = err?.message || tr('creation.inlineEdit.failed', 'Quick edit failed');
      }
    };

    const submitInstruction = () => {
      const text = instruction.value.trim();
      if (!text) return;
      runEdit({ instruction: text });
    };

    const retryLastEdit = () => {
      if (lastRequest.value) {
        runEdit({ ...lastRequest.value, isRetry: true });
      } else {
        localError.value = '';
      }
    };

    const clearError = () => {
      localError.value = '';
      if (job.value?.status === 'failed') {
        const id = activeJobId.value;
        activeJobId.value = '';
        if (id && typeof creationsStore?.clearAiJob === 'function') {
          creationsStore.clearAiJob(id);
        }
      }
    };

    const applyReplacement = () => {
      const anchor = activeRequest.value?.anchor || {
        originalText: props.selectedText || '',
        rawStart: Number.isInteger(props.rawStart) ? props.rawStart : null,
        rawEnd: Number.isInteger(props.rawEnd) ? props.rawEnd : null,
        lineStart: props.lineStart,
        lineEnd: props.lineEnd,
      };
      const revisedText = effectiveCandidate.value;
      emit('apply-replacement', {
        originalText: anchor.originalText,
        rawStart: anchor.rawStart,
        rawEnd: anchor.rawEnd,
        lineStart: anchor.lineStart,
        lineEnd: anchor.lineEnd,
        revisedText,
      });
      requestSeq += 1;
      const id = activeJobId.value;
      activeJobId.value = '';
      pendingStart.value = false;
      if (id && typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(id);
      }
      resetSessionState();
      emit('close');
    };

    const startRefine = () => {
      refineMode.value = true;
      instruction.value = '';
      Vue.nextTick(() => inputRef.value?.focus?.());
    };

    const discardEdit = () => {
      cancelEdit();
      resetSessionState();
      emit('close');
    };

    const handleEscape = () => {
      if (refineMode.value) {
        refineMode.value = false;
        return;
      }
      if (reviewMenuOpen.value) {
        reviewMenuOpen.value = false;
        return;
      }
      if (isRunning.value) {
        cancelEdit();
        return;
      }
      discardEdit();
    };

    const triggerQuickReview = (lensId) => {
      if (props.ambiguous || !aiAvailable.value) return;
      reviewMenuOpen.value = false;
      emit('quick-review', {
        lensId,
        selectedText: props.selectedText || '',
        rawStart: props.rawStart,
        rawEnd: props.rawEnd,
        lineStart: props.lineStart,
        lineEnd: props.lineEnd,
      });
      emit('close');
    };

    Vue.watch(() => props.visible, (nextVisible) => {
      if (!nextVisible) {
        cancelEdit();
        resetSessionState();
      }
    });

    Vue.watch(() => [
      props.agentId, props.creationId, props.filePath, props.selectedText,
      props.rawStart, props.rawEnd, props.lineStart, props.lineEnd,
    ], () => {
      cancelEdit();
      resetSessionState();
    });

    Vue.onBeforeUnmount(() => {
      cancelEdit();
      resetSessionState();
    });

    return {
      tr,
      presets,
      lenses,
      aiAvailable,
      job,
      isRunning,
      isCompleted,
      errorMessage,
      effectiveCandidate,
      diffHunks,
      isNoChange,
      instruction,
      refineMode,
      reviewMenuOpen,
      lastRequest,
      inputRef,
      runEdit,
      submitInstruction,
      retryLastEdit,
      clearError,
      cancelEdit,
      applyReplacement,
      startRefine,
      discardEdit,
      handleEscape,
      triggerQuickReview,
    };
  },
};
