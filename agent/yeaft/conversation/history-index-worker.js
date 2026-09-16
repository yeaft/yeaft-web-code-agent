import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConversationStore } from './persist.js';
import {
  VISIBLE_ENTRY_SCHEMA_VERSION,
  findLiteralSearch,
  normalizeLiteralSearch,
} from './visible-entry.js';
import { fingerprintConversationSources } from './history-index-state.js';
import { extractRecallTerms, scoreRecallTurn, normalizeRecallLimit, RECALL_LIMITS } from './recall-relevance.js';

const INDEX_SCHEMA_VERSION = 2;
const SHORT_BLOOM_BYTES = 256;
const BUILD_YIELD_INTERVAL = 64;
const QUERY_BATCH_ROWS = 128;
const QUERY_BATCH_BYTES = 2 * 1024 * 1024;
const sourceDigestCache = new Map();

function codePoints(value) {
  return Array.from(String(value || ''));
}

function shortGrams(value, sizes = [1, 2]) {
  const chars = codePoints(normalizeLiteralSearch(value));
  const out = new Set();
  for (const size of sizes) {
    if (size <= 0 || chars.length < size) continue;
    for (let index = 0; index <= chars.length - size; index += 1) {
      out.add(`${size}:${chars.slice(index, index + size).join('')}`);
    }
  }
  return out;
}

function bloomPositions(value) {
  const bytes = Buffer.from(value, 'utf8');
  let first = 2166136261;
  let second = 2246822519;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619) >>> 0;
    second = Math.imul(second ^ byte, 3266489917) >>> 0;
  }
  const bitCount = SHORT_BLOOM_BYTES * 8;
  return [
    first % bitCount,
    second % bitCount,
    (first + second) % bitCount,
    (first + Math.imul(second, 3)) % bitCount,
  ];
}

function shortBloom(value) {
  const bloom = Buffer.alloc(SHORT_BLOOM_BYTES);
  for (const gram of shortGrams(value)) {
    for (const bit of bloomPositions(gram)) bloom[bit >>> 3] |= 1 << (bit & 7);
  }
  return bloom;
}

function bloomMayContain(bloom, query) {
  const chars = codePoints(query);
  if (chars.length < 1 || chars.length > 2 || !bloom) return false;
  const gram = `${chars.length}:${chars.join('')}`;
  const bytes = Buffer.isBuffer(bloom) ? bloom : Buffer.from(bloom);
  return bloomPositions(gram).every(bit => (bytes[bit >>> 3] & (1 << (bit & 7))) !== 0);
}

