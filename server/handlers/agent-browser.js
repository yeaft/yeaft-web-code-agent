import { isRetiredBrowserSource } from '../retired-features.js';
import { sendToAgent, sendToWebClient } from '../ws-utils.js';
import {
  browserClientForPeer,
  browserPeers,
  browserRoutes,
  completeBrowserRequest,
  deleteBrowserPeer,
  findBrowserRequest,
  deleteBrowserRoute,
  getBrowserPeer,
  getBrowserRoute,
  installBrowserRoute,
} from '../browser-runtime-routes.js';

const AGENT_BROWSER_TYPES = new Set([
  'browser_runtime_status_result',
  'browser_runtime_install_progress',
  'browser_runtime_error',
  'browser_session_created',
  'browser_session_error',
  'browser_session_snapshot',
  'browser_session_list_result',
  'browser_peer_prepared',
  'browser_peer_offer',
  'browser_peer_ice_candidate',
  'browser_peer_state',
  'browser_peer_error',
]);

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sessionSnapshot(msg) {
  return {
    browserSessionId: clean(msg?.browserSessionId),
    revision: Number(msg?.revision) || 1,
    state: clean(msg?.state, 32) || 'unknown',
    activeUrl: clean(msg?.activeUrl, 4096) || 'about:blank',
    title: clean(msg?.title, 512),
    pageRevision: Number(msg?.pageRevision) || 1,
    captureMode: clean(msg?.captureMode, 32) || null,
    viewport: msg?.viewport && typeof msg.viewport === 'object' ? {
      width: Number(msg.viewport.width) || 0,
      height: Number(msg.viewport.height) || 0,
      deviceScaleFactor: Number(msg.viewport.deviceScaleFactor) || 1,
    } : null,
    viewerCount: Math.max(0, Number(msg?.viewerCount) || 0),
    interactivePeerCount: Math.max(0, Number(msg?.interactivePeerCount) || 0),
    authorizedProducerCount: Math.max(0, Number(msg?.authorizedProducerCount) || 0),
    expiresAt: Number(msg?.expiresAt) || null,
    terminalReason: clean(msg?.terminalReason, 128) || null,
    safeError: clean(msg?.safeError, 500) || null,
    sourceRef: msg?.sourceRef && typeof msg.sourceRef === 'object' ? {
      kind: clean(msg.sourceRef.kind, 32),
      sessionId: clean(msg.sourceRef.sessionId) || undefined,
      conversationId: clean(msg.sourceRef.conversationId) || undefined,
      workItemId: clean(msg.sourceRef.workItemId) || undefined,
    } : null,
  };
}

function safeByteCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return Math.min(number, 4 * 1024 * 1024 * 1024);
}

function publicRuntimeMessage(agentId, requestId, msg) {
  if (msg?.type === 'browser_runtime_error') {
    return {
      type: msg.type,
      agentId,
      requestId,
      code: clean(msg.code, 128) || 'browser_runtime_error',
      safeError: clean(msg.safeError, 500) || null,
    };
  }
  if (msg?.type === 'browser_runtime_install_progress') {
    return {
      type: msg.type,
      agentId,
      requestId,
      downloadedBytes: safeByteCount(msg.downloadedBytes),
      totalBytes: safeByteCount(msg.totalBytes),
    };
  }
  return {
    type: 'browser_runtime_status_result',
    agentId,
    requestId,
    supported: msg?.supported === true,
    state: clean(msg?.state, 32) || 'unknown',
    installed: msg?.installed === true,
    enabled: msg?.enabled === true,
    ready: msg?.ready === true,
    buildId: clean(msg?.buildId, 128) || null,
    platform: clean(msg?.platform, 32) || null,
    downloadBytes: safeByteCount(msg?.downloadBytes),
    downloadedBytes: safeByteCount(msg?.downloadedBytes),
    totalBytes: safeByteCount(msg?.totalBytes),
    probeCode: clean(msg?.probeCode, 128) || null,
    safeError: clean(msg?.safeError, 500) || null,
  };
}

function publicSessionMessage(agentId, msg) {
  if (msg?.type === 'browser_session_error') {
    return {
      type: 'browser_session_error',
      agentId,
      requestId: clean(msg.requestId) || null,
      browserSessionId: clean(msg.browserSessionId) || null,
      code: clean(msg.code, 128) || 'browser_runtime_error',
      safeError: clean(msg.safeError, 500) || null,
    };
  }
  if (msg?.type === 'browser_session_list_result') {
    return {
      type: msg.type,
      agentId,
      requestId: clean(msg.requestId) || null,
      sessions: (Array.isArray(msg.sessions) ? msg.sessions : []).filter(snapshot => !isRetiredBrowserSource(snapshot?.sourceRef)).slice(0, 64).map(sessionSnapshot),
    };
  }
  return {
    type: clean(msg?.type, 64),
    agentId,
    requestId: clean(msg?.requestId) || null,
    ...sessionSnapshot(msg),
  };
}

