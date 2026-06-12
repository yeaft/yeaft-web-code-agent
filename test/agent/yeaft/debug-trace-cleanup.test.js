/**
 * debug-trace-cleanup.test.js — disk-growth fix for the always-on trace store.
 *
 * Regression coverage for the 5GB debug.db incident: the always-on trajectory
 * store stamps every turn with the cumulative request/response snapshot (each
 * long-session row is MB-scale), so it must (a) prune aggressively by TTL and
 * (b) actually return freed pages to the OS instead of leaving the file at its
 * historical peak.
 *
 * What we assert:
 *   1. cleanup() defaults to a 10-day TTL (not the old 30) and deletes rows
 *      across all three tables older than the cutoff.
 *   2. New DBs are created with auto_vacuum=INCREMENTAL, so cleanup() shrinks
 *      the on-disk file (page_count drops) after a large delete.
 *   3. cleanup() is a safe no-op-vacuum on a legacy auto_vacuum=NONE DB — it
 *      still deletes rows and never throws.
 *   4. compact() rebuilds a legacy DB, reclaiming space and switching it to
 *      INCREMENTAL going forward.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The original trace_turns schema as it existed BEFORE the group/vp/thread +
 * per-loop-snapshot migration. A real legacy DB has these columns; DebugTrace's
 * constructor adds the newer ones (raw_request, messages_json, …) via
 * migrateAddColumn. SCHEMA also creates indexes on message_id/model/started_at,
 * so those columns must already exist or opening the legacy DB throws.
 */
const LEGACY_TURNS_DDL = `
  CREATE TABLE trace_turns (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    message_id TEXT,
    mode TEXT,
    turn_number INTEGER,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    stop_reason TEXT,
    latency_ms INTEGER,
    response_text TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )
`;

let dbPath;
let trace;

function cleanupFiles(p) {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(p + suffix, { force: true });
  }
}

