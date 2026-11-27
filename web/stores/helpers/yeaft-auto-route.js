import { findCatalogModel, normalizeModelEffort } from '../../utils/modelRefs.js';

export const UI_MODE_STORAGE_KEY = 'yeaft-ui-mode';
export const AUTO_ROUTE_TIMEOUT_MS = 45000;

export function normalizeUiMode(value) {
  return value === 'classic' ? 'classic' : 'cosmos';
}

export function readUiMode(storage) {
  const target = storage === undefined ? getLocalStorage() : storage;
  if (!target) return 'cosmos';
  try {
    const raw = target.getItem(UI_MODE_STORAGE_KEY);
    return raw ? normalizeUiMode(raw) : 'cosmos';
  } catch {
    return 'cosmos';
  }
}

export function writeUiMode(mode, storage) {
  const normalized = normalizeUiMode(mode);
  const target = storage === undefined ? getLocalStorage() : storage;
  if (target) {
    try {
      target.setItem(UI_MODE_STORAGE_KEY, normalized);
    } catch { /* best effort when storage is unavailable */ }
  }
  return normalized;
}

function getLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function ensurePendingMap(store) {
  if (!(store._pendingAutoRouteRequests instanceof Map)) {
    store._pendingAutoRouteRequests = new Map();
  }
  return store._pendingAutoRouteRequests;
}

function normalizeQuickSend(store, agentId, quickSend) {
  if (!quickSend || typeof quickSend !== 'object') return null;
  const model = typeof quickSend.model === 'string' ? quickSend.model.trim() : '';
  let effort = typeof quickSend.effort === 'string' ? quickSend.effort.trim() : null;
  const maxOutputTokens = Number.isFinite(quickSend.maxOutputTokens) && quickSend.maxOutputTokens > 0
    ? quickSend.maxOutputTokens
    : null;
  if (!model) return null;
  if (model && effort) {
    const config = store.llmConfig?.[agentId];
    const models = config?.agentConfig?.availableModels
      ?? config?.effectiveConfig?.availableModels
      ?? store.yeaftAvailableModels;
    const catalogModel = findCatalogModel(models, model);
    if (catalogModel?.protocol === 'openai-chat-completions') {
      effort = normalizeModelEffort(effort, catalogModel);
    }
  }
  return { model, effort: effort || null, maxOutputTokens };
}

function lookupPending(store, { requestId, clientMessageId }) {
  const map = ensurePendingMap(store);
  if (requestId && map.has(requestId)) return map.get(requestId);
  if (clientMessageId) {
    for (const entry of map.values()) {
      if (entry.clientMessageId === clientMessageId) return entry;
    }
  }
  return null;
}

function finalizePending(store, entry, result) {
  const map = ensurePendingMap(store);
  map.delete(entry.requestId);
  if (entry.timer) clearTimeout(entry.timer);
  entry.settled = true;
  entry.resolve(result);
}

/**
 * Send a sessionless message via `yeaft_auto_route_send` for a specific Agent.
 * Resolves with `{ ok, agentId, sessionId, decision, tier, title, sceneId, workDir,
 * confidence, reason, delivery, answeredAskUser, code, error }`.
 */
export function sendYeaftAutoRouteMessage(store, {
  agentId,
  text = '',
  attachments,
  preferredSceneId = null,
  preferredWorkDir = '',
  forceNew = false,
  quickSend = null,
  mentions,
  quote = null,
  cosmosDelivery = false,
  timeoutMs = AUTO_ROUTE_TIMEOUT_MS,
} = {}) {
  const targetAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  if (!targetAgentId) {
    return Promise.resolve({ ok: false, code: 'agent_unavailable', error: 'No agent selected.' });
  }
  const agent = (store.agents || []).find((a) => a.id === targetAgentId);
  if (!agent || !agent.online) {
    return Promise.resolve({ ok: false, agentId: targetAgentId, code: 'agent_unavailable', error: 'Agent is offline.' });
  }
  if (Array.isArray(agent.capabilities) && !agent.capabilities.includes('session_auto_route')) {
    return Promise.resolve({
      ok: false,
      agentId: targetAgentId,
      code: 'session_auto_route_unsupported',
      error: 'The selected Agent does not support automatic Session routing.',
    });
  }

  const safeAttachments = Array.isArray(attachments)
    ? attachments.filter((a) => a && typeof a.fileId === 'string' && a.fileId.trim())
    : [];
  const trimmedText = typeof text === 'string' ? text.trim() : '';
  if (!trimmedText && safeAttachments.length === 0) {
    return Promise.resolve({ ok: false, agentId: targetAgentId, code: 'empty_message', error: 'Message is empty.' });
  }

  const now = Date.now();
  const suffix = Math.random().toString(36).slice(2, 10);
  const clientMessageId = `u_${now.toString(36)}_${suffix}`;
  const requestId = `ar_${now.toString(36)}_${suffix}`;
  const normalizedQuickSend = normalizeQuickSend(store, targetAgentId, quickSend);
  const sceneId = typeof preferredSceneId === 'string' && preferredSceneId && preferredSceneId !== 'auto' && preferredSceneId !== 'none'
    ? preferredSceneId
    : '';

  const wsMsg = {
    type: 'yeaft_auto_route_send',
    agentId: targetAgentId,
    id: clientMessageId,
    requestId,
    text: trimmedText || '(attached files)',
    ...(cosmosDelivery === true ? { cosmosDelivery: true } : {}),
    ...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
    ...(sceneId ? { preferredSceneId: sceneId } : {}),
    ...(typeof preferredWorkDir === 'string' && preferredWorkDir.trim() ? { preferredWorkDir: preferredWorkDir.trim() } : {}),
    ...(forceNew ? { forceNew: true } : {}),
    ...(normalizedQuickSend ? { quickSend: normalizedQuickSend } : {}),
    ...(quote && typeof quote === 'object' ? { quote } : {}),
  };
  if (safeAttachments.length > 0) {
    wsMsg.attachments = safeAttachments.map((a) => ({
      fileId: a.fileId,
      isImage: !!a.isImage,
    }));
  }

  return new Promise((resolve) => {
    const map = ensurePendingMap(store);
    const entry = {
      requestId,
      clientMessageId,
      agentId: targetAgentId,
      createdAt: now,
      settled: false,
      timer: null,
      resolve,
    };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      const result = {
        ok: false,
        agentId: targetAgentId,
        requestId,
        clientMessageId,
        code: 'timeout',
        error: 'Auto-route request timed out.',
        at: Date.now(),
      };
      store.yeaftLastAutoRouteResult = result;
      finalizePending(store, entry, result);
    }, Math.max(1000, Number(timeoutMs) || AUTO_ROUTE_TIMEOUT_MS));

    map.set(requestId, entry);

    const dispatched = store.sendWsMessage?.(wsMsg);
    if (dispatched === false) {
      const result = {
        ok: false,
        agentId: targetAgentId,
        requestId,
        clientMessageId,
        code: 'disconnected',
        error: 'Connection unavailable; message was not sent.',
        at: Date.now(),
      };
      store.yeaftLastAutoRouteResult = result;
      finalizePending(store, entry, result);
    }
  });
}