async function sendCreateResponse(agentId, msg) {
  const request = completeBrowserRequest(agentId, msg, { kinds: 'browser_session_create' });
  if (!request) return true;
  const client = browserClientForPeer({
    clientId: request.clientId,
    webConnectionId: request.webConnectionId,
    webConnectionGeneration: request.webConnectionGeneration,
  });
  if (!client || client.userId !== request.ownerUserId) return true;
  if (msg.type === 'browser_session_created') {
    const route = installBrowserRoute({ agentId, ownerUserId: request.ownerUserId, msg });
    if (!route) {
      await sendToWebClient(client, {
        type: 'browser_session_error',
        agentId,
        requestId: request.requestId,
        browserSessionId: clean(msg.browserSessionId) || null,
        code: 'browser_route_capacity',
        safeError: 'browser_route_capacity',
      });
      await sendToAgent(agent, {
        type: 'browser_session_close',
        agentId,
        requestId: `server-cleanup-${request.serverRequestId}`,
        browserSessionId: clean(msg.browserSessionId),
        expectedRevision: Number(msg.revision) || 1,
        serverIdentity: {
          ownerUserId: request.ownerUserId,
          clientId: request.clientId,
          webConnectionId: request.webConnectionId,
          webConnectionGeneration: request.webConnectionGeneration,
        },
      }).catch(() => {});
      return true;
    }
  }
  const publicResponse = publicSessionMessage(agentId, request.response);
  // Create request replay is served from the ledger. Persist only the explicit
  // public projection, never the Agent-originated object.
  request.response = publicResponse;
  await sendToWebClient(client, publicResponse);
  return true;
}

