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
    lineStart: { type: Number, default: undefined },
    lineEnd: { type: Number, default: undefined },
    filePath: { type: String, default: '' },
    fileName: { type: String, default: '' },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    category: { type: String, default: 'book' },
    routeKey: { type: String, default: '' },
  },
  emits: ['close', 'apply-replacement', 'quote-to-session', 'quick-review'],
  template: `
    <div
      v-if="visible"
      class="canvas-inline-popover"
      :style="{ top: top + 'px', left: left + 'px' }"
      role="dialog"
      :aria-label="tr('creation.inlineEdit.placeholder', 'How should this passage change?')"
      @mousedown.stop
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
        <div v-if="!hasActualChange" class="canvas-inline-status">
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
              @keydown.escape.prevent="refineMode = false"
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
            :disabled="!aiAvailable"
            :title="aiAvailable ? tr(preset.labelKey, preset.id) : tr('creation.inlineEdit.unavailable', 'AI unavailable')"
            @mousedown.prevent
            @click="runEdit({ preset: preset.id })"
          >{{ tr(preset.labelKey, preset.id) }}</button>

          <div v-if="lenses.length > 0" class="canvas-popover-wrap">
            <button
              type="button"
              class="canvas-inline-preset-btn"
              :class="{ active: reviewMenuOpen }"
              :disabled="!aiAvailable"
              :aria-expanded="reviewMenuOpen"
              :title="aiAvailable ? tr('creation.inlineEdit.quickReview', 'Quick review') : tr('creation.inlineEdit.unavailable', 'AI unavailable')"
              @mousedown.prevent
              @click="reviewMenuOpen = !reviewMenuOpen"
            >{{ tr('creation.inlineEdit.quickReview', 'Quick review') }} ▾</button>

            <div v-if="reviewMenuOpen" class="canvas-inline-review-menu" role="menu">
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

        <div class="canvas-inline-input-row">
          <input
            ref="inputRef"
            v-model="instruction"
            type="text"
            class="canvas-inline-input"
            :disabled="!aiAvailable"
            :placeholder="aiAvailable
              ? tr('creation.inlineEdit.placeholder', 'How should this passage change?')
              : tr('creation.inlineEdit.unavailable', 'AI unavailable')"
            @keydown.enter.prevent="submitInstruction"
            @keydown.escape.prevent="$emit('close')"
          />
          <button
            type="button"
            class="canvas-inline-preset-btn"
            :disabled="!aiAvailable || !instruction.trim()"
            :title="tr('creation.inlineEdit.submit', 'Submit')"
            :aria-label="tr('creation.inlineEdit.submit', 'Submit')"
            @click="submitInstruction"
          >↵</button>
        </div>

        <div v-if="errorMessage" class="canvas-inline-status" role="alert">
          <span>{{ errorMessage }}</span>
          <button
            type="button"
            class="btn-ghost"
            @click="retryLastEdit"
          >{{ tr('creation.inlineEdit.refine', 'Retry') }}</button>
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

    const activeJobId = Vue.ref('');
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

    const isRunning = Vue.computed(() => job.value?.status === 'running');
    const isCompleted = Vue.computed(() => job.value?.status === 'completed');

    const errorMessage = Vue.computed(() => {
      if (localError.value) return localError.value;
      if (job.value?.status === 'failed') {
        return job.value.error || tr('creation.inlineEdit.failed', 'Quick edit failed');
      }
      return '';
    });

    const diffHunks = Vue.computed(() => {
      if (!job.value) return [];
      if (Array.isArray(job.value.diffHunks) && job.value.diffHunks.length > 0) {
        return job.value.diffHunks;
      }
      const orig = job.value.originalText ?? props.selectedText ?? '';
      const rev = job.value.revisedText ?? '';
      if (typeof computeInlineDiff === 'function') {
        return computeInlineDiff(orig, rev);
      }
      return rev ? [{ type: 'add', text: rev }] : [];
    });

    const hasActualChange = Vue.computed(() => {
      if (!job.value) return false;
      const orig = String(job.value.originalText ?? props.selectedText ?? '');
      const rev = String(job.value.revisedText ?? '');
      return rev.length > 0 && rev !== orig;
    });

    const clearCurrentJob = () => {
      const id = activeJobId.value;
      activeJobId.value = '';
      if (id && typeof creationsStore?.clearAiJob === 'function') {
        creationsStore.clearAiJob(id);
      }
    };

    const cancelEdit = async () => {
      const id = activeJobId.value;
      if (id && props.agentId && typeof creationsStore?.cancelAiJob === 'function') {
        try {
          await creationsStore.cancelAiJob(props.agentId, id);
        } catch {
          // ignore cancel errors
        }
      }
      clearCurrentJob();
      refineMode.value = false;
      localError.value = '';
    };

    const runEdit = async ({ preset = '', instruction: customInstruction = '' } = {}) => {
      if (!aiAvailable.value) {
        localError.value = tr('creation.inlineEdit.unavailable', 'AI unavailable');
        return;
      }
      const trimmedInstruction = String(customInstruction || '').trim();
      if (!preset && !trimmedInstruction) return;

      const baseText = (refineMode.value && job.value?.revisedText)
        ? job.value.revisedText
        : (props.selectedText || '');
      if (!baseText.trim()) return;

      lastRequest.value = { preset, instruction: trimmedInstruction };
      reviewMenuOpen.value = false;
      localError.value = '';
      refineMode.value = false;
      clearCurrentJob();

      try {
        const res = await creationsStore.startInlineEdit(props.agentId, {
          ...(props.creationId ? { creationId: props.creationId } : {}),
          category: props.category || 'book',
          ...(props.filePath ? { filePath: props.filePath } : {}),
          ...(props.fileName ? { fileName: props.fileName } : {}),
          fullContent: props.fullContent || '',
          selectedText: baseText,
          ...(props.lineStart > 0 ? { lineStart: props.lineStart } : {}),
          ...(props.lineEnd > 0 ? { lineEnd: props.lineEnd } : {}),
          preset: preset || undefined,
          instruction: trimmedInstruction || undefined,
          locale: getLocale(),
        });
        if (res?.jobId) {
          activeJobId.value = res.jobId;
          instruction.value = '';
        } else {
          localError.value = res?.error || tr('creation.inlineEdit.failed', 'Quick edit failed');
        }
      } catch (err) {
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
        runEdit(lastRequest.value);
      } else {
        localError.value = '';
      }
    };

    const clearError = () => {
      localError.value = '';
      if (job.value?.status === 'failed') {
        clearCurrentJob();
      }
    };

    const applyReplacement = () => {
      const revisedText = job.value?.revisedText ?? '';
      emit('apply-replacement', {
        originalText: props.selectedText || '',
        revisedText,
        lineStart: props.lineStart,
        lineEnd: props.lineEnd,
      });
      clearCurrentJob();
      instruction.value = '';
      refineMode.value = false;
      localError.value = '';
      emit('close');
    };

    const startRefine = () => {
      refineMode.value = true;
      instruction.value = '';
      Vue.nextTick(() => inputRef.value?.focus?.());
    };

    const discardEdit = () => {
      clearCurrentJob();
      instruction.value = '';
      refineMode.value = false;
      localError.value = '';
      emit('close');
    };

    const triggerQuickReview = (lensId) => {
      reviewMenuOpen.value = false;
      emit('quick-review', {
        lensId,
        selectedText: props.selectedText || '',
        lineStart: props.lineStart,
        lineEnd: props.lineEnd,
      });
      emit('close');
    };

    Vue.watch(() => props.visible, (nextVisible) => {
      if (!nextVisible) {
        reviewMenuOpen.value = false;
        refineMode.value = false;
        instruction.value = '';
        localError.value = '';
        if (isRunning.value) {
          cancelEdit();
        } else if (activeJobId.value) {
          clearCurrentJob();
        }
      }
    });

    Vue.onBeforeUnmount(() => {
      if (isRunning.value) {
        cancelEdit();
      } else if (activeJobId.value) {
        clearCurrentJob();
      }
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
      diffHunks,
      hasActualChange,
      instruction,
      refineMode,
      reviewMenuOpen,
      inputRef,
      runEdit,
      submitInstruction,
      retryLastEdit,
      clearError,
      cancelEdit,
      applyReplacement,
      startRefine,
      discardEdit,
      triggerQuickReview,
    };
  },
};
