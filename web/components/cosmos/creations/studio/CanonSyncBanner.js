/**
 * Yeaft Cosmos Creations — CanonSyncBanner
 *
 * Floating subtle bar at the bottom of the Studio canvas whenever there are
 * pending Canon update proposals. Wired to creationsStore.resolveProposal.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

export default {
  name: 'CanonSyncBanner',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    proposals: { type: Array, default: () => [] },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
  },
  data() {
    return {
      selectedMap: {},
      busy: false,
    };
  },
  watch: {
    proposals: {
      immediate: true,
      handler(list) {
        const next = {};
        for (const p of list || []) {
          next[p.id] = this.selectedMap[p.id] !== undefined ? this.selectedMap[p.id] : true;
        }
        this.selectedMap = next;
      },
    },
  },
  computed: {
    resolvedAgentId() {
      return this.agentId || this.creationsStore.activeCreation?.agentId || '';
    },
    resolvedCreationId() {
      return this.creationId || this.creationsStore.activeCreation?.creationId || '';
    },
    selectedIds() {
      return (this.proposals || []).filter((p) => this.selectedMap[p.id]).map((p) => p.id);
    },
  },
  methods: {
    toggleItem(id) {
      this.selectedMap = { ...this.selectedMap, [id]: !this.selectedMap[id] };
    },
    formatPatchPreview(p) {
      const parts = [];
      const contentMd = p?.patch?.contentMd ?? p?.canonPayload?.contentMd ?? p?.canonItem?.contentMd;
      if (typeof contentMd === 'string' && contentMd.trim()) {
        parts.push(contentMd.trim().slice(0, 180));
      }
      const stateVal = p?.patch?.state ?? p?.canonPayload?.state ?? p?.canonItem?.state;
      if (stateVal && typeof stateVal === 'object' && Object.keys(stateVal).length > 0) {
        try {
          parts.push(JSON.stringify(stateVal).slice(0, 180));
        } catch {
          // ignore
        }
      }
      return parts.join(' · ');
    },
    async syncSelected() {
      this.busy = true;
      try {
        for (const p of this.proposals) {
          if (!this.selectedMap[p.id]) continue;
          await this.creationsStore.resolveProposal(
            this.resolvedAgentId,
            this.resolvedCreationId,
            p.id,
            'accept'
          );
        }
      } finally {
        this.busy = false;
      }
    },
    async dismissAll() {
      this.busy = true;
      try {
        for (const p of this.proposals) {
          await this.creationsStore.resolveProposal(
            this.resolvedAgentId,
            this.resolvedCreationId,
            p.id,
            'reject'
          );
        }
      } finally {
        this.busy = false;
      }
    },
  },
  template: `
    <div v-if="proposals.length > 0" class="creation-canon-sync-banner">
      <div class="creation-canon-sync-head">
        <span class="creation-canon-sync-title">
          ✦ {{ $t('creation.canon.syncTitle', { count: proposals.length }) }}
        </span>
        <div class="creation-canon-sync-actions">
          <button
            type="button"
            class="creation-glass-btn is-primary"
            :disabled="busy || selectedIds.length === 0"
            @click="syncSelected"
          >
            ✦ {{ $t('creation.canon.syncAll') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn"
            :disabled="busy"
            @click="dismissAll"
          >
            {{ $t('creation.canon.dismiss') }}
          </button>
        </div>
      </div>

      <ul class="creation-canon-sync-list">
        <li v-for="p in proposals" :key="p.id" class="creation-canon-sync-item">
          <label class="creation-canon-sync-check">
            <input type="checkbox" :checked="Boolean(selectedMap[p.id])" @change="toggleItem(p.id)" />
            <strong class="creation-canon-sync-name">{{ p.title || p.patch?.title || p.canonItem?.title || p.canonPayload?.title || p.id }}</strong>
            <span v-if="p.summary" class="creation-canon-sync-summary">{{ p.summary }}</span>
            <span v-if="formatPatchPreview(p)" class="creation-canon-sync-preview">{{ formatPatchPreview(p) }}</span>
          </label>
        </li>
      </ul>
    </div>
  `,
};
