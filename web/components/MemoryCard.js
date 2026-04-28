/**
 * MemoryCard.js — R6 G2.
 *
 * Renders a single R6 memory shard entry. Read-only — entries are
 * authored by the dream cycle (auto-merge) or by explicit memory_save
 * tool calls; the user does not edit them inline. Click → open the
 * MemoryTraceModal for the entry's source message.
 *
 * Reused by:
 *   - VpDetailView "Memory" tab (per-VP shard)
 *   - UnifyFeatureDetailView "Feature Memory" section (per-feature shard)
 *   - UserMemoryPage (eventual refactor target — kept compatible)
 *
 * Props:
 *   entry { id, shard, body, importance?, tags?, kind?, vp?, task?,
 *           sourceRef?, supersededBy?, createdAt?, updatedAt? }
 *
 * Emits:
 *   open-trace (entryId) — parent should mount MemoryTraceModal.
 */
export default {
  name: 'MemoryCard',
  emits: ['open-trace'],
  props: {
    entry: { type: Object, required: true },
    /** When true, render the kind chip prominently. */
    showKind: { type: Boolean, default: true },
  },
  template: `
    <article
      class="memory-card"
      :class="['memory-card-' + (entry.shard || 'general'), entry.supersededBy ? 'memory-card-superseded' : null]"
      :aria-label="$t('unify.memory.card.aria', { id: entry.id })"
    >
      <header class="memory-card-head">
        <span v-if="showKind && entry.kind" class="memory-card-kind">{{ entry.kind }}</span>
        <span v-if="entry.shard" class="memory-card-shard">{{ entry.shard }}</span>
        <span v-if="entry.importance != null" class="memory-card-importance" :title="$t('unify.memory.card.importance')">
          ★{{ Math.round(entry.importance * 10) / 10 }}
        </span>
        <time v-if="timeLabel" class="memory-card-time">{{ timeLabel }}</time>
      </header>
      <p class="memory-card-body">{{ bodyExcerpt }}</p>
      <ul v-if="hasTags" class="memory-card-tags">
        <li v-for="t in entry.tags" :key="t" class="memory-card-tag">#{{ t }}</li>
      </ul>
      <footer class="memory-card-foot">
        <button
          type="button"
          class="memory-card-trace-btn"
          @click="$emit('open-trace', entry.id)"
          :disabled="!entry.sourceRef"
          :title="entry.sourceRef ? $t('unify.memory.card.traceTitle') : $t('unify.memory.card.traceUnavailable')"
        >
          {{ $t('unify.memory.card.trace') }}
        </button>
        <span v-if="entry.supersededBy" class="memory-card-superseded-tag">
          {{ $t('unify.memory.card.supersededBy', { id: entry.supersededBy }) }}
        </span>
      </footer>
    </article>
  `,
  computed: {
    bodyExcerpt() {
      const b = (this.entry && this.entry.body) || '';
      const s = String(b).trim();
      return s.length > 280 ? s.slice(0, 280) + '…' : s;
    },
    hasTags() {
      const t = this.entry && this.entry.tags;
      return Array.isArray(t) && t.length > 0;
    },
    timeLabel() {
      const ts = this.entry && (this.entry.updatedAt || this.entry.createdAt);
      if (!ts) return '';
      try {
        const d = typeof ts === 'string' ? new Date(ts) : new Date(Number(ts));
        return d.toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
      } catch { return ''; }
    },
  },
};
