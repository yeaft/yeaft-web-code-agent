import { randomUUID } from 'node:crypto';

const REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 4096;

const pendingRequests = new Map();
const expiredRequests = new Map();
const terminalOwners = new Map();

export const LEGACY_WORKBENCH_REQUEST_QUARANTINED = Symbol(
  'legacy-workbench-request-quarantined',
);

export function isLegacyWorkbenchRequestQuarantined(value) {
  return value?.quarantine === LEGACY_WORKBENCH_REQUEST_QUARANTINED;
}

export function workbenchTerminalCleanupMessage(owner) {
  if (!owner?.terminalId || !owner?.conversationId || !owner?.routeKey
      || !owner?.workspaceGeneration) return null;
  const requestId = owner.requestId || owner.pendingRequestId || null;
  return {
    type: 'terminal_close',
    conversationId: owner.conversationId,
    terminalId: owner.terminalId,
    workbenchRouteKey: owner.routeKey,
    workbenchWorkspaceGeneration: owner.workspaceGeneration,
    ...(requestId ? { _workbenchRequestId: requestId } : {}),
  };
}

function requestKey(agentId, requestId) {
  return `${String(agentId || '')}\u0000${String(requestId || '')}`;
}

function terminalKey(agentId, terminalId) {
  return `${String(agentId || '')}\u0000${String(terminalId || '')}`;
}

function releasePendingTerminalReservation(pending) {
  if (pending?.timeout) clearTimeout(pending.timeout);
  if (!pending?.terminalId) return;
  const key = terminalKey(pending.agentId, pending.terminalId);
  const owner = terminalOwners.get(key);
  if (owner?.pendingRequestId === pending.requestId) terminalOwners.delete(key);
}

function pruneExpiredRequests(now = Date.now()) {
  for (const [key, expired] of expiredRequests) {
    if (expired?.expiresAt > now) continue;
    expiredRequests.delete(key);
  }
}

function quarantineExpiredRequest(key, pending, now = Date.now()) {
  if (!pending?.allowLegacyCorrelation) return;
  pruneExpiredRequests(now);
  while (expiredRequests.size >= MAX_PENDING) {
    const oldest = expiredRequests.keys().next().value;
    if (oldest == null) break;
    expiredRequests.delete(oldest);
  }
  expiredRequests.set(key, {
    agentId: pending.agentId,
    requestId: pending.requestId,
    conversationId: pending.conversationId,
    workspaceGeneration: pending.workspaceGeneration,
    responseTypes: new Set(pending.expectedResponseTypes),
    routeKey: pending.routeKey,
    userId: pending.userId,
    clientId: pending.clientId,
    publicRequestId: pending.publicRequestId,
    terminalId: pending.terminalId,
    expiresAt: now + REQUEST_TTL_MS,
  });
}

function expirePending(key, pending, reason = 'timeout') {
  if (pendingRequests.get(key) !== pending) return false;
  pendingRequests.delete(key);
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = null;
  releasePendingTerminalReservation(pending);
  quarantineExpiredRequest(key, pending);
  if (typeof pending?.onTimeout === 'function') {
    Promise.resolve(pending.onTimeout(pending, reason)).catch(error => {
      console.error('[Server] Failed to report Workbench request timeout:', error);
    });
  }
  return true;
}

function prune(now = Date.now()) {
  pruneExpiredRequests(now);
  for (const [key, pending] of pendingRequests) {
    if (pending && pending.expiresAt > now) continue;
    expirePending(key, pending);
  }
}