function openDatabase(path, { create = false } = {}) {
  if (create) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, create ? {} : { readOnly: true });
  if (create) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE entries (
        entry_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        turn_id TEXT,
        speaker_vp_id TEXT,
        entry_start_seq INTEGER NOT NULL,
        entry_end_seq INTEGER NOT NULL,
        anchor_message_id TEXT NOT NULL,
        anchor_seq INTEGER NOT NULL,
        source_message_ids TEXT NOT NULL,
        text_body TEXT NOT NULL,
        short_bloom BLOB NOT NULL,
        timestamp TEXT
      );
      CREATE INDEX entries_session_seq
        ON entries(session_id, entry_end_seq DESC, entry_id DESC);
      CREATE VIRTUAL TABLE entry_fts USING fts5(
        normalized_text,
        content='',
        detail=none,
        columnsize=0,
        tokenize='trigram case_sensitive 1'
      );
    `);
  }
  db.function('yeaft_bloom_contains', { deterministic: true }, (bloom, query) => (
    bloomMayContain(bloom, String(query || '')) ? 1 : 0
  ));
  return db;
}

function setMeta(db, values) {
  const insert = db.prepare('INSERT INTO meta(key,value) VALUES(?,?)');
  for (const [key, value] of Object.entries(values)) insert.run(key, String(value));
}

function readMeta(db) {
  return Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(row => [row.key, row.value]));
}

function updateSemanticHash(hash, entry) {
  hash.update(JSON.stringify({
    entryId: entry.entryId,
    role: entry.role,
    turnId: entry.turnId || null,
    speakerVpId: entry.speakerVpId || null,
    entryStartSeq: entry.entryStartSeq,
    entryEndSeq: entry.entryEndSeq,
    anchorMessageId: entry.anchorMessageId,
    anchorSeq: entry.anchorSeq,
    sourceMessageIds: entry.sourceMessageIds || [],
    textParts: entry.textParts || [],
    timestamp: entry.timestamp || null,
  }), 'utf8');
  hash.update('\0', 'utf8');
}

function semanticSourceToken(ownerRoot, sessionId) {
  const rawBefore = fingerprintConversationSources(ownerRoot, sessionId, { forceHash: true });
  const store = new ConversationStore(ownerRoot);
  const hash = createHash('sha256');
  hash.update(`visible-history-index-v${INDEX_SCHEMA_VERSION}\0${sessionId}\0`, 'utf8');
  let entryCount = 0;
  if (rawBefore.exists) {
    for (const entry of store.iterateCanonicalVisibleEntriesBySession(sessionId)) {
      updateSemanticHash(hash, entry);
      entryCount += 1;
    }
  }
  const rawAfter = fingerprintConversationSources(ownerRoot, sessionId, { forceHash: true });
  if (rawBefore.fingerprint !== rawAfter.fingerprint) {
    const error = new Error('history source changed during semantic scan');
    error.code = 'source_changed';
    throw error;
  }
  return {
    fingerprint: hash.digest('hex'),
    rawFingerprint: rawAfter.fingerprint,
    files: rawAfter.files,
    bytes: rawAfter.bytes,
    exists: rawAfter.exists,
    entryCount,
  };
}

const yieldWorker = () => new Promise(resolve => setImmediate(resolve));

async function buildIndex() {
  const { ownerRoot, sessionId, databasePath, generation, sourceRevision } = workerData;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
  const rawBefore = fingerprintConversationSources(ownerRoot, sessionId, { forceHash: true });
  const store = new ConversationStore(ownerRoot);
  const db = openDatabase(databasePath, { create: true });
  const insertEntry = db.prepare(`
    INSERT INTO entries(
      entry_id, session_id, role, turn_id, speaker_vp_id,
      entry_start_seq, entry_end_seq, anchor_message_id, anchor_seq,
      source_message_ids, text_body, short_bloom, timestamp
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertFts = db.prepare('INSERT INTO entry_fts(rowid, normalized_text) VALUES(?,?)');
  const semanticHash = createHash('sha256');
  semanticHash.update(`visible-history-index-v${INDEX_SCHEMA_VERSION}\0${sessionId}\0`, 'utf8');
  let entryCount = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (rawBefore.exists) {
      for (const entry of store.iterateCanonicalVisibleEntriesBySession(sessionId)) {
        const text = entry.textParts.join(' ');
        const normalized = normalizeLiteralSearch(text);
        const inserted = insertEntry.run(
          entry.entryId,
          sessionId,
          entry.role,
          entry.turnId || null,
          entry.speakerVpId || null,
          entry.entryStartSeq,
          entry.entryEndSeq,
          entry.anchorMessageId,
          entry.anchorSeq,
          JSON.stringify(entry.sourceMessageIds || []),
          text,
          shortBloom(normalized),
          entry.timestamp || null,
        );
        insertFts.run(Number(inserted.lastInsertRowid), normalized);
        updateSemanticHash(semanticHash, entry);
        entryCount += 1;
        if (entryCount % BUILD_YIELD_INTERVAL === 0) await yieldWorker();
      }
    }
    const rawAfter = fingerprintConversationSources(ownerRoot, sessionId, { forceHash: true });
    if (rawBefore.fingerprint !== rawAfter.fingerprint) {
      const error = new Error('history source changed during rebuild');
      error.code = 'source_changed';
      throw error;
    }
    const semanticFingerprint = semanticHash.digest('hex');
    setMeta(db, {
      index_schema_version: INDEX_SCHEMA_VERSION,
      visible_entry_schema_version: VISIBLE_ENTRY_SCHEMA_VERSION,
      session_id: sessionId,
      generation,
      source_revision: sourceRevision,
      source_fingerprint: semanticFingerprint,
      raw_source_fingerprint: rawAfter.fingerprint,
      source_files: rawAfter.files,
      source_bytes: rawAfter.bytes,
      entry_count: entryCount,
      built_at: new Date().toISOString(),
    });
    db.exec('COMMIT');
    db.close();
    return {
      generation,
      databasePath,
      sourceRevision,
      fingerprint: semanticFingerprint,
      rawFingerprint: rawAfter.fingerprint,
      files: rawAfter.files,
      bytes: rawAfter.bytes,
      exists: rawAfter.exists,
      entryCount,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
    throw error;
  }
}

