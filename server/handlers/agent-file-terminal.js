import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { agents, webClients } from '../context.js';
import {
  sendToAgent,
  sendToWebClient,
  setCachedDir,
  invalidateParentDirCache,
  clearAgentDirCache,
} from '../ws-utils.js';
import {
  agentSupportsWorkbenchRequestCorrelation,
  agentSupportsWorkbenchTerminalCleanupFence,
  currentWorkbenchWorkspaceGeneration,
  workbenchRouteKeyFromConversationId,
} from '../workbench-route.js';
import {
  consumeLegacyWorkbenchRequest,
  consumeWorkbenchRequest,
  peekWorkbenchRequest,
  deleteWorkbenchTerminalOwner,
  getWorkbenchTerminalOwner,
  isLegacyWorkbenchRequestQuarantined,
  registerWorkbenchTerminalOwner,
  workbenchTerminalCleanupMessage,
} from '../workbench-correlation.js';
import { appendFileContentChunk, discardFileContentAssembly } from '../file-content-assembly.js';
import { cachePreviewFile, MAX_PREVIEW_FILE_BYTES } from '../preview-files.js';
import { createWorkbenchPreview, createWorkbenchVideo } from '../workbench-preview.js';

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
  if (pending?.onResponse) {
    await pending.onResponse(msg);
    return true;
  }
  const client = webClients.get(pending?.clientId);
  if (!client?.authenticated || client.userId !== pending?.userId) return false;
  await sendToWebClient(client, pendingResponse(agentId, msg, pending));
  return true;
}