export function registerWorkbenchRequest({
  agentId,
  clientId,
  userId,
  routeKey,
  conversationId,
  workspaceGeneration,
  route,
  role = null,
  requestType,
  expectedResponseTypes,
  publicRequestId = null,
  terminalId = null,
  allowLegacyCorrelation = false,
  onTimeout = null,
  onResponse = null,
}) {
  if (!agentId || !clientId || !userId || !routeKey || !conversationId
      || !workspaceGeneration || !requestType) return null;
  const expected = Array.isArray(expectedResponseTypes)
    ? expectedResponseTypes.filter(Boolean)
    : [];
  if (expected.length === 0) return null;
  prune();
  while (pendingRequests.size >= MAX_PENDING) {
    const oldest = pendingRequests.keys().next().value;
    if (oldest == null) break;
    expirePending(oldest, pendingRequests.get(oldest), 'capacity');
  }
  const requestId = randomUUID();
  const key = requestKey(agentId, requestId);
  const pending = {
    agentId,
    requestId,
    clientId,
    userId,
    routeKey,
    conversationId,
    workspaceGeneration,
    route: route ? { ...route } : null,
    role,
    requestType,
    expectedResponseTypes: new Set(expected),
    publicRequestId,
    terminalId,
    allowLegacyCorrelation: allowLegacyCorrelation === true,
    onTimeout,
    onResponse,
    expiresAt: Date.now() + REQUEST_TTL_MS,
    timeout: null,
  };
  pending.timeout = setTimeout(() => {
    expirePending(key, pending);
  }, REQUEST_TTL_MS);
  pending.timeout.unref?.();
  pendingRequests.set(key, pending);
  return requestId;
}

function consumePending(key, pending) {
  pendingRequests.delete(key);
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = null;
  return pending;
}

export function peekWorkbenchRequest({ agentId, requestId, responseType, routeKey = null }) {
  if (!agentId || !requestId || !responseType) return null;
  prune();
  const pending = pendingRequests.get(requestKey(agentId, requestId));
  if (!pending || !pending.expectedResponseTypes.has(responseType)) return null;
  if (routeKey && pending.routeKey !== routeKey) return null;
  return pending;
}

export function consumeWorkbenchRequest({ agentId, requestId, responseType, routeKey = null }) {
  if (!agentId || !requestId || !responseType) return null;
  prune();
  const key = requestKey(agentId, requestId);
  const pending = pendingRequests.get(key);
  if (!pending || !pending.expectedResponseTypes.has(responseType)) return null;
  if (routeKey && pending.routeKey !== routeKey) return null;
  return consumePending(key, pending);
}

/**
 * Correlate responses from the short-lived Agent release window that supported
 * Session Workbench routes but did not echo `_workbenchRequestId`. Agent fields
 * only filter Server-owned pending records; they never directly select a Web
 * client. Ambiguous matches are intentionally left pending to time out.
 */
function matchesLegacyCorrelation(record, {
  agentId,
  responseType,
  routeKey,
  userId,
  clientId,
  publicRequestId,
  terminalId,
}, responseTypes) {
  if (record.agentId !== agentId
      || record.routeKey !== routeKey
      || record.userId !== userId
      || !responseTypes?.has(responseType)) return false;
  if (clientId && record.clientId !== clientId) return false;
  if (publicRequestId && record.publicRequestId !== publicRequestId) return false;
  if (terminalId && record.terminalId !== terminalId) return false;
  return true;
}

