/**
 * BtwOverlay — Floating card for /btw side questions.
 * Renders inline (no Teleport) as a flex child above ChatInput.
 * Shows question + streaming answer. Closes on Esc / Ctrl+Enter.
 */

export default {
  name: 'BtwOverlay',
  template: `
    <div v-if="store.btwVisible" class="btw-float" role="status" aria-live="polite" aria-label="Side question response">
      <div class="btw-card">
        <div class="btw-question">{{ store.btwQuestion }}</div>
        <div class="btw-answer" ref="answerRef">
          <div v-if="renderedAnswer" v-html="renderedAnswer" class="btw-answer-content markdown-body"></div>
          <span v-if="store.btwLoading && !store.btwAnswer" class="btw-loading-dots">
            <span></span><span></span><span></span>
          </span>
          <span v-if="store.btwLoading && store.btwAnswer" class="btw-cursor"></span>
        </div>
        <div class="btw-hint">{{ $t('btw.hint') }}</div>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const answerRef = Vue.ref(null);

    const renderedAnswer = Vue.computed(() => {
      if (!store.btwAnswer) return '';
      try {
        return marked.parse(store.btwAnswer);
      } catch {
        return store.btwAnswer;
      }
    });

    // Auto-scroll answer area as content streams in
    Vue.watch(() => store.btwAnswer, () => {
      Vue.nextTick(() => {
        if (answerRef.value) {
          answerRef.value.scrollTop = answerRef.value.scrollHeight;
        }
      });
    });

    // Global keydown listener — no focus stealing
    const onGlobalKeydown = (e) => {
      if (!store.btwVisible) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        store.closeBtw();
      }
      if (!store.btwLoading && e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        store.closeBtw();
      }
    };

    Vue.onMounted(() => document.addEventListener('keydown', onGlobalKeydown));
    Vue.onUnmounted(() => document.removeEventListener('keydown', onGlobalKeydown));

    return {
      store,
      answerRef,
      renderedAnswer,
    };
  }
};
