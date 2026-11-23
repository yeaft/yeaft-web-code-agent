import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHistoryScan } from '../conversation/search.js';
import { readSessionTurnDeletions } from '../conversation/turn-deletion-journal.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 5 * DAY_MS;
const SEARCH_LIMIT = 25;
const PUBLISHED_LIMIT = 200;
const CANDIDATE_LIMIT = 25;

export function openDiscoveryStore(root) {
  const dir = join(root, 'session-discovery');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid Discovery storage directory');
  for (const name of ['discovery.db', 'discovery.db-wal', 'discovery.db-shm', 'discovery.db-journal']) {
    try { if (!lstatSync(join(dir, name)).isFile()) throw new Error('Invalid Discovery storage file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(join(dir, 'discovery.db'));
  try {
    db.exec(`
      PRAGMA busy_timeout = 1500;
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS index_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_cards (
        session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, work_dir TEXT NOT NULL,
        passages TEXT NOT NULL, active_at INTEGER NOT NULL, deletion_generation TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(title, work_dir, requests, replies);
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
      CREATE TABLE IF NOT EXISTS share_tombstones (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner_id, id)
      );
    `);
    db.exec("INSERT OR IGNORE INTO session_fts(session_fts, rank) VALUES('secure-delete', 1)");
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
function termsForQuery(text) {
  // Runs only contain letters/numbers/marks, so MATCH syntax is never accepted from the caller.
  return [...new Set(lexicalRuns(text).slice(0, 20).map(({ cjk, chars }) => {
    if (!cjk) return `"${chars.join('')}"*`;
    return `"${chars.length === 1 ? unigram(chars[0]) : bigrams(chars).join(' ')}"`;
  }))].join(' AND ');
}

export function discoveryIndexedAt(db) {
  return db.prepare('SELECT indexed_at FROM index_state WHERE id = 1').get()?.indexed_at ?? null;
}

export function candidateId(sessionId, body) {
  return `candidate_${createHash('sha256').update(JSON.stringify([sessionId, body.normalize('NFKC').toLowerCase()])).digest('hex')}`;
}

export function replaceDailyIndex(db, cards, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const indexedAt = discoveryIndexedAt(db);
    if (indexedAt !== null && now >= indexedAt && now - indexedAt < DAY_MS) {
      db.exec('ROLLBACK');
      return false;
    }
    db.exec('DELETE FROM session_cards; DELETE FROM session_fts; DELETE FROM candidates;');
    const insertCard = db.prepare(`INSERT INTO session_cards(session_id,title,work_dir,passages,active_at,deletion_generation)
      VALUES (?,?,?,?,?,?)`);
    const insertTerms = db.prepare('INSERT INTO session_fts(rowid,title,work_dir,requests,replies) VALUES (?,?,?,?,?)');
    const insertCandidate = db.prepare('INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?,?)');
    for (const card of cards) {
      const { lastInsertRowid } = insertCard.run(card.sessionId, card.title, card.workDir,
        JSON.stringify(card.messages.map(msg => msg.text)), card.activeAt, card.deletionGeneration);
      const textByRole = role => card.messages.filter(msg => msg.role === role).map(msg => termsForIndex(msg.text)).join(' zzpassagebreak ');
      insertTerms.run(lastInsertRowid, termsForIndex(card.title), termsForIndex(card.workDir), textByRole('user'), textByRole('assistant'));
      for (const item of card.candidates) {
        insertCandidate.run(candidateId(card.sessionId, item.body), card.sessionId, item.sourceMessageId,
          item.title, item.body, item.createdAt);
      }
    }
    db.prepare('INSERT OR REPLACE INTO index_state VALUES (1, ?)').run(now);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function expireDailyIndex(db, now) {
  const cutoff = now - ACTIVE_WINDOW_MS;
  if (!db.prepare('SELECT 1 FROM session_cards WHERE active_at < ? LIMIT 1').get(cutoff)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT rowid FROM session_cards WHERE active_at < ?)').run(cutoff);
    db.prepare('DELETE FROM candidates WHERE source_session_id IN (SELECT session_id FROM session_cards WHERE active_at < ?)').run(cutoff);
    db.prepare('DELETE FROM session_cards WHERE active_at < ?').run(cutoff);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function localSessionDirs(root, read) {
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

// A clear/recreation replaces the transcript stream ID. Turn deletion has a
// separate durable journal and invalidates derived text immediately, without
// scheduling a second index pass. Normal appends do not change either fence.
export function readSourceFence(root, sessionId, read) {
  const dir = join(root, 'sessions', sessionId);
  const conversation = join(dir, 'conversation');
  const date = path => {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() || stat.isFile() ? stat.mtimeMs : 0;
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  if (!lstatSync(conversation).isDirectory()) return null;
  const metaRaw = read(join(dir, 'session.json')) ?? read(join(dir, 'group.json'));
  if (!metaRaw) return null;
  const meta = JSON.parse(metaRaw);
  if (meta?.id !== sessionId) return null;
  const rawLineage = read(join(conversation, 'lineage.json'));
  if (rawLineage === null) return null;
  const lineage = rawLineage && JSON.parse(rawLineage);
  if (rawLineage && typeof lineage?.streamId !== 'string') return null;
  const journal = readSessionTurnDeletions(root, sessionId, read);
  if (!journal) return null;
  const operations = journal.operations;
  const tail = operations.at(-1);
  const legacyTimes = lineage ? null : ['segments', 'messages', 'cold'].map(name => date(join(conversation, name)));
  const key = JSON.stringify([meta.createdAt || '', lineage?.streamId || legacyTimes, operations.length, tail?.deletionId || tail?.turnId || null]);
  const freshAt = Math.max(...['index.json', 'segments', 'messages', 'cold'].map(name => date(join(conversation, name))));
  return { key, freshAt, meta, operations };
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

function resultSnippet(passages, query) {
  const terms = lexicalRuns(query).map(run => run.chars.join(''));
  let best = '', bestScore = 0, offset = 0;
  for (const text of passages) {
    const normalized = text.normalize('NFKC').toLowerCase();
    const hits = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
    if (hits.length > bestScore) {
      best = text;
      bestScore = hits.length;
      offset = Math.max(0, Math.min(...hits) - 48);
    }
  }
  if (!best) best = passages[0] || '';
  return `${offset ? '…' : ''}${best.slice(offset, offset + 220)}${best.length > offset + 220 ? '…' : ''}`;
}

export function searchDiscovery(db, root, allowedIds, query, now = Date.now()) {
  const indexedAt = discoveryIndexedAt(db);
  const match = termsForQuery(query);
  const results = [];
  if (!match || allowedIds.length === 0) return { indexedAt, results };
  const live = liveCards(root);
  for (const row of db.prepare(`SELECT c.* FROM session_fts
    JOIN session_cards c ON session_fts.rowid = c.rowid
    WHERE session_fts MATCH ? AND active_at >= ? AND session_id IN (SELECT value FROM json_each(?))
    ORDER BY bm25(session_fts, 9.0, 3.0, 2.0, 1.0), active_at DESC, session_id`).iterate(
    match, now - ACTIVE_WINDOW_MS, JSON.stringify(allowedIds),
  )) {
    if (!live(row.session_id, row.deletion_generation)) continue;
    results.push({ sessionId: row.session_id, title: row.title,
      snippet: resultSnippet(JSON.parse(row.passages), query), activeAt: row.active_at });
    if (results.length >= SEARCH_LIMIT) break;
  }
  return { indexedAt, results };
}

function sharedItem(row, status) {
  return {
    id: row.id, kind: row.kind || 'consensus', status, title: row.title, body: row.body,
    sourceSessionId: row.source_session_id, sourceMessageId: row.source_message_id,
    createdAt: row.created_at, updatedAt: row.updated_at ?? row.created_at,
  };
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
