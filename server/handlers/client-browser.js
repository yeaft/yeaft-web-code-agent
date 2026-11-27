import { createHash } from 'node:crypto';
import { isRetiredBrowserSource } from '../retired-features.js';
import { CONFIG } from '../config.js';
import { agents } from '../context.js';
import { sendToAgent, sendToWebClient } from '../ws-utils.js';
import {
  browserPeerMatchesClient,
  browserServerIdentity,
  deleteBrowserPeer,
  getBrowserPeer,
  getBrowserRoute,
  mintBrowserIceServers,
  registerBrowserCreateRequest,
  registerBrowserRequest,
  reserveBrowserPeer,
} from '../browser-runtime-routes.js';

const CLIENT_BROWSER_TYPES = new Set([
  'browser_runtime_status',
  'browser_runtime_install',
  'browser_runtime_enable',
  'browser_session_create',
  'browser_session_get',
  'browser_session_list',
  'browser_session_close',
  'browser_peer_attach',
  'browser_peer_answer',
  'browser_peer_ice_candidate',
  'browser_peer_detach',
]);

function clean(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
}

async function fail(client, msg, code, safeError = code) {
  const type = String(msg.type || '');
  await sendToWebClient(client, {
    type: type.startsWith('browser_peer_') ? 'browser_peer_error'
      : type.startsWith('browser_runtime_') ? 'browser_runtime_error'
        : 'browser_session_error',
    requestId: clean(msg.requestId) || null,
    agentId: clean(msg.agentId) || null,
    browserSessionId: clean(msg.browserSessionId) || null,
    peerId: clean(msg.peerId) || null,
    connectionGeneration: Number(msg.connectionGeneration) || null,
    code,
    safeError,
  });
  return true;
}

function agentSupportsBrowserSetup(agent) {
  return new Set(agent?.capabilities || []).has('browser_runtime_setup');
}

function agentSupportsBrowser(agent) {
  const capabilities = new Set(agent?.capabilities || []);
  return capabilities.has('browser_runtime')
    && capabilities.has('browser_webrtc')
    && (capabilities.has('browser_capture_tab') || capabilities.has('browser_capture_cdp'));
}

