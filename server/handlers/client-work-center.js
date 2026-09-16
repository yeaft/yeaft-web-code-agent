import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents, pendingFiles, previewFiles } from '../context.js';
import { forwardToAgent, sendToWebClient } from '../ws-utils.js';
import { forgetWorkItemWorkspace, rememberWorkItemWorkspace } from '../work-center-workspace-cache.js';
import {
  assertSupportedWorkItemAttachment,
  assertWorkItemAttachmentSize,
  MAX_WORK_ITEM_ATTACHMENTS,
  MAX_WORK_ITEM_ATTACHMENT_BYTES,
  MAX_WORK_ITEM_INLINE_BYTES,
} from '../work-item-attachment-policy.js';

const REQUEST_TIMEOUT_MS = 60_000;
const pendingRequests = new Map();
const WORK_ITEM_ATTACHMENT_OPS = new Set(['create', 'post_work_item_message', 'work_item_message', 'action_input', 'guide']);

export function workCenterOpAcceptsAttachments(op) {
  return WORK_ITEM_ATTACHMENT_OPS.has(op);
}

function decodePreviewBase64(value) {
  const data = typeof value === 'string' ? value : '';
  const maxEncodedLength = Math.ceil(MAX_WORK_ITEM_INLINE_BYTES / 3) * 4;
  if (!data || data.length > maxEncodedLength || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Attachment preview data is not valid base64');
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_WORK_ITEM_INLINE_BYTES) {
    throw new Error(`Attachment preview exceeds ${MAX_WORK_ITEM_INLINE_BYTES} bytes`);
  }
  if (buffer.toString('base64') !== data) {
    throw new Error('Attachment preview data is not canonical base64');
  }
  return buffer;
}

function hasPreviewSignature(buffer, mimeType) {
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const signature = buffer.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  return true;
}

export function normalizeWorkItemPreview(previewData, attachment = {}) {
  if (!previewData || typeof previewData !== 'object' || Array.isArray(previewData)) {
    throw new Error('Attachment preview data is missing');
  }
  const filename = typeof previewData.filename === 'string' && previewData.filename.trim()
    ? previewData.filename.trim()
    : typeof attachment.name === 'string' ? attachment.name.trim() : '';
  const mimeType = typeof previewData.mimeType === 'string' && previewData.mimeType.trim()
    ? previewData.mimeType.trim().toLowerCase()
    : typeof attachment.mimeType === 'string' ? attachment.mimeType.trim().toLowerCase() : '';
  const kind = assertSupportedWorkItemAttachment(filename, mimeType);
  const buffer = decodePreviewBase64(previewData.data);
  if (!hasPreviewSignature(buffer, mimeType)) {
    throw new Error('Attachment preview content does not match its declared type');
  }
  return {
    buffer,
    filename,
    mimeType: kind === 'text' ? 'text/plain; charset=utf-8' : mimeType,
    kind,
  };
}

function prunePendingRequests(now = Date.now()) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.expiresAt <= now) pendingRequests.delete(requestId);
  }
}

function resolveWorkItemAttachments(client, payload) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (attachments.length === 0) return { payload, consumedIds: [] };
  if (attachments.length > MAX_WORK_ITEM_ATTACHMENTS) {
    throw new Error(`WorkItem supports at most ${MAX_WORK_ITEM_ATTACHMENTS} attachments`);
  }

  const resolvedFiles = [];
  const consumedIds = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const fileId = typeof attachment?.fileId === 'string' ? attachment.fileId : '';
    if (!fileId || seen.has(fileId)) throw new Error('Invalid WorkItem attachment reference');
    seen.add(fileId);
    const file = pendingFiles.get(fileId);
    if (!file) throw new Error('WorkItem attachment expired; upload it again');
    if (file.userId && !CONFIG.skipAuth && file.userId !== client.userId) {
      throw new Error('WorkItem attachment access denied');
    }
    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || '');
    if (buffer.length > CONFIG.maxFileSize) throw new Error('WorkItem attachment exceeds the upload size limit');
    totalBytes += buffer.length;
    if (totalBytes > MAX_WORK_ITEM_ATTACHMENT_BYTES) {
      throw new Error(`WorkItem attachments exceed ${MAX_WORK_ITEM_ATTACHMENT_BYTES} bytes`);
    }
    assertSupportedWorkItemAttachment(file.name, file.mimeType);
    assertWorkItemAttachmentSize(buffer.length);
    resolvedFiles.push({ file, buffer });
    consumedIds.push(fileId);
  }
  const files = resolvedFiles.map(({ file, buffer }) => ({
    name: file.name,
    mimeType: file.mimeType,
    data: buffer.toString('base64'),
    isImage: String(file.mimeType || '').startsWith('image/'),
  }));
  return {
    payload: { ...(payload || {}), files },
    consumedIds,
  };
}