function currentSourceToken({ forceHash = false } = {}) {
  return fingerprintConversationSources(workerData.ownerRoot, workerData.sessionId, {
    digestCache: sourceDigestCache,
    forceHash,
  });
}

function indexStats(meta) {
  return {
    indexSourceFiles: Number(meta.source_files) || 0,
    indexSourceBytes: Number(meta.source_bytes) || 0,
    indexEntryCount: Number(meta.entry_count) || 0,
  };
}

function parseEntry(row, generation) {
  let sourceMessageIds = [];
  try { sourceMessageIds = JSON.parse(row.source_message_ids || '[]'); } catch {}
  return {
    indexGeneration: generation,
    entryId: row.entry_id,
    messageId: row.anchor_message_id,
    seq: Number(row.anchor_seq),
    entryStartSeq: Number(row.entry_start_seq),
    entryEndSeq: Number(row.entry_end_seq),
    role: row.role,
    turnId: row.turn_id,
    speakerVpId: row.speaker_vp_id,
    sourceMessageIds: Array.isArray(sourceMessageIds) ? sourceMessageIds : [],
    timestamp: row.timestamp || null,
  };
}

function pageBoundary(db, request, generation) {
  if (!request?.cursor) {
    return {
      beforeSeq: Number.isFinite(request?.beforeSeq) ? request.beforeSeq : Number.MAX_SAFE_INTEGER,
      cursorEndSeq: null,
      cursorEntryId: null,
    };
  }
  const cursor = request.cursor;
  const row = db.prepare('SELECT entry_start_seq,entry_end_seq FROM entries WHERE entry_id=? AND session_id=?')
    .get(cursor.entryId, workerData.sessionId);
  if (Number(cursor.indexGeneration) !== generation
    || !row
    || Number(row.entry_start_seq) !== Number(cursor.entryStartSeq)) {
    const error = new Error('stale history cursor');
    error.code = 'stale_result';
    throw error;
  }
  return {
    beforeSeq: Number.MAX_SAFE_INTEGER,
    cursorEndSeq: Number(row.entry_end_seq),
    cursorEntryId: cursor.entryId,
  };
}

function nextCursor(generation, selected, hasMore) {
  const oldest = selected.at(-1);
  if (!hasMore || !oldest) return null;
  return {
    indexGeneration: generation,
    entryId: oldest.entryId,
    entryStartSeq: oldest.entryStartSeq,
  };
}

