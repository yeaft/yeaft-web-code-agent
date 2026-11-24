import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHistoryScan } from '../conversation/search.js';
import { parseSeqFromId } from '../conversation/persist.js';
import { readSessionTurnDeletions, sessionDeletionProjection } from '../conversation/turn-deletion-journal.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 5 * DAY_MS;
export const DISCOVERY_SCHEMA_VERSION = 3;
const SEARCH_LIMIT = 25;
const ACTIVE_CARDS_LIMIT = 50;
const PUBLISHED_LIMIT = 200;
const CANDIDATE_LIMIT = 25;
const AUTOMATIC_LIMIT = 2000;
const AUTOMATIC_LIST_LIMIT = 25;
const MAX_PREVIEW_CHARS = 220;
const discoveryFiles = ['discovery.db', 'discovery.db-wal', 'discovery.db-shm', 'discovery.db-journal'];
const normalize = text => text.normalize('NFKC').toLowerCase();

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(name));
}

function migrateDiscoverySchema(db) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version || 0;
  if (version >= DISCOVERY_SCHEMA_VERSION && tableExists(db, 'session_messages') && tableExists(db, 'session_message_fts')) {
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Reconstructible Session search index tables are upgraded cleanly while
    // preserving durable owner-scoped Share items, automatic agreements and tombstones.
    const cardsColumns = tableExists(db, 'session_cards') ? tableColumns(db, 'session_cards') : new Set();
    if (!cardsColumns.has('fresh_at') || !cardsColumns.has('last_seq') || !cardsColumns.has('message_count')
        || !cardsColumns.has('transcript_signature')) {
      db.exec(`
        DROP TABLE IF EXISTS session_fts;
        DROP TABLE IF EXISTS session_message_fts;
        DROP TABLE IF EXISTS session_messages;
        DROP TABLE IF EXISTS session_cards;
        DELETE FROM candidates;
        DELETE FROM index_state;
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_cards (
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        work_dir TEXT NOT NULL,
        active_at INTEGER NOT NULL,
        deletion_generation TEXT NOT NULL,
        fresh_at INTEGER NOT NULL DEFAULT 0,
        transcript_signature TEXT NOT NULL DEFAULT '',
        last_seq INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS session_cards_active ON session_cards(active_at DESC, session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(title, work_dir);
      CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS session_messages_session ON session_messages(session_id, seq DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_message_fts USING fts5(requests, replies);
    `);
    db.exec("INSERT OR IGNORE INTO session_fts(session_fts, rank) VALUES('secure-delete', 1)");
    db.exec("INSERT OR IGNORE INTO session_message_fts(session_message_fts, rank) VALUES('secure-delete', 1)");
    db.exec(`PRAGMA user_version = ${DISCOVERY_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDiscoveryStore(root, { readOnly = false, busyTimeoutMs = 1500 } = {}) {
  const dir = join(root, 'session-discovery');
  if (!readOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (!lstatSync(dir).isDirectory()) throw new Error('Invalid Discovery storage directory'); }
  catch (error) { if (readOnly && error.code === 'ENOENT') return null; throw error; }
  for (const name of discoveryFiles) {
    try { if (!lstatSync(join(dir, name)).isFile()) throw new Error('Invalid Discovery storage file'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (readOnly && name === 'discovery.db') return null;
    }
  }
  const timeout = Math.max(50, Math.min(10_000, Math.floor(Number(busyTimeoutMs) || 1500)));
  const db = new DatabaseSync(join(dir, 'discovery.db'), { readOnly });
  if (readOnly) {
    try { db.exec(`PRAGMA busy_timeout = ${timeout}`); } catch { /* ignore */ }
    return db;
  }
  try {
    db.exec(`
      PRAGMA busy_timeout = ${timeout};
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS index_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS candidate_source ON candidates(source_session_id);
      CREATE TABLE IF NOT EXISTS share_items (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('consensus', 'output')),
        title TEXT NOT NULL, body TEXT NOT NULL, source_session_id TEXT, source_message_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id, id)
      );
      CREATE TABLE IF NOT EXISTS automatic_agreements (
        id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL, source_identity TEXT NOT NULL,
        source_ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automatic_agreement_recency ON automatic_agreements(created_at DESC, id);
      CREATE TABLE IF NOT EXISTS share_tombstones (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner_id, id)
      );
    `);
    migrateDiscoverySchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// unicode61 has no Chinese word segmentation. Encode CJK unigrams for short
// queries and consecutive bigrams for substring phrases; keep Latin words and
// filenames tokenized by their normal separators. These tokens are not UI text.
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function lexicalRuns(text) {
  const runs = [];
  for (const word of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    for (const char of word[0]) {
      const isCjk = cjk.test(char);
      if (runs.at(-1)?.word === word.index && runs.at(-1).cjk === isCjk) runs.at(-1).chars.push(char);
      else runs.push({ word: word.index, cjk: isCjk, chars: [char] });
    }
  }
  return runs;
}
const unigram = char => `z1x${char.codePointAt(0).toString(16)}`;
const bigrams = chars => chars.slice(1).map((char, i) => `z2x${chars[i].codePointAt(0).toString(16)}x${char.codePointAt(0).toString(16)}`);
function termsForIndex(text) {
  return lexicalRuns(text).map(({ cjk, chars }) => cjk
    ? [...chars.map(unigram), ...bigrams(chars)].join(' ')
    : chars.join('')).join(' ');
}
function lexicalTermClauses(text) {
  return [...new Set(lexicalRuns(text).slice(0, 20).map(({ cjk, chars }) => {
    if (!cjk) return `"${chars.join('')}"*`;
    return `"${chars.length === 1 ? unigram(chars[0]) : bigrams(chars).join(' ')}"`;
  }))];
}

function termsForQuery(text) {
  // Runs only contain letters/numbers/marks, so MATCH syntax is never accepted from the caller.
  return lexicalTermClauses(text).join(' AND ');
}

export function discoveryIndexedAt(db) {
  return db.prepare('SELECT indexed_at FROM index_state WHERE id = 1').get()?.indexed_at ?? null;
}

export function listIndexedCardWatermarks(db) {
  const map = new Map();
  for (const row of db.prepare(
    'SELECT session_id, title, work_dir, active_at, deletion_generation, fresh_at, transcript_signature, last_seq, message_count FROM session_cards',
  ).all()) {
    map.set(row.session_id, {
      sessionId: row.session_id,
      title: row.title,
      workDir: row.work_dir,
      activeAt: row.active_at,
      deletionGeneration: row.deletion_generation,
      freshAt: row.fresh_at,
      transcriptSignature: row.transcript_signature || '',
      lastSeq: row.last_seq,
      messageCount: row.message_count,
    });
  }
  return map;
}

export function candidateId(sessionId, body) {
  return `candidate_${createHash('sha256').update(JSON.stringify([sessionId, body.normalize('NFKC').toLowerCase()])).digest('hex')}`;
}

function deleteSessionFromIndex(db, sessionId) {
  const card = db.prepare('SELECT rowid FROM session_cards WHERE session_id = ?').get(sessionId);
  if (card) {
    db.prepare('DELETE FROM session_fts WHERE rowid = ?').run(card.rowid);
    db.prepare('DELETE FROM session_cards WHERE rowid = ?').run(card.rowid);
  }
  db.prepare('DELETE FROM session_message_fts WHERE rowid IN (SELECT rowid FROM session_messages WHERE session_id = ?)').run(sessionId);
  db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM candidates WHERE source_session_id = ?').run(sessionId);
}

function deleteSessionMessagesFromSeq(db, sessionId, fromSeq) {
  db.prepare(`DELETE FROM session_message_fts WHERE rowid IN (
    SELECT rowid FROM session_messages WHERE session_id = ? AND seq >= ?
  )`).run(sessionId, fromSeq);
  db.prepare('DELETE FROM session_messages WHERE session_id = ? AND seq >= ?').run(sessionId, fromSeq);
}

function insertCardMessages(db, sessionId, messages) {
  const insertMessage = db.prepare(`INSERT OR REPLACE INTO session_messages(session_id, seq, role, message_id, created_at, text)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insertMessageTerms = db.prepare('INSERT INTO session_message_fts(rowid, requests, replies) VALUES (?, ?, ?)');
  const existingMessage = db.prepare('SELECT rowid FROM session_messages WHERE session_id = ? AND seq = ?');
  const deleteMessageTerms = db.prepare('DELETE FROM session_message_fts WHERE rowid = ?');
  for (const msg of messages) {
    const previous = existingMessage.get(sessionId, msg.seq);
    if (previous) deleteMessageTerms.run(previous.rowid);
    const { lastInsertRowid } = insertMessage.run(
      sessionId, msg.seq, msg.role, msg.messageId, msg.createdAt, msg.text,
    );
    const encoded = termsForIndex(msg.text);
    insertMessageTerms.run(
      lastInsertRowid,
      msg.role === 'user' ? encoded : '',
      msg.role === 'assistant' ? encoded : '',
    );
  }
}

