import { CONFIG } from '../config.js';
import { agents } from '../context.js';
import {
  sendToWebClient, forwardToAgent,
  verifyConversationOwnership, getCachedDir
} from '../ws-utils.js';
import {
  agentSupportsWorkbenchRequestCorrelation,
  resolveWorkbenchRequest,
} from '../workbench-route.js';
import {
  deleteWorkbenchRequest,
  getWorkbenchTerminalOwner,
  registerWorkbenchRequest,
  registerWorkbenchTerminalOwner,
} from '../workbench-correlation.js';

/**
 * Handle workbench messages from web client (terminal, file, git operations).
 * Types: terminal_create, terminal_input, terminal_resize, terminal_close,
 *        read_file, write_file, list_directory,
 *        git_status, git_diff, git_add, git_reset, git_restore, git_commit, git_push,
 *        file_search, create_file, delete_files, move_files, copy_files, upload_to_dir
 */
/**
 * Yeaft sessions use an agent-generated virtual conversationId
 * ('yeaft-<timestamp>', see agent/yeaft/web-bridge.js) that exists neither in
 * agent.conversations nor in the sessions DB table, so
 * verifyConversationOwnership always falls through to "not found → deny".
 * For these ids the ownership boundary is the Agent itself: by the time we
 * get here the pro/admin workbench role gate (ws-client.js) and
 * checkAgentAccess → verifyAgentOwnership have both passed — the same trust
 * model already used by read_file and '_'-prefixed agent-level writes.
 */
function isYeaftVirtualConversation(conversationId) {
  return typeof conversationId === 'string' && conversationId.startsWith('yeaft-');
}

async function denyWorkbenchRoute(client, msg) {
  const error = 'Invalid Workbench Session route';
  console.warn(`[Security] Invalid Workbench route for ${msg?.type || 'unknown'}`);
  const response = workbenchFailureResponse({
    agentId: msg?.agentId || client.currentAgent,
    msg,
    resolved: {
      conversationId: msg?.conversationId,
      routeKey: msg?.workbenchRouteKey,
      workspaceGeneration: msg?.workbenchWorkspaceGeneration,
    },
    error,
  });
  if (response) await sendToWebClient(client, response);
  // History file-link previews are background requests, not failed chat turns.
  // Their correlated result already terminates the request without polluting
  // the conversation (or stopping an unrelated streaming answer).
  if (msg?.type === 'resolve_file_references' && response) return;
  await sendToWebClient(client, { type: 'error', message: error });
}

const AGENT_DIRECTORY_PICKER_CONVERSATION = '_workdir_picker';

const RESPONSE_TYPES = Object.freeze({
  terminal_create: ['terminal_created', 'terminal_error'],
  read_file: ['file_content'],
  video_metadata: ['video_metadata'],
  resolve_file_references: ['file_references_resolved'],
  write_file: ['file_saved'],
  list_directory: ['directory_listing'],
  git_status: ['git_status_result'],
  git_diff: ['git_diff_result'],
  git_add: ['git_op_result'],
  git_reset: ['git_op_result'],
  git_restore: ['git_op_result'],
  git_commit: ['git_op_result'],
  git_push: ['git_op_result'],
  file_search: ['file_search_result'],
  create_file: ['file_op_result'],
  delete_files: ['file_op_result'],
  move_files: ['file_op_result'],
  copy_files: ['file_op_result'],
  upload_to_dir: ['file_op_result'],
});

const TIMEOUT_RESPONSE_TYPES = Object.freeze({
  terminal_create: 'terminal_error',
  read_file: 'file_content',
  video_metadata: 'video_metadata',
  resolve_file_references: 'file_references_resolved',
  write_file: 'file_saved',
  list_directory: 'directory_listing',
  git_status: 'git_status_result',
  git_diff: 'git_diff_result',
  git_add: 'git_op_result',
  git_reset: 'git_op_result',
  git_restore: 'git_op_result',
  git_commit: 'git_op_result',
  git_push: 'git_op_result',
  file_search: 'file_search_result',
  create_file: 'file_op_result',
  delete_files: 'file_op_result',
  move_files: 'file_op_result',
  copy_files: 'file_op_result',
  upload_to_dir: 'file_op_result',
});

const FILE_OPERATIONS = Object.freeze({
  create_file: 'create',
  delete_files: 'delete',
  move_files: 'move',
  copy_files: 'copy',
  upload_to_dir: 'upload',
});

