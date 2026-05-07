import VpAvatar from './VpAvatar.js';

/**
 * VpQuickCard — compact card rendering for `intent === 'feature'` VP turns.
 * Replaces the full-AssistantTurn render in the main message stream;
 * clicking opens the right-side VpTurnDetailDrawer with the same turn's
 * full content.
 *
 * Props:
 *   turn    — turnGroups item: { speakerVpId, turnId, isStreaming, toolMsgs[],
 *             speakerStateCause, intent }
 *   preview — store.unifyQuickPreviews entry: { intent, preview, ... } | null
 *
 * Emits:
 *   open-detail({ vpId, turnId })
 */
export default {
  name: 'VpQuickCard',
  components: { VpAvatar },
  emits: ['open-detail'],
  props: {
    turn: { type: Object, required: true },
    preview: { type: Object, default: null },
  },
  computed: {
    previewText() {
      return (this.preview && this.preview.preview) || '';
    },
    status() {
      const t = this.turn;
      if (t.speakerStateCause === 'vp_typing_aborted') {
        return { kind: 'aborted' };
      }
      if (!t.isStreaming) {
        return { kind: 'done', toolCount: (t.toolMsgs || []).length };
      }
      const tools = t.toolMsgs || [];
      const last = tools[tools.length - 1];
      if (last && !last.hasResult) {
        return { kind: 'tool', toolName: last.toolName || 'tool' };
      }
      return { kind: 'thinking' };
    },
  },
  methods: {
    onClick() {
      this.$emit('open-detail', {
        vpId: this.turn.speakerVpId,
        turnId: this.turn.turnId,
      });
    },
  },
  template: `
    <div class="vp-quick-card" @click="onClick" role="button" tabindex="0"
         @keydown.enter.prevent="onClick" @keydown.space.prevent="onClick">
      <div class="vp-card-header">
        <VpAvatar :vp-id="turn.speakerVpId" :size="28" />
        <span class="vp-card-name">{{ turn.speakerVpId }}</span>
      </div>
      <div v-if="previewText" class="vp-card-preview">{{ previewText }}</div>
      <div class="vp-card-status" :class="'status-' + status.kind">
        <template v-if="status.kind === 'thinking'">
          <span class="vp-card-status-dot"></span>
          <span>{{ $t('unify.vp.status.thinking') }}</span>
        </template>
        <template v-else-if="status.kind === 'tool'">
          <span class="vp-card-status-icon">🔧</span>
          <span>{{ $t('unify.vp.status.tool', { name: status.toolName }) }}</span>
        </template>
        <template v-else-if="status.kind === 'done'">
          <span class="vp-card-status-icon">✓</span>
          <span>{{ $t('unify.vp.status.done', { count: status.toolCount }) }}</span>
        </template>
        <template v-else-if="status.kind === 'aborted'">
          <span class="vp-card-status-icon">⊘</span>
          <span>{{ $t('unify.vp.status.aborted') }}</span>
        </template>
      </div>
    </div>
  `,
};