/** Insert a turn whose started_at is `ageDays` in the past, with a fat payload. */
function insertOldTurn(db, id, ageDays, payloadBytes = 4096) {
  const started = Date.now() - ageDays * DAY_MS;
  const blob = 'x'.repeat(payloadBytes);
  db.prepare(`
    INSERT INTO trace_turns (id, trace_id, started_at, raw_request, raw_response, messages_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, started, blob, blob, blob);
}

beforeEach(() => {
  dbPath = join(tmpdir(), `yeaft-trace-test-${process.pid}-${Math.floor(performance.now())}.db`);
  cleanupFiles(dbPath);
});

afterEach(() => {
  try { trace?.close(); } catch { /* ignore */ }
  trace = null;
  cleanupFiles(dbPath);
});

describe('DebugTrace constructor', () => {
  it('creates new databases with auto_vacuum = INCREMENTAL (2)', () => {
    trace = new DebugTrace(dbPath);
    const probe = new DatabaseSync(dbPath);
    const { auto_vacuum: mode } = probe.prepare('PRAGMA auto_vacuum').get();
    probe.close();
    expect(mode).toBe(2); // 0=NONE, 1=FULL, 2=INCREMENTAL
  });
});

describe('DebugTrace.cleanup', () => {
  it('defaults to a 10-day TTL: deletes rows older than 10 days, keeps newer', () => {
    trace = new DebugTrace(dbPath);
    const db = new DatabaseSync(dbPath);
    insertOldTurn(db, 'old-15d', 15);
    insertOldTurn(db, 'old-11d', 11);
    insertOldTurn(db, 'fresh-2d', 2);
    insertOldTurn(db, 'fresh-now', 0);
    db.close();

    const res = trace.cleanup(); // no arg → default 10 days

    expect(res.deletedTurns).toBe(2); // 15d + 11d

    const probe = new DatabaseSync(dbPath);
    const remaining = probe.prepare('SELECT id FROM trace_turns ORDER BY id').all().map(r => r.id);
    probe.close();
    expect(remaining).toEqual(['fresh-2d', 'fresh-now']);
  });

  it('cascades deletes to trace_tools and trace_events past the cutoff', () => {
    trace = new DebugTrace(dbPath);
    const db = new DatabaseSync(dbPath);
    insertOldTurn(db, 'old-turn', 20);
    db.prepare(`INSERT INTO trace_tools (id, turn_id, tool_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('tool-1', 'old-turn', 'bash', Date.now() - 20 * DAY_MS);
    db.prepare(`INSERT INTO trace_events (id, trace_id, event_type, created_at) VALUES (?, ?, ?, ?)`)
      .run('evt-1', 'old-turn', 'dream_loop', Date.now() - 20 * DAY_MS);
    db.close();

    const res = trace.cleanup(10);
    expect(res.deletedTurns).toBe(1);
    expect(res.deletedTools).toBe(1);
    expect(res.deletedEvents).toBe(1);
  });

  it('honours a custom retention window', () => {
    trace = new DebugTrace(dbPath);
    const db = new DatabaseSync(dbPath);
    insertOldTurn(db, 'd5', 5);
    insertOldTurn(db, 'd1', 1);
    db.close();

    const res = trace.cleanup(3); // keep last 3 days
    expect(res.deletedTurns).toBe(1); // only d5

    const probe = new DatabaseSync(dbPath);
    const remaining = probe.prepare('SELECT id FROM trace_turns').all().map(r => r.id);
    probe.close();
    expect(remaining).toEqual(['d1']);
  });

  it('reclaims on-disk pages after a large delete (incremental_vacuum)', () => {
    trace = new DebugTrace(dbPath);
    const db = new DatabaseSync(dbPath);
    // ~4MB of old rows that will all be pruned.
    for (let i = 0; i < 200; i++) insertOldTurn(db, `old-${i}`, 30, 20 * 1024);
    insertOldTurn(db, 'keep', 0, 1024);

    const pagesBefore = db.prepare('PRAGMA page_count').get().page_count;
    db.close();

    trace.cleanup(10);

    const probe = new DatabaseSync(dbPath);
    const pagesAfter = probe.prepare('PRAGMA page_count').get().page_count;
    probe.close();

    // INCREMENTAL auto_vacuum should hand the freed pages back, so the file's
    // page_count must drop substantially after pruning ~4MB.
    expect(pagesAfter).toBeLessThan(pagesBefore / 2);
  });

  it('does not throw and still deletes on a legacy auto_vacuum=NONE database', () => {
    // Build a legacy DB with auto_vacuum=NONE BEFORE DebugTrace opens it, so
    // the constructor pragma is a no-op (mode change is rejected post-creation).
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA auto_vacuum = NONE');
    legacy.exec(LEGACY_TURNS_DDL);
    legacy.close();

    trace = new DebugTrace(dbPath); // migrates columns onto the legacy table
    const verify = new DatabaseSync(dbPath);
    expect(verify.prepare('PRAGMA auto_vacuum').get().auto_vacuum).toBe(0); // still NONE
    insertOldTurn(verify, 'legacy-old', 40);
    verify.close();

    let res;
    expect(() => { res = trace.cleanup(10); }).not.toThrow();
    expect(res.deletedTurns).toBe(1);
  });
});

describe('DebugTrace.compact', () => {
  it('rebuilds a legacy DB, reclaiming space and switching it to INCREMENTAL', () => {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA auto_vacuum = NONE');
    legacy.exec(LEGACY_TURNS_DDL);
    legacy.close();

    trace = new DebugTrace(dbPath);
    const db = new DatabaseSync(dbPath);
    for (let i = 0; i < 200; i++) insertOldTurn(db, `row-${i}`, 1, 20 * 1024);
    // Delete most rows WITHOUT vacuuming → free pages linger in a NONE db.
    db.prepare(`DELETE FROM trace_turns WHERE id != 'row-0'`).run();
    db.close();

    const { before, after } = trace.compact();
    expect(after).toBeLessThan(before);

    const probe = new DatabaseSync(dbPath);
    expect(probe.prepare('PRAGMA auto_vacuum').get().auto_vacuum).toBe(2); // now INCREMENTAL
    probe.close();
  });
});