function queryIndex(request) {
  const db = openDatabase(workerData.databasePath);
  try {
    const meta = readMeta(db);
    const generation = Number(meta.generation) || 0;
    const boundary = pageBoundary(db, request, generation);
    const senderKey = typeof request.senderKey === 'string' ? request.senderKey : '';
    const normalized = normalizeLiteralSearch(String(request.query || '').trim());
    const terms = normalized.split(/\s+/u).filter(Boolean);
    const queryLength = codePoints(terms[0] || '').length;
    const limit = Math.min(100, Math.max(1, Number(request.limit) || 20));
    const matches = [];
    let candidateRowsRead = 0;
    let candidateBytesRead = 0;
    let maxBatchRows = 0;
    let maxBatchBytes = 0;
    let batchEndSeq = boundary.cursorEndSeq;
    let batchEntryId = boundary.cursorEntryId;
    let exhausted = false;

    while (matches.length <= limit && !exhausted) {
      const params = [workerData.sessionId, boundary.beforeSeq];
      let sql = 'SELECT rowid,* FROM entries WHERE session_id=? AND entry_start_seq<?';
      if (batchEndSeq !== null) {
        sql += ' AND (entry_end_seq < ? OR (entry_end_seq = ? AND entry_id < ?))';
        params.push(batchEndSeq, batchEndSeq, batchEntryId);
      }
      if (queryLength >= 3) {
        const grams = terms
          .filter(term => codePoints(term).length >= 3)
          .map(term => codePoints(term).slice(0, 3).join(''));
        sql += ' AND rowid IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?)';
        params.push(grams.map(gram => `"${gram.replaceAll('"', '""')}"`).join(' AND '));
      } else if (queryLength > 0) {
        sql += ' AND yeaft_bloom_contains(short_bloom, ?) = 1';
        params.push(terms[0]);
      }
      if (senderKey === 'user') sql += " AND role='user'";
      else if (senderKey.startsWith('vp:')) {
        sql += " AND role='assistant' AND speaker_vp_id=?";
        params.push(senderKey.slice(3));
      }
      sql += ' ORDER BY entry_end_seq DESC, entry_id DESC LIMIT ?';
      params.push(QUERY_BATCH_ROWS);

      let batchRows = 0;
      let batchBytes = 0;
      let batchByteCapped = false;
      let lastRow = null;
      for (const row of db.prepare(sql).iterate(...params)) {
        const bytes = Buffer.byteLength(row.text_body || '', 'utf8');
        if (batchRows > 0 && batchBytes + bytes > QUERY_BATCH_BYTES) {
          batchByteCapped = true;
          break;
        }
        batchRows += 1;
        batchBytes += bytes;
        candidateRowsRead += 1;
        candidateBytesRead += bytes;
        lastRow = row;
        const matchIndexes = terms.map(term => findLiteralSearch(row.text_body, term));
        if (matchIndexes.some(index => index < 0)) continue;
        matches.push({ row, matchIndex: matchIndexes[0] || 0 });
        if (matches.length > limit) break;
      }
      maxBatchRows = Math.max(maxBatchRows, batchRows);
      maxBatchBytes = Math.max(maxBatchBytes, batchBytes);
      if (!lastRow || (!batchByteCapped && batchRows < QUERY_BATCH_ROWS) || matches.length > limit) {
        exhausted = true;
      }
      else {
        batchEndSeq = Number(lastRow.entry_end_seq);
        batchEntryId = lastRow.entry_id;
      }
    }

    const hasMore = matches.length > limit;
    const selected = matches.slice(0, limit).map(({ row, matchIndex }) => {
      const result = parseEntry(row, generation);
      const radius = 90;
      const start = Math.max(0, matchIndex - radius);
      const end = Math.min(row.text_body.length, matchIndex + (terms[0] || '').length + radius);
      return {
        ...result,
        snippet: terms.length > 0
          ? `${start > 0 ? '…' : ''}${row.text_body.slice(start, end)}${end < row.text_body.length ? '…' : ''}`
          : row.text_body.slice(0, 180),
      };
    });
    return {
      results: selected,
      hasMore,
      nextBeforeSeq: hasMore ? selected.at(-1)?.entryStartSeq ?? null : null,
      nextCursor: nextCursor(generation, selected, hasMore),
      indexGeneration: generation,
      candidateRowsRead,
      candidateBytesRead,
      maxBatchRows,
      maxBatchBytes,
      ...indexStats(meta),
    };
  } finally {
    db.close();
  }
}

