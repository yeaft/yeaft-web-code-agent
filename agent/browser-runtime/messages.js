import ctx from '../context.js';
import { BrowserRuntimeError } from './errors.js';

const BROWSER_MESSAGE_TYPES = new Set([
  'browser_runtime_status',
  'browser_runtime_install',
  'browser_runtime_enable',
  'browser_session_create',
  'browser_session_get',
  'browser_session_list',
  'browser_session_close',
  'browser_peer_prepare',
  'browser_peer_answer',
  'browser_peer_ice_candidate',
  'browser_peer_detach',
]);

function errorMessage(msg, error) {
  const type = String(msg?.type || '');
  const peerScoped = type.startsWith('browser_peer_');
  const setupScoped = type.startsWith('browser_runtime_');
  return {
    type: peerScoped ? 'browser_peer_error' : setupScoped ? 'browser_runtime_error' : 'browser_session_error',
    requestId: msg?.requestId || null,
    browserSessionId: msg?.browserSessionId || null,
    ...(peerScoped ? {
      peerId: msg?.peerId || null,
      connectionGeneration: msg?.connectionGeneration || null,
    } : {}),
    code: error?.code || 'browser_runtime_error',
    safeError: String(error?.message || error).slice(0, 500),
  };
}

function assertSetupIdentity(message) {
  const identity = message?.serverIdentity;
  if (!identity || typeof identity !== 'object'
      || !identity.ownerUserId || !identity.clientId
      || !identity.webConnectionId || !identity.webConnectionGeneration) {
    throw new BrowserRuntimeError('browser_identity_required');
  }
}

/** Route one authenticated Server command into the Agent-local Browser Runtime. */
export async function handleBrowserRuntimeMessage(msg, dependencies = {}) {
  if (!BROWSER_MESSAGE_TYPES.has(msg?.type)) return false;
  const runtime = dependencies.runtime || ctx.browserRuntime;
  const send = dependencies.send || ctx.sendToServer;
  if (!runtime) {
    await send?.(errorMessage(msg, new Error('browser_runtime_unavailable')));
    return true;
  }
  try {
    switch (msg.type) {
      case 'browser_runtime_status':
        assertSetupIdentity(msg);
        await send?.({
          type: 'browser_runtime_status_result',
          requestId: msg.requestId || null,
          ...(await runtime.setupStatus()),
        });
        break;
      case 'browser_runtime_install': {
        assertSetupIdentity(msg);
        const progress = async value => send?.({
          type: 'browser_runtime_install_progress',
          requestId: msg.requestId || null,
          ...value,
        });
        const result = await runtime.installAndEnable({
          confirmedBuildId: msg.confirmedBuildId,
          confirmedDownloadBytes: msg.confirmedDownloadBytes,
          onProgress: progress,
        });
        await send?.({
          type: 'browser_runtime_status_result',
          requestId: msg.requestId || null,
          ...result,
        });
        break;
      }
      case 'browser_runtime_enable':
        assertSetupIdentity(msg);
        await send?.({
          type: 'browser_runtime_status_result',
          requestId: msg.requestId || null,
          ...(await runtime.enableAndProbe()),
        });
        break;
      case 'browser_session_create':
        if (typeof msg.sourceRef?.kind === 'string' && msg.sourceRef.kind.trim() === 'work-item') {
          throw new BrowserRuntimeError('feature_disabled', 'Work Center is disabled');
        }
        await runtime.createSession(msg);
        break;
      case 'browser_session_get':
        await runtime.getSession(msg);
        break;
      case 'browser_session_list':
        await runtime.listSessions(msg);
        break;
      case 'browser_session_close':
        await runtime.closeSession(msg);
        break;
      case 'browser_peer_prepare':
        await runtime.preparePeer(msg);
        break;
      case 'browser_peer_answer':
        await runtime.answerPeer(msg);
        break;
      case 'browser_peer_ice_candidate':
        await runtime.addPeerIceCandidate(msg);
        break;
      case 'browser_peer_detach':
        await runtime.detachPeer(msg);
        break;
      default:
        return false;
    }
  } catch (error) {
    await send?.(errorMessage(msg, error));
  }
  return true;
}

export { BROWSER_MESSAGE_TYPES };
