import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { agents, previewFiles, webClients } from '../context.js';
import {
  sendToAgent,
  sendToWebClient,
  setCachedDir,
  invalidateParentDirCache,
  clearAgentDirCache,
} from '../ws-utils.js';
import {
  currentWorkbenchWorkspaceGeneration,
  workbenchRouteKeyFromConversationId,
} from '../workbench-route.js';
import {
  consumeWorkbenchRequest,
  deleteWorkbenchTerminalOwner,
  getWorkbenchTerminalOwner,
  registerWorkbenchTerminalOwner,
} from '../workbench-correlation.js';

function stripAgentRouting(msg) {
  const {
    _requestClientId: _ignoredClientId,
    _requestUserId: _ignoredUserId,
    _workbenchRequestId: _ignoredRequestId,
    workbenchRouteKey: _ignoredRouteKey,
    workbenchWorkspaceGeneration: _ignoredGeneration,
    ...visible
  } = msg || {};
  return visible;
}

function pendingResponse(agentId, msg, pending) {
  const { requestId: _agentRequestId, ...visible } = stripAgentRouting(msg);
  return {
    ...visible,
    agentId,
    conversationId: pending.conversationId,
    ...(pending.publicRequestId ? { requestId: pending.publicRequestId } : {}),
    workbenchRouteKey: pending.routeKey,
    workbenchWorkspaceGeneration: pending.workspaceGeneration,
  };
}

async function sendToPendingClient(agentId, msg, pending) {
  const client = webClients.get(pending?.clientId);
  if (!client?.authenticated || client.userId !== pending?.userId) return false;
  await sendToWebClient(client, pendingResponse(agentId, msg, pending));
  return true;
}

async function forwardLegacyResponse(agentId, msg) {
  const visible = { ...stripAgentRouting(msg), agentId };
  const agent = agents.get(agentId);
  const conversation = agent?.conversations?.get?.(visible.conversationId);
  const ownerId = conversation?.userId || agent?.ownerId || null;
  for (const [, client] of webClients) {
    if (!client?.authenticated) continue;
    const allowed = CONFIG.skipAuth
      || (ownerId ? client.userId === ownerId : client.role === 'admin');
    if (allowed) await sendToWebClient(client, visible);
  }
}

function cacheBinaryPreview(msg) {
  const fileId = randomUUID();
  const token = randomUUID();
  const filename = msg.filePath.split('/').pop() || 'file';
  previewFiles.set(fileId, {
    buffer: Buffer.from(msg.content, 'base64'),
    mimeType: msg.mimeType,
    filename,
    createdAt: Date.now(),
    token,
  });
  const { content: _binaryContent, ...projected } = msg;
  return {
    ...projected,
    binary: true,
    fileId,
    previewToken: token,
  };
}

async function handleTerminalResponse(agentId, msg, routeKey) {
  const terminalId = msg.terminalId || null;
  if (msg.type === 'terminal_created') {
    const pending = consumeWorkbenchRequest({
      agentId,
      requestId: msg._workbenchRequestId,
      responseType: msg.type,
      routeKey,
    });
    if (!pending) {
      const agentRecord = agents.get(agentId);
      if (agentRecord && terminalId && msg.workbenchWorkspaceGeneration) {
        await sendToAgent(agentRecord, {
          type: 'terminal_close',
          conversationId: msg.conversationId,
          terminalId,
          workbenchRouteKey: routeKey,
          workbenchWorkspaceGeneration: msg.workbenchWorkspaceGeneration,
        });
      }
      return;
    }
    if (pending.routeKey !== routeKey || pending.terminalId !== terminalId) {
      deleteWorkbenchTerminalOwner(agentId, pending.terminalId);
      return;
    }
    if (msg.success !== false) registerWorkbenchTerminalOwner({ ...pending, terminalId });
    else deleteWorkbenchTerminalOwner(agentId, terminalId);
    await sendToPendingClient(agentId, msg, pending);
    return;
  }

  // Create errors carry the one-shot create correlation even though a
  // terminal-id reservation already exists. Consume and release it first.
  if (msg.type === 'terminal_error' && msg._workbenchRequestId) {
    const pending = consumeWorkbenchRequest({
      agentId,
      requestId: msg._workbenchRequestId,
      responseType: msg.type,
      routeKey,
    });
    if (pending?.terminalId) deleteWorkbenchTerminalOwner(agentId, pending.terminalId);
    if (pending?.routeKey === routeKey) await sendToPendingClient(agentId, msg, pending);
    return;
  }

  const owner = terminalId ? getWorkbenchTerminalOwner(agentId, terminalId) : null;
  if (owner) {
    if (owner.routeKey !== routeKey) return;
    await sendToPendingClient(agentId, msg, owner);
    if (msg.type === 'terminal_closed') deleteWorkbenchTerminalOwner(agentId, terminalId);
  }
}

async function handleOneShotResponse(agentId, msg, routeKey) {
  const pending = consumeWorkbenchRequest({
    agentId,
    requestId: msg._workbenchRequestId,
    responseType: msg.type,
    routeKey,
  });
  if (!pending) return;
  const currentGeneration = currentWorkbenchWorkspaceGeneration({
    route: pending.route,
    userId: pending.userId,
    role: pending.role,
  });
  if (!currentGeneration || currentGeneration !== pending.workspaceGeneration) return;
  const projected = msg.type === 'file_content' && msg.binary
    ? cacheBinaryPreview(msg)
    : msg;
  await sendToPendingClient(agentId, projected, pending);
}

/**
 * Handle file, terminal, and git messages from an Agent. Route-scoped replies
 * are delivered only through Server-owned correlations. Agent-supplied client
 * or user ids never select a browser recipient.
 */
export async function handleAgentFileTerminal(agentId, agent, rawMsg) {
  const msg = rawMsg || {};
  const routeKey = workbenchRouteKeyFromConversationId(msg.conversationId, agentId);
  const terminalTypes = new Set([
    'terminal_created', 'terminal_output', 'terminal_closed', 'terminal_error',
  ]);
  const oneShotTypes = new Set([
    'file_content', 'file_saved', 'directory_listing', 'file_op_result',
    'git_status_result', 'git_diff_result', 'git_op_result', 'file_search_result',
  ]);
  if (!terminalTypes.has(msg.type) && !oneShotTypes.has(msg.type)) return false;

  if (msg.type === 'file_saved') invalidateParentDirCache(agentId, msg.filePath);
  if (msg.type === 'file_op_result') clearAgentDirCache(agentId);
  if (msg.type === 'directory_listing' && msg.dirPath && msg.entries && !msg.error) {
    setCachedDir(agentId, msg.dirPath, msg.entries);
  }

  if (routeKey) {
    if (terminalTypes.has(msg.type)) await handleTerminalResponse(agentId, msg, routeKey);
    else await handleOneShotResponse(agentId, msg, routeKey);
    return true;
  }

  // `_workbench:` is reserved for Server-authored route conversations. An
  // invalid or cross-Agent value is not a legacy conversation.
  if (typeof msg.conversationId === 'string' && msg.conversationId.startsWith('_workbench:')) {
    return true;
  }

  const projected = msg.type === 'file_content' && msg.binary
    ? cacheBinaryPreview(msg)
    : msg;
  await forwardLegacyResponse(agentId, projected);
  return true;
}