export function consumeLegacyWorkbenchRequest({
  agentId,
  responseType,
  routeKey,
  userId,
  clientId = null,
  publicRequestId = null,
  terminalId = null,
}) {
  if (!agentId || !responseType || !routeKey || !userId) return null;
  const correlation = {
    agentId,
    responseType,
    routeKey,
    userId,
    clientId,
    publicRequestId,
    terminalId,
  };
  prune();
  for (const [key, expired] of expiredRequests) {
    if (!matchesLegacyCorrelation(expired, correlation, expired.responseTypes)) continue;
    // A public request id identifies the expired request exactly, so one late
    // response can retire its tombstone. Without one, old and retried responses
    // are indistinguishable; keep the quarantine until TTL rather than risk
    // consuming a newer pending request.
    if (publicRequestId) expiredRequests.delete(key);
    return {
      quarantine: LEGACY_WORKBENCH_REQUEST_QUARANTINED,
      agentId: expired.agentId,
      requestId: expired.requestId,
      conversationId: expired.conversationId,
      routeKey: expired.routeKey,
      workspaceGeneration: expired.workspaceGeneration,
      terminalId: expired.terminalId,
    };
  }
  const matches = [];
  for (const [key, pending] of pendingRequests) {
    if (!matchesLegacyCorrelation(pending, correlation, pending.expectedResponseTypes)) continue;
    matches.push([key, pending]);
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;
  return consumePending(matches[0][0], matches[0][1]);
}

export function deleteWorkbenchRequest({ agentId, requestId }) {
  const key = requestKey(agentId, requestId);
  const pending = pendingRequests.get(key);
  const deleted = pendingRequests.delete(key);
  if (deleted) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  return deleted;
}

export function registerWorkbenchTerminalOwner(pending) {
  if (!pending?.agentId || !pending?.terminalId || !pending?.clientId
      || !pending?.userId || !pending?.routeKey || !pending?.workspaceGeneration) return false;
  const key = terminalKey(pending.agentId, pending.terminalId);
  const existing = terminalOwners.get(key);
  if (existing && (
    existing.clientId !== pending.clientId
    || existing.userId !== pending.userId
    || existing.routeKey !== pending.routeKey
    || existing.workspaceGeneration !== pending.workspaceGeneration
    || existing.conversationId !== pending.conversationId
  )) return false;
  terminalOwners.set(key, {
    agentId: pending.agentId,
    terminalId: pending.terminalId,
    clientId: pending.clientId,
    userId: pending.userId,
    routeKey: pending.routeKey,
    conversationId: pending.conversationId,
    workspaceGeneration: pending.workspaceGeneration,
    pendingRequestId: pending.requestId || pending.pendingRequestId || null,
  });
  return true;
}

export function getWorkbenchTerminalOwner(agentId, terminalId) {
  return terminalOwners.get(terminalKey(agentId, terminalId)) || null;
}

export function deleteWorkbenchTerminalOwner(agentId, terminalId) {
  return terminalOwners.delete(terminalKey(agentId, terminalId));
}

export function clearWorkbenchCorrelationsForClient(clientId) {
  if (!clientId) return [];
  // Capture terminal cleanup capabilities before releasing pending creates.
  // releasePendingTerminalReservation() removes the matching owner, but the
  // disconnect path still needs its exact create token to cancel Agent work.
  const terminals = [];
  for (const [key, owner] of terminalOwners) {
    if (owner?.clientId !== clientId) continue;
    terminals.push(owner);
    terminalOwners.delete(key);
  }
  for (const [key, pending] of pendingRequests) {
    if (pending?.clientId !== clientId) continue;
    pendingRequests.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  for (const [key, expired] of expiredRequests) {
    if (expired?.clientId === clientId) expiredRequests.delete(key);
  }
  return terminals;
}

export function clearWorkbenchCorrelationsForAgent(agentId) {
  if (!agentId) return;
  for (const [key, pending] of pendingRequests) {
    if (pending?.agentId !== agentId) continue;
    if (pending.onResponse) pending.onTimeout?.(pending, 'disconnect');
    pendingRequests.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  for (const [key, expired] of expiredRequests) {
    if (expired?.agentId === agentId) expiredRequests.delete(key);
  }
  for (const [key, owner] of terminalOwners) {
    if (owner?.agentId === agentId) terminalOwners.delete(key);
  }
}

export function __testResetWorkbenchCorrelations() {
  for (const pending of pendingRequests.values()) {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = null;
    releasePendingTerminalReservation(pending);
  }
  pendingRequests.clear();
  expiredRequests.clear();
  terminalOwners.clear();
}

export function __testExpireWorkbenchRequest(agentId, requestId) {
  const pending = pendingRequests.get(requestKey(agentId, requestId));
  if (!pending) return false;
  pending.expiresAt = 0;
  return true;
}
