/**
 * memory/index-db.js — DESIGN-H2-AMS §4. SQLite + FTS5 segment index.
 *
 * Source of truth: on-disk `~/.yeaft/memory/<scope>/memory.md` files.
 * SQLite is a derived index — rebuildable from disk at any time.
 *
 * Schema is created idempotently; opening an older DB without the
 * required tables triggers a fresh CREATE. A version PRAGMA guards
 * against silent schema drift.
 *
 * Uses node:sqlite (Node 22.5+ built-in). Synchronous API — fine for
 * our workload (10k segments, single-process agent).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

const DDL = [
  `PRAGMA journal_mode = WAL;`,
  `PRAGMA synchronous = NORMAL;`,
  `PRAGMA foreign_keys = ON;`,

  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS memory_segments (
     id          TEXT PRIMARY KEY,
     scope       TEXT NOT NULL,
     kind        TEXT NOT NULL,
     tags        TEXT NOT NULL DEFAULT '[]',
     body        TEXT NOT NULL,
     source_msgs TEXT NOT NULL DEFAULT '[]',
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );`,

  `CREATE INDEX IF NOT EXISTS idx_segments_scope
     ON memory_segments(scope);`,

  `CREATE INDEX IF NOT EXISTS idx_segments_updated
     ON memory_segments(updated_at DESC);`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     body, tags, scope,
     content='memory_segments',
     content_rowid='rowid',
     tokenize='unicode61 remove_diacritics 2'
   );`,

  `CREATE TRIGGER IF NOT EXISTS seg_ai AFTER INSERT ON memory_segments BEGIN
     INSERT INTO memory_fts(rowid, body, tags, scope)
     VALUES (new.rowid, new.body, new.tags, new.scope);
   END;`,

  `CREATE TRIGGER IF NOT EXISTS seg_au AFTER UPDATE ON memory_segments BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, body, tags, scope)
     VALUES('delete', old.rowid, old.body, old.tags, old.scope);
     INSERT INTO memory_fts(rowid, body, tags, scope)
     VALUES (new.rowid, new.body, new.tags, new.scope);
   END;`,

  `CREATE TRIGGER IF NOT EXISTS seg_ad AFTER DELETE ON memory_segments BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, body, tags, scope)
     VALUES('delete', old.rowid, old.body, old.tags, old.scope);
   END;`,
];

/**
 * Open (or create) the segment index DB. Returns a thin handle with
 * the operations the rest of the memory layer needs. The handle owns
 * the underlying DatabaseSync; call `.close()` when done.
 *
 * @param {string} dbPath  Absolute path to the .db file.
 * @returns {SegmentIndex}
 */
export function openSegmentIndex(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  for (const stmt of DDL) db.exec(stmt);

  // Version check / set
  const cur = db.prepare('SELECT value FROM schema_meta WHERE key=?').get('schema_version');
  if (!cur) {
    db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)')
      .run('schema_version', String(SCHEMA_VERSION));
  } else if (cur.value !== String(SCHEMA_VERSION)) {
    // For now, simple drop-and-recreate. v2 may add migrations.
    db.exec('DROP TABLE IF EXISTS memory_fts');
    db.exec('DROP TABLE IF EXISTS memory_segments');
    db.exec('DELETE FROM schema_meta');
    for (const stmt of DDL) db.exec(stmt);
    db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  return makeHandle(db);
}

/**
 * @typedef {object} SegmentIndex
 * @property {(seg: import('./segment.js').Segment) => void} upsert
 * @property {(ids: string[]) => void} deleteMany
 * @property {(scope: string) => void} deleteScope
 * @property {(id: string) => import('./segment.js').Segment | null} get
 * @property {(scope: string) => import('./segment.js').Segment[]} listByScope
 * @property {(opts: SearchOpts) => SearchHit[]} search
 * @property {() => number} count
 * @property {() => void} close
 * @property {DatabaseSync} _db   exposed for tests / advanced ops
 */