function safeInitialUrl(value) {
  const raw = clean(value, 4096) || 'about:blank';
  if (raw === 'about:blank') return raw;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function canonicalCreate(msg) {
  const initialUrl = safeInitialUrl(msg.options?.initialUrl);
  if (!initialUrl) return null;
  return {
    sourceRef: msg.sourceRef && typeof msg.sourceRef === 'object' ? {
      kind: clean(msg.sourceRef.kind, 32),
      sessionId: clean(msg.sourceRef.sessionId),
      conversationId: clean(msg.sourceRef.conversationId),
    } : null,
    options: {
      initialUrl,
      viewport: {
        width: Math.min(1920, Math.max(320, Math.floor(Number(msg.options?.viewport?.width) || 1280))),
        height: Math.min(1080, Math.max(240, Math.floor(Number(msg.options?.viewport?.height) || 720))),
        deviceScaleFactor: Math.min(2, Math.max(1, Number(msg.options?.viewport?.deviceScaleFactor) || 1)),
      },
      locale: clean(msg.options?.locale, 32) || 'en-US',
      capturePreference: ['auto', 'tab'].includes(msg.options?.capturePreference)
        ? msg.options.capturePreference : 'auto',
    },
  };
}

function ownerRoute(client, msg) {
  const route = getBrowserRoute(msg.agentId, msg.browserSessionId);
  return route && route.ownerUserId === client.userId ? route : null;
}

/** Owner-checked Web → Server → Agent Browser lifecycle and signaling relay. */
export async function handleClientBrowser(client, msg, checkAgentAccess) {
  if (!CLIENT_BROWSER_TYPES.has(msg?.type)) return false;
  if (!CONFIG.browserRuntime.enabled) return fail(client, msg, 'browser_runtime_disabled');
  const setupRequest = String(msg.type || '').startsWith('browser_runtime_');
  if (setupRequest) {
    if (client.browserRuntimeSetupProtocol !== 1) {
      return fail(client, msg, 'browser_setup_protocol_required');
    }
  } else if (client.browserRuntimeProtocol !== 1) {
    return fail(client, msg, 'browser_protocol_required');
  }
  const agentId = clean(msg.agentId);
  if (!await checkAgentAccess(agentId)) return true;
  const agent = agents.get(agentId);
  if (setupRequest ? !agentSupportsBrowserSetup(agent) : !agentSupportsBrowser(agent)) {
    return fail(client, msg, 'browser_runtime_unavailable');
  }
  const requestId = clean(msg.requestId);
  const requestRequired = msg.type !== 'browser_peer_answer'
    && msg.type !== 'browser_peer_ice_candidate';
  if (requestRequired && !requestId) return fail(client, msg, 'browser_request_id_required');
  const identity = browserServerIdentity(client);

  if (setupRequest) {
    const canonical = msg.type === 'browser_runtime_install' ? {
      confirmedBuildId: clean(msg.confirmedBuildId, 128),
      confirmedDownloadBytes: Number(msg.confirmedDownloadBytes) || 0,
    } : {};
    const registration = registerBrowserCreateRequest({
      agentId,
      client,
      requestId,
      digest: digest({ type: msg.type, ...canonical }),
      kind: msg.type,
    });
    if (registration.conflict) return fail(client, msg, 'browser_request_conflict');
    if (registration.capacity) return fail(client, msg, 'browser_request_capacity');
    if (registration.duplicate) {
      if (registration.request.response) await sendToWebClient(client, registration.request.response);
      return true;
    }
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      requestId: registration.request.serverRequestId,
      ...canonical,
      serverIdentity: identity,
    });
    return true;
  }

  if (msg.type === 'browser_session_create') {
    if (isRetiredBrowserSource(msg.sourceRef)) return fail(client, msg, 'feature_disabled', 'Work Center is disabled');
    const canonical = canonicalCreate(msg);
    if (!canonical) return fail(client, msg, 'browser_url_invalid');
    const registration = registerBrowserCreateRequest({
      agentId,
      client,
      requestId,
      digest: digest(canonical),
    });
    if (registration.conflict) return fail(client, msg, 'browser_request_conflict');
    if (registration.capacity) return fail(client, msg, 'browser_request_capacity');
    if (registration.duplicate) {
      if (registration.request.response) {
        await sendToWebClient(client, registration.request.response);
      }
      return true;
    }
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      requestId: registration.request.serverRequestId,
      ...canonical,
      serverIdentity: identity,
    });
    return true;
  }

  if (msg.type === 'browser_session_list') {
    const request = registerBrowserRequest({ agentId, client, requestId, kind: msg.type });
    if (!request) return fail(client, msg, 'browser_request_conflict');
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      requestId: request.serverRequestId,
      serverIdentity: identity,
    });
    return true;
  }

  if (msg.type === 'browser_peer_attach') {
    if (!ownerRoute(client, msg)) return fail(client, msg, 'browser_session_not_found');
    const connectionGeneration = Number(msg.connectionGeneration);
    const reserved = reserveBrowserPeer({
      agentId,
      browserSessionId: clean(msg.browserSessionId),
      client,
      requestId,
      connectionGeneration,
      role: msg.role === 'interactive' ? 'interactive' : 'viewer',
    });
    if (reserved.error) return fail(client, msg, reserved.error);
    const peer = reserved.peer;
    if (reserved.duplicate) {
      if (peer.state === 'prepared' || peer.state === 'offered' || peer.state === 'connected') {
        await sendToWebClient(client, {
          type: 'browser_peer_prepared',
          agentId,
          browserSessionId: peer.browserSessionId,
          peerId: peer.peerId,
          requestId: peer.requestId,
          connectionGeneration: peer.connectionGeneration,
          iceTransportPolicy: peer.iceTransportPolicy,
          iceServers: peer.webIceServers || [],
          role: peer.role,
        });
        if (peer.pendingOffer) await sendToWebClient(client, peer.pendingOffer);
      }
      return true;
    }
    const commonScope = {
      ownerUserId: client.userId,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
    };
    try {
      // Commit the Web endpoint's scoped ICE credentials before the Agent can
      // synchronously answer `browser_peer_prepare`. Otherwise a fast Agent
      // may produce `browser_peer_prepared` while this field is still unset,
      // causing the Web RTCPeerConnection to be created with no ICE servers.
      peer.webIceServers = mintBrowserIceServers({ ...commonScope, endpointRole: 'web' });
      peer.state = 'preparing';
      await sendToAgent(agent, {
        type: 'browser_peer_prepare',
        agentId,
        browserSessionId: peer.browserSessionId,
        peerId: peer.peerId,
        requestId,
        connectionGeneration: peer.connectionGeneration,
        serverIdentity: identity,
        routeExpiresAt: peer.expiresAt,
        role: peer.role,
        iceTransportPolicy: CONFIG.browserRuntime.iceTransportPolicy,
        agentIceServers: mintBrowserIceServers({ ...commonScope, endpointRole: 'agent' }),
      });
    } catch (error) {
      deleteBrowserPeer(peer.peerId);
      return fail(client, msg, 'browser_peer_prepare_failed', String(error?.message || error).slice(0, 500));
    }
    return true;
  }

  if (msg.type === 'browser_session_get' || msg.type === 'browser_session_close') {
    const route = ownerRoute(client, msg);
    if (!route) return fail(client, msg, 'browser_session_not_found');
    const request = registerBrowserRequest({
      agentId,
      client,
      requestId,
      kind: msg.type,
      browserSessionId: route.browserSessionId,
    });
    if (!request) return fail(client, msg, 'browser_request_conflict');
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      requestId: request.serverRequestId,
      browserSessionId: route.browserSessionId,
      ...(msg.type === 'browser_session_close' ? { expectedRevision: Number(msg.expectedRevision) || route.revision } : {}),
      serverIdentity: identity,
    });
    return true;
  }

  const peer = getBrowserPeer(msg.peerId);
  if (!browserPeerMatchesClient(peer, client, msg)) return fail(client, msg, 'browser_peer_stale');
  if (msg.type === 'browser_peer_answer') {
    const description = msg.description;
    if (description?.type !== 'answer' || typeof description.sdp !== 'string' || description.sdp.length > 96 * 1024) {
      return fail(client, msg, 'browser_sdp_invalid');
    }
    peer.state = 'answering';
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      description: { type: 'answer', sdp: description.sdp },
      serverIdentity: identity,
    });
    return true;
  }
  if (msg.type === 'browser_peer_ice_candidate') {
    if (peer.webCandidateCount >= 128) return fail(client, msg, 'browser_candidate_limit');
    const candidate = msg.candidate;
    if (candidate != null && (typeof candidate !== 'object'
      || typeof candidate.candidate !== 'string'
      || candidate.candidate.length > 4096)) return fail(client, msg, 'browser_candidate_invalid');
    peer.webCandidateCount += 1;
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      candidate: candidate == null ? null : {
        candidate: candidate.candidate,
        sdpMid: clean(candidate.sdpMid, 256) || null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: clean(candidate.usernameFragment, 256) || null,
      },
      serverIdentity: identity,
    });
    return true;
  }
  if (msg.type === 'browser_peer_detach') {
    deleteBrowserPeer(peer.peerId);
    await sendToAgent(agent, {
      type: msg.type,
      agentId,
      requestId,
      browserSessionId: peer.browserSessionId,
      peerId: peer.peerId,
      connectionGeneration: peer.connectionGeneration,
      serverIdentity: identity,
    });
    return true;
  }
  return false;
}

export { CLIENT_BROWSER_TYPES };
