import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeAtomic } from '../storage/atomic.js';

// IDs only; the journal is the commit point for logical deletion across the
// transcript, legacy files, coordinator log and debug store. Keep committed
// IDs after physical cleanup to fence old quotes and make retries idempotent.
export const SESSION_TURN_DELETION_FILE = 'deleted-turns.jsonl';

function journalPath(root, sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120).replace(/^\.+$/, '_') || '_';
  return join(root, 'sessions', safe, 'conversation', SESSION_TURN_DELETION_FILE);
}

export function readSessionTurnDeletions(ownerRoot, sessionId) {
  let raw;
  try { raw = readFileSync(journalPath(ownerRoot, sessionId), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { operations: [] };
  }
  const operations = raw.split('\n').filter(Boolean).map(line => {
    const op = JSON.parse(line);
    const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0);
    if (op.version !== 1 || op.sessionId !== sessionId || typeof op.turnId !== 'string'
      || !validIds(op.anchorMessageIds) || !validIds(op.messageIds)
      || !validIds(op.clientMessageIds) || !validIds(op.executionIds) || !validIds(op.referenceIds)) {
      throw new Error('Invalid Session turn deletion journal');
    }
    return op;
  });
  return { operations };
}

export function commitSessionTurnDeletion(ownerRoot, sessionId, operations, operation) {
  const path = journalPath(ownerRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, [...operations, operation].map(op => JSON.stringify(op)).join('\n') + '\n', { mode: 0o600 });
}

export function sessionDeletionProjection(operations) {
  const deletedIds = new Set(operations.flatMap(op => op.messageIds));
  const references = new Set(operations.flatMap(op => op.referenceIds));
  const localTurnIds = new Set(operations.filter(op => op.clientMessageIds.includes(op.turnId)).map(op => op.turnId));
  const clientIds = new Set(operations.flatMap(op => op.clientMessageIds));
  const executions = new Set(operations.flatMap(op => op.executionIds));
  const scrub = row => {
    if (!row || deletedIds.has(row.id)) return null;
    // Old processes may append after the deletion commit. Exclude only exact,
    // local ownership, never an imported row's coincidentally reused ID.
    if ((!row.origin || row.origin.sessionId === row.sessionId)
        && (deletedIds.has(row.causalRootId) || clientIds.has(row.causalRootId)
          || localTurnIds.has(row.userTurnId) || clientIds.has(row.clientMessageId)
          || executions.has(row.turnId))) return null;
    if (references.has(row.quote?.id || row.quote?.messageId)) {
      const { quote, ...kept } = row;
      return kept;
    }
    return row;
  };
  return { deletedIds, references, scrub };
}

export function sessionTurnTraceTombstones(ownerRoot, sessionId) {
  const { operations } = readSessionTurnDeletions(ownerRoot, sessionId);
  return {
    turnIds: new Set(operations.flatMap(op => op.executionIds)),
    messageIds: new Set(operations.flatMap(op => [...op.anchorMessageIds, ...op.clientMessageIds])),
  };
}

/** Durable fence for derived context: old summaries may include ANY earlier turn. */
export function sessionDeletionGeneration(ownerRoot, sessionId) {
  const { operations } = readSessionTurnDeletions(ownerRoot, sessionId);
  return operations.at(-1)?.deletionId || (operations.length ? `deleted-${operations.length}` : '');
}