/**
 * @typedef {object} SearchOpts
 * @property {string}        query        FTS5 MATCH expression
 * @property {string[]=}     scopeFilter  if set, restrict to these scopes
 * @property {number=}       limit        default 50
 */

/**
 * @typedef {object} SearchHit
 * @property {string} id
 * @property {string} scope
 * @property {string} kind
 * @property {string[]} tags
 * @property {string} body
 * @property {string[]} sourceMessages
 * @property {number} rank        bm25 (lower = better)
 * @property {number} createdAt
 * @property {number} updatedAt
 */

function makeHandle(db) {
  const stmtUpsert = db.prepare(`
    INSERT INTO memory_segments(id, scope, kind, tags, body, source_msgs, created_at, updated_at)
    VALUES (@id, @scope, @kind, @tags, @body, @sourceMsgs, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      scope=excluded.scope,
      kind=excluded.kind,
      tags=excluded.tags,
      body=excluded.body,
      source_msgs=excluded.source_msgs,
      updated_at=excluded.updated_at
  `);
  const stmtDeleteOne = db.prepare('DELETE FROM memory_segments WHERE id=?');
  const stmtDeleteScope = db.prepare('DELETE FROM memory_segments WHERE scope=?');
  const stmtGet = db.prepare('SELECT * FROM memory_segments WHERE id=?');
  const stmtListByScope = db.prepare(
    'SELECT * FROM memory_segments WHERE scope=? ORDER BY created_at ASC',
  );
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM memory_segments');

  return {
    _db: db,

    upsert(seg) {
      stmtUpsert.run({
        id: seg.id,
        scope: seg.scope,
        kind: seg.kind,
        tags: JSON.stringify(seg.tags || []),
        body: seg.body,
        sourceMsgs: JSON.stringify(seg.sourceMessages || []),
        createdAt: toEpochMs(seg.createdAt),
        updatedAt: toEpochMs(seg.updatedAt),
      });
    },

    deleteMany(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const tx = db.prepare('BEGIN');
      tx.run();
      try {
        for (const id of ids) stmtDeleteOne.run(id);
        db.prepare('COMMIT').run();
      } catch (err) {
        db.prepare('ROLLBACK').run();
        throw err;
      }
    },

    deleteScope(scope) { stmtDeleteScope.run(scope); },

    get(id) {
      const row = stmtGet.get(id);
      return row ? rowToSegment(row) : null;
    },

    listByScope(scope) {
      return stmtListByScope.all(scope).map(rowToSegment);
    },

    /**
     * @param {SearchOpts} opts
     * @returns {SearchHit[]}
     */
    search(opts) {
      const limit = Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.min(500, Math.floor(opts.limit)) : 50;
      const scopeFilter = Array.isArray(opts.scopeFilter) && opts.scopeFilter.length > 0
        ? opts.scopeFilter : null;

      // Build the SQL dynamically — scope IN (...) needs N placeholders.
      let sql = `
        SELECT s.*, bm25(memory_fts) AS rank
        FROM memory_fts
        JOIN memory_segments s ON s.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?`;
      const params = [opts.query];
      if (scopeFilter) {
        sql += ` AND s.scope IN (${scopeFilter.map(() => '?').join(',')})`;
        params.push(...scopeFilter);
      }
      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      return rows.map(r => ({
        ...rowToSegment(r),
        rank: r.rank,
      }));
    },

    count() {
      return stmtCount.get().n;
    },

    close() {
      db.close();
    },
  };
}

function rowToSegment(row) {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    tags: safeJsonArr(row.tags),
    body: row.body,
    sourceMessages: safeJsonArr(row.source_msgs),
    createdAt: fromEpochMs(row.created_at),
    updatedAt: fromEpochMs(row.updated_at),
  };
}

function safeJsonArr(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toEpochMs(iso) {
  if (typeof iso === 'number') return iso;
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : Date.now();
}

function fromEpochMs(ms) {
  return new Date(Number(ms) || Date.now()).toISOString();
}
