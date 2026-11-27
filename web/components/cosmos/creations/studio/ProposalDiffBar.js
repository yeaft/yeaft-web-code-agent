/**
 * Yeaft Cosmos Creations — ProposalDiffBar
 *
 * Computes a clean line-level diff between current node content and each pending
 * unit proposal (+N / -M badge + collapsible green/red diff preview).
 * Wired to creationsStore.resolveProposal(agentId, creationId, proposalId, decision).
 */
import { useCreationsStore } from '../../../../stores/creations.js';

function normalizeDiffText(val) {
  if (typeof val === 'string') return val;
  if (val == null) return '';
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function computeLineDiff(oldText, newText) {
  const a = normalizeDiffText(oldText).split('\n');
  const b = normalizeDiffText(newText).split('\n');
  const MAX_LINES = 600;
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const ops = [];
    const maxLen = Math.max(a.length, b.length);
    let added = 0;
    let removed = 0;
    for (let i = 0; i < maxLen; i += 1) {
      if (a[i] === b[i]) {
        ops.push({ type: 'same', text: a[i] });
      } else {
        if (i < a.length) {
          ops.push({ type: 'del', text: a[i] });
          removed += 1;
        }
        if (i < b.length) {
          ops.push({ type: 'add', text: b[i] });
          added += 1;
        }
      }
    }
    return { ops, added, removed };
  }

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      removed += 1;
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ type: 'del', text: a[i] });
    removed += 1;
    i += 1;
  }
  while (j < n) {
    ops.push({ type: 'add', text: b[j] });
    added += 1;
    j += 1;
  }
  return { ops, added, removed };
}

export default {
  name: 'ProposalDiffBar',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    node: { type: Object, required: true },
    currentContent: { type: String, default: '' },
    proposals: { type: Array, default: () => [] },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
  },
  emits: ['tune-proposal'],
  data() {
    return {
      expandedIds: {},
      busyId: null,
    };
  },
  computed: {
    resolvedAgentId() {
      return this.agentId || this.creationsStore.activeCreation?.agentId || '';
    },
    resolvedCreationId() {
      return this.creationId || this.creationsStore.activeCreation?.creationId || '';
    },
    enrichedProposals() {
      return (this.proposals || []).map((p) => {
        const nextText = p.proposedContent ?? p.content ?? p.payload?.content ?? '';
        const diff = computeLineDiff(this.currentContent, nextText);
        const hasConflict = Boolean(
          p.baseRevId && this.node?.currentRevId && p.baseRevId !== this.node.currentRevId
        );
        return { proposal: p, diff, hasConflict };
      });
    },
  },
  methods: {
    isExpanded(id) {
      return Boolean(this.expandedIds[id]);
    },
    toggleExpand(id) {
      this.expandedIds = { ...this.expandedIds, [id]: !this.expandedIds[id] };
    },
    async resolve(proposalId, decision) {
      this.busyId = proposalId;
      try {
        await this.creationsStore.resolveProposal(
          this.resolvedAgentId,
          this.resolvedCreationId,
          proposalId,
          decision
        );
      } finally {
        this.busyId = null;
      }
    },
  },
  template: `
    <div v-if="enrichedProposals.length > 0" class="creation-proposal-stack">
      <div
        v-for="entry in enrichedProposals"
        :key="entry.proposal.id"
        class="creation-proposal-bar"
        :class="{ 'has-conflict': entry.hasConflict }"
      >
        <div class="creation-proposal-head">
          <div class="creation-proposal-info">
            <span class="creation-status-pill is-needs_attention">✦ {{ $t('creation.proposal.title') }}</span>
            <span class="creation-proposal-summary">
              {{ entry.proposal.summary || entry.proposal.title || '' }}
            </span>
            <span class="creation-diff-add">+{{ entry.diff.added }} {{ $t('creation.proposal.added') }}</span>
            <span class="creation-diff-del">-{{ entry.diff.removed }} {{ $t('creation.proposal.removed') }}</span>
          </div>

          <div class="creation-proposal-actions">
            <button
              type="button"
              class="creation-glass-btn"
              @click="toggleExpand(entry.proposal.id)"
            >
              {{ isExpanded(entry.proposal.id) ? '▴' : '▾' }} Diff
            </button>
            <button
              type="button"
              class="creation-glass-btn is-primary"
              :disabled="busyId === entry.proposal.id"
              @click="resolve(entry.proposal.id, 'accept')"
            >
              ✓ {{ $t('creation.proposal.accept') }}
            </button>
            <button
              type="button"
              class="creation-glass-btn"
              @click="$emit('tune-proposal', entry.proposal)"
            >
              ✎ {{ $t('creation.proposal.continueTune') }}
            </button>
            <button
              type="button"
              class="creation-glass-btn is-danger"
              :disabled="busyId === entry.proposal.id"
              @click="resolve(entry.proposal.id, 'reject')"
            >
              ✕ {{ $t('creation.proposal.reject') }}
            </button>
          </div>
        </div>

        <div v-if="entry.hasConflict" class="creation-proposal-conflict">
          ⚠ {{ $t('creation.proposal.conflictWarn') }}
        </div>

        <div v-if="isExpanded(entry.proposal.id)" class="creation-proposal-diff">
          <div
            v-for="(line, li) in entry.diff.ops"
            :key="li"
            class="creation-diff-line"
            :class="{ 'creation-diff-add': line.type === 'add', 'creation-diff-del': line.type === 'del' }"
          >
            <span class="creation-diff-sign">{{ line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ') }}</span>
            <span class="creation-diff-text">{{ line.text }}</span>
          </div>
        </div>
      </div>
    </div>
  `,
};
