/**
 * MemoryTraceModal.js — R6 G2.
 *
 * Modal that opens when the user clicks "Trace" on a MemoryCard. Resolves
 * the entry's `sourceRef` (conversationId / messageId / threadId / range)
 * via memoryStore.requestTrace(entryId), then shows the entry alongside
 * the source-message reference.
 *
 * Per D2 / TASTE-5: this is a read-only browsing surface — system-prompt
 * memory composition is owned by the AGENT process, not the UI.
 *
 * Props:
 *   entryId   — the entry whose source we're tracing (null = closed).
 * Emits:
 *   close
 *   jump-to-message (sourceRef) — parent decides whether to scroll the
 *     main MessageList to the referenced message.
 */
export default {
  name: 'MemoryTraceModal',
  emits: ['close', 'jump-to-message'],
  props: {
    entryId: { type: String, default: null },
  },
  template: `
    <div
      v-if="entryId"
      class="memory-trace-modal-backdrop"
      role="dialog"
      :aria-label="$t('unify.memory.trace.title')"
      @click.self="$emit('close')"
      @keydown.esc="$emit('close')"
    >
      <div class="memory-trace-modal">
        <header class="memory-trace-modal-head">
          <h3>{{ $t('unify.memory.trace.title') }}</h3>
          <button
            type="button"
            class="memory-trace-modal-close"
            :aria-label="$t('unify.memory.trace.close')"
            @click="$emit('close')"
          >×</button>
        </header>
        <div class="memory-trace-modal-body">
          <p v-if="!trace" class="memory-trace-modal-loading">
            {{ $t('unify.memory.trace.loading') }}
          </p>
          <template v-else>
            <p v-if="trace.error" class="memory-trace-modal-error">
              {{ $t('unify.memory.trace.error', { error: trace.error }) }}
            </p>
            <template v-else-if="trace.entry">
              <section class="memory-trace-entry">
                <h4>{{ $t('unify.memory.trace.entry') }}</h4>
                <p class="memory-trace-entry-body">{{ trace.entry.body }}</p>
                <dl class="memory-trace-entry-meta">
                  <template v-if="trace.entry.kind"><dt>kind</dt><dd>{{ trace.entry.kind }}</dd></template>
                  <template v-if="trace.entry.shard"><dt>shard</dt><dd>{{ trace.entry.shard }}</dd></template>
                  <template v-if="trace.entry.vp"><dt>vp</dt><dd>{{ trace.entry.vp }}</dd></template>
                  <template v-if="trace.entry.task"><dt>task</dt><dd>{{ trace.entry.task }}</dd></template>
                </dl>
              </section>
              <section class="memory-trace-source">
                <h4>{{ $t('unify.memory.trace.source') }}</h4>
                <p v-if="!trace.sourceRef" class="memory-trace-empty">
                  {{ $t('unify.memory.trace.noSource') }}
                </p>
                <template v-else>
                  <dl class="memory-trace-source-ref">
                    <template v-if="trace.sourceRef.conversationId">
                      <dt>conversation</dt><dd>{{ trace.sourceRef.conversationId }}</dd>
                    </template>
                    <template v-if="trace.sourceRef.messageId">
                      <dt>message</dt><dd>{{ trace.sourceRef.messageId }}</dd>
                    </template>
                    <template v-if="trace.sourceRef.threadId">
                      <dt>thread</dt><dd>{{ trace.sourceRef.threadId }}</dd>
                    </template>
                    <template v-if="trace.sourceRef.range">
                      <dt>range</dt><dd>{{ formatRange(trace.sourceRef.range) }}</dd>
                    </template>
                  </dl>
                  <button
                    type="button"
                    class="memory-trace-jump-btn"
                    :disabled="!canJump"
                    @click="$emit('jump-to-message', trace.sourceRef)"
                  >{{ $t('unify.memory.trace.jump') }}</button>
                </template>
              </section>
            </template>
          </template>
        </div>
      </div>
    </div>
  `,
  setup(props) {
    const memStore = (window.Pinia && window.Pinia.useMemoryStore)
      ? window.Pinia.useMemoryStore()
      : null;

    // Issue the trace request when entryId becomes non-null.
    Vue.watch(() => props.entryId, (id) => {
      if (id && memStore) memStore.requestTrace(id);
    }, { immediate: true });

    const trace = Vue.computed(() => {
      if (!memStore || !props.entryId) return null;
      return memStore.traceFor(props.entryId);
    });

    const canJump = Vue.computed(() => {
      const t = trace.value;
      return !!(t && t.sourceRef && (t.sourceRef.conversationId || t.sourceRef.messageId));
    });

    function formatRange(r) {
      if (!r) return '';
      if (typeof r === 'string') return r;
      if (Array.isArray(r) && r.length === 2) return `${r[0]}–${r[1]}`;
      try { return JSON.stringify(r); } catch { return ''; }
    }

    return { trace, canJump, formatRange };
  },
};