export function handleYeaftSessionRouted(store, msg, sessionIdentityKeyFn) {
  if (!msg || typeof msg !== 'object') return false;
  const entry = lookupPending(store, {
    requestId: msg.requestId || null,
    clientMessageId: msg.clientMessageId || null,
  });

  const agentId = msg.agentId || entry?.agentId || null;
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
  const result = {
    ok: msg.ok === true,
    agentId,
    requestId: msg.requestId ?? entry?.requestId ?? null,
    clientMessageId: msg.clientMessageId ?? entry?.clientMessageId ?? null,
    sessionId,
    decision: msg.decision === 'created' ? 'created' : (msg.decision === 'matched' ? 'matched' : null),
    tier: typeof msg.tier === 'string' ? msg.tier : null,
    title: typeof msg.title === 'string' ? msg.title : null,
    sceneId: typeof msg.sceneId === 'string' ? msg.sceneId : null,
    workDir: typeof msg.workDir === 'string' ? msg.workDir : '',
    confidence: Number.isFinite(msg.confidence) ? msg.confidence : null,
    reason: typeof msg.reason === 'string' ? msg.reason : '',
    decisionModel: typeof msg.decisionModel === 'string' ? msg.decisionModel : null,
    routeSource: typeof msg.routeSource === 'string' ? msg.routeSource : null,
    delivery: msg.delivery === 'appended' || msg.delivery === 'queued' ? msg.delivery : null,
    answeredAskUser: msg.answeredAskUser === true,
    code: typeof msg.code === 'string' ? msg.code : null,
    error: msg.error || null,
    at: Date.now(),
  };

  store.yeaftLastAutoRouteResult = result;

  // Unmatched (expired / duplicate) receipts must be side-effect-free for
  // preview, processing, and unread state.
  if (!entry) return false;

  // New Agents send authoritative turn events before the receipt. Do not
  // re-mark a turn as processing or begin a stale optimistic preview if
  // authoritative delivery metadata is present or post-send events already landed.
  if (result.ok && !result.delivery && agentId && sessionId && !result.answeredAskUser) {
    store.recordYeaftSessionPreview?.(sessionId, agentId, {
      beginTurn: true,
      rootId: entry.clientMessageId || null,
      at: entry.createdAt || result.at,
      onlyIfNoUpdateSince: entry.createdAt || 0,
    });
    const key = typeof sessionIdentityKeyFn === 'function'
      ? sessionIdentityKeyFn(agentId, sessionId)
      : `${agentId}\u001f${sessionId}`;
    if (key) {
      store.yeaftProcessingSessions = {
        ...(store.yeaftProcessingSessions || {}),
        [key]: true,
      };
    }
  }

  finalizePending(store, entry, result);
  return true;
}

export function handleYeaftAutoRouteError(store, msg) {
  if (!msg || typeof msg !== 'object') return false;
  const entry = lookupPending(store, {
    requestId: msg.requestId || null,
    clientMessageId: msg.clientMessageId || msg.id || null,
  });
  if (!entry) return false;
  const result = {
    ok: false,
    agentId: msg.agentId || entry.agentId || null,
    requestId: entry.requestId,
    clientMessageId: entry.clientMessageId,
    sessionId: null,
    decision: null,
    code: msg.code || 'error',
    error: msg.message || 'Auto-route failed.',
    at: Date.now(),
  };
  store.yeaftLastAutoRouteResult = result;
  finalizePending(store, entry, result);
  return true;
}

export function clearPendingAutoRoutes(store, reason = 'cancelled') {
  const map = store._pendingAutoRouteRequests;
  if (!(map instanceof Map) || map.size === 0) return;
  for (const entry of Array.from(map.values())) {
    finalizePending(store, entry, {
      ok: false,
      agentId: entry.agentId,
      requestId: entry.requestId,
      clientMessageId: entry.clientMessageId,
      code: reason,
      error: 'Auto-route cancelled.',
      at: Date.now(),
    });
  }
}
