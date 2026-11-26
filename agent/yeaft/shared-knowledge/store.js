import { randomUUID } from 'node:crypto';
import { createAgentHistoryScan, isAgentHistorySessionId } from '../conversation/search.js';
import { parseSeqFromId } from '../conversation/persist.js';
import {
  lexicalTermClauses, localSessionDirs, openDiscoveryStore, readSourceFence, termsForIndex,
} from '../session-discovery/store.js';

export const KNOWLEDGE_DIMENSIONS = Object.freeze([
  'preference_rule', 'decision', 'project_fact', 'workstream', 'artifact_outcome', 'user_context',
]);

const MAX_PENDING_SEQS = 16_384;

export function validatePendingSeqs(seqs) {
  if (!Array.isArray(seqs)) throw new TypeError('Invalid digest pending sequences');
  if (seqs.length > MAX_PENDING_SEQS) throw new Error('Too many digest pending sequences');
  for (const seq of seqs) if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError('Invalid digest pending sequence');
  return seqs;
}

// Additive schema: older discovery readers ignore these tables. The job does
// not migrate or depend on legacy Share, route cards, or any memory tables.
export function openKnowledgeWriter(root) {
  const db = openDiscoveryStore(root);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_job (
        id INTEGER PRIMARY KEY CHECK (id = 1), bootstrap_since INTEGER NOT NULL,
        completed_slot INTEGER, lease TEXT, lease_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS knowledge_watermarks (
        session_id TEXT PRIMARY KEY, identity TEXT NOT NULL, generation TEXT NOT NULL, seq INTEGER NOT NULL,
        pending_seqs TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS shared_knowledge (
        id TEXT NOT NULL UNIQUE, dimension TEXT NOT NULL, scope TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL, sources TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS shared_knowledge_fts USING fts5(title, body, tags);
      INSERT OR IGNORE INTO shared_knowledge_fts(shared_knowledge_fts, rank) VALUES ('secure-delete', 1);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function claimKnowledgeJob(db, { slot, now, bootstrapSince, leaseMs }) {
  return transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO knowledge_job(id, bootstrap_since) VALUES (1, ?)').run(bootstrapSince);
    const state = db.prepare('SELECT * FROM knowledge_job WHERE id = 1').get();
    if (state.completed_slot >= slot) return { status: 'done' };
    if (state.lease && state.lease_until > now) return { status: 'busy' };
    const lease = randomUUID();
    db.prepare('UPDATE knowledge_job SET lease = ?, lease_until = ? WHERE id = 1').run(lease, now + leaseMs);
    return { status: 'claimed', lease, bootstrapSince: state.bootstrap_since };
  });
}

export function releaseKnowledgeJob(db, lease, completedSlot = null) {
  db.prepare(`UPDATE knowledge_job SET lease = NULL, lease_until = NULL,
    completed_slot = COALESCE(?, completed_slot) WHERE id = 1 AND lease = ?`).run(completedSlot, lease);
}

export function renewKnowledgeJob(db, lease, leaseUntil) {
  return db.prepare('UPDATE knowledge_job SET lease_until = ? WHERE id = 1 AND lease = ?').run(leaseUntil, lease).changes === 1;
}

export function readKnowledgeWatermark(db, sessionId) {
  const row = db.prepare('SELECT identity, generation, seq AS lastSeq, pending_seqs FROM knowledge_watermarks WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  const { pending_seqs, ...mark } = row;
  return { ...mark, pendingSeqs: validatePendingSeqs(JSON.parse(pending_seqs)) };
}

/** All sources (not just one contributor) must still belong to the live Agent scope. */
export function createKnowledgeSourceCheck(root, { allowedIds, signal } = {}) {
  const allowed = allowedIds ? new Set(allowedIds.filter(isAgentHistorySessionId)) : null;
  const telemetry = {};
  const { read } = createAgentHistoryScan(root, telemetry, signal);
  const entries = new Map();
  const dirs = localSessionDirs(root, read, allowed, { strict: true, entries });
  const cached = new Map();
  return ({ sessionId, generation, firstInputSeq, lastInputSeq }) => {
    if (signal?.aborted || telemetry.scanIncomplete || !dirs.has(sessionId)) return false;
    if (!cached.has(sessionId)) {
      let value = null;
      try {
        const source = readSourceFence(root, sessionId, read);
        if (source?.meta.createdAt === entries.get(sessionId)?.createdAt && source?.meta.createdAt
            && !source.meta.task && !source.meta.archived && !source.meta.archivedAt) value = source;
      } catch { /* fail closed */ }
      cached.set(sessionId, value);
    }
    const source = cached.get(sessionId);
    if (telemetry.scanIncomplete || !source) return false;
    if (source.key === generation) return true;
    // A cursor commit requires exact generation. A stored note can survive a
    // later unrelated deletion if the stream and old journal prefix match.
    if (!Number.isSafeInteger(firstInputSeq) || !Number.isSafeInteger(lastInputSeq)) return false;
    const [createdAt, stream, count] = JSON.parse(generation);
    if (JSON.stringify([createdAt, stream]) !== source.identity || !Number.isSafeInteger(count)
        || count < 0 || count >= source.operations.length) return false;
    const tail = source.operations[count - 1];
    if (JSON.stringify([createdAt, stream, count, tail?.deletionId || tail?.turnId || null]) !== generation) return false;
    return source.operations.slice(count).every(op => (op.anchorMessageIds.length + op.messageIds.length > 0)
      && [...op.anchorMessageIds, ...op.messageIds].every(id => {
        const seq = parseSeqFromId(id);
        return Number.isSafeInteger(seq) && (seq < firstInputSeq || seq > lastInputSeq);
      }));
  };
}

const publicSource = ({ sessionId, seq, messageId }) => ({ sessionId, seq, messageId });

function matchingRows(db, clauses, limit, { scope = null, dimension = null, allowedIds = null, sessionId = null, beforeSeq = null, offset = 0 } = {}) {
  if (!clauses.length) return [];
  const authority = allowedIds === null ? '' : `AND NOT EXISTS (
    SELECT 1 FROM json_each(k.sources) AS source
    WHERE source.value ->> '$.sessionId' NOT IN (SELECT value FROM json_each(?))
       OR (source.value ->> '$.sessionId' = ? AND COALESCE(source.value ->> '$.lastInputSeq', source.value ->> '$.seq') >= ?)
  )`;
  return db.prepare(`SELECT k.* FROM shared_knowledge_fts f JOIN shared_knowledge k ON k.rowid = f.rowid
    WHERE shared_knowledge_fts MATCH ? ${scope === null ? '' : 'AND k.scope = ? AND k.dimension = ?'} ${authority}
    ORDER BY bm25(shared_knowledge_fts, 5.0, 1.0, 3.0), k.updated_at DESC, k.id LIMIT ? OFFSET ?`)
    .all(clauses.join(' AND '), ...(scope === null ? [] : [scope, dimension]),
      ...(allowedIds === null ? [] : [JSON.stringify(allowedIds), sessionId, beforeSeq]), limit, offset);
}

function readItem(row) {
  return { id: row.id, dimension: row.dimension, scope: row.scope, title: row.title, body: row.body,
    tags: JSON.parse(row.tags), sources: JSON.parse(row.sources), updatedAt: row.updated_at };
}

/** Bounded same-Agent knowledge search, independent from legacy Share and routing. */
export function searchSharedKnowledge(root, allowedIds, { query, limit = 8, sessionId, beforeSeq, signal } = {}) {
  if (!root || !Array.isArray(allowedIds) || !allowedIds.length || typeof query !== 'string'
      || !query.trim() || query.length > 1024 || signal?.aborted) return [];
  const clauses = lexicalTermClauses(query);
  if (!clauses.length) return [];
  const db = openDiscoveryStore(root, { readOnly: true });
  if (!db) return [];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'shared_knowledge_fts'").get()) return [];
    const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));
    const live = createKnowledgeSourceCheck(root, { allowedIds, signal });
    const out = [];
    const pageSize = 100;
    const options = { allowedIds: [...new Set(allowedIds.filter(isAgentHistorySessionId))], sessionId,
      beforeSeq: Number.isSafeInteger(beforeSeq) ? beforeSeq : null };
    for (let offset = 0; offset < 400 && !signal?.aborted; offset += pageSize) {
      const page = matchingRows(db, clauses, pageSize, { ...options, offset });
      for (const row of page) {
        const { scope, ...item } = readItem(row);
        if (!item.sources.length || !item.sources.every(live)) continue;
        out.push({ ...item, sources: item.sources.slice(0, 16).map(publicSource) });
        if (out.length >= max) return out;
      }
      if (page.length < pageSize) break;
    }
    return out;
  } finally { db.close(); }
}

