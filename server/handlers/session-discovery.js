import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents } from '../context.js';
import { userDb, yeaftSessionDb } from '../database.js';
import { buildSessionCatalog, resolveAgentAccessError, sendToAgent, sendToWebClient } from '../ws-utils.js';

const CAPABILITY = 'session_discovery';
const REQUEST_TTL_MS = 15_000;
const pending = new Map();
const OPS = new Set(['search', 'active_sessions', 'workspace_folders', 'share_list', 'share_save', 'share_delete']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => typeof value === 'string' ? value.trim() : '';

export function ownedAgentSessionIds(userId, agentId) {
  return yeaftSessionDb.getByAgent(agentId).filter(row => row.userId === userId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(row => row.id);
}

function visibleNativeIds(client, agentId) {
  return buildSessionCatalog(client.userId, client.role)
    .filter(row => row.agentId === agentId && row.runtimeProvider === 'yeaft')
    .map(row => row.routeRef.sessionId);
}

function validateWindowDays(value) {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 1 && value <= 365 ? value : null;
}

function validateLimit(value, max) {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
}

function validatePayload(op, payload) {
  if (!isRecord(payload)) return null;
  if (op === 'search') {
    const query = clean(payload.query);
    const activeWindowDays = validateWindowDays(payload.activeWindowDays);
    const limit = validateLimit(payload.limit, 25);
    if (!query || query.length > 160 || activeWindowDays === null || limit === null) return null;
    return {
      query,
      ...(activeWindowDays !== undefined ? { activeWindowDays } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  if (op === 'active_sessions') {
    const activeWindowDays = validateWindowDays(payload.activeWindowDays);
    const limit = validateLimit(payload.limit, 200);
    if (activeWindowDays === null || limit === null) return null;
    return {
      ...(activeWindowDays !== undefined ? { activeWindowDays } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  if (op === 'workspace_folders') {
    if (payload.refresh !== undefined && typeof payload.refresh !== 'boolean') return null;
    return { ...(payload.refresh === true ? { refresh: true } : {}) };
  }
  if (op === 'share_list') return {};
  const id = clean(payload.id);
  const createId = clean(payload.createId);
  const expectedUpdatedAt = payload.expectedUpdatedAt;
  if (Object.hasOwn(payload, 'id') && (!/^[a-zA-Z0-9_-]{1,90}$/.test(id)
      || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0)) return null;
  if (op === 'share_delete') return id ? { id, expectedUpdatedAt } : null;
  if (id ? !!createId : !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(createId)) return null;
  const { kind } = payload;
  const title = clean(payload.title);
  const body = clean(payload.body);
  return ['consensus', 'output'].includes(kind) && title && title.length <= 120 && body && body.length <= 12000
    ? { ...(id ? { id, expectedUpdatedAt } : { createId }), kind, title, body } : null;
}

function dropRequest(id) {
  const request = pending.get(id);
  if (request) clearTimeout(request.timer);
  pending.delete(id);
  return request;
}

export function clearSessionDiscoveryRequests(client) {
  for (const [id, request] of pending) if (request.client === client) dropRequest(id);
}

export async function handleClientSessionDiscovery(client, msg) {
  if (!['session_discovery_request', 'session_discovery_cancel'].includes(msg.type)) return false;
  const requestId = clean(msg.requestId);
  if (!client.authenticated || !client.userId || !requestId || requestId.length > 100) return true;
  if (msg.type === 'session_discovery_cancel') {
    for (const [id, request] of pending) {
      if (request.client === client && request.ownerId === client.userId
          && request.op === 'search' && request.browserRequestId === requestId && request.agentId === msg.agentId) dropRequest(id);
    }
    return true;
  }
  const agentId = clean(msg.agentId);
  const op = clean(msg.op);
  if (!OPS.has(op)) return true;
  const respond = data => sendToWebClient(client, { type: 'session_discovery_response', requestId, op, agentId, ...data });
  const accessError = resolveAgentAccessError(agentId, client.userId, client.role);
  const agent = agents.get(agentId);
  if (accessError || !agent?.capabilities?.includes(CAPABILITY)) {
    await respond({ ok: false, error: 'Session discovery unavailable on this Agent' });
    return true;
  }
  const payload = validatePayload(op, msg.payload);
  if (!payload || pending.size >= 4096 || [...pending.values()].filter(item => item.client === client).length >= 8) {
    await respond({ ok: false, error: 'Invalid or too many discovery requests' });
    return true;
  }
  // Use only authenticated identity and the Server's catalog. Never forward
  // browser-supplied owner/Session IDs, even on a globally registered Agent.
  const ownerId = client.userId;
  const allowedIds = visibleNativeIds(client, agentId);
  const opaqueId = randomUUID();
  const timer = setTimeout(() => {
    dropRequest(opaqueId);
    void respond({ ok: false, error: 'Session discovery request timed out' });
  }, REQUEST_TTL_MS);
  timer.unref();
  pending.set(opaqueId, { client, agent, agentId, ownerId, op, timer, respond, browserRequestId: requestId, allowedIds: new Set(allowedIds) });
  try {
    if (await sendToAgent(agent, { type: 'session_discovery_request', requestId: opaqueId, op, ownerId, allowedIds, payload })) return true;
  } catch { /* use the same correlated failure as a closed socket */ }
  if (dropRequest(opaqueId)) await respond({ ok: false, error: 'Session discovery unavailable' });
  return true;
}

export async function handleAgentSessionDiscovery(agentId, agent, msg) {
  if (msg.type !== 'session_discovery_response') return false;
  const request = pending.get(msg.requestId);
  if (!request || request.agent !== agent || request.agentId !== agentId || request.op !== msg.op) return true;
  dropRequest(msg.requestId);
  const { client, ownerId, op, respond } = request;
  if (!client.authenticated || client.userId !== ownerId || (!CONFIG.skipAuth && !userDb.isActive(ownerId))
      || resolveAgentAccessError(agentId, ownerId, client.role)) return true;
  if (msg.ok !== true || !isRecord(msg.data)) {
    await respond({ ok: false, error: 'Session discovery request failed' });
    return true;
  }
  // A Session could be hidden/deleted after dispatch. Do not send derived
  // content even if the Agent matched the older request snapshot.
  const allowed = new Set(visibleNativeIds(client, agentId).filter(id => request.allowedIds.has(id)));
  const data = msg.data;
  const validText = (value, limit) => typeof value === 'string' && value.length <= limit;
  const validTime = value => Number.isSafeInteger(value) && value >= 0;
  const validItem = row => isRecord(row) && validText(row.id, 90)
    && ['consensus', 'output'].includes(row.kind) && validText(row.title, 120) && validText(row.body, 12000)
    && validTime(row.createdAt) && validTime(row.updatedAt);
  let result;
  const itemView = ({ id, kind, status, title, body, sourceSessionId, createdAt, updatedAt }) => ({
    id, kind, status, title, body, sourceSessionId: allowed.has(sourceSessionId) ? sourceSessionId : null,
    createdAt, updatedAt,
  });
  switch (op) {
    case 'search':
      result = { indexedAt: validTime(data.indexedAt) ? data.indexedAt : null, results: (Array.isArray(data.results) ? data.results : [])
        .filter(row => allowed.has(row?.sessionId) && validText(row.title, 240)
          && validText(row.snippet, 222) && validTime(row.activeAt)).slice(0, 25)
        .map(({ sessionId, title, snippet, activeAt }) => ({ sessionId, title, snippet, activeAt })) };
      break;
    case 'active_sessions':
      result = { indexedAt: validTime(data.indexedAt) ? data.indexedAt : null, cards: (Array.isArray(data.cards) ? data.cards : [])
        .filter(row => allowed.has(row?.sessionId) && validText(row.title, 240)
          && validText(row.workDir, 512) && validText(row.preview, 222)
          && validTime(row.activeAt) && validTime(row.messageCount)).slice(0, 200)
        .map(({ sessionId, title, workDir, preview, activeAt, messageCount }) => ({
          sessionId, title, workDir, preview, activeAt, messageCount,
        })) };
      break;
    case 'workspace_folders':
      result = {
        scannedAt: validTime(data.scannedAt) ? data.scannedAt : null,
        folders: (Array.isArray(data.folders) ? data.folders : [])
          .filter(row => isRecord(row) && validText(row.path, 512) && row.path.length > 0
            && validText(row.name, 120) && validText(row.label || '', 120))
          .slice(0, 120)
          .map(({ path, name, depth, markers, label }) => ({
            path,
            name,
            depth: Number.isSafeInteger(depth) && depth >= 0 && depth <= 3 ? depth : 0,
            markers: Array.isArray(markers) ? markers.filter(m => validText(m, 40)).slice(0, 8) : [],
            label: typeof label === 'string' ? label : '',
          })),
      };
      break;
    case 'share_list':
      result = { items: (Array.isArray(data.items) ? data.items : []).filter(row => validItem(row)
        && (row.status === 'published' || (row.status === 'candidate' && allowed.has(row.sourceSessionId))))
        .slice(0, 225).map(itemView) };
      break;
    case 'share_save': result = { item: validItem(data.item) && data.item.status === 'published' ? itemView(data.item) : null }; break;
    default: result = {};
  }
  await respond({ ok: true, data: result });
  return true;
}
