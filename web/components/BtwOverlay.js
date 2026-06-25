/**
 * BtwOverlay — Inline multi-turn /btw conversation panel.
 * Renders as a flex child above ChatInput when store.btwMode is true.
 * Shows multi-turn messages list with streaming support.
 * Esc key closes the panel (handled by ChatInput).
 */

export default {
  name: 'BtwOverlay',
  template: `
    <div v-if="store.btwMode" class="btw-float" role="log" aria-live="polite" aria-label="Side question conversation">
      <div class="btw-card">
        <div class="btw-header">
          <span class="btw-header-label">BTW</span>
          <button class="btw-close-btn" @click="store.closeBtw()" :title="$t('btw.close')">&times;</button>
        </div>
        <div class="btw-messages" ref="messagesRef">
          <template v-for="(msg, idx) in store.btwMessages" :key="idx">
            <div v-if="msg.role === 'user'" class="btw-msg btw-msg-user">{{ msg.content }}</div>
            <div v-else class="btw-msg btw-msg-assistant">
              <div v-if="renderedContents[idx]" v-html="renderedContents[idx]" class="btw-answer-content markdown-body"></div>
              <span v-if="store.btwLoading && idx === store.btwMessages.length - 1 && !msg.content" class="btw-loading-dots">
                <span></span><span></span><span></span>
              </span>
              <span v-if="store.btwLoading && idx === store.btwMessages.length - 1 && msg.content" class="btw-cursor"></span>
            </div>
          </template>
        </div>
        <div class="btw-hint">{{ $t('btw.hint') }}</div>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const messagesRef = Vue.ref(null);

    // Render markdown for each assistant message
    const renderedContents = Vue.computed(() => {
      return store.btwMessages.map(msg => {
        if (msg.role !== 'assistant' || !msg.content) return '';
        try {
          return marked.parse(msg.content);
        } catch {
          return msg.content;
        }
      });
    });

    // Auto-scroll as messages stream in
    Vue.watch(
      () => {
        const msgs = store.btwMessages;
        const last = msgs[msgs.length - 1];
        return last?.content?.length || 0;
      },
      () => {
        Vue.nextTick(() => {
          if (messagesRef.value) {
            messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
          }
        });
      }
    );

    // Also scroll when a new message pair is added
    Vue.watch(
      () => store.btwMessages.length,
      () => {
        Vue.nextTick(() => {
          if (messagesRef.value) {
            messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
          }
        });
      }
    );

    return {
      store,
      messagesRef,
      renderedContents,
    };
  }
};
