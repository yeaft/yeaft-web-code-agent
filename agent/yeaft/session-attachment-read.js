import { createHash } from 'node:crypto';
import ctx from '../context.js';
import { sendToServer } from '../connection/buffer.js';
import { DEFAULT_YEAFT_DIR } from './init.js';
import { ConversationStore } from './conversation/persist.js';
import { findExistingSessionYeaftDir } from './sessions/session-crud.js';
import { MAX_FILES_PER_TURN, MAX_PREVIEW_BYTES, MAX_TOTAL_BYTES, readPersistedAttachmentRange, sessionAttachmentName } from './attachments.js';

// v1 wire protocol: an ID locates an attachment on a visible canonical row,
// never a path. Keep in sync with server/session-attachment-relay.js.
const CHUNK_BYTES = 1024 * 1024;
const SESSION_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;
const ATTACHMENT_ID = /^(m[0-9]{1,16})\.(0|[1-9][0-9]?)$/;

/** Read only an attachment still named by the requested Session transcript, including cold rows. */
export function readSessionAttachmentChunk(msg, defaultRoot) {
  const { sessionId, attachmentId, offset, version, download } = msg;
  const match = typeof attachmentId === 'string' && ATTACHMENT_ID.exec(attachmentId);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !match
    || Number(match[2]) >= MAX_FILES_PER_TURN
    || !Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_TOTAL_BYTES
    || (offset > 0 && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) return { error: 'invalid_request' };

  const yeaftDir = findExistingSessionYeaftDir(defaultRoot, sessionId);
  const row = new ConversationStore(yeaftDir).findVisibleUserMessageById(sessionId, match[1]);
  const attachment = row?.attachments?.[Number(match[2])];
  if (!attachment?.path || (!download && attachment.isImage !== true)) return { error: 'not_found' };
  try {
    const { path, buffer, stat } = readPersistedAttachmentRange(attachment.path, { yeaftDir, sessionId }, {
      offset, length: CHUNK_BYTES, maxBytes: download ? MAX_TOTAL_BYTES : MAX_PREVIEW_BYTES,
    });
    const currentVersion = createHash('sha256')
      .update(JSON.stringify([path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
    if (version && currentVersion !== version) return { error: 'changed' };
    return { size: stat.size, version: currentVersion, filename: sessionAttachmentName(attachment.name), content: buffer.toString('base64') };
  } catch (error) {
    return { error: error.code === 'ATTACHMENT_TOO_LARGE' ? 'too_large' : 'not_found' };
  }
}

export async function handleSessionAttachmentRead(msg) {
  if (typeof msg.requestId !== 'string' || msg.requestId.length > 64) return;
  const response = {
    type: 'yeaft_session_attachment_chunk', requestId: msg.requestId,
    sessionId: msg.sessionId, attachmentId: msg.attachmentId, offset: msg.offset,
  };
  let chunk;
  try {
    chunk = readSessionAttachmentChunk(msg, ctx.CONFIG?.yeaftDir || DEFAULT_YEAFT_DIR);
  } catch (error) {
    console.warn('[Yeaft] Session attachment lookup failed:', error?.code || error?.name);
    chunk = { error: 'read_failed' };
  }
  if (await sendToServer({ ...response, ...chunk }) === 'dropped' && !chunk.error) {
    await sendToServer({ ...response, error: 'read_failed' });
  }
}
