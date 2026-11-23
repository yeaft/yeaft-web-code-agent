const pending = new Map();
const REQUEST_TIMEOUT_MS = 15_000;

export function supportsSessionDiscovery(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.includes('session_discovery');
}

/** A browser request belongs to one socket, Agent, operation, and caller lifecycle. */
export function requestSessionDiscovery(store, agentId, op, payload, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted || store.connectionState !== 'connected' || store.sessionDiscoverySupported !== true
        || !store.agents.some(agent => agent.id === agentId && agent.online && supportsSessionDiscovery(agent))) {
      reject(new Error('unavailable'));
      return;
    }
    const requestId = `discovery_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`)}`;
    const socket = store.ws;
    const finish = (error, data) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      pending.delete(requestId);
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => {
      if (op === 'search' && store.ws === socket && store.connectionState === 'connected') {
        store.sendWsMessage({ type: 'session_discovery_cancel', requestId, agentId });
      }
      finish(new Error('aborted'));
    };
    const timer = setTimeout(() => finish(new Error('timeout')), REQUEST_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    pending.set(requestId, { store, socket, agentId, op, finish });
    if (!store.sendWsMessage({ type: 'session_discovery_request', agentId, requestId, op, payload })) {
      finish(new Error('unavailable'));
    }
  });
}

export function acceptSessionDiscoveryResponse(store, msg) {
  const request = pending.get(msg.requestId);
  if (!request || request.store !== store || request.socket !== store.ws
      || request.agentId !== msg.agentId || request.op !== msg.op) return;
  request.finish(msg.ok === true ? null : new Error('request_failed'), msg.data);
}