function workbenchFailureResponse({ agentId, msg, resolved, error }) {
  const type = TIMEOUT_RESPONSE_TYPES[msg.type];
  if (!type) return null;
  const response = {
    type,
    agentId,
    conversationId: resolved.conversationId,
    workbenchRouteKey: resolved.routeKey,
    workbenchWorkspaceGeneration: resolved.workspaceGeneration,
    ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
    error,
  };
  if (msg.type === 'terminal_create') {
    return { ...response, terminalId: msg.terminalId || null, message: error };
  }
  if (msg.type === 'read_file' || msg.type === 'video_metadata') {
    return { ...response, filePath: msg.filePath, requestedFilePath: msg.filePath };
  }
  if (msg.type === 'resolve_file_references') {
    return { ...response, references: [] };
  }
  if (msg.type === 'write_file') {
    return { ...response, filePath: msg.filePath, requestedFilePath: msg.filePath };
  }
  if (msg.type === 'list_directory') {
    return { ...response, dirPath: msg.dirPath, entries: [] };
  }
  if (msg.type === 'git_status') {
    return { ...response, files: [] };
  }
  if (msg.type === 'git_diff') {
    return { ...response, diff: '' };
  }
  if (msg.type.startsWith('git_')) {
    return { ...response, success: false, operation: msg.type.slice(4) };
  }
  if (msg.type === 'file_search') {
    return { ...response, query: msg.query, results: [] };
  }
  return {
    ...response,
    success: false,
    operation: FILE_OPERATIONS[msg.type] || msg.type,
  };
}

function canonicalWorkbenchMessage(msg, resolved, { canonicalWorkDir = false } = {}) {
  const {
    _requestUserId: _ignoredUserId,
    _requestClientId: _ignoredClientId,
    _workbenchRequestId: _ignoredRequestId,
    ...clientFields
  } = msg || {};
  if (resolved.legacy) return {
    ...clientFields,
    ...(resolved.conversationId ? { conversationId: resolved.conversationId } : {}),
  };
  return {
    ...clientFields,
    agentId: resolved.agentId,
    conversationId: resolved.conversationId,
    workDir: (canonicalWorkDir || msg?.responseImagePreview) ? resolved.workDir : resolved.requestedWorkDir,
    workbenchRoute: resolved.route,
    workbenchRouteKey: resolved.routeKey,
    workbenchWorkspaceGeneration: resolved.workspaceGeneration,
  };
}

function correlateWorkbenchRequest({ agentId, clientId, client, msg, resolved, canonical }) {
  if (resolved.legacy) {
    return {
      ...canonical,
      _requestUserId: client.userId,
      _requestClientId: clientId,
    };
  }
  const expectedResponseTypes = RESPONSE_TYPES[msg.type];
  if (!expectedResponseTypes) return canonical;
  const supportsRequestCorrelation = agentSupportsWorkbenchRequestCorrelation(agents.get(agentId));
  const registration = {
    agentId,
    clientId,
    userId: client.userId,
    routeKey: resolved.routeKey,
    conversationId: resolved.conversationId,
    workspaceGeneration: resolved.workspaceGeneration,
    route: resolved.route,
    role: client.role,
    requestType: msg.type,
    expectedResponseTypes,
    publicRequestId: typeof msg.requestId === 'string' ? msg.requestId : null,
    terminalId: msg.terminalId || null,
    allowLegacyCorrelation: !supportsRequestCorrelation,
    onTimeout: async () => {
      if (!client.authenticated || client.userId !== registration.userId) return;
      const response = workbenchFailureResponse({
        agentId,
        msg,
        resolved,
        error: 'Workbench request timed out',
      });
      if (response) await sendToWebClient(client, response);
    },
  };
  const requestId = registerWorkbenchRequest(registration);
  if (!requestId) return null;
  if (msg.type === 'terminal_create'
      && !registerWorkbenchTerminalOwner({ ...registration, requestId })) {
    deleteWorkbenchRequest({ agentId, requestId });
    return null;
  }
  return {
    ...canonical,
    _workbenchRequestId: requestId,
    ...(!supportsRequestCorrelation ? {
      _requestUserId: client.userId,
      _requestClientId: clientId,
    } : {}),
  };
}

async function forwardCorrelatedWorkbenchRequest({ agentId, clientId, client, msg, resolved, canonical }) {
  const outbound = correlateWorkbenchRequest({ agentId, clientId, client, msg, resolved, canonical });
  if (!outbound) return false;
  try {
    await forwardToAgent(agentId, outbound);
    return true;
  } catch (error) {
    if (outbound._workbenchRequestId) {
      deleteWorkbenchRequest({ agentId, requestId: outbound._workbenchRequestId });
    }
    throw error;
  }
}

