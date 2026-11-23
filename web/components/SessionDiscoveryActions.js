import NavigationIcon from './NavigationIcon.js';
import { useAuthStore } from '../stores/auth.js';
import { requestSessionDiscovery, supportsSessionDiscovery } from '../stores/helpers/session-discovery.js';

const kinds = ['consensus', 'output'];
const isShareItem = item => typeof item?.id === 'string' && kinds.includes(item.kind)
  && ['candidate', 'published'].includes(item.status)
  && typeof item.title === 'string' && typeof item.body === 'string'
  && Number.isSafeInteger(item.updatedAt)
  && (item.status !== 'candidate' || typeof item.sourceSessionId === 'string');

function newCreateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID is secure-context-only; self-hosted HTTP can use getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default {
  name: 'SessionDiscoveryActions',
  components: { NavigationIcon },
  emits: ['select'],
  props: {
    store: { type: Object, required: true },
    agents: { type: Array, required: true },
    sessions: { type: Array, required: true },
    catalogLoading: Boolean,
    projectPath: { type: Function, required: true },
  },
  setup() {
    const auth = useAuthStore();
    return { titleId: Vue.useId(), connectionOwner: Vue.computed(() => auth.authGeneration) };
  },
  data() {
    return {
      mode: '', agentId: '', controller: null, operation: '', errorKey: '',
      query: '', results: null, firstIndexPending: false, items: null, draft: null, removing: null,
    };
  },
  computed: {
    serverSupported() { return this.store.sessionDiscoverySupported === true; },
    turnDeletions() { return this.store.yeaftTurnDeleteHistoryBySession; },
    supportedAgents() { return this.agents.filter(supportsSessionDiscovery); },
    onlineAgents() { return this.supportedAgents.filter(agent => agent.online); },
    connected() { return this.store.connectionState === 'connected'; },
    targetAvailable() { return this.serverSupported && this.connected && this.onlineAgents.some(agent => agent.id === this.agentId); },
    mutating() { return ['share_save', 'share_delete'].includes(this.operation); },
    catalogBySessionId() {
      const rows = new Map();
      if (!this.catalogLoading && this.targetAvailable && this.mode === 'search') {
        for (const row of this.sessions) {
          const route = row.routeRef;
          if (row.catalogKey && !row.hidden && route?.runtimeProvider === 'yeaft' && route.agentId === this.agentId) {
            rows.set(route.sessionId, row);
          }
        }
      }
      return rows;
    },
    visibleResults() {
      return [...(this.results || [])].flatMap(result => {
        const row = this.catalogBySessionId.get(result.sessionId);
        return row ? [{ row, title: row.title || result.title, snippet: result.snippet, path: this.projectPath(row) }] : [];
      });
    },
  },
  watch: {
    connectionOwner() { this.close(); },
    targetAvailable(available) {
      if (!available) {
        const { draft, removing } = this;
        const writeUnconfirmed = this.mutating || this.errorKey === 'sessionDiscovery.writeFailed';
        this.clearResults();
        // Retry an unconfirmed write against the same Agent with the original identity/version.
        if (writeUnconfirmed) {
          this.draft = draft;
          this.removing = removing;
          this.errorKey = 'sessionDiscovery.writeFailed';
        }
      } else if (this.mode === 'share' && this.items === null && !this.draft && !this.removing && !this.operation) {
        void this.loadShare();
      }
    },
    turnDeletions(next, previous) {
      if (!this.mode || !this.agentId) return;
      const deletedSessions = new Set(Object.entries(next || {}).flatMap(([key, deletion]) =>
        deletion.agentId === this.agentId && deletion.epoch !== previous?.[key]?.epoch ? [deletion.sessionId] : []));
      if (!deletedSessions.size) return;
      if (this.mode === 'search') {
        // A deletion changes the searchable snapshot, including any query in flight.
        this.editQuery();
        return;
      }
      const staleCandidate = item => item?.status === 'candidate' && deletedSessions.has(item.sourceSessionId);
      // An in-flight list may describe an older snapshot; request it again.
      this.items = null;
      if (staleCandidate(this.draft) || staleCandidate(this.removing)) {
        this.stopRequest();
        this.returnToList();
        return;
      }
      if (this.targetAvailable && !this.draft && !this.removing) void this.loadShare();
    },
  },
  beforeUnmount() { this.stopRequest(); },
  methods: {
    open(mode) {
      if (!this.serverSupported) return;
      this.clearResults();
      this.mode = mode;
      this.query = '';
      const preferred = this.store.activeSessionRoute?.agentId || this.store.currentAgent;
      this.agentId = this.onlineAgents.find(agent => agent.id === preferred)?.id || this.onlineAgents[0]?.id || '';
      this.$refs.dialog.showModal();
      this.$nextTick(() => (mode === 'search' && this.targetAvailable ? this.$refs.query : this.$refs.agent)?.focus());
      if (mode === 'share' && this.targetAvailable) void this.loadShare();
    },
    close() {
      this.mode = '';
      this.clearResults();
      if (this.$refs.dialog?.open) this.$refs.dialog.close();
    },
    stopRequest() {
      this.controller?.abort();
      this.controller = null;
      this.operation = '';
    },
    clearResults() {
      this.stopRequest();
      this.errorKey = '';
      this.results = null;
      this.firstIndexPending = false;
      this.items = null;
      this.draft = null;
      this.removing = null;
    },
    changeAgent(event) {
      this.clearResults();
      this.agentId = event.target.value;
      if (this.mode === 'share') void this.loadShare();
      else if (this.query.trim()) void this.search();
    },
    async request(op, payload, accept) {
      this.stopRequest();
      const controller = new AbortController();
      this.controller = controller;
      this.operation = op;
      this.errorKey = '';
      try {
        const data = await requestSessionDiscovery(this.store, this.agentId, op, payload, controller.signal);
        if (!controller.signal.aborted && this.targetAvailable) accept(data);
      } catch {
        if (!controller.signal.aborted) this.errorKey = this.mutating ? 'sessionDiscovery.writeFailed' : 'sessionDiscovery.readFailed';
      } finally {
        if (this.controller === controller) this.stopRequest();
      }
    },
    search() {
      const query = this.query.trim();
      if (!query || !this.targetAvailable) return;
      this.results = null;
      this.firstIndexPending = false;
      return this.request('search', { query }, data => {
        if (!Array.isArray(data?.results)) throw new Error('invalid search response');
        this.firstIndexPending = data.indexedAt === null;
        if (this.firstIndexPending) return;
        this.results = data.results.filter(result => typeof result?.sessionId === 'string'
          && typeof result.title === 'string' && typeof result.snippet === 'string');
      });
    },
    editQuery() {
      this.stopRequest();
      this.results = null;
      this.firstIndexPending = false;
      this.errorKey = '';
    },
    selectResult(sessionId) {
      // Resolve against the live, owner-scoped sidebar catalog, not the index.
      const row = this.catalogBySessionId.get(sessionId);
      if (!row) return;
      this.close();
      this.$emit('select', row);
    },
    loadShare() {
      return this.request('share_list', {}, data => {
        if (!Array.isArray(data?.items)) throw new Error('invalid Share response');
        this.items = data.items.filter(isShareItem);
      });
    },
    edit(item = null) {
      this.errorKey = '';
      this.draft = item ? { ...item } : { createId: newCreateId(), kind: 'output', title: '', body: '' };
      this.$nextTick(() => this.$refs.draftTitle?.focus());
    },
    returnToList() {
      if (this.errorKey === 'sessionDiscovery.writeFailed') this.items = null;
      this.draft = null;
      this.removing = null;
      this.errorKey = '';
      if (this.items === null && this.targetAvailable) void this.loadShare();
      this.$nextTick(() => this.$refs.add?.focus());
    },
    save() {
      if (this.operation || !this.draft || !this.targetAvailable) return;
      const { id, createId, kind, title, body, updatedAt } = this.draft;
      if (!title.trim() || !body.trim()) return;
      const identity = id ? { id, expectedUpdatedAt: updatedAt } : { createId };
      return this.request('share_save', { ...identity, kind, title: title.trim(), body: body.trim() }, data => {
        if (!isShareItem(data?.item) || data.item.status !== 'published' || (id && data.item.id !== id)) {
          throw new Error('invalid published Share item');
        }
        if (this.items) {
          const index = this.items.findIndex(item => item.id === data.item.id);
          if (index < 0) this.items.unshift(data.item);
          else this.items.splice(index, 1, data.item);
        }
        this.returnToList();
      });
    },
    confirmRemoval(item) {
      this.errorKey = '';
      this.removing = item;
      this.$nextTick(() => this.$refs.cancelRemove?.focus());
    },
    remove() {
      if (this.operation || !this.removing || !this.targetAvailable) return;
      const { id, updatedAt } = this.removing;
      return this.request('share_delete', { id, expectedUpdatedAt: updatedAt }, () => {
        if (this.items) this.items = this.items.filter(item => item.id !== id);
        this.returnToList();
      });
    },
  },
  template: `
    <div v-if="serverSupported && (supportedAgents.length || mode)" class="session-discovery-actions">
      <button type="button" class="btn-ghost" aria-haspopup="dialog"
        :aria-label="$t('sessionDiscovery.search')" :title="$t('sessionDiscovery.search')" @click="open('search')">
        <NavigationIcon name="search" :size="18" />
      </button>
      <button type="button" class="btn-ghost" aria-haspopup="dialog" @click="open('share')">{{ $t('sessionDiscovery.share') }}</button>
    </div>
    <Teleport to="body">
      <dialog ref="dialog" class="session-discovery-dialog" :aria-labelledby="titleId" @cancel.prevent="close()" @keydown.esc.stop.prevent="close()">
        <template v-if="mode">
          <header>
            <h2 :id="titleId">{{ $t('sessionDiscovery.' + mode) }}</h2>
            <button type="button" class="btn-ghost" :aria-label="$t('common.close')" :title="$t('common.close')" @click="close()">
              <NavigationIcon name="close" :size="18" />
            </button>
          </header>
          <div class="session-discovery-body">
            <label class="session-discovery-field">
              {{ $t('sessionDiscovery.agent') }}
              <select ref="agent" :value="agentId" :disabled="mutating || !onlineAgents.length || !connected" @change="changeAgent">
                <option v-if="!targetAvailable" :value="agentId">{{ $t('sessionDiscovery.selectAgent') }}</option>
                <option v-for="agent in onlineAgents" :key="agent.id" :value="agent.id">{{ agent.name || agent.id }}</option>
              </select>
            </label>
            <p v-if="!targetAvailable" role="status">{{ $t('sessionDiscovery.unavailable') }}</p>
            <template v-else-if="mode === 'search'">
              <form class="session-discovery-search" @submit.prevent="search">
                <label class="session-discovery-field">
                  {{ $t('sessionDiscovery.query') }}
                  <input ref="query" v-model="query" type="search" maxlength="160" @input="editQuery" />
                </label>
                <button type="submit" class="btn-primary" :disabled="!query.trim() || !!operation">{{ $t('sessionDiscovery.submitSearch') }}</button>
              </form>
              <p v-if="operation || (results && catalogLoading)" role="status">{{ $t(operation ? 'sessionDiscovery.searching' : 'common.loading') }}</p>
              <p v-else-if="firstIndexPending" role="status">{{ $t('sessionDiscovery.firstIndexPending') }}</p>
              <p v-else-if="results && !visibleResults.length" role="status">{{ $t('sessionDiscovery.noResults') }}</p>
              <ul v-else-if="visibleResults.length" class="session-discovery-list">
                <li v-for="result in visibleResults" :key="result.row.catalogKey">
                  <button type="button" class="btn-ghost session-discovery-result" @click="selectResult(result.row.routeRef.sessionId)">
                    <strong>{{ result.title }}</strong>
                    <span v-if="result.path" class="session-discovery-meta">{{ result.path }}</span>
                    <span v-if="result.snippet" class="session-discovery-text">{{ result.snippet }}</span>
                  </button>
                </li>
              </ul>
            </template>
            <template v-else>
              <p v-if="operation" role="status">{{ $t(mutating ? 'sessionDiscovery.updating' : 'common.loading') }}</p>
              <form v-if="draft" class="session-discovery-form" @submit.prevent="save">
                <label class="session-discovery-field">{{ $t('sessionDiscovery.kind') }}
                  <select v-model="draft.kind" :disabled="mutating">
                    <option value="output">{{ $t('sessionDiscovery.output') }}</option>
                    <option value="consensus">{{ $t('sessionDiscovery.consensus') }}</option>
                  </select>
                </label>
                <label class="session-discovery-field">{{ $t('sessionDiscovery.title') }}
                  <input ref="draftTitle" v-model="draft.title" maxlength="120" required :readonly="mutating" />
                </label>
                <label class="session-discovery-field">{{ $t('sessionDiscovery.body') }}
                  <textarea v-model="draft.body" rows="6" maxlength="12000" required :readonly="mutating"></textarea>
                </label>
                <div class="session-discovery-buttons">
                  <button type="button" class="btn-secondary" :disabled="mutating" @click="returnToList">{{ $t('common.cancel') }}</button>
                  <button type="submit" class="btn-primary" :disabled="mutating || !draft.title.trim() || !draft.body.trim()">
                    {{ $t(draft.status === 'published' ? 'sessionDiscovery.saveChanges' : 'sessionDiscovery.publish') }}
                  </button>
                </div>
              </form>
              <div v-else-if="removing">
                <p>{{ $t('sessionDiscovery.removePrompt', { title: removing.title }) }}</p>
                <div class="session-discovery-buttons">
                  <button ref="cancelRemove" type="button" class="btn-secondary" :disabled="mutating" @click="returnToList">{{ $t('common.cancel') }}</button>
                  <button type="button" class="btn-danger" :disabled="mutating" @click="remove">{{ $t('sessionDiscovery.confirmRemove') }}</button>
                </div>
              </div>
              <template v-else-if="items">
                <button ref="add" type="button" class="btn-primary" @click="edit()">{{ $t('sessionDiscovery.add') }}</button>
                <p v-if="!items.length" role="status">{{ $t('sessionDiscovery.noItems') }}</p>
                <ul v-else class="session-discovery-list">
                  <li v-for="item in items" :key="item.id" class="session-discovery-item">
                    <h3>{{ item.title }}</h3>
                    <p class="session-discovery-meta">{{ $t('sessionDiscovery.' + item.kind) }} · {{ $t('sessionDiscovery.' + item.status) }}</p>
                    <p class="session-discovery-text">{{ item.body }}</p>
                    <div class="session-discovery-buttons">
                      <button type="button" class="btn-secondary" @click="edit(item)">
                        {{ $t(item.status === 'candidate' ? 'sessionDiscovery.review' : 'sessionDiscovery.edit') }}
                      </button>
                      <button type="button" class="btn-ghost" @click="confirmRemoval(item)">{{ $t('sessionDiscovery.remove') }}</button>
                    </div>
                  </li>
                </ul>
              </template>
            </template>
            <p v-if="errorKey" role="alert">{{ $t(errorKey) }}</p>
            <button v-if="errorKey && mode === 'share' && items === null && !draft && !removing && targetAvailable" type="button" class="btn-secondary" @click="loadShare">{{ $t('common.retry') }}</button>
          </div>
        </template>
      </dialog>
    </Teleport>
  `,
};
