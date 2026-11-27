/**
 * Creations Store — Pinia store for Yeaft Cosmos Creation Stars (Galaxy L1/L2/L3).
 *
 * Strictly Agent-scoped: all cached lists, details, node contents, threads, and live
 * events are keyed by `(agentId, creationId[, nodeId|threadId])` so multi-Agent stars
 * never collide or overwrite each other.
 */
import { useChatStore } from './chat.js';
import { useAuthStore } from './auth.js';
import { yeaftSessionIdentityKey } from './helpers/yeaft-session-identity.js';
import { hasBufferedLiveYeaftSession } from './helpers/messageHandler.js';
import { workbenchRouteKey, workbenchWorkspaceGeneration } from '../utils/workbench-route.js';
import * as canvasContext from '../utils/canvas-context.js';

const { defineStore } = Pinia;

const KEY_SEP = '\u001f';
const USER_PREFIX_RE = /^user_\d+_[a-zA-Z0-9]+:/;
const pendingRequests = new Map();
const inFlightBindFolder = new Map();
const inFlightResolveSession = new Map();
const inFlightWorkspaceCreates = new Map();
const pendingOpenActivations = new Map();
let requestSeq = 0;
let pendingWorkbenchSeq = 0;
let igniteAttemptSeq = 0;
let storeGeneration = 0;

function ackErrorMessage(res, fallback) {
  if (!res) return fallback;
  if (typeof res.error === 'string' && res.error.trim()) return res.error.trim();
  if (res.error && typeof res.error.message === 'string' && res.error.message.trim()) {
    return res.error.message.trim();
  }
  if (typeof res.message === 'string' && res.message.trim()) return res.message.trim();
  if (res.error && typeof res.error.code === 'string' && res.error.code.trim()) {
    return `${fallback} (${res.error.code.trim()})`;
  }
  return fallback;
}

function isAmbiguousRpcResult(res) {
  return !res || res.ambiguous === true
    || ['timeout', 'disconnected', 'connection_closed', 'offline'].includes(res.error?.code)
    || /timed?\s*out|disconnect|connection\s+closed|offline/i.test(String(res.error?.message || res.error || ''));
}

function extractSessionId(res) {
  return res?.session?.id
    || res?.group?.id
    || res?.sessionId
    || res?.id
    || null;
}

function extractProjectId(res) {
  return res?.result?.id
    || res?.project?.id
    || res?.id
    || null;
}

/**
 * Explicitly switch the active route to `(agentId, sessionId)`, verify that the
 * active route matches before sending, and dispatch the initial creation prompt
 * using the exact `sendYeaftSessionMessage` contract.
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @param {string} text
 * @returns {Promise<{ ok: boolean, error?: string, result?: any }>}
 */
export async function sendInitialCreationPrompt(agentId, sessionId, text, {
  isOpenStillCurrent = () => true, routeReady = false, cosmosDelivery = false,
} = {}) {
  const targetAgentId = String(agentId || '').trim();
  const targetSessionId = String(sessionId || '').trim();
  const trimmedText = String(text || '').trim();
  if (!targetAgentId || !targetSessionId || !trimmedText) {
    return { ok: false, error: 'Missing agentId, sessionId, or prompt text' };
  }

  const chatStore = getChatStoreSafe();
  const sessionsStore = getSessionsStoreSafe();
  if (!chatStore || typeof chatStore.sendYeaftSessionMessage !== 'function') {
    return { ok: false, error: 'Chat store unavailable' };
  }

  if (!isOpenStillCurrent()) return { ok: false };
  if (!routeReady) {
    if (chatStore.currentAgent !== targetAgentId) chatStore.selectAgent?.(targetAgentId);
    chatStore.enterYeaft?.(targetAgentId, { deferBootstrap: true });
    sessionsStore?.setActive?.(targetSessionId, targetAgentId);
    chatStore.setActiveSessionFilter?.(targetSessionId, { agentId: targetAgentId, force: true });
  }

  const authStore = useAuthStore();
  const sessionKey = yeaftSessionIdentityKey(targetAgentId, targetSessionId);
  const routeState = () => [chatStore.currentAgent, chatStore.currentView, chatStore.uiMode,
    chatStore.yeaftActiveSessionFilter, chatStore.activeSessionRoute?.agentId,
    chatStore.activeSessionRoute?.sessionId, authStore?.authGeneration,
    chatStore.chatHistoryConnectionGeneration];
  const startRoute = routeState();
  let routeChanged = false;
  const stop = globalThis.Vue?.watch?.(routeState, () => { routeChanged = true; }, { flush: 'sync' });
  const canSend = () => isOpenStillCurrent() && !routeChanged
    && routeState().every((value, i) => value === startRoute[i]);
  const matchesRoute = () => chatStore.currentAgent === targetAgentId
    && (!chatStore.yeaftActiveSessionFilter || chatStore.yeaftActiveSessionFilter === targetSessionId)
    && (chatStore.resolveYeaftSessionAgentId?.(targetSessionId) ?? targetAgentId) === targetAgentId;
  const sendError = { ok: false, error: 'Failed to send initial creation prompt' };
  try {
    if (!matchesRoute()) return { ok: false, error: 'Active session route does not match target creation session' };
    // chat.js recursively sends after pending config promises, without a navigation
    // fence. Drain that same queue here so the actual send starts synchronously.
    const pendingConfig = () => chatStore._sessionSceneSwitches?.get(sessionKey)?.promise
      || chatStore._sessionModelSwitchQueue?.get(sessionKey);
    for (let pending = pendingConfig(); pending; pending = pendingConfig()) {
      const result = await pending.catch(() => null);
      if (!canSend()) return { ok: false };
      if (!result?.ok || pendingConfig() === pending) return sendError;
    }
    if (!matchesRoute()) return sendError;
    if (!canSend()) return { ok: false };
    const sent = await chatStore.sendYeaftSessionMessage({
      groupId: targetSessionId,
      text: trimmedText,
      ...(cosmosDelivery ? { cosmosDelivery: true } : {}),
    });
    if (!canSend()) return { ok: false };
    return sent === false ? sendError : { ok: true, result: sent };
  } finally {
    stop?.();
  }
}

/**
 * Return a human-readable Agent display name, stripping internal `user_<ts>_<rand>:` prefixes
 * when falling back to raw Agent IDs.
 * @param {object|string|null|undefined} agent
 * @returns {string}
 */