/** Agent-authenticated Browser events routed only through Server-owned ledgers. */
export async function handleAgentBrowser(agentId, agent, msg) {
  if (!AGENT_BROWSER_TYPES.has(msg?.type)) return false;
  if (msg.type === 'browser_runtime_install_progress') {
    const request = findBrowserRequest(agentId, msg.requestId);
    if (!request || request.state !== 'pending' || request.kind !== 'browser_runtime_install') return true;
    const client = browserClientForPeer({
      clientId: request.clientId,
      webConnectionId: request.webConnectionId,
      webConnectionGeneration: request.webConnectionGeneration,
    });
    if (client?.userId === request.ownerUserId) {
      await sendToWebClient(client, publicRuntimeMessage(agentId, request.requestId, msg));
    }
    return true;
  }
  if (msg.type === 'browser_runtime_status_result' || msg.type === 'browser_runtime_error') {
    const pendingRequest = findBrowserRequest(agentId, msg.requestId);
    const request = completeBrowserRequest(agentId, msg, {
      consume: pendingRequest?.kind === 'browser_runtime_status',
      kinds: ['browser_runtime_status', 'browser_runtime_install', 'browser_runtime_enable'],
    });
    if (!request) return true;
    const client = browserClientForPeer({
      clientId: request.clientId,
      webConnectionId: request.webConnectionId,
      webConnectionGeneration: request.webConnectionGeneration,
    });
    if (client?.userId !== request.ownerUserId) return true;
    const response = publicRuntimeMessage(agentId, request.requestId, msg);
    request.response = response;
    await sendToWebClient(client, response);
    return true;
  }
  if (msg.type === 'browser_session_created'
      || (msg.type === 'browser_session_error' && msg.requestId)) {
    return sendCreateResponse(agentId, msg);
  }

  if (msg.type === 'browser_session_list_result') {
    const request = completeBrowserRequest(agentId, msg, {
      consume: true,
      kinds: 'browser_session_list',
    });
    if (!request) return true;
    for (const snapshot of Array.isArray(msg.sessions) ? msg.sessions : []) {
      if (!snapshot?.browserSessionId || isRetiredBrowserSource(snapshot.sourceRef)) continue;
      installBrowserRoute({ agentId, ownerUserId: request.ownerUserId, msg: snapshot });
    }
    const client = browserClientForPeer({
      clientId: request.clientId,
      webConnectionId: request.webConnectionId,
      webConnectionGeneration: request.webConnectionGeneration,
    });
    if (client?.userId === request.ownerUserId) {
      await sendToWebClient(client, publicSessionMessage(agentId, request.response));
    }
    return true;
  }

  if (msg.type === 'browser_session_snapshot' && msg.requestId) {
    const request = completeBrowserRequest(agentId, msg, {
      consume: true,
      kinds: ['browser_session_get', 'browser_session_close'],
    });
    if (!request) return true;
    const client = browserClientForPeer({
      clientId: request.clientId,
      webConnectionId: request.webConnectionId,
      webConnectionGeneration: request.webConnectionGeneration,
    });
    if (client?.userId === request.ownerUserId) {
      const route = getBrowserRoute(agentId, msg.browserSessionId);
      if (route) {
        route.revision = Number(msg.revision) || route.revision;
        route.state = clean(msg.state, 32) || route.state;
        if (route.state === 'closed' || route.state === 'failed') {
          deleteBrowserRoute(agentId, route.browserSessionId);
        }
      }
      await sendToWebClient(client, publicSessionMessage(agentId, request.response));
    }
    return true;
  }

  if (msg.type === 'browser_session_snapshot') {
    const route = getBrowserRoute(agentId, msg.browserSessionId);
    if (!route) return true;
    route.revision = Number(msg.revision) || route.revision;
    route.state = clean(msg.state, 32) || route.state;
    route.updatedAt = Date.now();
    const recipients = [];
    for (const peer of browserPeers.values()) {
      if (peer.agentId !== agentId || peer.browserSessionId !== route.browserSessionId) continue;
      const client = browserClientForPeer(peer);
      if (client && !recipients.includes(client)) recipients.push(client);
    }
    if (route.state === 'closed' || route.state === 'failed') {
      deleteBrowserRoute(agentId, route.browserSessionId);
    }
    const snapshot = publicSessionMessage(agentId, msg);
    for (const client of recipients) await sendToWebClient(client, snapshot);
    return true;
  }

  const peer = getBrowserPeer(msg.peerId);
  if (!peer || peer.agentId !== agentId
      || peer.browserSessionId !== msg.browserSessionId
      || peer.connectionGeneration !== Number(msg.connectionGeneration)) return true;
  const route = getBrowserRoute(agentId, peer.browserSessionId);
  if (!route || route.ownerUserId !== peer.ownerUserId) {
    deleteBrowserPeer(peer.peerId);
    return true;
  }
  const client = browserClientForPeer(peer);
  if (!client || client.userId !== route.ownerUserId) {
    deleteBrowserPeer(peer.peerId);
    return true;
  }

  if (msg.type === 'browser_peer_prepared') {
    peer.state = 'prepared';
    await sendToWebClient(client, {
      type: msg.type,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      requestId: peer.requestId,
      connectionGeneration: peer.connectionGeneration,
      iceTransportPolicy: peer.iceTransportPolicy,
      iceServers: peer.webIceServers || [],
      role: peer.role,
    });
    if (peer.pendingOffer) {
      await sendToWebClient(client, peer.pendingOffer);
      peer.pendingOffer = null;
      peer.state = 'offered';
    }
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await sendToWebClient(client, candidate);
    }
    return true;
  }
  if (msg.type === 'browser_peer_offer') {
    const description = msg.description;
    if (description?.type !== 'offer' || typeof description.sdp !== 'string' || description.sdp.length > 96 * 1024) {
      deleteBrowserPeer(peer.peerId);
      return true;
    }
    const offer = {
      type: msg.type,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      requestId: peer.requestId,
      connectionGeneration: peer.connectionGeneration,
      description: { type: 'offer', sdp: description.sdp },
      iceServers: peer.webIceServers || [],
      role: peer.role,
    };
    if (peer.state !== 'prepared' && peer.state !== 'offered') {
      peer.pendingOffer = offer;
      return true;
    }
    peer.state = 'offered';
    await sendToWebClient(client, offer);
    return true;
  }
  if (msg.type === 'browser_peer_ice_candidate') {
    if (peer.agentCandidateCount >= 128) return true;
    const raw = msg.candidate;
    if (raw != null && (typeof raw !== 'object'
      || typeof raw.candidate !== 'string'
      || raw.candidate.length > 4096)) return true;
    peer.agentCandidateCount += 1;
    const candidate = {
      type: msg.type,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      candidate: raw == null ? null : {
        candidate: raw.candidate,
        sdpMid: clean(raw.sdpMid, 256) || null,
        sdpMLineIndex: Number.isInteger(raw.sdpMLineIndex) ? raw.sdpMLineIndex : null,
        usernameFragment: clean(raw.usernameFragment, 256) || null,
      },
    };
    if (peer.state !== 'prepared' && peer.state !== 'offered') {
      if (peer.pendingCandidates.length < 128) peer.pendingCandidates.push(candidate);
      return true;
    }
    await sendToWebClient(client, candidate);
    return true;
  }
  if (msg.type === 'browser_peer_state') {
    peer.state = clean(msg.state, 32) || peer.state;
    if (peer.state === 'connected') peer.expiresAt = null;
    if (['failed', 'disconnected', 'closed'].includes(peer.state)) deleteBrowserPeer(peer.peerId);
  }
  if (msg.type === 'browser_peer_error') deleteBrowserPeer(peer.peerId);
  await sendToWebClient(client, {
    type: msg.type,
    agentId,
    browserSessionId: peer.browserSessionId,
    peerId: peer.peerId,
    connectionGeneration: peer.connectionGeneration,
    requestId: peer.requestId,
    state: clean(msg.state, 32) || null,
    code: clean(msg.code, 128) || null,
    safeError: clean(msg.safeError, 500) || null,
  });
  return true;
}

export { AGENT_BROWSER_TYPES };