/**
 * Incrementally apply Session discovery changes in a single transaction.
 * Untouched Sessions stay persisted without rewriting their messages or FTS rows.
 */
export function applyDailyIndexUpdates(db, {
  upserts = [],
  removedSessionIds = [],
  automatic = [],
  now,
  root = null,
  force = false,
  markIndexed = true,
} = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const indexedAt = discoveryIndexedAt(db);
    if (!force && indexedAt !== null && now >= indexedAt && now - indexedAt < DAY_MS) {
      db.exec('ROLLBACK');
      return false;
    }
    const insertCard = db.prepare(`INSERT INTO session_cards(
      session_id, title, work_dir, active_at, deletion_generation, fresh_at, transcript_signature, last_seq, message_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateCard = db.prepare(`UPDATE session_cards
      SET title = ?, work_dir = ?, active_at = ?, deletion_generation = ?, fresh_at = ?, transcript_signature = ?, last_seq = ?, message_count = ?
      WHERE rowid = ?`);
    const selectCard = db.prepare('SELECT rowid FROM session_cards WHERE session_id = ?');
    const deleteCardTerms = db.prepare('DELETE FROM session_fts WHERE rowid = ?');
    const insertCardTerms = db.prepare('INSERT INTO session_fts(rowid, title, work_dir) VALUES (?, ?, ?)');
    const insertCandidate = db.prepare('INSERT OR IGNORE INTO candidates VALUES (?, ?, ?, ?, ?, ?)');

    for (const sessionId of removedSessionIds) {
      deleteSessionFromIndex(db, sessionId);
    }

    for (const card of upserts) {
      if (card.mode === 'replace') {
        deleteSessionFromIndex(db, card.sessionId);
        const { lastInsertRowid } = insertCard.run(
          card.sessionId, card.title, card.workDir, card.activeAt, card.deletionGeneration,
          card.freshAt, card.transcriptSignature || '', card.lastSeq, card.messageCount,
        );
        insertCardTerms.run(lastInsertRowid, termsForIndex(card.title), termsForIndex(card.workDir));
      } else {
        const existing = selectCard.get(card.sessionId);
        if (existing) {
          updateCard.run(
            card.title, card.workDir, card.activeAt, card.deletionGeneration,
            card.freshAt, card.transcriptSignature || '', card.lastSeq, card.messageCount, existing.rowid,
          );
          deleteCardTerms.run(existing.rowid);
          insertCardTerms.run(existing.rowid, termsForIndex(card.title), termsForIndex(card.workDir));
          if (Number.isFinite(card.pruneFromSeq)) {
            deleteSessionMessagesFromSeq(db, card.sessionId, card.pruneFromSeq);
          }
        } else {
          const { lastInsertRowid } = insertCard.run(
            card.sessionId, card.title, card.workDir, card.activeAt, card.deletionGeneration,
            card.freshAt, card.transcriptSignature || '', card.lastSeq, card.messageCount,
          );
          insertCardTerms.run(lastInsertRowid, termsForIndex(card.title), termsForIndex(card.workDir));
        }
      }
      if (card.messages?.length) insertCardMessages(db, card.sessionId, card.messages);
      for (const item of card.candidates || []) {
        insertCandidate.run(
          candidateId(card.sessionId, item.body), card.sessionId, item.sourceMessageId,
          item.title, item.body, item.createdAt,
        );
      }
    }

    if (root) updateAutomaticAgreements(db, root, automatic);
    if (markIndexed) {
      db.prepare('INSERT OR REPLACE INTO index_state VALUES (1, ?)').run(now);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function localSessionDirs(root, read, allowed = null) {
  const base = join(resolve(root), 'sessions');
  const dirs = new Map();
  try {
    if (!lstatSync(base).isDirectory()) return dirs;
    const manifest = JSON.parse(read(join(root, 'sessions-manifest.json')) || '{}');
    if (manifest.version !== 1 || !Array.isArray(manifest.sessions)) return dirs;
    const seen = new Set();
    for (const row of manifest.sessions) {
      const { id, path } = row || {};
      if (typeof id !== 'string' || typeof path !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(id)) continue;
      if (allowed && !allowed.has(id)) continue;
      if (seen.has(id)) { dirs.delete(id); continue; }
      seen.add(id);
      const dir = join(base, id);
      if (resolve(path) !== dir) continue;
      try { if (lstatSync(dir).isDirectory()) dirs.set(id, dir); } catch { /* missing/archived/transient */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return dirs;
}

function hasSessionIndexSchema(db) {
  return tableExists(db, 'session_cards')
    && tableExists(db, 'session_fts')
    && tableExists(db, 'session_messages')
    && tableExists(db, 'session_message_fts');
}

function compareNumericFileNames(a, b, prefixLength, suffixLength) {
  const numA = Number.parseInt(a.slice(prefixLength, a.length - suffixLength), 10);
  const numB = Number.parseInt(b.slice(prefixLength, b.length - suffixLength), 10);
  return numA - numB || a.localeCompare(b);
}

// A clear/recreation replaces the transcript stream ID. Turn deletion has a
// separate durable journal and invalidates derived text immediately, without
// scheduling a second index pass. Normal appends do not change either fence.
export function readSourceFence(root, sessionId, read, { includeSignature = false, list = null } = {}) {
  const sessionsDir = join(root, 'sessions');
  const dir = join(sessionsDir, sessionId);
  const conversation = join(dir, 'conversation');
  const date = path => {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() || stat.isFile() ? stat.mtimeMs : 0;
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  if (!lstatSync(sessionsDir).isDirectory() || !lstatSync(dir).isDirectory() || !lstatSync(conversation).isDirectory()) return null;
  const metaRaw = read(join(dir, 'session.json')) ?? read(join(dir, 'group.json'));
  if (!metaRaw) return null;
  const meta = JSON.parse(metaRaw);
  if (meta?.id !== sessionId) return null;
  const rawLineage = read(join(conversation, 'lineage.json'));
  if (rawLineage === null) return null;
  const lineage = rawLineage && JSON.parse(rawLineage);
  if (rawLineage && (typeof lineage?.streamId !== 'string' || !lineage.streamId || lineage.streamId.length > 256)) return null;
  const journal = readSessionTurnDeletions(root, sessionId, read);
  if (!journal) return null;
  const operations = journal.operations;
  const tail = operations.at(-1);
  const legacyTimes = lineage ? null : ['segments', 'messages', 'cold'].map(name => date(join(conversation, name)));
  const sourceIdentity = [meta.createdAt || '', lineage?.streamId || legacyTimes];
  const identity = JSON.stringify(sourceIdentity);
  const key = JSON.stringify([...sourceIdentity, operations.length, tail?.deletionId || tail?.turnId || null]);
  const freshAt = Math.max(...['index.json', 'segments', 'messages', 'cold'].map(name => date(join(conversation, name))));
  let transcriptSignature = '';
  if (includeSignature) {
    const boundedList = list || createAgentHistoryScan(root, {}).list;
    const parts = [];
    const indexRaw = read(join(conversation, 'index.json'));
    let parsedIndex = false;
    if (indexRaw) {
      try {
        const idx = JSON.parse(indexRaw);
        let segSignature = null;
        const lastSeg = Array.isArray(idx?.segments) ? idx.segments.at(-1) : null;
        if (lastSeg?.file && /^\d+\.jsonl$/u.test(lastSeg.file)) {
          try {
            const st = lstatSync(join(conversation, 'segments', lastSeg.file));
            if (st.isFile()) segSignature = [st.size, Math.floor(st.mtimeMs)];
          } catch { /* ignore */ }
        }
        parts.push([
          'idx',
          idx?.totalMessages ?? null,
          idx?.nextSeq ?? null,
          idx?.revision ?? null,
          lastSeg?.file ?? null,
          lastSeg?.lastSeq ?? null,
          lastSeg?.bytes ?? null,
          segSignature,
        ]);
        parsedIndex = true;
      } catch { /* fallback to directory scan below */ }
    }
    if (!parsedIndex) {
      // No usable index.json (e.g. legacy or test fixture writing segments directly):
      // stat the highest-numbered segment so in-place appends change the signature.
      try {
        const segDir = join(conversation, 'segments');
        const files = (boundedList(segDir, '.jsonl') || [])
          .filter(name => /^\d+\.jsonl$/u.test(name))
          .sort((a, b) => compareNumericFileNames(a, b, 0, 6));
        const latest = files.at(-1);
        if (latest) {
          const stat = lstatSync(join(segDir, latest));
          if (stat.isFile()) parts.push(['seg', files.length, latest, stat.size, Math.floor(stat.mtimeMs)]);
        }
      } catch { /* ignore */ }
    }
    // Always include legacy markdown directories when present so edits to legacy
    // files are never masked by an existing index.json.
    for (const kind of ['messages', 'cold']) {
      try {
        const dirPath = join(conversation, kind);
        if (date(dirPath) === 0) continue;
        const files = (boundedList(dirPath, '.md') || [])
          .filter(name => /^m\d+\.md$/u.test(name))
          .sort((a, b) => compareNumericFileNames(a, b, 1, 3));
        const latest = files.at(-1);
        if (latest) {
          const stat = lstatSync(join(dirPath, latest));
          if (stat.isFile()) parts.push([kind, files.length, latest, stat.size, Math.floor(stat.mtimeMs)]);
        }
      } catch { /* ignore */ }
    }
    if (parts.length > 0) transcriptSignature = JSON.stringify(parts);
  }
  return { key, identity, streamId: lineage?.streamId, freshAt, transcriptSignature, meta, operations };
}

function liveCards(root) {
  const { read } = createAgentHistoryScan(root, {});
  const dirs = localSessionDirs(root, read);
  const cache = new Map();
  return (sessionId, deletionGeneration) => {
    if (!dirs.has(sessionId)) return false;
    if (!cache.has(sessionId)) {
      let generation = null;
      try { generation = readSourceFence(root, sessionId, read)?.key || null; } catch { /* fail closed */ }
      cache.set(sessionId, generation);
    }
    return cache.get(sessionId) === deletionGeneration;
  };
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function boundedSlice(text, start, end) {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  if (s > 0 && isLowSurrogate(text.charCodeAt(s)) && isHighSurrogate(text.charCodeAt(s - 1))) s += 1;
  e = Math.min(e, s + MAX_PREVIEW_CHARS);
  if (e < text.length && isLowSurrogate(text.charCodeAt(e)) && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  if (e < s) e = s;
  return `${s > 0 ? '…' : ''}${text.slice(s, e)}${e < text.length ? '…' : ''}`;
}

function snippetFromText(text, query) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const terms = lexicalRuns(query).map(run => run.chars.join(''));
  const normalized = clean.normalize('NFKC').toLowerCase();
  const hits = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const offset = hits.length > 0 ? Math.max(0, Math.min(...hits) - 48) : 0;
  return boundedSlice(clean, offset, offset + MAX_PREVIEW_CHARS);
}

function latestSessionText(db, sessionId) {
  return db.prepare('SELECT text FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId)?.text || '';
}

export function getRecentSessionMessagesFromIndex(db, sessionId, limit = 4) {
  if (!hasSessionIndexSchema(db)) return [];
  const bounded = Math.max(1, Math.min(12, Math.floor(Number(limit) || 4)));
  const rows = db.prepare(
    'SELECT role, text, created_at FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
  ).all(sessionId, bounded);
  return rows.reverse().map(row => ({
    role: row.role,
    text: String(row.text || '').slice(0, 600),
    createdAt: row.created_at,
  }));
}

function resolveWindowCutoff(options, now) {
  if (!options) return null;
  if (Number.isFinite(options.activeWindowMs) && options.activeWindowMs > 0) return now - options.activeWindowMs;
  if (Number.isFinite(options.activeWindowDays) && options.activeWindowDays > 0) return now - options.activeWindowDays * DAY_MS;
  return null;
}

/**
 * Search persisted Session cards and complete User / final Assistant messages.
 * Defaults to searching all indexed Sessions authorized by `allowedIds`.
 * Pass `activeWindowDays` / `activeWindowMs` (e.g. 5 days) to restrict results
 * to recently active Sessions for automatic routing / new UI flows.
 */
export function searchDiscovery(db, root, allowedIds, query, now = Date.now(), options = {}) {
  const indexedAt = tableExists(db, 'index_state') ? discoveryIndexedAt(db) : null;
  const clauses = lexicalTermClauses(query);
  const match = clauses.join(' AND ');
  const results = [];
  if (!match || !Array.isArray(allowedIds) || allowedIds.length === 0 || !hasSessionIndexSchema(db)) {
    return { indexedAt, results };
  }
  const limit = Math.max(1, Math.min(SEARCH_LIMIT, Math.floor(Number(options?.limit) || SEARCH_LIMIT)));
  const cutoff = resolveWindowCutoff(options, now);
  const allowedJson = JSON.stringify(allowedIds);
  const live = liveCards(root);
  const bestBySession = new Map();

  const recordCandidate = (sessionId, row, rank, matchedText) => {
    if (!live(sessionId, row.deletion_generation)) return;
    const existing = bestBySession.get(sessionId);
    if (!existing) {
      bestBySession.set(sessionId, {
        sessionId,
        title: row.title,
        workDir: row.work_dir,
        activeAt: row.active_at,
        deletionGeneration: row.deletion_generation,
        rank,
        matchedText,
      });
      return;
    }
    if (rank < existing.rank) {
      existing.rank = rank;
      if (matchedText) existing.matchedText = matchedText;
    } else if (!existing.matchedText && matchedText) {
      existing.matchedText = matchedText;
    }
  };

  // 1. Direct metadata hits (all terms in title/work_dir).
  for (const row of db.prepare(`SELECT c.session_id, c.title, c.work_dir, c.active_at, c.deletion_generation,
      bm25(session_fts, 9.0, 3.0) AS rank
    FROM session_fts
    JOIN session_cards c ON session_fts.rowid = c.rowid
    WHERE session_fts MATCH ?
      AND (? IS NULL OR c.active_at >= ?)
      AND c.session_id IN (SELECT value FROM json_each(?))
    ORDER BY rank, c.active_at DESC, c.session_id
    LIMIT ?`).iterate(match, cutoff, cutoff, allowedJson, limit * 4)) {
    // Metadata match gets a strong priority boost over body-only hits.
    recordCandidate(row.session_id, row, Number(row.rank) - 4.0, null);
  }

  // 2. Direct single-message hits (all terms within one complete user/assistant message).
  for (const row of db.prepare(`SELECT c.session_id, c.title, c.work_dir, c.active_at, c.deletion_generation,
      m.text AS matched_text,
      bm25(session_message_fts, 2.0, 1.0) AS rank
    FROM session_message_fts
    JOIN session_messages m ON session_message_fts.rowid = m.rowid
    JOIN session_cards c ON c.session_id = m.session_id
    WHERE session_message_fts MATCH ?
      AND (? IS NULL OR c.active_at >= ?)
      AND c.session_id IN (SELECT value FROM json_each(?))
    ORDER BY rank, c.active_at DESC, m.seq DESC
    LIMIT ?`).iterate(match, cutoff, cutoff, allowedJson, limit * 8)) {
    recordCandidate(row.session_id, row, Number(row.rank), row.matched_text);
  }

  // 3. Cross-message / title+message multi-term intersection: when a query has
  // multiple terms spanning different messages or title + message in the same Session.
  // Deduplicate per Session inside SQL so a single chatty Session cannot starve others.
  if (clauses.length > 1 && bestBySession.size < limit * 2) {
    let intersected = null;
    const sampleTextBySession = new Map();
    const metaTermStmt = db.prepare(`SELECT c.session_id, c.title, c.work_dir, c.active_at, c.deletion_generation
      FROM session_fts
      JOIN session_cards c ON session_fts.rowid = c.rowid
      WHERE session_fts MATCH ?
        AND (? IS NULL OR c.active_at >= ?)
        AND c.session_id IN (SELECT value FROM json_each(?))
      ORDER BY c.active_at DESC, c.session_id
      LIMIT ?`);
    const msgTermStmt = db.prepare(`SELECT session_id, title, work_dir, active_at, deletion_generation, matched_text
      FROM (
        SELECT c.session_id, c.title, c.work_dir, c.active_at, c.deletion_generation,
          m.text AS matched_text,
          ROW_NUMBER() OVER (PARTITION BY c.session_id ORDER BY m.seq DESC) AS rn
        FROM session_message_fts
        JOIN session_messages m ON session_message_fts.rowid = m.rowid
        JOIN session_cards c ON c.session_id = m.session_id
        WHERE session_message_fts MATCH ?
          AND (? IS NULL OR c.active_at >= ?)
          AND c.session_id IN (SELECT value FROM json_each(?))
      )
      WHERE rn = 1
      ORDER BY active_at DESC, session_id
      LIMIT ?`);
    for (const clause of clauses) {
      const matchedThisClause = new Map();
      for (const row of metaTermStmt.iterate(clause, cutoff, cutoff, allowedJson, limit * 16)) {
        matchedThisClause.set(row.session_id, row);
      }
      for (const row of msgTermStmt.iterate(clause, cutoff, cutoff, allowedJson, limit * 16)) {
        if (!matchedThisClause.has(row.session_id)) matchedThisClause.set(row.session_id, row);
        if (!sampleTextBySession.has(row.session_id)) sampleTextBySession.set(row.session_id, row.matched_text);
      }
      if (intersected === null) {
        intersected = matchedThisClause;
      } else {
        for (const id of intersected.keys()) {
          if (!matchedThisClause.has(id)) intersected.delete(id);
        }
      }
      if (intersected.size === 0) break;
    }
    if (intersected) {
      for (const [sessionId, row] of intersected) {
        if (!bestBySession.has(sessionId)) {
          // Cross-message match ranks below single-message / metadata matches.
          recordCandidate(sessionId, row, 1.0, sampleTextBySession.get(sessionId) ?? null);
        }
      }
    }
  }

  const ordered = [...bestBySession.values()].sort((a, b) => (
    a.rank - b.rank || b.activeAt - a.activeAt || a.sessionId.localeCompare(b.sessionId)
  ));

  for (const candidate of ordered) {
    const text = candidate.matchedText ?? latestSessionText(db, candidate.sessionId);
    results.push({
      sessionId: candidate.sessionId,
      title: candidate.title,
      snippet: snippetFromText(text, query),
      activeAt: candidate.activeAt,
    });
    if (results.length >= limit) break;
  }
  return { indexedAt, results };
}

/**
 * List recently active Session cards authorized by `allowedIds`.
 * Intended for new-UI active Session routing (default 5-day window + owner scope).
 */
export function listActiveSessionCards(db, root, allowedIds, now = Date.now(), {
  activeWindowMs = ACTIVE_WINDOW_MS,
  activeWindowDays = null,
  limit = ACTIVE_CARDS_LIMIT,
} = {}) {
  const indexedAt = tableExists(db, 'index_state') ? discoveryIndexedAt(db) : null;
  const cards = [];
  if (!Array.isArray(allowedIds) || allowedIds.length === 0 || !hasSessionIndexSchema(db)) {
    return { indexedAt, cards };
  }
  const cutoff = resolveWindowCutoff({ activeWindowMs, activeWindowDays }, now) ?? (now - ACTIVE_WINDOW_MS);
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || ACTIVE_CARDS_LIMIT)));
  const live = liveCards(root);
  for (const row of db.prepare(`SELECT session_id, title, work_dir, active_at, deletion_generation, message_count
    FROM session_cards
    WHERE active_at >= ?
      AND session_id IN (SELECT value FROM json_each(?))
    ORDER BY active_at DESC, session_id`).iterate(cutoff, JSON.stringify(allowedIds))) {
    if (!live(row.session_id, row.deletion_generation)) continue;
    cards.push({
      sessionId: row.session_id,
      title: row.title,
      workDir: row.work_dir,
      activeAt: row.active_at,
      messageCount: row.message_count,
      preview: snippetFromText(latestSessionText(db, row.session_id), ''),
    });
    if (cards.length >= boundedLimit) break;
  }
  return { indexedAt, cards };
}

// Missing or changed lineage invalidates the entire source. Ordinary appends
// do not affect an already collected rule. A turn deletion only invalidates
// agreements derived from that deleted turn.
function automaticSourceChecker(root, allowed, telemetry = {}, signal) {
  const { read, stopped } = createAgentHistoryScan(root, telemetry, signal);
  const dirs = localSessionDirs(root, read, allowed);
  const cache = new Map();
  return row => {
    if (stopped() || telemetry.scanIncomplete) return null;
    const id = row.source_session_id;
    if (!dirs.has(id)) return false;
    if (!cache.has(id)) {
      try {
        const source = readSourceFence(root, id, read);
        cache.set(id, source ? { identity: source.identity,
          anchors: new Set(source.operations.flatMap(op => op.anchorMessageIds)),
          scrub: sessionDeletionProjection(source.operations).scrub } : null);
      } catch { cache.set(id, null); }
    }
    if (telemetry.scanIncomplete) return null;
    const source = cache.get(id);
    if (!source || source.identity !== row.source_identity) return false;
    const ref = JSON.parse(row.source_ref);
    return !source.anchors.has(ref.id) && Boolean(source.scrub(ref));
  };
}

function updateAutomaticAgreements(db, root, automatic) {
  const existing = db.prepare('SELECT id, source_session_id, source_identity, source_ref FROM automatic_agreements').all();
  const checkSource = automaticSourceChecker(root, new Set(existing.map(row => row.source_session_id)));
  const remove = db.prepare('DELETE FROM automatic_agreements WHERE id = ?');
  for (const row of existing) {
    const live = checkSource(row);
    if (live === null) break; // Unreadable due to a budget, not evidence of deletion.
    if (!live) remove.run(row.id);
  }
  const insert = db.prepare('INSERT OR IGNORE INTO automatic_agreements VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const { sessionId, sourceIdentity, ref, title, body, createdAt } of automatic) {
    const id = `automatic_${createHash('sha256').update(JSON.stringify([sessionId, sourceIdentity, ref.id])).digest('hex')}`;
    insert.run(id, sessionId, sourceIdentity, JSON.stringify(ref), title, body, createdAt);
  }
  db.prepare(`DELETE FROM automatic_agreements WHERE id IN (
    SELECT id FROM automatic_agreements ORDER BY created_at DESC, id LIMIT -1 OFFSET ?
  )`).run(AUTOMATIC_LIMIT);
}

function searchAutomaticAgreements(db, root, allowedIds, { keyword = '', limit = AUTOMATIC_LIST_LIMIT,
  sessionId, beforeSeq, telemetry = {}, signal, seen = new Set() } = {}) {
  if (!db || !allowedIds.length || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'automatic_agreements'").get()) return [];
  const live = automaticSourceChecker(root, new Set(allowedIds), telemetry, signal);
  const terms = normalize(keyword).split(/\s+/u).filter(Boolean);
  const results = [];
  for (const row of db.prepare(`SELECT * FROM automatic_agreements
    WHERE source_session_id IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC, id`).iterate(JSON.stringify(allowedIds))) {
    if (signal?.aborted || telemetry.scanIncomplete) break;
    const body = normalize(row.body);
    if (seen.has(body) || !terms.every(term => body.includes(term))) continue;
    const { id: messageId } = JSON.parse(row.source_ref);
    if (row.source_session_id === sessionId && Number.isFinite(beforeSeq) && parseSeqFromId(messageId) >= beforeSeq) continue;
    if (!live(row)) continue;
    seen.add(body);
    results.push(sharedItem({ ...row, source_message_id: messageId }, 'automatic'));
    if (results.length >= Math.min(AUTOMATIC_LIST_LIMIT, limit)) break;
  }
  return results;
}

function sharedItem(row, status) {
  return {
    id: row.id, kind: row.kind || 'consensus', status, title: row.title, body: row.body,
    sourceSessionId: row.source_session_id, sourceMessageId: row.source_message_id,
    createdAt: row.created_at, updatedAt: row.updated_at ?? row.created_at,
  };
}

/** Query saved copies only for the authenticated owner. Automatic entries are
 * instead fenced by the host-approved IDs and by their live transcript source. */
export function searchShare(db, root, ownerId, allowedIds, options) {
  const { keyword, limit, signal } = options;
  if (!db || signal?.aborted) return [];
  const allowed = new Set(allowedIds);
  const terms = normalize(keyword).split(/\s+/u).filter(Boolean);
  const seen = new Set();
  const items = [];
  if (typeof ownerId === 'string' && ownerId && tableExists(db, 'share_items')) {
    for (const row of db.prepare('SELECT * FROM share_items WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT ?')
      .iterate(ownerId, PUBLISHED_LIMIT)) {
      if (signal?.aborted) break;
      const body = normalize(row.body);
      const text = `${normalize(row.title)} ${body}`;
      if (seen.has(body) || !terms.every(term => text.includes(term))) continue;
      seen.add(body);
      const item = sharedItem(row, 'published');
      if (!allowed.has(item.sourceSessionId)) item.sourceSessionId = item.sourceMessageId = null;
      items.push(item);
      if (items.length >= limit) break;
    }
  }
  return [...items, ...searchAutomaticAgreements(db, root, allowedIds, { ...options, seen })]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit);
}

function* liveCandidates(db, root, ownerId, allowedIds, now, id = null) {
  const live = liveCards(root);
  for (const row of db.prepare(`SELECT p.*, c.deletion_generation FROM candidates p
    JOIN session_cards c ON p.source_session_id = c.session_id
    WHERE (? IS NULL OR p.id = ?) AND c.active_at >= ?
      AND c.session_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM share_items s WHERE s.owner_id = ? AND s.id = p.id)
      AND NOT EXISTS (SELECT 1 FROM share_tombstones d WHERE d.owner_id = ? AND d.id = p.id)
    ORDER BY p.created_at DESC, p.id`).iterate(id, id, now - ACTIVE_WINDOW_MS, JSON.stringify(allowedIds), ownerId, ownerId)) {
    if (live(row.source_session_id, row.deletion_generation)) yield row;
  }
}

export function listShare(db, root, ownerId, allowedIds, now = Date.now()) {
  const published = db.prepare('SELECT * FROM share_items WHERE owner_id = ? ORDER BY updated_at DESC, id').all(ownerId);
  const items = published.map(row => sharedItem(row, 'published'));
  const seen = new Set(published.filter(row => row.kind === 'consensus').map(row => row.body.normalize('NFKC').toLowerCase()));
  let added = 0;
  for (const row of liveCandidates(db, root, ownerId, allowedIds, now)) {
    const key = row.body.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(sharedItem(row, 'candidate'));
    if (++added >= CANDIDATE_LIMIT) break;
  }
  return { items };
}

export function changeShare(db, root, ownerId, allowedIds, op, payload, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = payload.id || payload.createId;
    const previous = db.prepare('SELECT * FROM share_items WHERE owner_id = ? AND id = ?').get(ownerId, id);
    const candidate = !previous && id.startsWith('candidate_')
      ? [...liveCandidates(db, root, ownerId, allowedIds, now, id)][0] : null;
    const source = previous || candidate;
    let result = {};
    if (op === 'share_delete') {
      if (source && (source.updated_at ?? source.created_at) !== payload.expectedUpdatedAt) throw new Error('Shared item changed');
      if (previous) db.prepare('DELETE FROM share_items WHERE owner_id = ? AND id = ?').run(ownerId, id);
      if (source) db.prepare('INSERT OR IGNORE INTO share_tombstones VALUES (?,?)').run(ownerId, id);
    } else {
      if (payload.createId && previous) {
        if (previous.kind !== payload.kind || previous.title !== payload.title || previous.body !== payload.body) {
          throw new Error('Shared create identity was already used with different content');
        }
        db.exec('COMMIT');
        return { item: sharedItem(previous, 'published') };
      }
      if (payload.id && (!source || (source.updated_at ?? source.created_at) !== payload.expectedUpdatedAt)) throw new Error('Shared item changed');
      if (db.prepare('SELECT 1 FROM share_tombstones WHERE owner_id = ? AND id = ?').get(ownerId, id)) throw new Error('Shared item was deleted');
      if (!previous && db.prepare('SELECT COUNT(*) AS n FROM share_items WHERE owner_id = ?').get(ownerId).n >= PUBLISHED_LIMIT) {
        throw new Error('Share area is full');
      }
      const row = db.prepare(`INSERT INTO share_items VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id, id) DO UPDATE SET kind=excluded.kind, title=excluded.title,
          body=excluded.body, updated_at=excluded.updated_at RETURNING *`).get(
        ownerId, id, payload.kind, payload.title, payload.body, source?.source_session_id ?? null,
        source?.source_message_id ?? null, source?.created_at ?? now, Math.max(now, (source?.updated_at ?? source?.created_at ?? 0) + 1));
      result = { item: sharedItem(row, 'published') };
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
