/**
 * Yeaft Cosmos Creations — OutlineBoard
 *
 * Shown when a folder/volume (or root outline view) is selected in Studio mode.
 * Wired to creationsStore's Agent-scoped `updateNode`, `reorderNodes`, `startBatchRun`.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

function isFolderNode(n) {
  if (!n) return false;
  return n.kind === 'folder' || n.nodeType === 'folder' || n.type === 'folder' || n.isFolder === true;
}

export default {
  name: 'OutlineBoard',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    folder: { type: Object, default: null },
    nodes: { type: Array, default: () => [] },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
  },
  emits: ['select-node', 'create-unit'],
  data() {
    return {
      selectedIds: [],
      checkpointEvery: 5,
      batchInstruction: '',
      startingBatch: false,
      editingSummaries: {},
      loadingOutlineIds: {},
      addingUnit: false,
      newUnitTitle: '',
      newUnitSummary: '',
    };
  },
  computed: {
    resolvedAgentId() {
      return this.agentId || this.creationsStore.activeCreation?.agentId || '';
    },
    resolvedCreationId() {
      return this.creationId || this.creationsStore.activeCreation?.creationId || '';
    },
    allSiblings() {
      const folderId = this.folder?.id || null;
      return (this.nodes || [])
        .filter((n) => n && (folderId ? n.parentId === folderId : !n.parentId))
        .sort((a, b) => (a.sortOrder ?? a.position ?? 0) - (b.sortOrder ?? b.position ?? 0));
    },
    childUnits() {
      return this.allSiblings.filter((n) => !isFolderNode(n));
    },
    eligibleUnits() {
      return this.childUnits.filter((u) => this.isBatchEligible(u));
    },
    allSelected() {
      return this.eligibleUnits.length > 0 && this.eligibleUnits.every((u) => this.selectedIds.includes(u.id));
    },
    boardTitle() {
      return this.folder?.title || this.$t('creation.studio.outlineBoard');
    },
  },
  watch: {
    'folder.id'() {
      this.selectedIds = [];
      this.editingSummaries = {};
      this.loadingOutlineIds = {};
    },
  },
  methods: {
    isBatchEligible(node) {
      if (!node) return false;
      return node.batchEligible !== false && node.status !== 'final' && !node.userEdited;
    },
    isSelected(id) {
      return this.selectedIds.includes(id);
    },
    toggleSelect(unitOrId) {
      const unit = typeof unitOrId === 'object' ? unitOrId : this.childUnits.find((u) => u.id === unitOrId);
      if (!unit || !this.isBatchEligible(unit)) return;
      const id = unit.id;
      if (this.isSelected(id)) {
        this.selectedIds = this.selectedIds.filter((x) => x !== id);
      } else {
        this.selectedIds = [...this.selectedIds, id];
      }
    },
    toggleSelectAll() {
      this.selectedIds = this.allSelected ? [] : this.eligibleUnits.map((u) => u.id);
    },
    getSummaryDraft(unit) {
      return this.editingSummaries[unit.id] !== undefined
        ? this.editingSummaries[unit.id]
        : (unit.outlineMd ?? unit.summary ?? '');
    },
    onSummaryInput(unit, value) {
      this.editingSummaries = { ...this.editingSummaries, [unit.id]: value };
    },
    async loadFullOutline(unit) {
      if (!unit?.id || this.loadingOutlineIds[unit.id]) return;
      this.loadingOutlineIds = { ...this.loadingOutlineIds, [unit.id]: true };
      try {
        await this.creationsStore.loadNode(this.resolvedAgentId, this.resolvedCreationId, unit.id);
      } finally {
        const next = { ...this.loadingOutlineIds };
        delete next[unit.id];
        this.loadingOutlineIds = next;
      }
    },
    async saveSummary(unit) {
      if (this.editingSummaries[unit.id] === undefined) return;
      const outlineMd = this.editingSummaries[unit.id];
      const prevOutline = unit.outlineMd ?? unit.summary ?? '';
      if (outlineMd !== prevOutline) {
        await this.creationsStore.updateNode(this.resolvedAgentId, this.resolvedCreationId, unit.id, { outlineMd });
      }
      const next = { ...this.editingSummaries };
      delete next[unit.id];
      this.editingSummaries = next;
    },
    async moveUnit(idx, delta) {
      const target = idx + delta;
      if (target < 0 || target >= this.childUnits.length) return;
      const unitA = this.childUnits[idx];
      const unitB = this.childUnits[target];
      if (!unitA || !unitB) return;
      const ordered = this.allSiblings.map((s) => s.id);
      const posA = ordered.indexOf(unitA.id);
      const posB = ordered.indexOf(unitB.id);
      if (posA < 0 || posB < 0) return;
      ordered[posA] = unitB.id;
      ordered[posB] = unitA.id;
      await this.creationsStore.reorderNodes(
        this.resolvedAgentId,
        this.resolvedCreationId,
        this.folder?.id || null,
        ordered
      );
    },
    async startBatch() {
      const ids = this.selectedIds.length > 0
        ? this.eligibleUnits.filter((u) => this.selectedIds.includes(u.id)).map((u) => u.id)
        : this.eligibleUnits.map((u) => u.id);
      if (!ids.length) return;
      this.startingBatch = true;
      try {
        await this.creationsStore.startBatchRun(this.resolvedAgentId, this.resolvedCreationId, {
          nodeIds: ids,
          checkpointEvery: Math.max(1, Number(this.checkpointEvery) || 5),
          instruction: this.batchInstruction.trim() || undefined,
        });
        this.batchInstruction = '';
      } finally {
        this.startingBatch = false;
      }
    },
    submitNewUnit() {
      const title = this.newUnitTitle.trim();
      if (!title) return;
      this.$emit('create-unit', {
        parentId: this.folder?.id || null,
        title,
        outlineMd: this.newUnitSummary.trim(),
        modality: 'markdown_doc',
      });
      this.newUnitTitle = '';
      this.newUnitSummary = '';
      this.addingUnit = false;
    },
  },
  template: `
    <section class="creation-outline-board">
      <header class="creation-outline-header">
        <div class="creation-outline-heading">
          <h2 class="creation-outline-title">{{ boardTitle }}</h2>
          <span class="creation-outline-count">{{ $t('creation.inspector.units', { count: childUnits.length }) }}</span>
        </div>

        <button type="button" class="creation-glass-btn" @click="addingUnit = !addingUnit">
          + {{ $t('creation.studio.addChapter') }}
        </button>
      </header>

      <!-- Top Batch Execution Toolbar -->
      <div class="creation-batch-toolbar">
        <label class="creation-batch-select-all">
          <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
          <span>{{ $t('creation.studio.selectForBatch') }} ({{ selectedIds.length }})</span>
        </label>

        <label class="creation-batch-checkpoint">
          <input
            v-model.number="checkpointEvery"
            type="number"
            min="1"
            max="50"
            class="creation-num-input"
          />
          <span>{{ $t('creation.studio.checkpointEvery', { count: checkpointEvery }) }}</span>
        </label>

        <input
          v-model="batchInstruction"
          class="creation-batch-instruction"
          :placeholder="$t('creation.studio.batchInstruction')"
        />

        <button
          type="button"
          class="creation-glass-btn is-primary"
          :disabled="startingBatch || eligibleUnits.length === 0"
          @click="startBatch"
        >
          ✦ {{ $t('creation.studio.startBatch') }}
        </button>
      </div>

      <!-- Add Unit Outline Form -->
      <form v-if="addingUnit" class="creation-outline-add-form" @submit.prevent="submitNewUnit">
        <input
          v-model="newUnitTitle"
          class="creation-inline-input"
          :placeholder="$t('creation.studio.unitPlaceholder')"
          autofocus
        />
        <textarea
          v-model="newUnitSummary"
          class="creation-inline-textarea"
          rows="2"
          :placeholder="$t('creation.studio.batchInstruction')"
        ></textarea>
        <div class="creation-outline-add-actions">
          <button type="submit" class="creation-glass-btn is-primary">{{ $t('creation.studio.addChapter') }}</button>
          <button type="button" class="creation-glass-btn" @click="addingUnit = false">{{ $t('creation.canon.dismiss') }}</button>
        </div>
      </form>

      <!-- Unit Cards Grid -->
      <div v-if="childUnits.length === 0" class="creation-outline-empty">
        <p>{{ $t('creation.studio.noFolders') }}</p>
      </div>

      <div v-else class="creation-outline-grid">
        <article
          v-for="(unit, idx) in childUnits"
          :key="unit.id"
          class="creation-outline-card"
          :class="{ 'is-selected': isSelected(unit.id) }"
        >
          <div class="creation-outline-card-head">
            <label class="creation-outline-check" @click.stop>
              <input
                type="checkbox"
                :checked="isSelected(unit.id)"
                :disabled="!isBatchEligible(unit)"
                @change="toggleSelect(unit)"
              />
            </label>
            <button type="button" class="creation-outline-card-title" @click="$emit('select-node', unit.id)">
              {{ unit.title }}
            </button>
            <span v-if="!isBatchEligible(unit)" class="creation-status-pill is-locked">
              {{ unit.status === 'final' ? $t('creation.status.final') : $t('creation.studio.batchSkipped') }}
            </span>
            <span v-else class="creation-status-pill" :class="'is-' + (unit.status || 'outline')">
              {{ $t('creation.status.' + (unit.status || 'outline')) }}
            </span>
          </div>

          <div v-if="unit.outlineTruncated === true" class="creation-outline-truncated">
            <p class="creation-outline-preview">{{ unit.outlineMd ?? unit.summary ?? '' }}</p>
            <button
              type="button"
              class="creation-glass-btn creation-outline-load-btn"
              :disabled="Boolean(loadingOutlineIds[unit.id])"
              @click="loadFullOutline(unit)"
            >
              {{ loadingOutlineIds[unit.id] ? $t('creation.studio.loadingFullOutline') : $t('creation.studio.loadFullOutline') }}
            </button>
          </div>
          <textarea
            v-else
            class="creation-outline-summary"
            rows="3"
            :value="getSummaryDraft(unit)"
            :placeholder="$t('creation.studio.unitPlaceholder')"
            @input="onSummaryInput(unit, $event.target.value)"
            @blur="saveSummary(unit)"
          ></textarea>

          <footer class="creation-outline-card-foot">
            <span class="creation-outline-wc">{{ $t('creation.inspector.words', { count: unit.wordCount || 0 }) }}</span>
            <div class="creation-outline-card-btns">
              <button type="button" class="creation-icon-mini" :disabled="idx === 0" @click="moveUnit(idx, -1)">↑</button>
              <button type="button" class="creation-icon-mini" :disabled="idx === childUnits.length - 1" @click="moveUnit(idx, 1)">↓</button>
              <button type="button" class="creation-glass-btn" @click="$emit('select-node', unit.id)">
                {{ $t('creation.studio.editorView') }} →
              </button>
            </div>
          </footer>
        </article>
      </div>
    </section>
  `,
};
