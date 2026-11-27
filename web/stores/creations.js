/**
 * Creations Store — Pinia store for Yeaft Cosmos Creation Stars (Galaxy L1/L2/L3).
 *
 * Strictly Agent-scoped: all cached lists, details, node contents, threads, and live
 * events are keyed by `(agentId, creationId[, nodeId|threadId])` so multi-Agent stars
 * never collide or overwrite each other.
 */
import { useChatStore } from './chat.js';
import { useAuthStore } from './auth.js';

const { defineStore } = Pinia;

const KEY_SEP = '\u001f';
const pendingRequests = new Map();
let requestSeq = 0;
let storeGeneration = 0;

export function creationDetailKey(agentId, creationId) {
  return `${agentId}${KEY_SEP}${creationId}`;
}

export function creationNodeKey(agentId, creationId, nodeId) {
  return `${agentId}${KEY_SEP}${creationId}${KEY_SEP}${nodeId}`;
}

export function creationThreadKey(agentId, creationId, threadId) {
  return `${agentId}${KEY_SEP}${creationId}${KEY_SEP}${threadId}`;
}

function emptyAgentBucket() {
  return { list: [], loaded: false, loading: false, error: null };
}

function defaultIgniteDraft() {
  return {
    open: false,
    title: '',
    kind: 'book',
    prompt: '',
    pendingFiles: [],
    celestial: null,
    submitting: false,
    error: null,
  };
}

function upsertById(list, item) {
  if (!item || !item.id) return list;
  const idx = list.findIndex((entry) => entry && entry.id === item.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...next[idx], ...item };
    return next;
  }
  return [...list, item];
}

function replaceById(list, item) {
  if (!item || !item.id) return list;
  const idx = list.findIndex((entry) => entry && entry.id === item.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = item;
    return next;
  }
  return [...list, item];
}

function removeById(list, id) {
  if (!id || !Array.isArray(list)) return list || [];
  return list.filter((entry) => entry && entry.id !== id);
}

function ensureDetailBucket(state, agentId, creationId) {
  const key = creationDetailKey(agentId, creationId);
  if (!state.detailsByKey[key]) {
    state.detailsByKey[key] = {
      creation: null,
      nodes: [],
      canon: [],
      sources: [],
      assets: [],
      threads: [],
      proposals: [],
      runs: [],
      loadedAt: 0,
    };
  }
  return state.detailsByKey[key];
}

function isFolderNode(node) {
  if (!node) return false;
  return node.kind === 'folder' || node.nodeType === 'folder' || node.type === 'folder' || node.isFolder === true;
}

function deleteKeysWithPrefix(mapObj, prefix) {
  for (const key of Object.keys(mapObj)) {
    if (key.startsWith(prefix)) {
      delete mapObj[key];
    }
  }
}