// Candidate discovery and complete-turn reads share one worker operation and
// immutable index generation. Only bounded metadata is read before byte checks.
function recallTurns(request) {
  const db = openDatabase(workerData.databasePath);
  try {
    const indexMeta = readMeta(db);
    const generation = Number(indexMeta.generation) || 0;
    const terms = extractRecallTerms(request.prompt);
    const cap = (value, fallback) => Math.min(fallback, Math.max(1, Math.floor(Number(value) || fallback)));
    const limit = normalizeRecallLimit(request.limit);
    const maxTurnRows = cap(request.maxTurnRows, RECALL_LIMITS.maxTurnRows);
    const maxTurnBytes = cap(request.maxTurnBytes, RECALL_LIMITS.maxTurnBytes);
    const maxReadBytes = cap(request.maxReadBytes, RECALL_LIMITS.maxReadBytes);
    const beforeSeq = Number.isFinite(request.beforeSeq) ? request.beforeSeq : Number.MAX_SAFE_INTEGER;
    const meta = {
      status: 'ready', reason: 'no_match', terms, indexGeneration: generation,
      candidateRowsRead: 0, boundaryRowsRead: 0, turnRowsRead: 0, readBytes: 0,
      skippedOversizedTurns: 0, skippedFencedTurns: 0, candidateCapped: false,
      limits: { ...RECALL_LIMITS, maxTurnRows, maxTurnBytes, maxReadBytes, limit },
      ...indexStats(indexMeta),
    };
    if (limit === 0) return { turns: [], meta: { ...meta, status: 'disabled', reason: 'disabled' } };
    const sourceBefore = currentSourceToken();
    if (sourceBefore.fingerprint !== indexMeta.raw_source_fingerprint) {
      return { turns: [], meta: { ...meta, status: 'not_ready', reason: 'stale_result' } };
    }
    const candidates = new Map();
    const candidateById = db.prepare(`SELECT entry_id,entry_start_seq,entry_end_seq,role
      FROM entries WHERE rowid=? AND session_id=? AND role IN ('user','assistant') AND entry_end_seq<?`);
    const addCandidate = row => {
      if (!row) return;
      if (candidates.size < RECALL_LIMITS.maxCandidates) candidates.set(row.entry_id, row);
      else meta.candidateCapped = true;
    };
    const shortTerms = terms.filter(term => codePoints(term).length < 3);
    for (const term of terms.filter(term => codePoints(term).length >= 3)) {
      const chars = codePoints(normalizeLiteralSearch(term));
      const grams = [...new Set([chars.slice(0, 3).join(''), chars.slice(-3).join('')])];
      const match = grams.map(gram => `"${gram.replaceAll('"', '""')}"`).join(' AND ');
      // Fixed trigram prefix, not exhaustive term search: false positives or
      // rows rejected by the seq fence can consume all 32 slots. Do not scan
      // additional postings to fill the result; candidateCapped reports this.
      const ids = db.prepare('SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? ORDER BY rowid ASC LIMIT ?')
        .all(match, RECALL_LIMITS.candidatesPerTerm + 1);
      if (ids.length > RECALL_LIMITS.candidatesPerTerm) meta.candidateCapped = true;
      for (const { rowid } of ids.slice(0, RECALL_LIMITS.candidatesPerTerm)) {
        meta.candidateRowsRead += 1;
        addCandidate(candidateById.get(rowid, workerData.sessionId, beforeSeq));
      }
    }
    // Two-character Chinese words cannot use trigram FTS. Scan only a fixed
    // newest metadata/bloom prefix, never unbounded text or the source JSONL.
    if (shortTerms.length) {
      const rows = db.prepare(`SELECT entry_id,entry_start_seq,entry_end_seq,role,short_bloom
        FROM entries WHERE session_id=? AND entry_end_seq<?
        ORDER BY entry_end_seq DESC,entry_id DESC LIMIT ?`)
        .all(workerData.sessionId, beforeSeq, RECALL_LIMITS.shortTermRows);
      meta.candidateRowsRead += rows.length;
      if (rows.length === RECALL_LIMITS.shortTermRows) meta.candidateCapped = true;
      for (const row of rows) {
        if (shortTerms.some(term => bloomMayContain(row.short_bloom, normalizeLiteralSearch(term)))) addCandidate(row);
      }
    }
    const previousRows = db.prepare(`SELECT entry_id,entry_start_seq,entry_end_seq,role
      FROM entries WHERE session_id=? AND entry_end_seq<=?
      ORDER BY entry_end_seq DESC,entry_id DESC LIMIT ?`);
    const followingRows = db.prepare(`SELECT entry_id,entry_start_seq,entry_end_seq,role,
        length(CAST(text_body AS BLOB))+length(CAST(source_message_ids AS BLOB)) AS bytes
      FROM entries WHERE session_id=? AND entry_end_seq>=?
      ORDER BY entry_end_seq ASC,entry_id ASC LIMIT ?`);
    const readEntry = db.prepare('SELECT * FROM entries WHERE session_id=? AND entry_id=?');
    const seenUsers = new Set();
    const turns = [];
    for (const candidate of [...candidates.values()].sort((a, b) => b.entry_end_seq - a.entry_end_seq)) {
      let user = candidate.role === 'user' ? candidate : null;
      if (!user) {
        const remaining = RECALL_LIMITS.maxBoundaryRows - meta.boundaryRowsRead;
        if (remaining <= 0) { meta.candidateCapped = true; break; }
        for (const row of previousRows.iterate(workerData.sessionId, candidate.entry_start_seq, remaining)) {
          meta.boundaryRowsRead += 1;
          if (row.role === 'user') { user = row; break; }
        }
      }
      if (!user || seenUsers.has(user.entry_id)) continue;
      seenUsers.add(user.entry_id);
      if (user.entry_start_seq >= beforeSeq) continue;
      const rows = [];
      let complete = true;
      let bytes = 0;
      for (const row of followingRows.iterate(workerData.sessionId, user.entry_start_seq, maxTurnRows + 1)) {
        meta.turnRowsRead += 1;
        if (row.role === 'user' && row.entry_id !== user.entry_id) break;
        rows.push(row);
        bytes += Number(row.bytes) || 0;
        if (rows.length > maxTurnRows || bytes > maxTurnBytes) {
          complete = false;
          meta.skippedOversizedTurns += 1;
          break;
        }
      }
      if (!complete) continue;
      if (rows.some(row => row.entry_end_seq >= beforeSeq)) {
        meta.skippedFencedTurns += 1;
        continue;
      }
      if (meta.readBytes + bytes > maxReadBytes) { meta.candidateCapped = true; continue; }
      const messages = rows.map(row => {
        const full = readEntry.get(workerData.sessionId, row.entry_id);
        const entry = parseEntry(full, generation);
        return { ...entry, id: entry.entryId, sessionId: workerData.sessionId, content: full.text_body };
      });
      meta.readBytes += bytes;
      turns.push({ id: user.entry_id, userSeq: Number(user.entry_start_seq), messages });
    }
    const termDocumentFrequency = Object.create(null);
    for (const term of terms) termDocumentFrequency[term.toLocaleLowerCase()] = 0;
    for (const turn of turns) {
      turn.relevance = scoreRecallTurn(terms, turn.messages.map(message => message.content).join('\n'));
      for (const term of turn.relevance.matchedTerms) termDocumentFrequency[term.toLocaleLowerCase()] += 1;
    }
    const stats = { sampleSize: turns.length, termDocumentFrequency };
    const rejections = {};
    for (const turn of turns) {
      turn.relevance = scoreRecallTurn(terms, turn.messages.map(message => message.content).join('\n'), stats);
      turn.score = turn.relevance.score;
      turn.matchedTerms = turn.relevance.matchedTerms;
      if (!turn.score) rejections[turn.relevance.reason] = (rejections[turn.relevance.reason] || 0) + 1;
    }
    const selected = turns.filter(turn => turn.score > 0)
      .sort((a, b) => b.score - a.score || b.userSeq - a.userSeq).slice(0, limit);
    if (workerData.testHooksEnabled && request._testBarrier instanceof SharedArrayBuffer) {
      const barrier = new Int32Array(request._testBarrier);
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0, 100);
    }
    const sourceAfter = currentSourceToken();
    if (sourceBefore.fingerprint !== sourceAfter.fingerprint) {
      return { turns: [], meta: { ...meta, status: 'not_ready', reason: 'stale_result' } };
    }
    return {
      turns: selected,
      meta: { ...meta, reason: selected.length ? 'matched' : terms.length ? 'no_match' : 'generic_prompt',
        ...stats, rejections, sourceFingerprint: sourceAfter.fingerprint },
    };
  } finally {
    db.close();
  }
}