export async function handleClientWorkbench(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    // Terminal messages (forward to agent)
    case 'terminal_create':
    case 'terminal_input':
    case 'terminal_resize':
    case 'terminal_close': {
      const termAgentId = msg.agentId || client.currentAgent;
      if (!termAgentId) return;
      if (!await checkAgentAccess(termAgentId)) return;
      const resolved = resolveWorkbenchRequest(client, msg, termAgentId, {
        allowMissingSession: msg.type === 'terminal_close',
      });
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      const termConvId = resolved.conversationId || msg.conversationId || client.currentConversation;
      if (!termConvId) return;
      if (resolved.legacy && !CONFIG.skipAuth && !isYeaftVirtualConversation(termConvId) && !verifyConversationOwnership(termConvId, client.userId, client.role)) {
        console.warn(`[Security] User ${client.userId} terminal access denied for ${termConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      let terminalResolved = { ...resolved, conversationId: termConvId };
      if (!resolved.legacy && msg.type !== 'terminal_create') {
        const owner = getWorkbenchTerminalOwner(termAgentId, msg.terminalId);
        const ownerMatches = owner
          && owner.clientId === clientId
          && owner.userId === client.userId
          && owner.routeKey === resolved.routeKey
          && owner.conversationId === termConvId;
        const generationMatches = msg.type === 'terminal_close'
          ? msg.workbenchWorkspaceGeneration === owner?.workspaceGeneration
          : owner?.workspaceGeneration === resolved.workspaceGeneration;
        if (!ownerMatches || !generationMatches) {
          await denyWorkbenchRoute(client, msg);
          return;
        }
        if (msg.type === 'terminal_close') {
          terminalResolved = {
            ...terminalResolved,
            workspaceGeneration: owner.workspaceGeneration,
          };
        }
      }
      const forwarded = await forwardCorrelatedWorkbenchRequest({
        agentId: termAgentId,
        clientId,
        client,
        msg,
        resolved: terminalResolved,
        canonical: canonicalWorkbenchMessage(msg, terminalResolved, {
          canonicalWorkDir: msg.type === 'terminal_create',
        }),
      });
      if (!forwarded) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      break;
    }

    case 'resolve_file_references':
    case 'read_file':
    case 'video_metadata': {
      const fileAgentId = msg.agentId || client.currentAgent;
      if (!fileAgentId) { console.warn('[Server] read_file: no agentId'); return; }
      if (!await checkAgentAccess(fileAgentId)) return;
      const resolved = resolveWorkbenchRequest(client, msg, fileAgentId);
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      const fileConvId = resolved.conversationId || msg.conversationId || client.currentConversation || '_explorer';
      if (msg.type === 'video_metadata'
          && (!agents.get(fileAgentId)?.capabilities?.includes?.('workbench_video_stream')
            || !agentSupportsWorkbenchRequestCorrelation(agents.get(fileAgentId)))) {
        await sendToWebClient(client, workbenchFailureResponse({
          agentId: fileAgentId,
          msg,
          resolved: { ...resolved, conversationId: fileConvId },
          error: 'Video streaming is not supported by this Agent',
        }));
        return;
      }
      if (msg.responseImagePreview
          && !agents.get(fileAgentId)?.capabilities?.includes?.('response_image_preview')) {
        await sendToWebClient(client, workbenchFailureResponse({
          agentId: fileAgentId,
          msg,
          resolved: { ...resolved, conversationId: fileConvId },
          error: 'Response image preview is not supported by this Agent',
        }));
        return;
      }
      console.log(`[Server] Forwarding ${msg.type} to agent ${fileAgentId}, conv=${fileConvId}${msg.filePath ? `, path=${msg.filePath}` : ''}`);
      await forwardCorrelatedWorkbenchRequest({
        agentId: fileAgentId,
        clientId,
        client,
        msg,
        resolved,
        canonical: canonicalWorkbenchMessage(msg, { ...resolved, conversationId: fileConvId }, {
          canonicalWorkDir: !resolved.legacy
            && (msg.type === 'resolve_file_references' || msg.type === 'video_metadata'),
        }),
      });
      break;
    }

    case 'write_file': {
      const writeAgentId = msg.agentId || client.currentAgent;
      if (!writeAgentId) return;
      if (!await checkAgentAccess(writeAgentId)) return;
      const resolved = resolveWorkbenchRequest(client, msg, writeAgentId);
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      const writeConvId = resolved.conversationId || msg.conversationId || client.currentConversation || '_explorer';
      const isAgentLevelWrite = writeConvId.startsWith('_') || isYeaftVirtualConversation(writeConvId);
      if (resolved.legacy && !isAgentLevelWrite) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(writeConvId, client.userId, client.role)) {
          console.warn(`[Security] User ${client.userId} file write denied for ${writeConvId}`);
          await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
          return;
        }
      }
      await forwardCorrelatedWorkbenchRequest({
        agentId: writeAgentId,
        clientId,
        client,
        msg,
        resolved,
        canonical: canonicalWorkbenchMessage(msg, { ...resolved, conversationId: writeConvId }),
      });
      break;
    }

    case 'list_directory': {
      const dirAgentId = msg.agentId || client.currentAgent;
      if (!dirAgentId) return;
      if (!await checkAgentAccess(dirAgentId)) return;

      const isAgentDirectoryPicker = msg.directoryPickerScope === 'agent'
        && msg.conversationId === AGENT_DIRECTORY_PICKER_CONVERSATION
        && !msg.workbenchRoute
        && typeof msg.requestId === 'string'
        && msg.requestId.length > 0;
      if (isAgentDirectoryPicker) {
        const agent = agents.get(dirAgentId);
        const defaultWorkDir = typeof agent?.workDir === 'string' ? agent.workDir : '';
        const correlationKey = `agent-directory-picker:${dirAgentId}`;
        const internalRequestId = registerWorkbenchRequest({
          agentId: dirAgentId,
          clientId,
          userId: client.userId,
          routeKey: correlationKey,
          conversationId: AGENT_DIRECTORY_PICKER_CONVERSATION,
          workspaceGeneration: correlationKey,
          route: null,
          role: client.role,
          requestType: 'agent_directory_picker',
          expectedResponseTypes: ['directory_listing'],
          publicRequestId: msg.requestId,
        });
        if (!internalRequestId) return;
        const canonical = {
          type: 'list_directory',
          agentId: dirAgentId,
          conversationId: AGENT_DIRECTORY_PICKER_CONVERSATION,
          directoryPickerScope: 'agent',
          dirPath: typeof msg.dirPath === 'string' ? msg.dirPath : defaultWorkDir,
          workDir: defaultWorkDir,
          _workbenchRequestId: internalRequestId,
        };
        try {
          await forwardToAgent(dirAgentId, canonical);
        } catch (error) {
          deleteWorkbenchRequest({ agentId: dirAgentId, requestId: internalRequestId });
          throw error;
        }
        return;
      }

      const resolved = resolveWorkbenchRequest(client, msg, dirAgentId);
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      const canonical = canonicalWorkbenchMessage(msg, {
        ...resolved,
        conversationId: resolved.conversationId || msg.conversationId || client.currentConversation || '_explorer',
      });

      // Route-scoped requests bypass the legacy Agent/path cache. Relative
      // paths can mean different directories in sibling Sessions.
      const cached = resolved.legacy ? getCachedDir(dirAgentId, canonical.dirPath) : null;
      if (cached) {
        await sendToWebClient(client, {
          type: 'directory_listing',
          agentId: dirAgentId,
          conversationId: canonical.conversationId,
          requestId: canonical.requestId,
          workbenchRouteKey: canonical.workbenchRouteKey,
          dirPath: canonical.dirPath,
          entries: cached,
          fromCache: true
        });
        return;
      }

      await forwardCorrelatedWorkbenchRequest({
        agentId: dirAgentId,
        clientId,
        client,
        msg,
        resolved,
        canonical: { ...canonical, type: 'list_directory' },
      });
      break;
    }

    case 'git_status':
    case 'git_diff':
    case 'git_add':
    case 'git_reset':
    case 'git_restore':
    case 'git_commit':
    case 'git_push':
    case 'file_search': {
      const gitAgentId = msg.agentId || client.currentAgent;
      if (!gitAgentId) return;
      if (!await checkAgentAccess(gitAgentId)) return;
      const resolved = resolveWorkbenchRequest(client, msg, gitAgentId);
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      await forwardCorrelatedWorkbenchRequest({
        agentId: gitAgentId,
        clientId,
        client,
        msg,
        resolved,
        canonical: canonicalWorkbenchMessage(msg, resolved),
      });
      break;
    }

    case 'create_file':
    case 'delete_files':
    case 'move_files':
    case 'copy_files':
    case 'upload_to_dir': {
      const fopAgentId = msg.agentId || client.currentAgent;
      if (!fopAgentId) return;
      if (!await checkAgentAccess(fopAgentId)) return;
      const resolved = resolveWorkbenchRequest(client, msg, fopAgentId);
      if (!resolved) {
        await denyWorkbenchRoute(client, msg);
        return;
      }
      await forwardCorrelatedWorkbenchRequest({
        agentId: fopAgentId,
        clientId,
        client,
        msg,
        resolved,
        canonical: canonicalWorkbenchMessage(msg, resolved),
      });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