export const useCreationsStore = defineStore('creations', {
  state: () => ({
    selectedAgentId: '',
    byAgent: {},
    detailsByKey: {},
    nodeContentsByKey: {},
    threadMessagesByKey: {},
    activeCreation: null,
    inspectorTarget: null,
    viewMode: 'galaxy',
    kindFilter: 'all',
    searchQuery: '',
    openActivationSeq: 0,
    igniteDraft: defaultIgniteDraft(),
  }),

  getters: {
    creationsForAgent: (state) => (agentId) => {
      if (!agentId) return [];
      return state.byAgent[agentId]?.list || [];
    },

    currentAgentState: (state) => {
      if (!state.selectedAgentId) return emptyAgentBucket();
      return state.byAgent[state.selectedAgentId] || emptyAgentBucket();
    },

    currentAgentCreations(state) {
      const list = state.byAgent[state.selectedAgentId]?.list || [];
      const kind = state.kindFilter || 'all';
      const query = String(state.searchQuery || '').trim().toLowerCase();

      return list.filter((item) => {
        if (!item) return false;
        if (item.status === 'archived' && !query) return false;
        if (kind !== 'all' && item.kind !== kind) return false;
        if (!query) return true;
        const haystack = [
          item.title,
          item.summary,
          item.kind,
          item.status,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });
    },

    activeDetail(state) {
      const active = state.activeCreation;
      if (!active || !active.agentId || !active.creationId) return null;
      return state.detailsByKey[creationDetailKey(active.agentId, active.creationId)] || null;
    },

    activeNode(state) {
      const active = state.activeCreation;
      if (!active || !active.activeNodeId) return null;
      const detail = state.detailsByKey[creationDetailKey(active.agentId, active.creationId)];
      if (!detail || !Array.isArray(detail.nodes)) return null;
      return detail.nodes.find((n) => n && n.id === active.activeNodeId) || null;
    },

    activeNodeContent(state) {
      const active = state.activeCreation;
      if (!active || !active.activeNodeId) return null;
      return state.nodeContentsByKey[
        creationNodeKey(active.agentId, active.creationId, active.activeNodeId)
      ] || null;
    },

    pendingProposalsForActive(state) {
      const active = state.activeCreation;
      if (!active) return { unitProposals: [], canonProposals: [], all: [] };
      const detail = state.detailsByKey[creationDetailKey(active.agentId, active.creationId)];
      const proposals = Array.isArray(detail?.proposals) ? detail.proposals : [];
      const pending = proposals.filter((p) => p && p.status === 'pending');
      const unitProposals = pending.filter(
        (p) => p.type === 'unit_edit' || p.targetType === 'node' || p.targetType === 'unit' || p.kind === 'node_edit' || p.kind === 'unit_edit' || Boolean(p.nodeId),
      );
      const canonProposals = pending.filter(
        (p) => p.type === 'canon_patch' || p.targetType === 'canon' || p.kind === 'canon_sync' || p.kind === 'canon_upsert' || (!p.nodeId && Boolean(p.canonId || p.canonItem || p.patch)),
      );
      return { unitProposals, canonProposals, all: pending };
    },

    activeRunsForActive(state) {
      const active = state.activeCreation;
      if (!active) return [];
      const detail = state.detailsByKey[creationDetailKey(active.agentId, active.creationId)];
      const runs = Array.isArray(detail?.runs) ? detail.runs : [];
      return runs.filter((r) => r && (r.status === 'running' || r.status === 'paused'));
    },
  },

  actions: {
    _ensureAgentBucket(agentId) {
      if (!this.byAgent[agentId]) {
        this.byAgent[agentId] = emptyAgentBucket();
      }
      return this.byAgent[agentId];
    },

    /**
     * Send an Agent-scoped Creation RPC over WebSocket and await its correlated response.
     */
    request(agentId, op, payload = {}, { timeoutMs = 45000 } = {}) {
      const targetAgentId = String(agentId || '').trim();
      if (!targetAgentId) {
        return Promise.reject(new Error('No Agent selected'));
      }
      const chatStore = useChatStore();
      const requestId = `creation-${Date.now()}-${++requestSeq}-${Math.random().toString(36).slice(2, 8)}`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`Creation request "${op}" timed out`));
        }, timeoutMs);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timer,
          agentId: targetAgentId,
          op,
        });

        const sent = chatStore.sendWsMessage({
          type: 'creation_request',
          agentId: targetAgentId,
          requestId,
          op,
          payload: payload || {},
        });

        if (sent === false) {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          reject(new Error('WebSocket connection unavailable'));
        }
      });
    },

    /**
     * Upload raw File objects via `/api/upload` and return `{ fileId }` descriptors.
     */
    async uploadRawFiles(rawFiles) {
      const files = Array.from(rawFiles || []).filter(Boolean);
      if (!files.length) return [];

      const body = new FormData();
      for (const file of files) {
        body.append('files', file, file.name || 'attachment');
      }

      const authStore = useAuthStore();
      const token = authStore.getActiveToken?.() || authStore.token;
      const response = await fetch('/api/upload', {
        method: 'POST',
        body,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        let message = `Upload failed (${response.status})`;
        try {
          const errBody = await response.json();
          if (errBody?.error || errBody?.message) {
            message = errBody.error || errBody.message;
          }
        } catch {
          // ignore json parse failure
        }
        throw new Error(message);
      }

      const data = await response.json();
      if (!Array.isArray(data?.files)) {
        throw new Error('Invalid upload response');
      }
      return data.files
        .filter((f) => f && typeof f.fileId === 'string' && f.fileId)
        .map((f) => ({
          fileId: f.fileId,
          name: f.name || f.originalName || undefined,
          mimeType: f.mimeType || undefined,
          size: typeof f.size === 'number' ? f.size : undefined,
        }));
    },

    _syncCreationSummaryFromDetail(agentId, creationId, creationPatch = null) {
      const bucket = this.byAgent[agentId];
      const dKey = creationDetailKey(agentId, creationId);
      const detail = this.detailsByKey[dKey];
      if (!bucket || !Array.isArray(bucket.list)) return;
      const idx = bucket.list.findIndex((c) => c && c.id === creationId);
      if (idx < 0 && !creationPatch) return;

      const patch = {};
      if (detail) {
        if (Array.isArray(detail.nodes)) {
          const units = detail.nodes.filter((n) => n && !isFolderNode(n));
          patch.unitCount = units.length;
          const readableUnits = units.filter((u) => (u.wordCount || 0) > 0 || u.hasContent || u.status === 'draft' || u.status === 'final');
          patch.readableUnitCount = readableUnits.length;
          patch.hasReadableContent = readableUnits.length > 0;
          patch.wordCount = units.reduce((sum, u) => sum + (Number(u.wordCount) || 0), 0);
        }
        if (Array.isArray(detail.sources)) {
          patch.sourceCount = detail.sources.length;
        }
        if (Array.isArray(detail.proposals)) {
          patch.pendingProposalCount = detail.proposals.filter((p) => p && p.status === 'pending').length;
        }
      }
      if (creationPatch && typeof creationPatch === 'object') {
        Object.assign(patch, creationPatch);
      }

      if (idx >= 0) {
        const next = bucket.list.slice();
        next[idx] = { ...next[idx], ...patch };
        bucket.list = next;
        if (detail && detail.creation) {
          detail.creation = { ...detail.creation, ...patch };
        }
      } else if (creationPatch && creationPatch.id) {
        bucket.list = upsertById(bucket.list, { ...creationPatch, ...patch });
      }
    },

    invalidatePendingOpen() {
      this.openActivationSeq += 1;
    },

    async selectGalaxyAgent(agentId, { force = false } = {}) {
      this.openActivationSeq += 1;
      const nextId = String(agentId || '').trim();
      this.selectedAgentId = nextId;

      if (this.inspectorTarget && this.inspectorTarget.agentId !== nextId) {
        this.inspectorTarget = null;
      }

      if (!nextId) return [];
      const bucket = this._ensureAgentBucket(nextId);
      if (!force && (bucket.loaded || bucket.loading)) {
        return bucket.list;
      }
      return this.listCreations(nextId);
    },

    async listCreations(agentId, opts = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId) return [];

      const gen = storeGeneration;
      const bucket = this._ensureAgentBucket(targetId);
      bucket.loading = true;
      bucket.error = null;

      try {
        const res = await this.request(targetId, 'list_creations', opts);
        if (gen !== storeGeneration) return [];
        const list = Array.isArray(res?.creations)
          ? res.creations
          : (Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []));
        const currentBucket = this._ensureAgentBucket(targetId);
        currentBucket.list = list;
        currentBucket.loaded = true;
        currentBucket.loading = false;
        currentBucket.error = null;
        return list;
      } catch (err) {
        if (gen === storeGeneration) {
          const currentBucket = this._ensureAgentBucket(targetId);
          currentBucket.loading = false;
          currentBucket.error = err?.message || 'Failed to load creations';
        }
        throw err;
      }
    },

    async createCreation(agentId, payload = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId) throw new Error('No Agent selected');

      const gen = storeGeneration;
      const { rawFiles, ...rest } = payload || {};
      let attachments = Array.isArray(rest.attachments) ? rest.attachments.slice() : [];
      if (rawFiles && rawFiles.length > 0) {
        const uploaded = await this.uploadRawFiles(rawFiles);
        attachments = [...attachments, ...uploaded];
      }

      const reqPayload = {
        ...rest,
        ...(attachments.length ? { attachments } : {}),
      };

      const res = await this.request(targetId, 'create_creation', reqPayload);
      if (gen !== storeGeneration) return res;
      const creation = res?.creation || (res?.id ? res : null);

      if (creation && creation.id) {
        const bucket = this._ensureAgentBucket(targetId);
        bucket.list = upsertById(bucket.list, creation);
        bucket.loaded = true;

        const detail = ensureDetailBucket(this, targetId, creation.id);
        detail.creation = { ...(detail.creation || {}), ...creation };
        if (Array.isArray(res?.nodes)) detail.nodes = res.nodes;
        if (Array.isArray(res?.canon)) detail.canon = res.canon;
        if (Array.isArray(res?.sources)) detail.sources = res.sources;
        if (Array.isArray(res?.assets)) detail.assets = res.assets;
        if (Array.isArray(res?.threads)) detail.threads = res.threads;
        if (Array.isArray(res?.proposals)) detail.proposals = res.proposals;
        if (Array.isArray(res?.runs)) detail.runs = res.runs;
        detail.loadedAt = Date.now();
      }

      return res;
    },

    async openCreation(agentId, creationId, { mode } = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId || !creationId) throw new Error('Missing agentId or creationId');

      const gen = storeGeneration;
      const seq = ++this.openActivationSeq;

      const res = await this.request(targetId, 'get_creation', { creationId });
      if (gen !== storeGeneration) return null;

      const creation = res?.creation || res || {};
      const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
      const canon = Array.isArray(res?.canon) ? res.canon : [];
      const sources = Array.isArray(res?.sources) ? res.sources : [];
      const assets = Array.isArray(res?.assets) ? res.assets : [];
      const threads = Array.isArray(res?.threads) ? res.threads : [];
      const proposals = Array.isArray(res?.proposals) ? res.proposals : [];
      const runs = Array.isArray(res?.runs) ? res.runs : [];

      const dKey = creationDetailKey(targetId, creationId);
      this.detailsByKey[dKey] = {
        creation,
        nodes,
        canon,
        sources,
        assets,
        threads,
        proposals,
        runs,
        loadedAt: Date.now(),
      };

      if (creation?.id) {
        const bucket = this._ensureAgentBucket(targetId);
        bucket.list = upsertById(bucket.list, creation);
      }

      if (seq !== this.openActivationSeq) {
        return this.detailsByKey[dKey];
      }

      const defaultMode = (creation.hasReadableContent || (creation.readableUnitCount || 0) > 0)
        ? 'read'
        : 'studio';
      const resolvedMode = (mode === 'read' || mode === 'studio') ? mode : defaultMode;

      const readingId = creation.readingNodeId;
      const hasReadingNode = readingId && nodes.some((n) => n && n.id === readingId);
      const firstUnit = nodes.find((n) => n && !isFolderNode(n))
        || nodes[0]
        || null;
      const initialNodeId = hasReadingNode ? readingId : (firstUnit?.id || null);

      this.inspectorTarget = null;
      this.activeCreation = {
        agentId: targetId,
        creationId,
        mode: resolvedMode,
        activeNodeId: initialNodeId,
        activeCanonId: null,
        activeSourceId: null,
      };

      if (initialNodeId) {
        try {
          await this.loadNode(targetId, creationId, initialNodeId);
        } catch {
          // Node content error is non-fatal for opening the interior modal.
        }
      }

      return gen === storeGeneration ? (this.detailsByKey[dKey] || null) : null;
    },

    closeCreation() {
      this.openActivationSeq += 1;
      this.activeCreation = null;
    },

    setActiveMode(mode) {
      if (!this.activeCreation) return;
      if (mode !== 'read' && mode !== 'studio') return;
      this.activeCreation = {
        ...this.activeCreation,
        mode,
      };
    },

    async selectNode(nodeId) {
      if (!this.activeCreation) return null;
      const { agentId, creationId } = this.activeCreation;
      this.activeCreation = {
        ...this.activeCreation,
        activeNodeId: nodeId || null,
        activeCanonId: null,
        activeSourceId: null,
      };
      if (!nodeId) return null;
      return this.loadNode(agentId, creationId, nodeId);
    },

    selectCanon(canonId) {
      if (!this.activeCreation) return;
      this.activeCreation = {
        ...this.activeCreation,
        activeCanonId: canonId || null,
        activeNodeId: null,
        activeSourceId: null,
      };
    },

    async selectSource(sourceId) {
      if (!this.activeCreation) return null;
      const { agentId, creationId } = this.activeCreation;
      this.activeCreation = {
        ...this.activeCreation,
        activeSourceId: sourceId || null,
        activeNodeId: null,
        activeCanonId: null,
      };
      if (!sourceId) return null;
      return this.getSource(agentId, creationId, sourceId);
    },

    async updateCreation(agentId, creationId, patch = {}) {
      const res = await this.request(agentId, 'update_creation', { creationId, ...patch, patch });
      const updated = res?.creation || (res?.id ? res : { id: creationId, ...patch });

      const bucket = this._ensureAgentBucket(agentId);
      bucket.list = upsertById(bucket.list, updated);

      const dKey = creationDetailKey(agentId, creationId);
      if (this.detailsByKey[dKey]) {
        this.detailsByKey[dKey].creation = {
          ...(this.detailsByKey[dKey].creation || {}),
          ...updated,
        };
      }
      return updated;
    },

    async deleteCreation(agentId, creationId) {
      const res = await this.request(agentId, 'delete_creation', { creationId });
      this._removeCreationLocal(agentId, creationId);
      return res;
    },

    _removeCreationLocal(agentId, creationId) {
      const bucket = this.byAgent[agentId];
      if (bucket) {
        bucket.list = removeById(bucket.list, creationId);
      }
      const dKey = creationDetailKey(agentId, creationId);
      delete this.detailsByKey[dKey];
      const prefix = `${dKey}${KEY_SEP}`;
      deleteKeysWithPrefix(this.nodeContentsByKey, prefix);
      deleteKeysWithPrefix(this.threadMessagesByKey, prefix);

      if (this.activeCreation?.agentId === agentId && this.activeCreation?.creationId === creationId) {
        this.activeCreation = null;
      }
      if (this.inspectorTarget?.agentId === agentId && this.inspectorTarget?.creationId === creationId) {
        this.inspectorTarget = null;
      }
    },

    async uploadSources(agentId, creationId, rawFiles = [], textSources = []) {
      const attachments = rawFiles && rawFiles.length ? await this.uploadRawFiles(rawFiles) : [];
      const res = await this.request(agentId, 'add_sources', {
        creationId,
        ...(attachments.length ? { attachments } : {}),
        textSources: Array.isArray(textSources) ? textSources : [],
      });

      const added = Array.isArray(res?.sources)
        ? res.sources
        : (res?.source ? [res.source] : []);
      const detail = ensureDetailBucket(this, agentId, creationId);
      for (const src of added) {
        detail.sources = upsertById(detail.sources, src);
      }
      if (res?.creation) {
        detail.creation = { ...(detail.creation || {}), ...res.creation };
        const bucket = this._ensureAgentBucket(agentId);
        bucket.list = upsertById(bucket.list, res.creation);
      }
      return res;
    },

    async getSource(agentId, creationId, sourceId) {
      const res = await this.request(agentId, 'get_source', { creationId, sourceId });
      const source = res?.source || (res?.id ? res : null);
      if (source && source.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.sources = upsertById(detail.sources, source);
      }
      return source || res;
    },

    async deleteSource(agentId, creationId, sourceId) {
      const res = await this.request(agentId, 'delete_source', { creationId, sourceId });
      const dKey = creationDetailKey(agentId, creationId);
      if (this.detailsByKey[dKey]) {
        this.detailsByKey[dKey].sources = removeById(this.detailsByKey[dKey].sources, sourceId);
      }
      if (
        this.activeCreation?.agentId === agentId
        && this.activeCreation?.creationId === creationId
        && this.activeCreation?.activeSourceId === sourceId
      ) {
        this.activeCreation = { ...this.activeCreation, activeSourceId: null };
      }
      return res;
    },

    async getCanon(agentId, creationId, canonId) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'get_canon', { creationId, canonId });
      if (gen !== storeGeneration) return null;
      const item = res?.canon || res?.item || (res?.id ? res : null);
      if (item && item.id) {
        const normalized = { ...item, contentTruncated: false, stateTruncated: false };
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.canon = replaceById(detail.canon, normalized);
        return normalized;
      }
      return item || res;
    },

    async upsertCanon(agentId, creationId, item) {
      const res = await this.request(agentId, 'upsert_canon', { creationId, item });
      const saved = res?.canon || res?.item || (res?.id ? res : item);
      if (saved && saved.id) {
        const normalized = { ...saved, contentTruncated: false, stateTruncated: false };
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.canon = replaceById(detail.canon, normalized);
        return normalized;
      }
      return saved;
    },

    async deleteCanon(agentId, creationId, canonId) {
      const res = await this.request(agentId, 'delete_canon', { creationId, canonId });
      const dKey = creationDetailKey(agentId, creationId);
      if (this.detailsByKey[dKey]) {
        this.detailsByKey[dKey].canon = removeById(this.detailsByKey[dKey].canon, canonId);
      }
      if (
        this.activeCreation?.agentId === agentId
        && this.activeCreation?.creationId === creationId
        && this.activeCreation?.activeCanonId === canonId
      ) {
        this.activeCreation = { ...this.activeCreation, activeCanonId: null };
      }
      return res;
    },

    async createNode(agentId, creationId, payload = {}) {
      const res = await this.request(agentId, 'create_node', { creationId, ...payload });
      const node = res?.node || (res?.id ? res : null);
      if (node && node.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.nodes = upsertById(detail.nodes, node);
      }
      return res;
    },

    async loadNode(agentId, creationId, nodeId) {
      const gen = storeGeneration;
      const nKey = creationNodeKey(agentId, creationId, nodeId);
      const prev = this.nodeContentsByKey[nKey] || {
        content: '',
        revisions: [],
        loading: false,
        dirty: false,
        loaded: false,
        loadedRevId: null,
      };
      const dKey = creationDetailKey(agentId, creationId);
      const currentNode = this.detailsByKey[dKey]?.nodes?.find((n) => n && n.id === nodeId) || null;
      const currentNodeRevId = currentNode?.currentRevId ?? null;
      const isLoadedForCurrentRev = Boolean(
        prev.loaded && (prev.dirty || currentNodeRevId == null || prev.loadedRevId === currentNodeRevId),
      );
      this.nodeContentsByKey[nKey] = {
        ...prev,
        loading: true,
        loaded: isLoadedForCurrentRev,
      };

      try {
        const res = await this.request(agentId, 'get_node', { creationId, nodeId });
        if (gen !== storeGeneration) return null;
        const content = res?.content !== undefined
          ? res.content
          : (res?.node?.content !== undefined ? res.node.content : '');
        const revisions = Array.isArray(res?.revisions) ? res.revisions : prev.revisions;
        const loadedRevId = res?.node?.currentRevId ?? prev.loadedRevId ?? null;
        const live = this.nodeContentsByKey[nKey];

        if (live?.dirty === true) {
          // User has a dirty draft (e.g. opened Revision History or edited mid-refresh):
          // preserve the dirty draft, keep it editable (loaded: true), and keep its original save base.
          this.nodeContentsByKey[nKey] = {
            ...live,
            revisions,
            loading: false,
            loaded: true,
          };
        } else {
          this.nodeContentsByKey[nKey] = {
            content,
            revisions,
            loading: false,
            dirty: false,
            loaded: true,
            loadedRevId,
          };
        }

        if (res?.node && res.node.id) {
          const detail = ensureDetailBucket(this, agentId, creationId);
          detail.nodes = upsertById(detail.nodes, { ...res.node, outlineTruncated: false });
          if (Array.isArray(res?.pendingProposals)) {
            for (const prop of res.pendingProposals) {
              if (prop && prop.id) {
                const normalizedProp = {
                  ...prop,
                  contentTruncated: prop.contentTruncated === true ? true : false,
                };
                detail.proposals = replaceById(detail.proposals, normalizedProp);
              }
            }
          }
        }
        return this.nodeContentsByKey[nKey];
      } catch (err) {
        if (gen === storeGeneration) {
          const live = this.nodeContentsByKey[nKey] || prev;
          this.nodeContentsByKey[nKey] = { ...live, loading: false };
        }
        throw err;
      }
    },

    async updateNode(agentId, creationId, nodeId, patch = {}) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'update_node', { creationId, nodeId, ...patch });
      if (gen !== storeGeneration) return res;
      if (res?.conflict === true) {
        return res;
      }
      const nKey = creationNodeKey(agentId, creationId, nodeId);
      const prev = this.nodeContentsByKey[nKey] || {
        content: '',
        revisions: [],
        loading: false,
        dirty: false,
        loaded: false,
        loadedRevId: null,
      };
      const nextContent = res?.content !== undefined
        ? res.content
        : (patch.content !== undefined ? patch.content : prev.content);
      const nextRevisions = Array.isArray(res?.revisions) ? res.revisions : prev.revisions;
      const loadedRevId = res?.node?.currentRevId ?? prev.loadedRevId ?? null;

      this.nodeContentsByKey[nKey] = {
        ...prev,
        content: nextContent,
        revisions: nextRevisions,
        loading: false,
        dirty: false,
        loaded: true,
        loadedRevId,
      };

      if (res?.node && res.node.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.nodes = upsertById(detail.nodes, { ...res.node, outlineTruncated: false });
        this._syncCreationSummaryFromDetail(agentId, creationId, res?.creation || null);
      }
      return res;
    },

    setNodeDirty(agentId, creationId, nodeId, dirty) {
      if (!agentId || !creationId || !nodeId) return;
      const nKey = creationNodeKey(agentId, creationId, nodeId);
      const prev = this.nodeContentsByKey[nKey] || {
        content: '',
        revisions: [],
        loading: false,
        dirty: false,
        loaded: false,
        loadedRevId: null,
      };
      this.nodeContentsByKey[nKey] = {
        ...prev,
        dirty: Boolean(dirty),
      };
    },

    async reorderNodes(agentId, creationId, parentId, orderedIds = []) {
      const res = await this.request(agentId, 'reorder_nodes', {
        creationId,
        parentId: parentId || null,
        orderedIds,
      });
      const detail = ensureDetailBucket(this, agentId, creationId);
      if (Array.isArray(res?.nodes)) {
        detail.nodes = res.nodes;
      } else if (Array.isArray(orderedIds)) {
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        detail.nodes = detail.nodes.map((node) => {
          if (!node || !orderMap.has(node.id)) return node;
          return { ...node, parentId: parentId ?? node.parentId, sortOrder: orderMap.get(node.id) };
        });
      }
      return res;
    },

    async deleteNode(agentId, creationId, nodeId) {
      const res = await this.request(agentId, 'delete_node', { creationId, nodeId });
      const dKey = creationDetailKey(agentId, creationId);
      if (this.detailsByKey[dKey]) {
        this.detailsByKey[dKey].nodes = removeById(this.detailsByKey[dKey].nodes, nodeId);
      }
      delete this.nodeContentsByKey[creationNodeKey(agentId, creationId, nodeId)];
      if (
        this.activeCreation?.agentId === agentId
        && this.activeCreation?.creationId === creationId
        && this.activeCreation?.activeNodeId === nodeId
      ) {
        this.activeCreation = { ...this.activeCreation, activeNodeId: null };
      }
      return res;
    },

    async restoreRevision(agentId, creationId, nodeId, revisionId, opts = {}) {
      const gen = storeGeneration;
      const reqPayload = {
        creationId,
        nodeId,
        revisionId,
        ...(opts && Object.hasOwn(opts, 'baseRevId') ? { baseRevId: opts.baseRevId } : {}),
      };
      const res = await this.request(agentId, 'restore_revision', reqPayload);
      if (gen !== storeGeneration) return res;
      if (res?.conflict === true) {
        return res;
      }
      const nKey = creationNodeKey(agentId, creationId, nodeId);
      const prev = this.nodeContentsByKey[nKey] || {
        content: '',
        revisions: [],
        loading: false,
        dirty: false,
        loaded: false,
        loadedRevId: null,
      };
      this.nodeContentsByKey[nKey] = {
        ...prev,
        content: res?.content !== undefined ? res.content : prev.content,
        revisions: Array.isArray(res?.revisions) ? res.revisions : prev.revisions,
        loading: false,
        dirty: false,
        loaded: true,
        loadedRevId: res?.node?.currentRevId ?? prev.loadedRevId ?? null,
      };
      if (res?.node && res.node.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.nodes = upsertById(detail.nodes, res.node);
        this._syncCreationSummaryFromDetail(agentId, creationId, res?.creation || null);
      }
      return res;
    },

    async listProposals(agentId, creationId, opts = {}) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'list_proposals', { creationId, ...opts });
      if (gen !== storeGeneration) return [];
      const proposals = Array.isArray(res?.proposals) ? res.proposals : (Array.isArray(res) ? res : []);
      const detail = ensureDetailBucket(this, agentId, creationId);
      for (const prop of proposals) {
        detail.proposals = upsertById(detail.proposals, prop);
      }
      this._syncCreationSummaryFromDetail(agentId, creationId);
      return proposals;
    },

    async getProposal(agentId, creationId, proposalId) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'get_proposal', { creationId, proposalId });
      if (gen !== storeGeneration) return null;
      const proposal = res?.proposal || (res?.id ? res : null);
      if (proposal && proposal.id) {
        const hydrated = {
          ...proposal,
          contentTruncated: proposal.contentTruncated === true ? true : false,
        };
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.proposals = replaceById(detail.proposals, hydrated);
        return hydrated;
      }
      return proposal || res;
    },

    async resolveProposal(agentId, creationId, proposalId, decision, editedPayload) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'resolve_proposal', {
        creationId,
        proposalId,
        decision,
        ...(editedPayload !== undefined ? { editedPayload } : {}),
      });
      if (gen !== storeGeneration) return res;
      if (res?.conflict === true) {
        return res;
      }
      const detail = ensureDetailBucket(this, agentId, creationId);
      if (res?.proposal && res.proposal.id) {
        detail.proposals = upsertById(detail.proposals, res.proposal);
      } else {
        detail.proposals = detail.proposals.map((p) => (
          p && p.id === proposalId ? { ...p, status: decision } : p
        ));
      }
      if (res?.node && res.node.id) {
        detail.nodes = upsertById(detail.nodes, res.node);
        if (res.node.content !== undefined) {
          const nKey = creationNodeKey(agentId, creationId, res.node.id);
          const prev = this.nodeContentsByKey[nKey] || { content: '', revisions: [], loading: false, dirty: false, loaded: false, loadedRevId: null };
          this.nodeContentsByKey[nKey] = {
            ...prev,
            content: res.node.content,
            dirty: false,
            loaded: true,
            loadedRevId: res.node.currentRevId ?? prev.loadedRevId ?? null,
          };
        }
      }
      if (res?.nodeId && res?.content !== undefined) {
        const nKey = creationNodeKey(agentId, creationId, res.nodeId);
        const prev = this.nodeContentsByKey[nKey] || { content: '', revisions: [], loading: false, dirty: false, loaded: false, loadedRevId: null };
        this.nodeContentsByKey[nKey] = {
          ...prev,
          content: res.content,
          dirty: false,
          loaded: true,
          loadedRevId: res?.node?.currentRevId ?? prev.loadedRevId ?? null,
        };
      }
      if (res?.canon && res.canon.id) {
        detail.canon = upsertById(detail.canon, res.canon);
      }
      this._syncCreationSummaryFromDetail(agentId, creationId, res?.creation || null);
      return res;
    },

    async loadThread(agentId, creationId, scopeType = 'global', scopeId = null) {
      const gen = storeGeneration;
      const res = await this.request(agentId, 'get_thread', {
        creationId,
        scopeType,
        scopeId: scopeId || null,
      });
      if (gen !== storeGeneration) return null;
      const thread = res?.thread || {
        id: res?.threadId || `${scopeType}:${scopeId || 'global'}`,
        scopeType,
        scopeId: scopeId || null,
      };
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      const contextPreview = res?.contextPreview || null;

      const tKey = creationThreadKey(agentId, creationId, thread.id);
      const prev = this.threadMessagesByKey[tKey];
      const detail = ensureDetailBucket(this, agentId, creationId);
      const activeThreadRun = (detail.runs || []).find(
        (r) => r && r.status === 'running' && (r.type === 'thread' || r.threadId) && r.threadId === thread.id,
      );
      const assistantAlreadyPresent = Boolean(
        activeThreadRun && messages.some(
          (m) => m && m.role === 'assistant' && (
            (activeThreadRun.assistantMessageId && m.id === activeThreadRun.assistantMessageId)
            || (activeThreadRun.id && m.runId === activeThreadRun.id)
          ),
        ),
      );
      const reconciledStream = (activeThreadRun && !assistantAlreadyPresent)
        ? (prev?.streamingMessage || null)
        : null;

      this.threadMessagesByKey[tKey] = {
        thread,
        messages,
        contextPreview,
        streamingMessage: reconciledStream,
        hasMore: Boolean(res?.hasMore),
        nextBeforeId: res?.nextBeforeId ?? null,
        loadingMore: false,
      };

      detail.threads = upsertById(detail.threads, thread);
      return this.threadMessagesByKey[tKey];
    },

    async loadMoreThreadMessages(agentId, creationId, threadId) {
      const gen = storeGeneration;
      const tKey = creationThreadKey(agentId, creationId, threadId);
      const bucket = this.threadMessagesByKey[tKey];
      if (!bucket || !bucket.hasMore || !bucket.nextBeforeId || bucket.loadingMore) {
        return bucket || null;
      }
      this.threadMessagesByKey[tKey] = { ...bucket, loadingMore: true };
      try {
        const res = await this.request(agentId, 'get_thread', {
          creationId,
          threadId,
          scopeType: bucket.thread?.scopeType || 'global',
          scopeId: bucket.thread?.scopeId || null,
          beforeId: bucket.nextBeforeId,
        });
        if (gen !== storeGeneration) return null;
        const older = Array.isArray(res?.messages) ? res.messages : [];
        const current = this.threadMessagesByKey[tKey] || bucket;
        const existing = Array.isArray(current.messages) ? current.messages : [];
        const existingIds = new Set(existing.map((m) => m && m.id).filter(Boolean));
        const uniqueOlder = older.filter((m) => m && (!m.id || !existingIds.has(m.id)));
        this.threadMessagesByKey[tKey] = {
          ...current,
          messages: [...uniqueOlder, ...existing],
          hasMore: Boolean(res?.hasMore),
          nextBeforeId: res?.nextBeforeId ?? null,
          loadingMore: false,
        };
        return this.threadMessagesByKey[tKey];
      } catch (err) {
        if (gen === storeGeneration && this.threadMessagesByKey[tKey]) {
          this.threadMessagesByKey[tKey] = { ...this.threadMessagesByKey[tKey], loadingMore: false };
        }
        throw err;
      }
    },

    async sendMessage(agentId, creationId, payload = {}) {
      const { rawFiles, ...rest } = payload || {};
      let attachments = Array.isArray(rest.attachments) ? rest.attachments.slice() : [];
      if (rawFiles && rawFiles.length > 0) {
        const uploaded = await this.uploadRawFiles(rawFiles);
        attachments = [...attachments, ...uploaded];
      }

      const res = await this.request(agentId, 'send_message', {
        creationId,
        ...rest,
        ...(attachments.length ? { attachments } : {}),
      });

      const threadId = res?.threadId || res?.thread?.id || rest.threadId;
      if (threadId) {
        const tKey = creationThreadKey(agentId, creationId, threadId);
        const bucket = this.threadMessagesByKey[tKey] || {
          thread: res?.thread || { id: threadId, scopeType: rest.scopeType || 'global', scopeId: rest.scopeId || null },
          messages: [],
          contextPreview: null,
          streamingMessage: null,
        };
        if (res?.userMessage) {
          bucket.messages = upsertById(bucket.messages, res.userMessage);
        }
        if (res?.contextPreview) {
          bucket.contextPreview = res.contextPreview;
        }
        this.threadMessagesByKey[tKey] = bucket;
      }

      return res;
    },

    async startBatchRun(agentId, creationId, payload = {}) {
      const res = await this.request(agentId, 'start_batch_run', { creationId, ...payload });
      const run = res?.run || (res?.id ? res : null);
      if (run && run.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.runs = upsertById(detail.runs, run);
      }
      return res;
    },

    async controlRun(agentId, creationId, runId, action) {
      const res = await this.request(agentId, 'control_run', { creationId, runId, action });
      const run = res?.run || (res?.id ? res : null);
      if (run && run.id) {
        const detail = ensureDetailBucket(this, agentId, creationId);
        detail.runs = upsertById(detail.runs, run);
      }
      return res;
    },

    async exportCreation(agentId, creationId, format = 'markdown') {
      return this.request(agentId, 'export_creation', { creationId, format });
    },

    mediaUrl(agentId, creationId, mediaKind, mediaId) {
      if (!agentId || !creationId || !mediaKind || !mediaId) return '';
      return `/api/yeaft/creations/${encodeURIComponent(agentId)}/${encodeURIComponent(creationId)}/media/${encodeURIComponent(mediaKind)}/${encodeURIComponent(mediaId)}`;
    },

    /**
     * Resolve or reject an in-flight `creation_request` RPC.
     */
    handleCreationResponse(msg) {
      if (!msg || typeof msg.requestId !== 'string') return;
      const pending = pendingRequests.get(msg.requestId);
      if (!pending) return;

      if (msg.agentId && msg.agentId !== pending.agentId) return;
      if (msg.op && msg.op !== pending.op) return;

      clearTimeout(pending.timer);
      pendingRequests.delete(msg.requestId);

      if (msg.ok === false || msg.error) {
        const err = new Error(msg.error || msg.message || `Creation ${pending.op} failed`);
        if (msg.errorCode) err.errorCode = msg.errorCode;
        pending.reject(err);
        return;
      }

      pending.resolve(msg.data !== undefined ? msg.data : (msg.result !== undefined ? msg.result : msg));
    },

    /**
     * Apply real-time server/agent Creation events strictly scoped to `msg.agentId`.
     */
    handleCreationEvent(msg) {
      if (!msg || !msg.agentId) return;
      const agentId = String(msg.agentId);
      const eventObj = msg.event && typeof msg.event === 'object' ? msg.event : null;
      const event = typeof msg.event === 'string'
        ? msg.event
        : (eventObj?.type || msg.eventType || msg.kind || '');
      const payload = eventObj
        ? (eventObj.data && typeof eventObj.data === 'object' ? { ...eventObj, ...eventObj.data } : eventObj)
        : (msg.payload && typeof msg.payload === 'object' ? msg.payload : msg);
      const creationId = payload.creationId || msg.creationId || payload.creation?.id;

      switch (event) {
        case 'creation_upserted': {
          const creation = payload.creation || payload;
          if (!creation || !creation.id) return;
          const bucket = this._ensureAgentBucket(agentId);
          bucket.list = upsertById(bucket.list, creation);
          const dKey = creationDetailKey(agentId, creation.id);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].creation = {
              ...(this.detailsByKey[dKey].creation || {}),
              ...creation,
            };
          }
          break;
        }

        case 'creation_deleted': {
          const delId = creationId || payload.id;
          if (!delId) return;
          this._removeCreationLocal(agentId, delId);
          break;
        }

        case 'node_upserted': {
          const node = payload.node || payload;
          if (!creationId || !node || !node.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].nodes = upsertById(this.detailsByKey[dKey].nodes, node);
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'node_deleted': {
          const removedIds = Array.isArray(payload.nodeIds)
            ? payload.nodeIds
            : (payload.nodeId ? [payload.nodeId] : []);
          if (!creationId || !removedIds.length) return;
          const removedSet = new Set(removedIds);
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].nodes = this.detailsByKey[dKey].nodes.filter((n) => n && !removedSet.has(n.id));
          }
          for (const nid of removedIds) {
            delete this.nodeContentsByKey[creationNodeKey(agentId, creationId, nid)];
          }
          if (
            this.activeCreation?.agentId === agentId
            && this.activeCreation?.creationId === creationId
            && removedSet.has(this.activeCreation?.activeNodeId)
          ) {
            this.activeCreation = { ...this.activeCreation, activeNodeId: null };
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'structure_updated': {
          if (!creationId || !Array.isArray(payload.nodes)) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].nodes = payload.nodes;
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'node_content_delta': {
          const nodeId = payload.nodeId || msg.nodeId;
          if (!creationId || !nodeId) return;
          const nKey = creationNodeKey(agentId, creationId, nodeId);
          const prev = this.nodeContentsByKey[nKey] || {
            content: '',
            revisions: [],
            loading: false,
            dirty: false,
          };
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          const nextContent = payload.replace === true
            ? (payload.content !== undefined ? payload.content : delta)
            : (typeof payload.content === 'string'
                ? payload.content
                : `${typeof prev.content === 'string' ? prev.content : ''}${delta}`);
          this.nodeContentsByKey[nKey] = {
            ...prev,
            content: nextContent,
            loading: false,
          };
          break;
        }

        case 'node_content_updated': {
          const nodeId = payload.nodeId || msg.nodeId;
          if (!creationId || !nodeId) return;
          const nKey = creationNodeKey(agentId, creationId, nodeId);
          const prev = this.nodeContentsByKey[nKey] || {
            content: '',
            revisions: [],
            loading: false,
            dirty: false,
            loaded: false,
            loadedRevId: null,
          };
          this.nodeContentsByKey[nKey] = {
            ...prev,
            content: payload.content !== undefined ? payload.content : prev.content,
            revisions: Array.isArray(payload.revisions) ? payload.revisions : prev.revisions,
            loading: false,
            dirty: false,
            loaded: true,
            loadedRevId: payload.node?.currentRevId ?? payload.revId ?? prev.loadedRevId ?? null,
          };
          if (payload.node && payload.node.id) {
            const dKey = creationDetailKey(agentId, creationId);
            if (this.detailsByKey[dKey]) {
              this.detailsByKey[dKey].nodes = upsertById(this.detailsByKey[dKey].nodes, payload.node);
            }
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'canon_upserted': {
          const item = payload.canon || payload.item || payload;
          if (!creationId || !item || !item.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].canon = upsertById(this.detailsByKey[dKey].canon, item);
          }
          break;
        }

        case 'canon_deleted': {
          const canonId = payload.canonId || payload.id;
          if (!creationId || !canonId) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].canon = removeById(this.detailsByKey[dKey].canon, canonId);
          }
          break;
        }

        case 'source_added': {
          const source = payload.source || payload;
          if (!creationId || !source || !source.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].sources = upsertById(this.detailsByKey[dKey].sources, source);
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'source_deleted': {
          const sourceId = payload.sourceId || payload.id;
          if (!creationId || !sourceId) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].sources = removeById(this.detailsByKey[dKey].sources, sourceId);
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'asset_saved': {
          const asset = payload.asset || payload;
          if (!creationId || !asset || !asset.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            if (!Array.isArray(this.detailsByKey[dKey].assets)) {
              this.detailsByKey[dKey].assets = [];
            }
            this.detailsByKey[dKey].assets = upsertById(this.detailsByKey[dKey].assets, asset);
          }
          break;
        }

        case 'proposal_created': {
          const proposal = payload.proposal || payload;
          if (!creationId || !proposal || !proposal.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].proposals = upsertById(this.detailsByKey[dKey].proposals, proposal);
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'proposal_resolved': {
          const proposal = payload.proposal || null;
          const proposalId = proposal?.id || payload.proposalId || payload.id;
          if (!creationId || !proposalId) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            if (proposal) {
              this.detailsByKey[dKey].proposals = upsertById(this.detailsByKey[dKey].proposals, proposal);
            } else {
              this.detailsByKey[dKey].proposals = this.detailsByKey[dKey].proposals.map((p) => (
                p && p.id === proposalId ? { ...p, status: payload.decision || payload.status || 'resolved' } : p
              ));
            }
          }
          this._syncCreationSummaryFromDetail(agentId, creationId, payload.creation || null);
          break;
        }

        case 'thread_message_delta': {
          const threadId = payload.threadId || msg.threadId;
          if (!creationId || !threadId) return;
          const tKey = creationThreadKey(agentId, creationId, threadId);
          const bucket = this.threadMessagesByKey[tKey] || {
            thread: { id: threadId },
            messages: [],
            contextPreview: null,
            streamingMessage: null,
          };
          const prevStream = bucket.streamingMessage || {
            id: payload.messageId || `stream-${Date.now()}`,
            role: 'assistant',
            content: '',
            toolStatus: null,
          };
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          bucket.streamingMessage = {
            ...prevStream,
            id: payload.messageId || prevStream.id,
            content: typeof payload.content === 'string' ? payload.content : `${prevStream.content}${delta}`,
          };
          this.threadMessagesByKey[tKey] = { ...bucket };
          break;
        }

        case 'thread_tool_status': {
          const threadId = payload.threadId || msg.threadId;
          if (!creationId || !threadId) return;
          const tKey = creationThreadKey(agentId, creationId, threadId);
          const bucket = this.threadMessagesByKey[tKey] || {
            thread: { id: threadId },
            messages: [],
            contextPreview: null,
            streamingMessage: null,
          };
          const prevStream = bucket.streamingMessage || {
            id: payload.messageId || `stream-${Date.now()}`,
            role: 'assistant',
            content: '',
            toolStatus: null,
          };
          bucket.streamingMessage = {
            ...prevStream,
            toolStatus: payload.toolStatus || (payload.name ? `${payload.name} (${payload.status || 'running'})` : (payload.toolName || payload.status || null)),
          };
          this.threadMessagesByKey[tKey] = { ...bucket };
          break;
        }

        case 'thread_message_complete': {
          const threadId = payload.threadId || msg.threadId;
          if (!creationId || !threadId) return;
          const tKey = creationThreadKey(agentId, creationId, threadId);
          const bucket = this.threadMessagesByKey[tKey] || {
            thread: { id: threadId },
            messages: [],
            contextPreview: null,
            streamingMessage: null,
          };
          const message = payload.message || (bucket.streamingMessage
            ? {
                id: payload.messageId || bucket.streamingMessage.id,
                role: 'assistant',
                content: payload.content ?? bucket.streamingMessage.content,
                createdAt: payload.createdAt || Date.now(),
              }
            : null);
          if (message) {
            bucket.messages = upsertById(bucket.messages, message);
          }
          bucket.streamingMessage = null;
          if (payload.contextPreview) {
            bucket.contextPreview = payload.contextPreview;
          }
          this.threadMessagesByKey[tKey] = { ...bucket };
          break;
        }

        case 'run_updated': {
          const run = payload.run || payload;
          if (!creationId || !run || !run.id) return;
          const dKey = creationDetailKey(agentId, creationId);
          if (this.detailsByKey[dKey]) {
            this.detailsByKey[dKey].runs = upsertById(this.detailsByKey[dKey].runs, run);
          }

          // Clear matching streamingMessage when a thread run reaches terminal state.
          const isTerminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
          if (isTerminal && (run.type === 'thread' || run.threadId)) {
            const prefix = `${creationDetailKey(agentId, creationId)}${KEY_SEP}`;
            for (const key of Object.keys(this.threadMessagesByKey)) {
              if (!key.startsWith(prefix)) continue;
              if (run.threadId && key !== creationThreadKey(agentId, creationId, run.threadId)) continue;
              const tb = this.threadMessagesByKey[key];
              if (tb && tb.streamingMessage) {
                this.threadMessagesByKey[key] = { ...tb, streamingMessage: null };
              }
            }
          }

          // Mirror active run status & progress onto the Galaxy list item without clobbering persisted creation.status.
          const bucket = this.byAgent[agentId];
          if (bucket && Array.isArray(bucket.list)) {
            const idx = bucket.list.findIndex((c) => c && c.id === creationId);
            if (idx >= 0) {
              const next = bucket.list.slice();
              const isRunning = run.status === 'running';
              const isPaused = run.status === 'paused';
              const progress = typeof run.progress === 'number'
                ? run.progress
                : (run.totalUnits > 0 ? (run.completedUnits || 0) / run.totalUnits : next[idx].activeRunProgress);
              next[idx] = {
                ...next[idx],
                activeRunStatus: isRunning ? 'running' : (isPaused ? 'paused' : null),
                activeRunProgress: (isRunning || isPaused) ? progress : null,
              };
              bucket.list = next;
            }
          }
          break;
        }

        default:
          break;
      }
    },

    async reconcileAfterReconnect(agentId = null) {
      const gen = storeGeneration;
      const filterAgentId = agentId ? String(agentId).trim() : null;
      const tasks = [];

      if (this.selectedAgentId && (!filterAgentId || this.selectedAgentId === filterAgentId)) {
        tasks.push(this.listCreations(this.selectedAgentId).catch(() => {}));
      }

      const active = this.activeCreation;
      if (active && active.agentId && active.creationId && (!filterAgentId || active.agentId === filterAgentId)) {
        const { agentId: aId, creationId: cId } = active;
        tasks.push((async () => {
          try {
            const res = await this.request(aId, 'get_creation', { creationId: cId });
            if (gen !== storeGeneration) return;
            const dKey = creationDetailKey(aId, cId);
            const creation = res?.creation || res || {};
            const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
            const canon = Array.isArray(res?.canon) ? res.canon : [];
            const sources = Array.isArray(res?.sources) ? res.sources : [];
            const assets = Array.isArray(res?.assets) ? res.assets : [];
            const threads = Array.isArray(res?.threads) ? res.threads : [];
            const proposals = Array.isArray(res?.proposals) ? res.proposals : [];
            const runs = Array.isArray(res?.runs) ? res.runs : [];
            this.detailsByKey[dKey] = {
              creation,
              nodes,
              canon,
              sources,
              assets,
              threads,
              proposals,
              runs,
              loadedAt: Date.now(),
            };
            if (creation?.id) {
              const bucket = this._ensureAgentBucket(aId);
              bucket.list = upsertById(bucket.list, creation);
            }

            const currentActive = this.activeCreation;
            if (currentActive && currentActive.agentId === aId && currentActive.creationId === cId) {
              const activeNodeObj = currentActive.activeNodeId
                ? nodes.find((n) => n && n.id === currentActive.activeNodeId) || null
                : null;
              let targetNodeId = currentActive.activeNodeId || null;
              if (currentActive.mode === 'read' && (!activeNodeObj || isFolderNode(activeNodeObj))) {
                const firstUnit = nodes
                  .filter((n) => n && !isFolderNode(n))
                  .sort((a, b) => (a.sortOrder ?? a.position ?? a.order ?? 0) - (b.sortOrder ?? b.position ?? b.order ?? 0))[0] || null;
                targetNodeId = firstUnit?.id || null;
              }
              if (targetNodeId) {
                const nKey = creationNodeKey(aId, cId, targetNodeId);
                if (!this.nodeContentsByKey[nKey]?.dirty) {
                  await this.loadNode(aId, cId, targetNodeId).catch(() => {});
                }
              }
            }

            const prefix = `${dKey}${KEY_SEP}`;
            const cachedThreads = Object.entries(this.threadMessagesByKey)
              .filter(([key]) => key.startsWith(prefix))
              .map(([, tb]) => tb?.thread)
              .filter(Boolean);
            await Promise.all(
              cachedThreads.map((thr) => this.loadThread(
                aId,
                cId,
                thr.scopeType || 'global',
                thr.scopeId || null,
              ).catch(() => {})),
            );
          } catch {
            // non-fatal during reconnect reconciliation
          }
        })());
      }

      await Promise.all(tasks);
    },

    clearAll() {
      storeGeneration += 1;
      this.openActivationSeq += 1;
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Creations store cleared'));
      }
      pendingRequests.clear();

      this.selectedAgentId = '';
      this.byAgent = {};
      this.detailsByKey = {};
      this.nodeContentsByKey = {};
      this.threadMessagesByKey = {};
      this.activeCreation = null;
      this.inspectorTarget = null;
      this.viewMode = 'galaxy';
      this.kindFilter = 'all';
      this.searchQuery = '';
      this.igniteDraft = defaultIgniteDraft();
    },
  },
});