function outlineIndex(request) {
  const db = openDatabase(workerData.databasePath);
  try {
    const meta = readMeta(db);
    const generation = Number(meta.generation) || 0;
    const boundary = pageBoundary(db, request, generation);
    const limit = Math.min(100, Math.max(1, Number(request.limit) || 50));
    const params = [workerData.sessionId, boundary.beforeSeq];
    let sql = 'SELECT * FROM entries WHERE session_id=? AND entry_start_seq<?';
    if (boundary.cursorEndSeq !== null) {
      sql += ' AND (entry_end_seq < ? OR (entry_end_seq = ? AND entry_id < ?))';
      params.push(boundary.cursorEndSeq, boundary.cursorEndSeq, boundary.cursorEntryId);
    }
    sql += ' ORDER BY entry_end_seq DESC, entry_id DESC LIMIT ?';
    params.push(limit + 1);
    const rows = db.prepare(sql).all(...params);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).map(row => ({
      ...parseEntry(row, generation),
      snippet: row.text_body.length > 180 ? `${row.text_body.slice(0, 180).trimEnd()}…` : row.text_body,
    }));
    const totalCount = request.includeTotal === true
      ? Number(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE session_id=?').get(workerData.sessionId)?.n) || 0
      : null;
    return {
      results: selected.slice().reverse(),
      hasMore,
      nextBeforeSeq: hasMore ? selected.at(-1)?.entryStartSeq ?? null : null,
      nextCursor: nextCursor(generation, selected, hasMore),
      totalCount,
      indexGeneration: generation,
      ...indexStats(meta),
    };
  } finally {
    db.close();
  }
}