export function formatAgentDisplayName(agent) {
  if (!agent) return '';
  if (typeof agent === 'string') {
    const trimmed = agent.trim();
    return trimmed.replace(USER_PREFIX_RE, '') || trimmed;
  }
  const rawName = typeof agent.name === 'string' ? agent.name.trim() : '';
  if (rawName && !USER_PREFIX_RE.test(rawName)) {
    return rawName;
  }
  const fallback = rawName || (typeof agent.id === 'string' ? agent.id.trim() : '');
  if (!fallback) return '';
  return fallback.replace(USER_PREFIX_RE, '') || fallback;
}

function getChatStoreSafe() {
  try {
    if (typeof Pinia !== 'undefined' && typeof Pinia.useChatStore === 'function') {
      return Pinia.useChatStore();
    }
  } catch {
    // fallback to module import
  }
  return useChatStore();
}

function getSessionsStoreSafe() {
  try {
    if (typeof Pinia !== 'undefined' && typeof Pinia.useSessionsStore === 'function') {
      return Pinia.useSessionsStore();
    }
    if (typeof window !== 'undefined' && typeof window.Pinia?.useSessionsStore === 'function') {
      return window.Pinia.useSessionsStore();
    }
  } catch {
    // sessions store unavailable
  }
  return null;
}

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

function defaultIgniteResume() {
  return {
    agentId: '', attemptKey: '', projectId: '', creationId: '', sessionId: '',
    projectSelection: '', newProjectName: '', sessionMode: 'new', existingSessionId: '',
    baselineProjectIds: [], baselineSessionIds: [], projectAttempted: false, sessionAttempted: false,
  };
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
    attemptId: 0,
    error: null,
    resume: defaultIgniteResume(),
  };
}

export function normalizeWorkspacePath(raw) {
  const path = String(raw ?? '').trim();
  if (!path) return '';
  const unc = /^\\\\[^\\/]/.test(path) || /^\/\/[^\\/]/.test(path);
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const normalized = (unc || drive ? path.replace(/\\/g, '/') : path).replace(/\/+/g, '/');
  if (unc) return `/${normalized.replace(/\/+$/, '')}`;
  if (drive) {
    const withLowerDrive = normalized[0].toLowerCase() + normalized.slice(1);
    // Keep a bare drive root absolute (c:/, not c:).
    return withLowerDrive.length === 3 ? withLowerDrive : withLowerDrive.replace(/\/+$/, '');
  }
  return normalized.replace(/\/+$/, '') || '/';
}

function folderImportKey(folderIdentity) {
  // FNV-1a over the serialized tuple works even outside a secure browser context.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(folderIdentity)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `bind-folder:${hash.toString(16).padStart(16, '0')}`;
}

function normalizeDraftKey(rootDir, filePath) {
  return `${normalizeWorkspacePath(rootDir)}::${normalizeWorkspacePath(filePath)}`;
}

/** Only the native Sessions inventory is eligible for linking a Creation. */
export function creationSessionsForAgent(sessionsStore, agentId) {
  if (!agentId) return [];
  const rows = sessionsStore?.sessionsForAgent?.(agentId) || sessionsStore?.sessionList || [];
  return rows.filter(s => s?.id && s.agentId === agentId && (!s.runtimeProvider || s.runtimeProvider === 'yeaft'));
}

