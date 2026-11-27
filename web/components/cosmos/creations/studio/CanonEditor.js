/**
 * Yeaft Cosmos Creations — CanonEditor
 *
 * Structured editor for the 4 Canon types (world, entity, ledger, rule).
 * Wired to creationsStore's Agent-scoped `upsertCanon` and `deleteCanon`.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

function cloneEntityState(state) {
  if (!state || typeof state !== 'object') return [];
  if (Array.isArray(state)) {
    return state.map((entry) => ({
      key: String(entry.key || ''),
      value: String(entry.value || ''),
    }));
  }
  return Object.entries(state).map(([key, value]) => ({
    key: String(key),
    value: String(value ?? ''),
  }));
}

function cloneLedgerRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    name: String(r?.name || ''),
    detail: String(r?.detail || ''),
    introduced: String(r?.introduced || ''),
    target: String(r?.target || ''),
    status: r?.status === 'resolved' ? 'resolved' : 'open',
  }));
}

export default {
  name: 'CanonEditor',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    item: { type: Object, required: true },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
  },
  emits: ['deleted'],
  data() {
    return {
      title: '',
      type: 'world',
      body: '',
      profile: '',
      statePairs: [],
      rows: [],
      pinned: false,
      locked: false,
      saving: false,
      hydrating: false,
      hydrateFailed: false,
      dirty: false,
      _canonFetchSeq: 0,
    };
  },
  computed: {
    resolvedAgentId() {
      return this.agentId || this.creationsStore.activeCreation?.agentId || '';
    },
    resolvedCreationId() {
      return this.creationId || this.creationsStore.activeCreation?.creationId || '';
    },
    isTruncated() {
      return Boolean(this.item?.contentTruncated || this.item?.stateTruncated);
    },
    isLockedForHydration() {
      return Boolean(this.hydrating || this.hydrateFailed || this.isTruncated);
    },
    saveDisabled() {
      return Boolean(this.saving || this.isLockedForHydration || !this.dirty);
    },
  },
  watch: {
    item: {
      immediate: true,
      handler(val) {
        if (!val) return;
        this.applyItem(val);
        this.hydrateFailed = false;
        if ((val.contentTruncated || val.stateTruncated) && val.id) {
          this.fetchFullCanon(val.id);
        } else {
          this.hydrating = false;
        }
      },
    },
  },
  methods: {
    applyItem(val) {
      this.title = val.title || '';
      this.type = val.type || 'world';
      this.body = val.contentMd || val.bodyMd || val.body || val.content || '';
      this.profile = val.profile || val.contentMd || val.bodyMd || val.body || '';
      this.statePairs = cloneEntityState(val.state);
      this.rows = cloneLedgerRows(val.rows || val.state?.rows);
      this.pinned = Boolean(val.pinned);
      this.locked = Boolean(val.lockedByUser ?? val.locked);
      this.dirty = false;
    },
    async fetchFullCanon(canonId) {
      const aId = this.resolvedAgentId;
      const cId = this.resolvedCreationId;
      if (!aId || !cId || typeof this.creationsStore.getCanon !== 'function') {
        this.hydrateFailed = true;
        this.hydrating = false;
        return;
      }
      const seq = ++this._canonFetchSeq;
      this.hydrating = true;
      this.hydrateFailed = false;
      try {
        const full = await this.creationsStore.getCanon(aId, cId, canonId);
        if (seq !== this._canonFetchSeq || this.item?.id !== canonId) return;
        if (full && typeof full === 'object') {
          this.applyItem(full);
          this.hydrateFailed = false;
        } else {
          this.hydrateFailed = true;
        }
      } catch {
        if (seq === this._canonFetchSeq && this.item?.id === canonId) {
          this.hydrateFailed = true;
        }
      } finally {
        if (seq === this._canonFetchSeq) {
          this.hydrating = false;
        }
      }
    },
    markDirty() {
      this.dirty = true;
    },
    addStateField() {
      this.statePairs.push({ key: '', value: '' });
      this.dirty = true;
    },
    removeStateField(idx) {
      this.statePairs.splice(idx, 1);
      this.dirty = true;
    },
    addLedgerRow() {
      this.rows.push({
        name: '',
        detail: '',
        introduced: '',
        target: '',
        status: 'open',
      });
      this.dirty = true;
    },
    removeLedgerRow(idx) {
      this.rows.splice(idx, 1);
      this.dirty = true;
    },
    toggleRowStatus(row) {
      row.status = row.status === 'resolved' ? 'open' : 'resolved';
      this.dirty = true;
    },
    async saveCanon() {
      if (this.hydrating || this.hydrateFailed || this.isTruncated) return;
      this.saving = true;
      try {
        const payload = {
          id: this.item.id,
          type: this.type,
          title: this.title.trim() || this.item.title,
          pinned: this.pinned,
          lockedByUser: this.locked,
        };
        if (this.type === 'entity') {
          const stateObj = {};
          for (const pair of this.statePairs) {
            const k = pair.key.trim();
            if (k) stateObj[k] = pair.value;
          }
          payload.contentMd = this.profile;
          payload.state = stateObj;
        } else if (this.type === 'ledger') {
          payload.state = { rows: this.rows.filter((r) => r.name.trim() || r.detail.trim()) };
          payload.contentMd = this.body;
        } else {
          payload.contentMd = this.body;
        }
        await this.creationsStore.upsertCanon(this.resolvedAgentId, this.resolvedCreationId, payload);
        this.dirty = false;
      } finally {
        this.saving = false;
      }
    },
    async removeCanon() {
      await this.creationsStore.deleteCanon(this.resolvedAgentId, this.resolvedCreationId, this.item.id);
      this.$emit('deleted', this.item.id);
    },
  },
  template: `
    <section class="creation-canon-editor">
      <header class="creation-canon-editor-head">
        <div class="creation-canon-title-row">
          <span class="creation-kind-badge">{{ $t('creation.canon.' + type) }}</span>
          <input
            v-model="title"
            class="creation-canon-title-input"
            :disabled="isLockedForHydration"
            :placeholder="$t('creation.canon.titlePlaceholder')"
            @input="markDirty"
          />
        </div>

        <div class="creation-canon-editor-actions">
          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': pinned }"
            :disabled="isLockedForHydration"
            @click="pinned = !pinned; markDirty()"
          >
            📌 {{ pinned ? $t('creation.canon.pinned') : $t('creation.canon.unpinned') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': locked }"
            :disabled="isLockedForHydration"
            @click="locked = !locked; markDirty()"
          >
            🔒 {{ locked ? $t('creation.canon.locked') : $t('creation.canon.unlocked') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn is-primary"
            :disabled="saveDisabled"
            @click="saveCanon"
          >
            {{ saving ? $t('creation.interior.saving') : $t('creation.interior.save') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn is-danger"
            @click="removeCanon"
          >
            {{ $t('creation.inspector.delete') }}
          </button>
        </div>
      </header>

      <div v-if="hydrateFailed" class="creation-conflict-banner" role="alert">
        <span>{{ $t('creation.canon.hydrateFailed') }}</span>
        <button
          type="button"
          class="creation-glass-btn"
          :disabled="hydrating"
          @click="fetchFullCanon(item.id)"
        >
          {{ $t('creation.canon.retryHydrate') }}
        </button>
      </div>

      <fieldset class="creation-canon-editor-body" :disabled="isLockedForHydration" style="border:0;margin:0;padding:0;min-width:0;">
        <!-- Entity Canon -->
        <template v-if="type === 'entity'">
          <div class="creation-canon-section">
            <h3 class="creation-canon-section-title">{{ $t('creation.canon.entity') }}</h3>
            <textarea
              v-model="profile"
              class="creation-canon-textarea"
              rows="8"
              :readonly="isLockedForHydration"
              :placeholder="$t('creation.canon.bodyPlaceholder')"
              @input="markDirty"
            ></textarea>
          </div>

          <div class="creation-canon-section">
            <div class="creation-canon-section-head">
              <h3 class="creation-canon-section-title">{{ $t('creation.canon.addStateField') }}</h3>
              <button type="button" class="creation-glass-btn" :disabled="isLockedForHydration" @click="addStateField">
                + {{ $t('creation.canon.addStateField') }}
              </button>
            </div>

            <table class="creation-canon-table">
              <tbody>
                <tr v-for="(pair, idx) in statePairs" :key="idx">
                  <td><input v-model="pair.key" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                  <td><input v-model="pair.value" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                  <td>
                    <button type="button" class="creation-icon-mini is-danger" :disabled="isLockedForHydration" @click="removeStateField(idx)">×</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- Ledger Canon -->
        <template v-else-if="type === 'ledger'">
          <div class="creation-canon-section">
            <div class="creation-canon-section-head">
              <h3 class="creation-canon-section-title">{{ $t('creation.canon.ledger') }}</h3>
              <button type="button" class="creation-glass-btn" :disabled="isLockedForHydration" @click="addLedgerRow">
                + {{ $t('creation.canon.addLedgerRow') }}
              </button>
            </div>

            <div class="creation-table-scroll">
              <table class="creation-canon-table">
                <tbody>
                  <tr v-for="(row, idx) in rows" :key="idx">
                    <td><input v-model="row.name" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                    <td><input v-model="row.detail" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                    <td><input v-model="row.introduced" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                    <td><input v-model="row.target" class="creation-inline-input" :readonly="isLockedForHydration" @input="markDirty" /></td>
                    <td>
                      <button
                        type="button"
                        class="creation-status-pill"
                        :class="row.status === 'resolved' ? 'is-completed' : 'is-active'"
                        :disabled="isLockedForHydration"
                        @click="toggleRowStatus(row)"
                      >
                        {{ row.status }}
                      </button>
                    </td>
                    <td>
                      <button type="button" class="creation-icon-mini is-danger" :disabled="isLockedForHydration" @click="removeLedgerRow(idx)">×</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <!-- World / Rule Canon -->
        <template v-else>
          <div class="creation-canon-section">
            <textarea
              v-model="body"
              class="creation-canon-textarea is-tall"
              rows="16"
              :readonly="isLockedForHydration"
              :placeholder="$t('creation.canon.bodyPlaceholder')"
              @input="markDirty"
            ></textarea>
          </div>
        </template>
      </fieldset>
    </section>
  `,
};
