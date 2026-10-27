import {
  clearOverlayPointerGesture,
  shouldDismissFromOverlayClick,
  trackOverlayPointerDown,
  trackOverlayPointerUp,
} from '../utils/overlay-dismiss.js';

// One application-level dialog serves both sidebar and conversation entry points.
// Closing abandons navigation, not the durable Agent operation.
export default {
  name: 'SessionMergeModal',
  props: { source: { type: Object, required: true } },
  emits: ['close'],
  data() {
    return { selectedId: '', busy: false, error: '', generation: 0 };
  },
  computed: {
    chat() { return window.Pinia.useChatStore(); },
    candidates() { return this.chat.sessionMergeCandidates(this.source); },
    selected() { return this.candidates.find(row => row.routeRef.sessionId === this.selectedId) || null; },
    unavailable() { return this.busy ? null : this.chat.sessionMergeUnavailableReason(this.source); },
    contextKey() {
      return JSON.stringify(this.chat.sessionBranchFence());
    },
    errorText() {
      if (this.error) return this.error;
      return this.unavailable ? this.$t('yeaft.session.error.' + this.unavailable) : '';
    },
  },
  watch: {
    contextKey() { this.close(); },
    busy(busy) {
      if (busy) this.$nextTick(() => this.$refs.close?.focus());
    },
  },
  mounted() {
    this.returnFocus = document.activeElement;
    document.addEventListener('keydown', this.onKeydown);
    this.$nextTick(() => (this.$refs.select || this.$refs.close)?.focus());
  },
  beforeUnmount() {
    this.generation++;
    document.removeEventListener('keydown', this.onKeydown);
  },
  methods: {
    trackOverlayPointerDown,
    trackOverlayPointerUp,
    clearOverlayPointerGesture,
    onOverlayClick(event) {
      if (shouldDismissFromOverlayClick(event)) this.close();
    },
    close() {
      this.generation++;
      this.$emit('close');
      if (this.returnFocus?.isConnected) this.returnFocus.focus();
    },
    onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Tab') {
        const controls = [...this.$refs.dialog.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
        const first = controls[0], last = controls.at(-1);
        const active = document.activeElement;
        if (!controls.includes(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault(); first?.focus();
        }
      }
    },
    async submit() {
      if (this.busy || this.unavailable || !this.selected) return;
      const generation = ++this.generation;
      const fence = this.chat.sessionBranchFence();
      this.error = '';
      this.busy = true;
      const result = await this.chat.mergeCatalogSessions(this.source, this.selected);
      if (generation !== this.generation || !this.chat.isSessionBranchFenceCurrent(fence)) return;
      this.busy = false;
      if (!result?.ok || !result.session?.id || result.session.agentId !== this.source.routeRef.agentId) {
        const code = result?.error?.code || 'merge_failed';
        const key = 'yeaft.session.error.' + code;
        const translated = this.$t(key);
        this.error = translated === key ? (result?.error?.message || this.$t('yeaft.session.error.merge_failed')) : translated;
        this.$nextTick(() => this.$refs.error?.focus());
        return;
      }
      const route = { ...this.source.routeRef, sessionId: result.session.id };
      this.close();
      this.chat.openCatalogSession({ catalogKey: `yeaft:${route.agentId}:${route.sessionId}`, routeRef: route });
    },
  },
  template: `
    <div class="modal-overlay session-merge-overlay"
      @pointerdown="trackOverlayPointerDown($event)" @pointerup="trackOverlayPointerUp($event)"
      @pointercancel="clearOverlayPointerGesture($event)" @click="onOverlayClick">
      <form ref="dialog" class="modal session-merge-modal" role="dialog" aria-modal="true"
        :aria-label="$t('yeaft.session.merge')" aria-describedby="session-merge-help" @submit.prevent="submit">
        <header class="modal-header">
          <h3>{{ $t('yeaft.session.merge') }}</h3>
          <button ref="close" type="button" class="modal-close" :aria-label="$t('common.close')" @click="close">×</button>
        </header>
        <div class="modal-body">
          <p id="session-merge-help" class="session-merge-help">{{ $t('yeaft.session.mergeHelp') }}</p>
          <label for="session-merge-source">{{ $t('yeaft.session.mergeWith') }}</label>
          <select v-if="candidates.length" id="session-merge-source" ref="select" v-model="selectedId" :disabled="busy">
            <option disabled value="">{{ $t('yeaft.session.mergeChoose') }}</option>
            <option v-for="row in candidates" :key="row.catalogKey" :value="row.routeRef.sessionId">{{ row.title || row.routeRef.sessionId }}</option>
          </select>
          <p v-else class="session-merge-empty" role="status">{{ $t('yeaft.session.mergeEmpty') }}</p>
          <p v-if="errorText" ref="error" class="session-merge-error" role="alert" tabindex="-1">{{ errorText }}</p>
          <p v-if="busy" class="session-merge-help" role="status">{{ $t('yeaft.session.merging') }}</p>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn-secondary" @click="close">{{ $t('common.close') }}</button>
          <button type="submit" class="btn-primary" :disabled="busy || !!unavailable || !selected" :aria-busy="busy ? 'true' : 'false'">{{ $t(busy ? 'yeaft.session.merging' : 'yeaft.session.merge') }}</button>
        </footer>
      </form>
    </div>
  `,
};