/** Keep a single Agent import key for the lifetime of a form, not a submission. */
export function newCreationAttemptKey() {
  return `workspace:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
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
    openWorkspaceSeq: 0,
    mountedCreationTabRoutes: {},
    docDraftsByAgent: {},
    pendingWorkbenchTarget: null,
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
    getDocDraft(agentId, rootDir, filePath) {
      if (!Object.hasOwn(this.docDraftsByAgent, agentId)) return null;
      return this.docDraftsByAgent[agentId]?.[normalizeDraftKey(rootDir, filePath)] ?? null;
    },

    getOrCreateDocDraft(agentId, rootDir, filePath, initial = {}) {
      if (!agentId) return null;
      const existing = this.getDocDraft(agentId, rootDir, filePath);
      if (existing) return existing;
      if (!Object.hasOwn(this.docDraftsByAgent, agentId)) {
        this.docDraftsByAgent = { ...this.docDraftsByAgent, [agentId]: {} };
      }
      const bucket = this.docDraftsByAgent[agentId];
      const key = normalizeDraftKey(rootDir, filePath);
      bucket[key] = Vue.reactive({
        content: '', loaded: false, loading: false, saving: false, loadError: null,
        diskMtimeMs: null, diskSize: null, isBinary: false, diskChangedToBinary: false,
        isDirty: initial?.dirty ?? false,
        ...initial,
        rootDir,
        path: filePath,
        bufferVersion: 1,
        probeSeq: 0,
      });
      return bucket[key];
    },

    setDocDraft(agentId, rootDir, filePath, draft = {}) {
      const existing = this.getDocDraft(agentId, rootDir, filePath);
      if (!existing) return this.getOrCreateDocDraft(agentId, rootDir, filePath, draft);
      const patch = { ...draft };
      if (!Object.hasOwn(patch, 'isDirty') && Object.hasOwn(patch, 'dirty')) patch.isDirty = patch.dirty;
      const changed = ['content', 'isDirty'].some(key => Object.hasOwn(patch, key) && patch[key] !== existing[key]);
      const bufferVersion = existing.bufferVersion + (changed ? 1 : 0);
      Object.assign(existing, patch, { bufferVersion });
      return existing;
    },

    deleteDocDraft(agentId, rootDir, filePath) {
      if (!Object.hasOwn(this.docDraftsByAgent, agentId)) return;
      delete this.docDraftsByAgent[agentId][normalizeDraftKey(rootDir, filePath)];
    },

    clearDocDraftsForRoot(agentId, rootDir) {
      const drafts = Object.hasOwn(this.docDraftsByAgent, agentId) && this.docDraftsByAgent[agentId];
      if (drafts) deleteKeysWithPrefix(drafts, normalizeDraftKey(rootDir, ''));
    },

    listDirtyDocDrafts(agentId, rootDir = null) {
      if (!Object.hasOwn(this.docDraftsByAgent, agentId)) return [];
      const prefix = rootDir ? normalizeDraftKey(rootDir, '') : '';
      return Object.entries(this.docDraftsByAgent[agentId])
        .filter(([key, draft]) => key.startsWith(prefix) && (draft?.isDirty ?? draft?.dirty))
        .map(([, draft]) => draft);
    },

    registerCreationTabRoute(routeKey, { agentId, sessionId, workspaceGeneration } = {}) {
      if (!routeKey) return;
      const previous = Object.hasOwn(this.mountedCreationTabRoutes, routeKey)
        ? this.mountedCreationTabRoutes[routeKey] : null;
      this.mountedCreationTabRoutes[routeKey] = {
        agentId: agentId ?? previous?.agentId,
        sessionId: sessionId ?? previous?.sessionId,
        workspaceGeneration: workspaceGeneration ?? previous?.workspaceGeneration,
        count: (previous?.count || 0) + 1,
      };
    },

    unregisterCreationTabRoute(routeKey) {
      if (!Object.hasOwn(this.mountedCreationTabRoutes, routeKey)) return;
      const route = this.mountedCreationTabRoutes[routeKey];
      if (route.count > 1) route.count -= 1;
      else delete this.mountedCreationTabRoutes[routeKey];
      for (const [openSeq, { agentId, sessionId }] of pendingOpenActivations) {
        if (route.agentId === agentId && route.sessionId === sessionId && !this.hasMountedCreationTab(agentId, sessionId)) {
          this.resolveCreationActivation(openSeq, false);
        }
      }
    },

    isCreationTabMounted(routeKey) {
      return Number(this.mountedCreationTabRoutes[routeKey]?.count || 0) > 0;
    },

    hasMountedCreationTab(agentId, sessionId) {
      const routeKey = workbenchRouteKey({ runtimeProvider: 'yeaft', agentId, sessionId });
      return this.isCreationTabMounted(routeKey) || Object.values(this.mountedCreationTabRoutes).some(route => (
        route.count > 0 && route.agentId === agentId && route.sessionId === sessionId
      ));
    },

    waitForCreationActivation(openSeq, { agentId, sessionId, workspaceGeneration }) {
      if (!Number.isSafeInteger(openSeq) || openSeq !== this.openWorkspaceSeq) return Promise.resolve(false);
      const existing = pendingOpenActivations.get(openSeq);
      if (existing) return existing.promise;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const routeKey = workbenchRouteKey({ runtimeProvider: 'yeaft', agentId, sessionId });
      pendingOpenActivations.set(openSeq, { agentId, sessionId, routeKey, workspaceGeneration, resolve, promise });
      return promise;
    },

    resolveCreationActivation(openSeq, accepted, { workspaceGeneration } = {}) {
      const pending = pendingOpenActivations.get(openSeq);
      if (!pending) return;
      pendingOpenActivations.delete(openSeq);
      pending.resolve(accepted === true && openSeq === this.openWorkspaceSeq
        && (pending.workspaceGeneration == null || workspaceGeneration === pending.workspaceGeneration));
    },

    cancelStaleGenerationActivations(routeKey, liveWorkspaceGeneration) {
      let canceled = false;
      for (const [openSeq, pending] of pendingOpenActivations) {
        if (pending.routeKey === routeKey && pending.workspaceGeneration != null
          && pending.workspaceGeneration !== liveWorkspaceGeneration) {
          this.resolveCreationActivation(openSeq, false);
          canceled = true;
        }
      }
      return canceled;
    },

    resetIgniteResume() {
      this.igniteDraft.resume = defaultIgniteResume();
    },

    beginIgniteAttempt() {
      const attemptId = ++igniteAttemptSeq;
      Object.assign(this.igniteDraft, { attemptId, submitting: true, error: null });
      return attemptId;
    },

    finishIgniteAttempt(attemptId) {
      if (!attemptId || this.igniteDraft.attemptId !== attemptId) return;
      // Release ownership as well as the lock: a late finally becomes a no-op.
      Object.assign(this.igniteDraft, { submitting: false, attemptId: 0 });
    },

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

    _upsertSummary(agentId, creation) {
      if (!agentId || !creation || !creation.id) return;
      const bucket = this._ensureAgentBucket(agentId);
      bucket.list = upsertById(bucket.list, creation);
      const dKey = creationDetailKey(agentId, creation.id);
      if (this.detailsByKey[dKey]) {
        this.detailsByKey[dKey].creation = {
          ...(this.detailsByKey[dKey].creation || {}),
          ...creation,
        };
      }
    },

    setPendingWorkbenchTarget(target) {
      if (!target || typeof target !== 'object') {
        this.pendingWorkbenchTarget = null;
        return null;
      }
      const next = { ...target, seq: ++pendingWorkbenchSeq };
      this.pendingWorkbenchTarget = next;
      return next;
    },

    clearPendingWorkbenchTarget(seq) {
      if (!seq || this.pendingWorkbenchTarget?.seq === seq) {
        this.pendingWorkbenchTarget = null;
      }
    },

    async ensureWorkspace(agentId, creationId, { rootDir } = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId || !creationId) throw new Error('Missing agentId or creationId');
      const gen = storeGeneration;
      const res = await this.request(targetId, 'ensure_workspace', {
        creationId,
        ...(rootDir ? { rootDir } : {}),
      });
      if (gen === storeGeneration && res?.creation?.id) {
        this._upsertSummary(targetId, res.creation);
      }
      return res;
    },

    async findByFolder(agentId, rootDir) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      const trimmedDir = String(rootDir || '').trim();
      if (!targetId || !trimmedDir) return null;
      const res = await this.request(targetId, 'find_by_folder', { rootDir: trimmedDir });
      return res?.creation || null;
    },

    async bindFolderAsCreation({
      agentId,
      rootDir,
      title,
      kind = 'book',
      sessionId = null,
      projectId = null,
    } = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      const trimmedDir = String(rootDir || '').trim();
      if (!targetId || !trimmedDir) {
        throw new Error('Missing agentId or rootDir');
      }

      const dedupeKey = JSON.stringify([targetId, normalizeWorkspacePath(trimmedDir)]);
      if (inFlightBindFolder.has(dedupeKey)) {
        return inFlightBindFolder.get(dedupeKey);
      }

      const run = (async () => {
        const found = await this.findByFolder(targetId, trimmedDir);
        if (found?.id) {
          let existing = found;
          if (!String(found.rootDir ?? '').trim()) {
            const ensured = await this.ensureWorkspace(targetId, found.id, { rootDir: trimmedDir });
            existing = ensured?.creation || ensured;
            if (!String(existing?.rootDir ?? '').trim()) throw new Error('Failed to prepare workspace');
          }
          if ((sessionId && !existing.sessionId) || (projectId && !existing.projectId)) {
            const patch = {
              ...(sessionId && !existing.sessionId ? { sessionId } : {}),
              ...(projectId && !existing.projectId ? { projectId } : {}),
            };
            const updated = await this.updateCreation(targetId, found.id, patch);
            return { creation: { ...existing, ...updated, rootDir: updated?.rootDir || existing.rootDir }, existed: true };
          }
          this._upsertSummary(targetId, existing);
          return { creation: existing, existed: true };
        }

        const normalized = trimmedDir.replace(/[\\/]+$/, '');
        const lastSegment = normalized.split(/[\\/]/).filter(Boolean).pop() || 'Creation';
        const resolvedTitle = String(title || '').trim() || lastSegment;

        const res = await this.createCreation(targetId, {
          title: resolvedTitle,
          kind,
          rootDir: trimmedDir,
          importKey: folderImportKey(dedupeKey),
          ...(sessionId ? { sessionId } : {}),
          ...(projectId ? { projectId } : {}),
          initializeFolder: true,
          autoPlan: false,
        });
        const created = res?.creation || (res?.id ? res : null);
        return { creation: created, existed: false };
      })().finally(() => {
        if (inFlightBindFolder.get(dedupeKey) === run) {
          inFlightBindFolder.delete(dedupeKey);
        }
      });

      inFlightBindFolder.set(dedupeKey, run);
      return run;
    },

    createWorkspaceCreation(options) {
      return this.createCreationWithWorkspace(options);
    },

    async createCreationWithWorkspace(options = {}) {
      const targetId = String(options.agentId || this.selectedAgentId || '').trim();
      const { attemptKey, title, kind = 'book', rawFiles } = options;
      const trimmedTitle = String(title || '').trim();
      const flightKey = typeof attemptKey === 'string' && attemptKey.trim() ? `${targetId}::${attemptKey}` : null;
      const gen = storeGeneration;
      const existing = flightKey && inFlightWorkspaceCreates.get(flightKey);
      if (existing) {
        const baseRes = await existing.promise;
        if (gen !== storeGeneration) throw new Error('Creations store cleared');
        const patch = {
          ...(trimmedTitle && trimmedTitle !== baseRes.creation.title ? { title: trimmedTitle } : {}),
          ...(kind !== baseRes.creation.kind ? { kind } : {}),
        };
        const updated = Object.keys(patch).length
          ? await this.updateCreation(targetId, baseRes.creation.id, patch) : null;
        if (gen !== storeGeneration) throw new Error('Creations store cleared');
        return {
          ...baseRes,
          ...(updated ? { creation: { ...baseRes.creation, ...updated } } : {}),
          _submittedSnapshot: { ...baseRes._submittedSnapshot, files: existing.submittedFiles },
        };
      }

      const entry = { promise: null, submittedFiles: [] };
      const filesAtStart = Array.isArray(rawFiles) ? rawFiles.slice() : [];
      // Reserve the attempt before issuing any RPC; remounts reuse this promise.
      entry.promise = Promise.resolve().then(() => {
        if (gen !== storeGeneration) throw new Error('Creations store cleared');
        return this._createWorkspace(targetId, { ...options, rawFiles: filesAtStart });
      }).then(result => {
        entry.submittedFiles = result._submittedSnapshot.files;
        return result;
      }).finally(() => {
        if (flightKey && inFlightWorkspaceCreates.get(flightKey) === entry) inFlightWorkspaceCreates.delete(flightKey);
      });
      if (flightKey) inFlightWorkspaceCreates.set(flightKey, entry);
      return entry.promise;
    },

    async _createWorkspace(targetId, {
      title,
      kind = 'book',
      projectId = null,
      newProjectName = '',
      sessionMode = 'new',
      existingSessionId = null,
      rootDir = '',
      prompt = '',
      rawFiles = [],
      celestial = null,
      resumeProjectId = null,
      resumeCreationId = null,
      resumeSessionId = null,
      attemptKey = null,
      baselineProjectIds,
      baselineSessionIds,
      projectAttempted = false,
      sessionAttempted = false,
    }) {
      const gen = storeGeneration;
      const chatStore = getChatStoreSafe();
      const sessionsStore = getSessionsStoreSafe();
      let targetProjectId = String(resumeProjectId || projectId || '').trim() || null;
      let targetSessionId = String(resumeSessionId || '').trim() || null;
      const trimmedProjectName = String(newProjectName || '').trim();
      const trimmedTitle = String(title || '').trim();
      const trimmedRootDir = String(rootDir || '').trim();
      const trimmedResumeId = String(resumeCreationId || '').trim();
      let created = null;
      let createRes = null;
      let uploadedFilesThisCall = [];
      let didAttemptProject = projectAttempted;
      let didAttemptSession = sessionAttempted;
      const projectRows = () => chatStore?.yeaftProjects || chatStore?.sessionProjects || [];
      const sessionRows = () => sessionsStore?.sessionsForAgent?.(targetId) || chatStore?.yeaftSessions || [];
      const idsOf = rows => rows.map(row => row?.id).filter(Boolean);
      // An empty inventory is a valid baseline if the mutation was already attempted.
      const capturedBaselineProjects = Array.isArray(baselineProjectIds) && (projectAttempted || baselineProjectIds.length)
        ? [...baselineProjectIds] : idsOf(projectRows());
      let capturedBaselineSessions = Array.isArray(baselineSessionIds) ? [...baselineSessionIds] : [];
      const refreshNativeInventory = async () => {
        const res = await chatStore?.sessionCrudRequest?.('list', {}, { agentId: targetId });
        if (res?.ok === false) throw new Error(ackErrorMessage(res, 'Failed to refresh Session inventory'));
        return res;
      };
      const ensureSameStore = () => {
        if (gen !== storeGeneration) throw new Error('Creations store cleared');
      };

      const checkpointResume = () => {
        const resume = this.igniteDraft?.resume;
        if (gen !== storeGeneration || !attemptKey || resume?.attemptKey !== attemptKey || resume.agentId !== targetId) return;
        Object.assign(resume, {
          projectId: targetProjectId || resume.projectId,
          creationId: created?.id || trimmedResumeId || resume.creationId,
          sessionId: targetSessionId || resume.sessionId,
          projectAttempted: didAttemptProject,
          sessionAttempted: didAttemptSession,
          baselineProjectIds: capturedBaselineProjects,
          baselineSessionIds: capturedBaselineSessions,
        });
      };

      try {
        if (!targetId) throw new Error('No Agent selected');
        // Project creation is checkpointed before any workspace/session RPC.
        if (!targetProjectId && trimmedProjectName && projectAttempted) {
          const loadProjects = chatStore?.loadYeaftProjects || chatStore?.fetchProjects;
          const snapshot = loadProjects ? await loadProjects.call(chatStore) : await refreshNativeInventory();
          ensureSameStore();
          const rows = Array.isArray(snapshot?.projects) ? snapshot.projects
            : Array.isArray(snapshot) ? snapshot : projectRows();
          const matches = rows.filter(p => p?.id && p.name === trimmedProjectName && !capturedBaselineProjects.includes(p.id));
          if (matches.length > 1) throw new Error('Multiple Projects match the previous creation attempt');
          if (matches.length === 1) targetProjectId = matches[0].id;
        }
        if (!targetProjectId && trimmedProjectName) {
          if (typeof chatStore?.mutateProject !== 'function') {
            throw new Error('Project creation unavailable');
          }
          didAttemptProject = true;
          checkpointResume();
          const projRes = await chatStore.mutateProject('create', { name: trimmedProjectName }, targetId);
          const createdProjectId = extractProjectId(projRes);
          if (projRes && projRes.ok === false) {
            if (!isAmbiguousRpcResult(projRes)) didAttemptProject = false;
            throw new Error(ackErrorMessage(projRes, 'Failed to create Project'));
          }
          if (!projRes || !createdProjectId) {
            throw new Error(ackErrorMessage(projRes, 'Failed to create Project'));
          }
          targetProjectId = createdProjectId;
          ensureSameStore();
        }

        checkpointResume();

        // Step 2: Create or resume the folder-backed Creation.
        // Do NOT persist targetProjectId before move_session succeeds.
        if (trimmedResumeId) {
          const dKey = creationDetailKey(targetId, trimmedResumeId);
          created = this.detailsByKey[dKey]?.creation
            || (this.byAgent[targetId]?.list || []).find((c) => c && c.id === trimmedResumeId)
            || null;
          if (!created) {
            const getRes = await this.request(targetId, 'get_creation', { creationId: trimmedResumeId });
            created = getRes?.creation || (getRes?.id ? getRes : null);
            ensureSameStore();
            if (created?.id) {
              this._upsertSummary(targetId, created);
            }
          }
          if (!created?.id) {
            throw new Error('Failed to resume Creation');
          }
        } else {
          const filesToSubmit = Array.isArray(rawFiles) ? rawFiles.slice() : [];
          createRes = await this.createCreation(targetId, {
            ...(trimmedTitle ? { title: trimmedTitle } : {}),
            kind,
            mission: prompt || '',
            prompt: prompt || '',
            ...(trimmedRootDir ? { rootDir: trimmedRootDir } : {}),
            initializeFolder: true,
            autoPlan: false,
            ...(attemptKey ? { importKey: attemptKey } : {}),
            ...(celestial ? { celestial } : {}),
            ...(filesToSubmit.length ? { rawFiles: filesToSubmit } : {}),
          });
          created = createRes?.creation || (createRes?.id ? createRes : null);
          ensureSameStore();
          if (!created?.id) {
            throw new Error('Failed to create Creation');
          }
          if (created.deduplicated || createRes?.deduplicated) {
            // importKey deduplication happens before attachment ingestion. Only
            // consume files that the Agent confirms were already attached.
            const sources = createRes?.sources ?? this.detailsByKey[creationDetailKey(targetId, created.id)]?.sources;
            const subtle = globalThis.crypto?.subtle;
            if (Array.isArray(sources) && subtle?.digest) {
              // Each stored source can confirm only one selection, even for identical files.
              const remainingSources = sources.filter(source => typeof source?.name === 'string' && source.name.trim()
                && typeof source.sha256 === 'string' && source.sha256.trim());
              for (const file of filesToSubmit) {
                if (!remainingSources.some(source => source.name === file.name)) continue;
                let fileSha256;
                try {
                  const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
                  fileSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                } catch {
                  continue; // An unreadable file or unavailable digest cannot confirm ingestion.
                }
                const confirmedIndex = remainingSources.findIndex(source => source.name === file.name && source.sha256 === fileSha256);
                if (confirmedIndex < 0) continue;
                remainingSources.splice(confirmedIndex, 1);
                uploadedFilesThisCall.push(file);
              }
              ensureSameStore();
            }
          } else {
            uploadedFilesThisCall = filesToSubmit;
          }
        }

        checkpointResume();

        // Step 3: Resolve or create the linked Yeaft Session with strict ack validation.
        if (!Array.isArray(baselineSessionIds) || (!sessionAttempted && !baselineSessionIds.length)) {
          capturedBaselineSessions = idsOf(sessionRows());
        }
        if (!targetSessionId && sessionMode === 'new') {
          targetSessionId = created.sessionId || null;
          if (!targetSessionId && sessionAttempted) {
            const snapshot = typeof chatStore?.loadYeaftSessions === 'function'
              ? await chatStore.loadYeaftSessions(targetId) : await refreshNativeInventory();
            ensureSameStore();
            const scopedRows = Array.isArray(snapshot) ? snapshot : snapshot?.sessions;
            const workspace = normalizeWorkspacePath(created.rootDir);
            const sessionTitle = created.title || trimmedTitle;
            const matches = (scopedRows || sessionRows()).filter(s => s?.id
              && (s.agentId === targetId || (scopedRows && !s.agentId))
              && (!s.runtimeProvider || s.runtimeProvider === 'yeaft')
              && !capturedBaselineSessions.includes(s.id)
              && (workspace ? normalizeWorkspacePath(s.workDir) === workspace
                : sessionTitle && (s.displayName || s.name || s.title) === sessionTitle));
            if (matches.length > 1) throw new Error('Multiple Sessions match the previous creation attempt');
            if (matches.length === 1) targetSessionId = matches[0].id;
          }
        }
        if (sessionMode === 'existing' && (!targetSessionId || targetSessionId === existingSessionId)) {
          const existingSession = sessionsStore?.sessionById?.(existingSessionId, targetId) || null;
          const hasKnownSession = Boolean(
            existingSession || chatStore?.hasKnownYeaftSession?.(existingSessionId, targetId),
          );
          if (!existingSessionId || !hasKnownSession) {
            throw new Error('Selected session does not exist on this Agent');
          }
          targetSessionId = existingSessionId;
          checkpointResume();
          if (created.rootDir && existingSession && !existingSession.workDir) {
            if (typeof chatStore?.sessionCrudRequest === 'function') {
              const updRes = await chatStore.sessionCrudRequest(
                'update',
                { sessionId: existingSessionId, patch: { workDir: created.rootDir } },
                { agentId: targetId },
              );
              ensureSameStore();
              if (!updRes || updRes.ok === false) {
                throw new Error(ackErrorMessage(updRes, 'Failed to update session working directory'));
              }
            }
          }
        } else if (!targetSessionId) {
          if (typeof chatStore?.createYeaftSession !== 'function') {
            throw new Error('Session creation unavailable');
          }
          didAttemptSession = true;
          checkpointResume();
          const sessionRes = await chatStore.createYeaftSession({
            displayName: created.title || trimmedTitle || 'Creation',
            workDir: created.rootDir || trimmedRootDir || undefined,
            agentId: targetId,
          });
          const createdSessionId = extractSessionId(sessionRes);
          if (sessionRes && sessionRes.ok === false) {
            if (!isAmbiguousRpcResult(sessionRes)) didAttemptSession = false;
            throw new Error(ackErrorMessage(sessionRes, 'Failed to create Session'));
          }
          if (!sessionRes || !createdSessionId) {
            throw new Error(ackErrorMessage(sessionRes, 'Failed to create Session'));
          }
          targetSessionId = createdSessionId;
          ensureSameStore();
        }

        checkpointResume();

        // Step 4: Assign the Session to the Project (only persist projectId when ack succeeds).
        let appliedProjectId = null;
        let projectWarning = null;
        if (targetProjectId && targetSessionId) {
          if (typeof chatStore?.mutateProject === 'function') {
            const moveRes = await chatStore.mutateProject('move_session', {
              sessionId: targetSessionId,
              projectId: targetProjectId,
            }, targetId);
            ensureSameStore();
            if (moveRes && moveRes.ok !== false) {
              appliedProjectId = targetProjectId;
            } else {
              projectWarning = ackErrorMessage(moveRes, 'Failed to assign session to project');
            }
          } else {
            projectWarning = 'Project assignment unavailable';
          }
        }

        // Step 5: Persist confirmed sessionId & appliedProjectId on the Creation.
        const isResumedOrDeduplicated = Boolean(trimmedResumeId || created?.deduplicated || createRes?.deduplicated);
        const updated = await this.updateCreation(targetId, created.id, {
          sessionId: targetSessionId,
          projectId: appliedProjectId,
          ...(isResumedOrDeduplicated && trimmedTitle && trimmedTitle !== created.title ? { title: trimmedTitle } : {}),
          ...(isResumedOrDeduplicated && kind && kind !== created.kind ? { kind } : {}),
        });
        ensureSameStore();
        if (!updated?.id) {
          throw new Error('Failed to save Creation session link');
        }

        return {
          agentId: targetId,
          creation: { ...created, ...updated },
          sessionId: targetSessionId,
          projectId: appliedProjectId,
          ...(projectWarning ? { projectWarning, requestedProjectId: targetProjectId } : {}),
          rootDir: updated?.rootDir || created.rootDir || trimmedRootDir || '',
          prompt,
          _submittedSnapshot: {
            files: uploadedFilesThisCall, title: trimmedTitle, prompt: String(prompt || ''), kind, celestial: celestial || null,
          },
        };
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err || 'Failed to create Creation'));
        wrapped.partialProjectId = targetProjectId || null;
        wrapped.partialCreation = created || (trimmedResumeId ? { id: trimmedResumeId } : null);
        wrapped.partialSessionId = targetSessionId;
        wrapped.projectAttempted = didAttemptProject;
        wrapped.sessionAttempted = didAttemptSession;
        wrapped.baselineProjectIds = capturedBaselineProjects;
        wrapped.baselineSessionIds = capturedBaselineSessions;
        checkpointResume();
        throw wrapped;
      }
    },

    async resolveCreationSession(agentId, creation, { createIfMissing = true } = {}) {
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId || !creation?.id) {
        throw new Error('Missing agentId or creation');
      }

      const dedupeKey = `${targetId}::${creation.id}`;
      if (inFlightResolveSession.has(dedupeKey)) {
        return inFlightResolveSession.get(dedupeKey);
      }

      // This resolution is shared across launchers. It never navigates; the
      // caller must commit its route only while it still owns the open request.
      const gen = storeGeneration;
      const run = (async () => {
        let latest = creation;
        let rootDir = latest.rootDir || '';
        if (!rootDir) {
          const wsRes = await this.ensureWorkspace(targetId, latest.id);
          if (gen !== storeGeneration) return null;
          if (wsRes?.creation) {
            latest = { ...latest, ...wsRes.creation };
          }
          rootDir = wsRes?.rootDir || latest.rootDir || '';
        }

        const chatStore = getChatStoreSafe();
        const sessionsStore = getSessionsStoreSafe();
        const linkedSessionId = record => String(record?.sessionId || '').trim() || null;
        let expectedSessionId = linkedSessionId(latest);
        const isDeleted = id => sessionsStore?.isConfirmedDeletedSession?.(targetId, id);
        const hasLiveSession = id => (
          (!isDeleted(id) && Boolean(sessionsStore?.sessionById?.(id, targetId)))
          || hasBufferedLiveYeaftSession(chatStore, targetId, id)
        );
        const creationId = latest.id;
        const getLatestCreation = async () => {
          const res = await this.request(targetId, 'get_creation', { creationId });
          const record = res?.creation || (res?.id ? res : null);
          if (gen === storeGeneration && record?.id) this._upsertSummary(targetId, record);
          return record;
        };
        const useLink = (record, id) => ({ creation: record, sessionId: id, rootDir: record.rootDir || rootDir });

        let list;
        const listHasSession = id => list?.ok === true && Array.isArray(list.sessions)
          && list.sessions.some(row => row?.id === id);
        if (expectedSessionId) {
          if (hasLiveSession(expectedSessionId)) return useLink(latest, expectedSessionId);
          if (!isDeleted(expectedSessionId) && chatStore?.connectionState === 'connected'
              && chatStore.agents?.find(agent => agent?.id === targetId)?.online !== false
              && typeof chatStore.sessionCrudRequest === 'function') {
            try {
              list = await chatStore.sessionCrudRequest('list', {}, { agentId: targetId, suppressAutoSelect: true });
            } catch {
              // A failed refresh isn't evidence that the linked Session is gone.
            }
            if (gen !== storeGeneration) return null;
          }
        }

        // The Agent may have broadcast a relink while the list was in flight.
        const cached = this.byAgent[targetId]?.list?.find(row => row?.id === creationId)
          || this.detailsByKey[creationDetailKey(targetId, creationId)]?.creation;
        const cachedId = linkedSessionId(cached);
        if (cachedId && cachedId !== expectedSessionId && !isDeleted(cachedId)
            && (hasLiveSession(cachedId) || listHasSession(cachedId))) {
          return useLink({ ...latest, ...cached }, cachedId);
        }
        if (expectedSessionId && !isDeleted(expectedSessionId)) {
          const confirmedAbsent = list?.ok === true && Array.isArray(list.sessions)
            ? !listHasSession(expectedSessionId)
            : !hasLiveSession(expectedSessionId) && sessionsStore?.authoritativeSnapshotAgents?.[targetId] === true;
          // Catalog and Server replay misses are not proof of deletion.
          if (!confirmedAbsent) return useLink(latest, expectedSessionId);
        }
        if (!createIfMissing) return useLink(latest, null);

        // No live cached winner. Re-read before creating to catch an unbroadcast relink.
        const current = await getLatestCreation();
        if (gen !== storeGeneration) return null;
        if (!current?.id) throw new Error('Creation not found');
        const currentId = linkedSessionId(current);
        latest = { ...latest, ...current };
        rootDir = current.rootDir || rootDir;
        // The earlier inventory may predate this newer link or a live restore. Don't replace it on stale evidence.
        if (currentId && currentId !== expectedSessionId && !isDeleted(currentId)) return useLink(latest, currentId);
        if (currentId && hasLiveSession(currentId)) return useLink(latest, currentId);
        expectedSessionId = currentId;

        let sessionId;
        if (typeof chatStore?.createYeaftSession !== 'function') {
          throw new Error('Session creation unavailable');
        }
        const sessionRes = await chatStore.createYeaftSession({
          displayName: latest.title || 'Creation',
          workDir: rootDir || undefined,
          agentId: targetId,
        });
        if (gen !== storeGeneration) return null;
        sessionId = extractSessionId(sessionRes);
        if (!sessionRes || sessionRes.ok === false || !sessionId) {
          throw new Error(ackErrorMessage(sessionRes, 'Failed to create Session'));
        }

        let projectPatch = {};
        if (latest.projectId && typeof chatStore?.mutateProject === 'function') {
          try {
            const moveRes = await chatStore.mutateProject('move_session', {
              sessionId,
              projectId: latest.projectId,
            }, targetId);
            if (!moveRes || moveRes.ok === false) {
              projectPatch = { projectId: null };
            }
          } catch {
            projectPatch = { projectId: null };
          }
        }
        if (gen !== storeGeneration) return null;
        try {
          latest = await this.updateCreation(targetId, creationId, { sessionId, expectedSessionId, ...projectPatch });
        } catch (err) {
          if (String(err?.errorCode || err?.code).toUpperCase() !== 'CONFLICT') throw err;
          if (gen !== storeGeneration) return null;
          const winner = await getLatestCreation();
          if (gen !== storeGeneration) return null;
          const winnerId = linkedSessionId(winner);
          // Do NOT hard-delete the candidate Session: it was already broadcast to
          // other tabs and may contain user messages or links to another Creation.
          if (!winnerId) throw err;
          return useLink(winner, winnerId);
        }
        if (gen !== storeGeneration) return null;
        if (!latest?.id) {
          throw new Error('Failed to save Creation session link');
        }

        return { creation: latest, sessionId, rootDir };
      })().finally(() => {
        if (inFlightResolveSession.get(dedupeKey) === run) {
          inFlightResolveSession.delete(dedupeKey);
        }
      });

      inFlightResolveSession.set(dedupeKey, run);
      return run;
    },

    openCreationInClassic(options) {
      return this.openCreationWorkspace({ ...options, uiMode: 'classic' });
    },

    async openCreationWorkspace(agentOrOptions, creationOrId, openOptions = {}) {
      const options = typeof agentOrOptions === 'string'
        ? { ...openOptions, agentId: agentOrOptions, creationId: creationOrId?.id || creationOrId }
        : (agentOrOptions || {});
      const { agentId, creationId, mode = 'studio', promptToSend = '', initialPrompt = promptToSend,
        openedFromGalaxy = false, maximize = mode === 'read' } = options;
      const mySeq = this.cancelPendingWorkspaceOpen();
      const targetId = String(agentId || this.selectedAgentId || '').trim();
      if (!targetId || !creationId) throw new Error('Missing agentId or creationId');

      const chatStore = getChatStoreSafe();
      const targetUiMode = options.uiMode || chatStore?.uiMode || 'classic';
      const sessionsStore = getSessionsStoreSafe();
      const authStore = useAuthStore();
      const authUser = () => authStore?.userId || authStore?.username || '';
      const startAuthUser = authUser();
      const startAuthGeneration = authStore?.authGeneration;
      const startView = chatStore.currentView;
      const startUiMode = chatStore.uiMode;
      const sessionIdForRoute = () => chatStore.yeaftActiveSessionFilter || chatStore.currentConversation;
      const startRoute = { agentId: chatStore.currentAgent, sessionId: sessionIdForRoute() };
      const ownsOpen = () => (
        this.openWorkspaceSeq === mySeq
        && authUser() === startAuthUser
        && authStore?.authGeneration === startAuthGeneration
      );
      let applyingRoute = false;
      let appliedRoute = null;
      const isOpenStillCurrent = () => ownsOpen() && (applyingRoute || (
        chatStore.currentView === (appliedRoute?.view ?? startView)
        && chatStore.uiMode === (appliedRoute?.uiMode ?? startUiMode)
        && chatStore.currentAgent === (appliedRoute?.agentId ?? startRoute.agentId)
        && sessionIdForRoute() === (appliedRoute?.sessionId ?? startRoute.sessionId)
      ));

      // Capture navigation even if the user returns to the original route before the ACK.
      const stopWatchingRoute = globalThis.Vue?.watch?.(
        [() => chatStore.currentView, () => chatStore.uiMode, () => chatStore.currentAgent,
          sessionIdForRoute, authUser, () => authStore?.authGeneration],
        () => {
          if (this.openWorkspaceSeq === mySeq && !applyingRoute) this.cancelPendingWorkspaceOpen();
        },
        { flush: 'sync' },
      );
      sessionsStore?.beginSuppressAutoSelect?.();
      try {
        const dKey = creationDetailKey(targetId, creationId);
        const acknowledgedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
        const acknowledgedRootDir = typeof options.rootDir === 'string' ? options.rootDir.trim() : '';
        const hasAcknowledgedRoute = Boolean(acknowledgedSessionId && acknowledgedRootDir);
        let creation = (creationOrId?.id ? creationOrId : null) || this.detailsByKey[dKey]?.creation
          || (this.byAgent[targetId]?.list || []).find((c) => c && c.id === creationId)
          || null;

        if (!creation && hasAcknowledgedRoute) creation = { id: creationId };
        if (!creation) {
          const res = await this.request(targetId, 'get_creation', { creationId });
          if (!isOpenStillCurrent()) return null;
          creation = res?.creation || (res?.id ? res : null);
          if (creation?.id) this._upsertSummary(targetId, creation);
        }
        if (!creation?.id) throw new Error('Creation not found');

        const resolved = hasAcknowledgedRoute
          ? {
              creation: { ...creation, sessionId: acknowledgedSessionId, rootDir: acknowledgedRootDir },
              sessionId: acknowledgedSessionId,
              rootDir: acknowledgedRootDir,
            }
          : await this.resolveCreationSession(targetId, creation, { createIfMissing: true });
        if (!isOpenStillCurrent()) return null;
        if (!resolved?.sessionId) throw new Error('Failed to resolve Creation session');
        const { creation: latest, sessionId, rootDir } = resolved;
        // A caller-supplied path can be a materialization hint for a cached, unbound Creation.
        const hasRecordedRoot = Boolean(String((hasAcknowledgedRoute ? creation.rootDir : rootDir) || '').trim());
        const target = {
          agentId: targetId, sessionId, creationId: latest.id,
          rootDir: rootDir || latest.rootDir || '', maximize, openSeq: mySeq,
          openedFromGalaxy: Boolean(openedFromGalaxy),
        };

        // The drawer (or Classic route commit below) owns its synchronous route changes.
        applyingRoute = true;
        if (targetUiMode === 'cosmos') {
          if (!isOpenStillCurrent()) return null;
          // CosmosPage must register its activation waiter before publishing the target.
          const detail = { ...target, hasRecordedRoot, initialPrompt: initialPrompt || '', handled: false };
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('cosmos-open-creation-workspace', { detail }));
          }
          if (detail.handled) {
            return { creation: latest, sessionId, rootDir };
          }
        }

        if (chatStore.uiMode === 'cosmos') chatStore.setUiMode?.('classic');
        if (!isOpenStillCurrent()) return null;
        if (chatStore.currentAgent !== targetId) chatStore.selectAgent?.(targetId);
        chatStore.enterYeaft?.(targetId, { deferBootstrap: true });
        sessionsStore?.setActive?.(sessionId, targetId);
        chatStore.setActiveSessionFilter?.(sessionId, { agentId: targetId, force: true });

        appliedRoute = { view: chatStore.currentView, uiMode: chatStore.uiMode,
          agentId: chatStore.currentAgent, sessionId: sessionIdForRoute() };
        applyingRoute = false;
        if (!isOpenStillCurrent()) return null;
        const liveWorkspaceGeneration = () => workbenchWorkspaceGeneration(
          workbenchRouteKey(chatStore.activeSessionRoute), chatStore.effectiveWorkDir,
        );
        const workspaceGeneration = liveWorkspaceGeneration();
        target.workspaceGeneration = workspaceGeneration;
        const isPromptTargetCurrent = () => isOpenStillCurrent() && liveWorkspaceGeneration() === workspaceGeneration;
        const trimmedPrompt = String(initialPrompt || '').trim();
        const needsActivationReceipt = !hasRecordedRoot || (this.hasMountedCreationTab(targetId, sessionId)
          && this.listDirtyDocDrafts(targetId).length > 0);
        const activationPromise = trimmedPrompt && needsActivationReceipt ? this.waitForCreationActivation(mySeq, target) : null;
        this.setPendingWorkbenchTarget(target);

        if (!isOpenStillCurrent()) return null;
        chatStore.openWorkbench?.();

        let promptError = null;
        if (activationPromise) {
          // Give Workbench a render cycle to mount the destination before treating it as absent.
          await globalThis.Vue?.nextTick?.();
          if (!this.hasMountedCreationTab(targetId, sessionId)) this.resolveCreationActivation(mySeq, false);
        }
        if (trimmedPrompt && (!activationPromise || await activationPromise)) {
          if (!isPromptTargetCurrent()) return null;
          const sendRes = await sendInitialCreationPrompt(targetId, sessionId, trimmedPrompt, {
            isOpenStillCurrent: isPromptTargetCurrent, routeReady: true,
          });
          if (!isOpenStillCurrent()) return null;
          if (!sendRes?.ok) promptError = sendRes?.error || 'Failed to send initial creation prompt';
        }

        if (!isOpenStillCurrent()) return null;
        return {
          creation: latest,
          sessionId,
          rootDir,
          ...(promptError ? { promptError } : {}),
        };
      } catch (err) {
        if (!isOpenStillCurrent()) return null;
        throw err;
      } finally {
        stopWatchingRoute?.();
        sessionsStore?.endSuppressAutoSelect?.();
      }
    },

    cancelPendingWorkspaceOpen() {
      const seq = ++this.openWorkspaceSeq;
      for (const openSeq of pendingOpenActivations.keys()) {
        this.resolveCreationActivation(openSeq, false);
      }
      if (this.pendingWorkbenchTarget?.openSeq != null && this.pendingWorkbenchTarget.openSeq !== seq) {
        this.clearPendingWorkbenchTarget(this.pendingWorkbenchTarget.seq);
      }
      return seq;
    },

    invalidatePendingOpen() {
      this.openActivationSeq += 1;
      this.cancelPendingWorkspaceOpen();
    },

    async selectGalaxyAgent(agentId, { force = false } = {}) {
      this.openActivationSeq += 1;
      const nextId = String(agentId || '').trim();
      if (this.selectedAgentId !== nextId) this.cancelPendingWorkspaceOpen();
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
        for (const item of list) {
          if (!item?.id) continue;
          const detail = this.detailsByKey[creationDetailKey(targetId, item.id)];
          if (detail?.creation) detail.creation = { ...detail.creation, ...item };
        }
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
        if (gen !== storeGeneration) throw new Error('Creations store cleared');
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
      this.invalidatePendingOpen();
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
      const gen = storeGeneration;
      const res = await this.request(agentId, 'update_creation', { creationId, ...patch, patch });
      const updated = res?.creation || (res?.id ? res : { id: creationId, ...patch });
      if (gen !== storeGeneration) return updated;

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
      const existing = this.detailsByKey[creationDetailKey(agentId, creationId)]?.creation;
      const rootDir = existing?.rootDir || this.byAgent[agentId]?.list.find(c => c?.id === creationId)?.rootDir;
      const gen = storeGeneration;
      const res = await this.request(agentId, 'delete_creation', { creationId });
      if (gen !== storeGeneration) return res;
      if (rootDir) this.clearDocDraftsForRoot(agentId, rootDir);
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
      this.invalidatePendingOpen();
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Creations store cleared'));
      }
      pendingRequests.clear();
      inFlightBindFolder.clear();
      inFlightResolveSession.clear();
      inFlightWorkspaceCreates.clear();
      this.clearPendingWorkbenchTarget();
      if (typeof canvasContext.clearAllCanvasContextRefs === 'function') {
        canvasContext.clearAllCanvasContextRefs();
      } else if (typeof canvasContext.clearCanvasContextRefs === 'function') {
        canvasContext.clearCanvasContextRefs();
      }

      this.selectedAgentId = '';
      this.byAgent = {};
      this.docDraftsByAgent = {};
      this.mountedCreationTabRoutes = {};
      this.detailsByKey = {};
      this.nodeContentsByKey = {};
      this.threadMessagesByKey = {};
      this.activeCreation = null;
      this.inspectorTarget = null;
      this.pendingWorkbenchTarget = null;
      this.viewMode = 'galaxy';
      this.kindFilter = 'all';
      this.searchQuery = '';
      this.igniteDraft = defaultIgniteDraft();
    },
  },
});
