import { createHash } from 'node:crypto';
import { isVisibleConversationRow } from './internal-control.js';

export const VISIBLE_ENTRY_SCHEMA_VERSION = 1;

function messageSeq(message) {
  if (Number.isFinite(message?.seq)) return Number(message.seq);
  const match = typeof message?.id === 'string' ? message.id.match(/^m(\d+)$/) : null;
  return match ? Number.parseInt(match[1], 10) : null;
}

function visibleText(content) {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && typeof part === 'object' && part.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function speakerVpId(message) {
  return message?.speakerVpId || message?.meta?.senderVpId
    || (message?.role === 'assistant' && message?.from && message.from !== 'user'
      ? message.from : null);
}

function entryIdentity(message, speaker) {
  if (message.role === 'user') return `user:${message.id}`;
  const turnId = typeof message.turnId === 'string' && message.turnId ? message.turnId : null;
  return turnId
    ? `assistant:turn:${turnId}:speaker:${speaker || ''}`
    : `assistant:message:${message.id}`;
}

function entryId(sessionId, identity) {
  const digest = createHash('sha256')
    .update(`${VISIBLE_ENTRY_SCHEMA_VERSION}\0${sessionId}\0${identity}`, 'utf8')
    .digest('base64url')
    .slice(0, 22);
  return `entry_${digest}`;
}

function visibleRow(message, sessionId, seenMessageIds) {
  if (!message || message.sessionId !== sessionId || !isVisibleConversationRow(message)) return null;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  if (!message.id || seenMessageIds.has(message.id)) return null;
  const seq = messageSeq(message);
  if (!Number.isFinite(seq)) return null;
  seenMessageIds.add(message.id);
  const speaker = speakerVpId(message);
  return {
    message,
    seq,
    text: visibleText(message.content),
    speakerVpId: speaker,
    identity: entryIdentity(message, speaker),
  };
}

function projectEntry(sessionId, identity, rows) {
  const ordered = rows.slice().sort((a, b) => a.seq - b.seq);
  const latest = ordered[ordered.length - 1];
  const latestText = ordered.slice().reverse().find(row => row.text) || latest;
  const first = ordered[0];
  const message = latestText.message;
  return {
    entryId: entryId(sessionId, identity),
    role: first.message.role,
    turnId: first.message.turnId || first.message.threadId || first.message.id,
    speakerVpId: first.speakerVpId,
    entryStartSeq: first.seq,
    entryEndSeq: latest.seq,
    anchorMessageId: message.id,
    anchorSeq: latestText.seq,
    sourceMessageIds: ordered.map(row => row.message.id),
    textParts: ordered.filter(row => row.text).map(row => row.text),
    timestamp: message.ts || message.time || null,
    ...(message.userTurnId ? { userTurnId: message.userTurnId } : {}),
    ...(message.relation ? { relation: message.relation } : {}),
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
  };
}

function flushAssistantEntries(sessionId, entries, boundaryMessageId = null) {
  const projected = Array.from(entries.entries(), ([identity, rows]) => {
    const oldest = rows.reduce((candidate, row) => (
      !candidate || row.seq < candidate.seq ? row : candidate
    ), null);
    const boundaryIdentity = boundaryMessageId || `start:${oldest?.message?.id || 'unknown'}`;
    return projectEntry(sessionId, `${identity}:after:${boundaryIdentity}`, rows);
  });
  projected.sort((a, b) => b.entryEndSeq - a.entryEndSeq || b.entryStartSeq - a.entryStartSeq);
  entries.clear();
  return projected;
}

/**
 * Project visible persisted rows into canonical user/assistant entries.
 *
 * Input must be newest-first. A visible user row closes the assistant response
 * bucket above it. That boundary lets interleaved VP rows (A-B-A) coalesce by
 * explicit turnId + speaker without scanning the whole transcript. Legacy
 * assistant rows without a turnId remain separate because guessing from
 * adjacency would make their identity change after prepend or transcript edits.
 */
export function* iterateCanonicalVisibleEntriesNewestFirst(messages, sessionId) {
  const seenMessageIds = new Set();
  const assistantEntries = new Map();

  for (const message of messages) {
    const row = visibleRow(message, sessionId, seenMessageIds);
    if (!row) continue;
    if (row.message.role === 'user') {
      yield* flushAssistantEntries(sessionId, assistantEntries, row.message.id);
      yield projectEntry(sessionId, row.identity, [row]);
      continue;
    }
    const rows = assistantEntries.get(row.identity) || [];
    rows.push(row);
    assistantEntries.set(row.identity, rows);
  }

  yield* flushAssistantEntries(sessionId, assistantEntries);
}

export function normalizeLiteralSearch(value) {
  return typeof value === 'string' ? value.toLocaleLowerCase() : '';
}

export function findLiteralSearch(text, query) {
  const needle = normalizeLiteralSearch(query);
  if (!needle) return 0;
  return normalizeLiteralSearch(text).indexOf(needle);
}

export const __visibleEntryForTest = {
  entryIdentity,
  entryId,
  messageSeq,
  projectEntry,
  speakerVpId,
  visibleText,
};