/**
 * Relay Work Center commands to the selected Agent.
 *
 * WorkItem data is Agent-local. The server owns authentication and routing.
 * Request ownership stays server-side; an Agent can never choose which user
 * receives a response by echoing or forging identity fields.
 */
export async function handleClientWorkCenter(client, msg, checkAgentAccess) {
  if (msg?.type !== 'work_center_request') return false;

  const agentId = typeof msg.agentId === 'string' && msg.agentId.trim()
    ? msg.agentId.trim()
    : client.currentAgent;
  if (!agentId) return true;
  if (!await checkAgentAccess(agentId)) return true;

  const op = typeof msg.op === 'string' ? msg.op : '';
  const sourcePayload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  if (workCenterOpAcceptsAttachments(op) && Object.hasOwn(sourcePayload, 'files')) {
    await sendToWebClient(client, {
      type: 'work_center_response',
      requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
      agentId,
      op,
      ok: false,
      error: 'WorkItem files are server-generated and cannot be supplied by the browser',
    });
    return true;
  }

  const capabilities = agents.get(agentId)?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes('work_center')) {
    await sendToWebClient(client, {
      type: 'work_center_response',
      requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
      agentId,
      op,
      ok: false,
      error: 'The selected Agent does not support Work Center; upgrade and restart the Agent',
    });
    return true;
  }

  prunePendingRequests();
  const requestId = randomUUID();
  let resolved = { payload: sourcePayload, consumedIds: [] };
  try {
    const attachments = Array.isArray(sourcePayload.attachments) ? sourcePayload.attachments : [];
    if (workCenterOpAcceptsAttachments(op) && attachments.length > 0) {
      const capabilities = agents.get(agentId)?.capabilities;
      if (!Array.isArray(capabilities) || !capabilities.includes('work_item_attachments')) {
        throw new Error('The selected Agent does not support WorkItem attachments');
      }
    }
    if (workCenterOpAcceptsAttachments(op)) {
      resolved = resolveWorkItemAttachments(client, sourcePayload);
    }
  } catch (error) {
    await sendToWebClient(client, {
      type: 'work_center_response',
      requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
      agentId,
      op,
      ok: false,
      error: error?.message || String(error),
    });
    return true;
  }

  // Store the browser correlation id before forwarding. Agent responses can
  // arrive synchronously for an empty Work Center, so writing it after the
  // awaited send creates a race where the response deletes this entry first.
  pendingRequests.set(requestId, {
    client,
    agentId,
    clientRequestId: typeof msg.requestId === 'string' ? msg.requestId : null,
    attachmentFileIds: resolved.consumedIds,
    workItemId: typeof resolved.payload?.id === 'string' ? resolved.payload.id : null,
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  });

  try {
    await forwardToAgent(agentId, {
      type: 'work_center_request',
      requestId,
      op,
      payload: resolved.payload,
    });
  } catch (error) {
    pendingRequests.delete(requestId);
    throw error;
  }

  return true;
}

export async function deliverWorkCenterResponse(agentId, msg) {
  prunePendingRequests();
  const pending = typeof msg?.requestId === 'string' ? pendingRequests.get(msg.requestId) : null;
  if (!pending || pending.agentId !== agentId) return false;
  pendingRequests.delete(msg.requestId);
  // Keep staged Work Center bytes until the existing upload cleanup expires them.
  // The Agent may have committed the durable clientMessageId while this response
  // is lost before the browser receives it; a same-envelope retry must still be
  // able to resolve the original fileId and reach the Agent receipt preflight.
  const { agentId: _untrustedAgentId, requestId: _opaqueRequestId, _requestUserId, ...payload } = msg;
  let response = payload;
  if (msg.ok === true && msg.op === 'delete') {
    forgetWorkItemWorkspace(pending.client?.userId, agentId, pending.workItemId);
  } else if (msg.ok === true && msg.data?.id) {
    rememberWorkItemWorkspace(pending.client?.userId, agentId, msg.data);
  }
  if (msg.ok === true && msg.op === 'preview_attachment') {
    try {
      const data = payload.data;
      const preview = normalizeWorkItemPreview(data?.previewData, data?.attachment);
      const fileId = randomUUID();
      const token = randomUUID();
      previewFiles.set(fileId, {
        ...preview,
        createdAt: Date.now(),
        token,
      });
      const { previewData: _previewData, ...safeData } = data;
      response = {
        ...payload,
        data: { ...safeData, preview: `/api/preview/${fileId}?token=${encodeURIComponent(token)}` },
      };
    } catch (error) {
      response = {
        ...payload,
        ok: false,
        error: error?.message || String(error),
        data: undefined,
      };
    }
  }
  await sendToWebClient(pending.client, {
    ...response,
    agentId,
    requestId: pending.clientRequestId,
  });
  return true;
}

export function clearWorkCenterRequestsForClient(client) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.client === client) pendingRequests.delete(requestId);
  }
}

export function __testResetWorkCenterRequests() {
  pendingRequests.clear();
}