function consumeRouteResponse(agentId, agent, msg, routeKey) {
  if (msg._workbenchRequestId) {
    return consumeWorkbenchRequest({
      agentId,
      requestId: msg._workbenchRequestId,
      responseType: msg.type,
      routeKey,
    });
  }
  const agentRecord = agents.get(agentId) || agent;
  if (agentSupportsWorkbenchRequestCorrelation(agentRecord)) return null;
  return consumeLegacyWorkbenchRequest({
    agentId,
    responseType: msg.type,
    routeKey,
    userId: msg._requestUserId,
    clientId: msg._requestClientId || null,
    publicRequestId: typeof msg.requestId === 'string' ? msg.requestId : null,
    terminalId: msg.terminalId || null,
  });
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

function cacheBinaryPreview(msg, suppliedBuffer = null, pending = null) {
  const buffer = suppliedBuffer || Buffer.from(msg.content || '', 'base64');
  if (buffer.length > MAX_PREVIEW_FILE_BYTES) return {
    ...msg,
    binary: false,
    content: '',
    error: 'File exceeds the 20 MB transfer limit.',
    errorCode: 'FILE_PREVIEW_TOO_LARGE',
    errorDetails: { sizeBytes: buffer.length, limitBytes: MAX_PREVIEW_FILE_BYTES },
  };
  const fileId = randomUUID();
  const stableToken = createWorkbenchPreview(fileId, pending, msg.filePath);
  const token = stableToken || randomUUID();
  const filename = msg.filePath.split('/').pop() || 'file';
  if (!cachePreviewFile(fileId, {
    buffer,
    mimeType: msg.mimeType,
    filename,
    createdAt: Date.now(),
    token,
  }) && !stableToken) return {
    ...msg,
    binary: false,
    content: '',
    error: 'Preview cache is at capacity.',
    errorCode: 'FILE_PREVIEW_CACHE_FULL',
  };
  const { content: _binaryContent, ...projected } = msg;
  return {
    ...projected,
    binary: true,
    fileId,
    previewToken: token,
    previewUrl: `/api/preview/${fileId}?token=${encodeURIComponent(token)}`,
  };
}

async function handleTerminalResponse(agentId, agent, msg, routeKey) {
  const terminalId = msg.terminalId || null;
  if (msg.type === 'terminal_created') {
    const pending = consumeRouteResponse(agentId, agent, msg, routeKey);
    const quarantined = isLegacyWorkbenchRequestQuarantined(pending);
    if (!pending || quarantined) {
      const agentRecord = agents.get(agentId);
      const cleanup = quarantined ? pending : {
        requestId: msg._workbenchRequestId || null,
        conversationId: msg.conversationId,
        routeKey,
        workspaceGeneration: msg.workbenchWorkspaceGeneration,
        terminalId,
      };
      const closeMessage = workbenchTerminalCleanupMessage(cleanup);
      if (agentRecord
          && closeMessage
          && agentSupportsWorkbenchTerminalCleanupFence(agentRecord)) {
        await sendToAgent(agentRecord, closeMessage);
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
  if (msg.type === 'terminal_error') {
    const pending = consumeRouteResponse(agentId, agent, msg, routeKey);
    // Explicit opaque ids and quarantined legacy replies must never fall
    // through to terminal ownership. A quarantine tombstone describes the
    // expired create, not any same-id replacement owner.
    if (isLegacyWorkbenchRequestQuarantined(pending)) return;
    if (pending?.terminalId) deleteWorkbenchTerminalOwner(agentId, pending.terminalId);
    if (pending?.routeKey === routeKey) {
      await sendToPendingClient(agentId, msg, pending);
      return;
    }
    if (msg._workbenchRequestId) return;
  }

  const owner = terminalId ? getWorkbenchTerminalOwner(agentId, terminalId) : null;
  if (owner) {
    if (owner.routeKey !== routeKey) return;
    await sendToPendingClient(agentId, msg, owner);
    if (msg.type === 'terminal_closed') deleteWorkbenchTerminalOwner(agentId, terminalId);
  }
}

async function handleAgentDirectoryPickerResponse(agentId, msg) {
  const pending = consumeWorkbenchRequest({
    agentId,
    requestId: msg._workbenchRequestId,
    responseType: msg.type,
    routeKey: `agent-directory-picker:${agentId}`,
  });
  if (!pending || pending.requestType !== 'agent_directory_picker') return;
  await sendToPendingClient(agentId, msg, pending);
}

function hasCurrentWorkspaceGeneration(pending) {
  const currentGeneration = currentWorkbenchWorkspaceGeneration({
    route: pending.route,
    userId: pending.userId,
    role: pending.role,
  });
  return currentGeneration !== null
    && (!currentGeneration || currentGeneration === pending.workspaceGeneration);
}

async function handleFileContentChunk(agentId, agent, msg, routeKey) {
  if (!msg._workbenchRequestId) return;
  const pending = peekWorkbenchRequest({
    agentId,
    requestId: msg._workbenchRequestId,
    responseType: 'file_content',
    routeKey,
  });
  if (!pending || pending.requestType !== 'read_file') return;
  if (!hasCurrentWorkspaceGeneration(pending)) {
    await pending.onResponse?.({ error: 'Preview workspace is no longer available' });
    discardFileContentAssembly(agentId, msg._workbenchRequestId);
    consumeWorkbenchRequest({
      agentId,
      requestId: msg._workbenchRequestId,
      responseType: 'file_content',
      routeKey,
    });
    return;
  }
  const result = appendFileContentChunk(agentId, msg);
  if (result.status === 'pending') return;
  const consumed = consumeWorkbenchRequest({
    agentId,
    requestId: msg._workbenchRequestId,
    responseType: 'file_content',
    routeKey,
  });
  if (!consumed) return;
  if (result.status !== 'complete') {
    discardFileContentAssembly(agentId, msg._workbenchRequestId);
    const errorCode = result.status === 'capacity'
      ? 'FILE_PREVIEW_CACHE_FULL'
      : 'FILE_TRANSFER_INVALID';
    await sendToPendingClient(agentId, {
      ...msg,
      type: 'file_content',
      binary: false,
      content: '',
      error: result.status === 'capacity'
        ? 'Preview transfer capacity was exceeded.'
        : 'Preview transfer was incomplete or invalid.',
      errorCode,
    }, consumed);
    return;
  }
  const completed = {
    ...msg,
    type: 'file_content',
    content: '',
  };
  delete completed.chunkIndex;
  delete completed.chunkCount;
  delete completed.totalBytes;
  await sendToPendingClient(agentId, consumed.onResponse
    ? { ...completed, buffer: result.buffer }
    : cacheBinaryPreview(completed, result.buffer, consumed), consumed);
}

async function handleOneShotResponse(agentId, agent, msg, routeKey) {
  if (msg.type === 'file_content' && msg._workbenchRequestId) {
    discardFileContentAssembly(agentId, msg._workbenchRequestId);
  }
  const pending = consumeRouteResponse(agentId, agent, msg, routeKey);
  if (!pending) return;
  const currentGeneration = currentWorkbenchWorkspaceGeneration({
    route: pending.route,
    userId: pending.userId,
    role: pending.role,
  });
  if (currentGeneration === null || (currentGeneration && currentGeneration !== pending.workspaceGeneration)) {
    await pending.onResponse?.({ error: 'Preview workspace is no longer available' });
    return;
  }
  let projected = msg;
  if (msg.type === 'file_content' && msg.binary && !pending.onResponse) {
    projected = cacheBinaryPreview(msg, null, pending);
  } else if (msg.type === 'video_metadata' && !msg.error && !pending.onResponse) {
    const fileId = randomUUID();
    const token = createWorkbenchVideo(fileId, pending, msg);
    const { mtimeMs: _mtimeMs, ...publicMetadata } = msg;
    projected = token ? {
      ...publicMetadata,
      filePath: msg.requestedFilePath || msg.filePath,
      videoStream: true,
      fileId,
      previewToken: token,
      previewUrl: `/api/preview/${fileId}?token=${encodeURIComponent(token)}`,
    } : {
      ...publicMetadata,
      filePath: msg.requestedFilePath || msg.filePath,
      error: 'Video stream is unavailable for this Session.',
      errorCode: 'VIDEO_STREAM_UNAVAILABLE',
    };
  }
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
    'file_content', 'file_content_chunk', 'video_metadata', 'video_chunk', 'file_references_resolved', 'file_saved', 'directory_listing', 'file_op_result',
    'git_status_result', 'git_diff_result', 'git_op_result', 'file_search_result',
  ]);
  if (!terminalTypes.has(msg.type) && !oneShotTypes.has(msg.type)) return false;

  if (msg.type === 'file_saved') invalidateParentDirCache(agentId, msg.filePath);
  if (msg.type === 'file_op_result') clearAgentDirCache(agentId);
  if (msg.type === 'directory_listing' && msg.dirPath && msg.entries && !msg.error) {
    setCachedDir(agentId, msg.dirPath, msg.entries);
  }

  if (routeKey) {
    if (terminalTypes.has(msg.type)) await handleTerminalResponse(agentId, agent, msg, routeKey);
    else if (msg.type === 'file_content_chunk') await handleFileContentChunk(agentId, agent, msg, routeKey);
    else await handleOneShotResponse(agentId, agent, msg, routeKey);
    return true;
  }

  if (msg.type === 'directory_listing'
      && msg.conversationId === '_workdir_picker'
      && msg._workbenchRequestId) {
    await handleAgentDirectoryPickerResponse(agentId, msg);
    return true;
  }

  // Opaque correlation ids are Server-owned. A response carrying one cannot
  // downgrade to legacy routing when its conversation is invalid or stale.
  if (msg._workbenchRequestId) return true;

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