/** Relevant predecessors are shortlisted by scope + terms; never send the whole knowledge bank to a model. */
export function findKnowledgePredecessors(db, candidates, checkSource) {
  const items = new Map();
  for (const candidate of candidates) {
    const options = { scope: candidate.scope, dimension: candidate.dimension };
    const rows = matchingRows(db, lexicalTermClauses(candidate.title), 6, options);
    for (const tag of candidate.tags) rows.push(...matchingRows(db, lexicalTermClauses(tag), 4, options));
    const found = new Set();
    for (const row of rows) {
      if (found.has(row.id)) continue;
      const item = readItem(row);
      if (!item.sources.length || !item.sources.every(checkSource)) continue;
      items.set(item.id, item);
      found.add(item.id);
      if (found.size >= 3) break;
    }
  }
  return [...items.values()];
}

function removeItem(db, id) {
  db.prepare('DELETE FROM shared_knowledge_fts WHERE rowid IN (SELECT rowid FROM shared_knowledge WHERE id = ?)').run(id);
  db.prepare('DELETE FROM shared_knowledge WHERE id = ?').run(id);
}

function writeItem(db, id, item, sources, now) {
  removeItem(db, id);
  // Preserve all input ranges. A deletion outside them must not hide an
  // otherwise valid note. Within a generation we retain a conservative union.
  const bySession = new Map();
  for (const ref of sources) {
    const key = JSON.stringify([ref.sessionId, ref.generation]);
    const previous = bySession.get(key);
    const latest = !previous || previous.seq < ref.seq ? ref : previous;
    bySession.set(key, previous && previous.firstInputSeq != null && ref.firstInputSeq != null
      ? { ...latest, firstInputSeq: Math.min(previous.firstInputSeq, ref.firstInputSeq),
        lastInputSeq: Math.max(previous.lastInputSeq, ref.lastInputSeq) } : latest);
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO shared_knowledge VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.dimension, item.scope, item.title, item.body, JSON.stringify(item.tags),
      JSON.stringify([...bySession.values()]), now);
  db.prepare('INSERT INTO shared_knowledge_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)')
    .run(lastInsertRowid, termsForIndex(item.title), termsForIndex(item.body), termsForIndex(item.tags.join(' ')));
}

/** Check the dispatch-time lease and sources again, then commit notes + cursors atomically. */
export function commitKnowledgeBatch(db, { root, lease, actions, watermarks, now, signal }) {
  return transaction(db, () => {
    if (signal?.aborted || !db.prepare('SELECT 1 FROM knowledge_job WHERE id = 1 AND lease = ?').get(lease)) return false;
    const live = createKnowledgeSourceCheck(root, { signal });
    if (!watermarks.every(live) || !actions.every(action => action.sources.every(live))) return false;
    const upsert = db.prepare(`INSERT INTO knowledge_watermarks(session_id, identity, generation, seq, pending_seqs) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET identity = excluded.identity, generation = excluded.generation,
        seq = excluded.seq, pending_seqs = excluded.pending_seqs`);
    for (const action of actions) {
      if (action.action === 'supersede') removeItem(db, action.targetId);
      writeItem(db, action.action === 'update' ? action.targetId : randomUUID(), action.item, action.sources, now);
    }
    for (const mark of watermarks) {
      upsert.run(mark.sessionId, mark.identity, mark.generation, mark.lastSeq, JSON.stringify(validatePendingSeqs(mark.pendingSeqs)));
    }
    return true;
  });
}