function validatedEntry(db, request, generation) {
  if (Number(request.indexGeneration) !== generation) return null;
  const row = db.prepare('SELECT * FROM entries WHERE entry_id=? AND session_id=?')
    .get(request.entryId, workerData.sessionId);
  if (!row
    || row.anchor_message_id !== request.anchorMessageId
    || Number(row.anchor_seq) !== Number(request.anchorSeq)
    || Number(row.entry_start_seq) !== Number(request.entryStartSeq)) return null;
  return row;
}

function validateAnchor(request) {
  const db = openDatabase(workerData.databasePath);
  try {
    const meta = readMeta(db);
    const generation = Number(meta.generation) || 0;
    const row = validatedEntry(db, request, generation);
    if (!row) return { ok: false, code: 'stale_result', indexGeneration: generation };
    return { ok: true, entry: parseEntry(row, generation), indexGeneration: generation };
  } finally {
    db.close();
  }
}

function validateAndReadWindow(request) {
  const db = openDatabase(workerData.databasePath);
  try {
    const meta = readMeta(db);
    const generation = Number(meta.generation) || 0;
    const sourceBefore = currentSourceToken();
    if (sourceBefore.fingerprint !== meta.raw_source_fingerprint) {
      return { ok: false, code: 'stale_result', indexGeneration: generation };
    }
    const row = validatedEntry(db, request, generation);
    if (!row) return { ok: false, code: 'stale_result', indexGeneration: generation };
    if (workerData.testHooksEnabled && request._testBarrier instanceof SharedArrayBuffer) {
      const barrier = new Int32Array(request._testBarrier);
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0, 100);
    }
    const entry = parseEntry(row, generation);
    const store = new ConversationStore(workerData.ownerRoot);
    const window = store.loadVisibleWindowBySession(workerData.sessionId, request.anchorSeq, {
      beforeTurns: request.beforeTurns,
      afterTurns: request.afterTurns,
      entryStartSeq: entry.entryStartSeq,
      entryEndSeq: entry.entryEndSeq,
      sourceMessageIds: entry.sourceMessageIds,
      maxRows: request.maxRows,
      maxBytes: request.maxBytes,
    });
    const sourceAfter = currentSourceToken();
    if (sourceBefore.fingerprint !== sourceAfter.fingerprint) {
      return { ok: false, code: 'stale_result', indexGeneration: generation };
    }
    return {
      ok: true,
      entry,
      window,
      indexGeneration: generation,
      rawSourceFingerprint: sourceAfter.fingerprint,
    };
  } finally {
    db.close();
  }
}

async function run() {
  if (workerData.mode === 'rebuild') return buildIndex();
  if (workerData.mode === 'fingerprint') return semanticSourceToken(workerData.ownerRoot, workerData.sessionId);
  if (!existsSync(workerData.databasePath)) throw new Error('history index database missing');
  return await new Promise(resolve => {
    const close = () => {
      try { parentPort.close(); } catch {}
      resolve({ closed: true });
    };
    parentPort.on('message', message => {
      const { requestId, op, payload = {} } = message || {};
      if (op === 'close') return close();
      try {
        let result;
        if (op === 'search') result = queryIndex(payload);
        else if (op === 'recall-turns') result = recallTurns(payload);
        else if (op === 'outline') result = outlineIndex(payload);
        else if (op === 'validate-anchor') result = validateAnchor(payload);
        else if (op === 'validate-and-read-window') result = validateAndReadWindow(payload);
        else if (op === 'source-token') result = currentSourceToken(payload);
        else throw new Error(`unknown history index operation: ${op}`);
        parentPort.postMessage({ requestId, result });
      } catch (error) {
        parentPort.postMessage({
          requestId,
          error: error?.message || String(error),
          ...(error?.code ? { code: error.code } : {}),
        });
      }
    });
  });
}

run()
  .then(result => {
    if (workerData.mode === 'rebuild') {
      parentPort.postMessage({ type: 'rebuilt', result });
      parentPort.close();
    } else if (workerData.mode === 'fingerprint') {
      parentPort.postMessage({ type: 'fingerprint', result });
      parentPort.close();
    }
  })
  .catch(error => {
    parentPort.postMessage({ type: 'fatal', error: error?.stack || error?.message || String(error) });
    process.exitCode = 1;
  });
