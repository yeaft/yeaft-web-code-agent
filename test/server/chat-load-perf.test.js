// feat-chat-load-perf: regression tests for the chat-session load path.
//
// Three bottlenecks are covered:
//
//   A. getRecentTurns on sessions with thousands of messages — the new
//      composite (session_id, role, id DESC) index must let SQLite seek
//      directly instead of scanning all session rows and post-filtering
//      role. We exercise this with a real 5000-row session and a per-call
//      wall-time budget that's tight enough to fail loudly if the index
//      regresses but loose enough to survive CI jitter.
//
//   B. bulkAddHistory must not re-run the destructive DELETE + re-INSERT
//      rebuild on every resume. The "tight timestamp range" heuristic is
//      a one-shot repair; without a sentinel, the rebuild's own
//      `ts = lastTs + 1` timestamps re-trip the (< 1000ms) test on every
//      subsequent resume. The sentinel column `sessions.ts_rebuilt_at`
//      guards against repeat runs.
//
// The tail-read fast path for loadSessionHistory is covered separately in
// test/agent/history-tail-read.test.js — it lives in the agent layer, not
// the DB layer.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

let db, sessionDb, messageDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
});

afterAll(() => { cleanupTestDb(); });

describe('feat-chat-load-perf: getRecentTurns composite index', () => {
  it('serves last 5 turns on a 5000-row session within budget', () => {
    const sessionId = 'perf-session';
    sessionDb.create(sessionId, 'agent-1', 'A', '/tmp/work');

    // Build a 5000-row session: 1000 user messages each followed by 4
    // assistant messages. This shape forces getRecentTurns to walk past
    // many assistant rows to find user turn boundaries — exactly what
    // the index needs to optimize.
    db.exec('BEGIN');
    const insert = db.prepare(
      'INSERT INTO messages (session_id, role, content, message_type, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 1000; i++) {
      insert.run(sessionId, 'user', `user msg ${i}`, 'user', 1_700_000_000_000 + i * 100);
      for (let j = 0; j < 4; j++) {
        insert.run(sessionId, 'assistant', `asst ${i}.${j}`, 'assistant', 1_700_000_000_000 + i * 100 + j + 1);
      }
    }
    db.exec('COMMIT');
    expect(messageDb.getCount(sessionId)).toBe(5000);

    // Warm the cache once (first call cost includes plan-cache priming).
    messageDb.getRecentTurns(sessionId, 5);

    const start = Date.now();
    let result;
    for (let k = 0; k < 10; k++) {
      result = messageDb.getRecentTurns(sessionId, 5);
    }
    const elapsed = Date.now() - start;

    // Each call should be fast (< 5 ms typical). Budget 200ms total for
    // 10 calls keeps CI jitter under control while still failing loudly
    // if SQLite is doing a full session scan.
    expect(elapsed).toBeLessThan(200);

    // Correctness: must return the LAST 5 user turns and all assistants
    // after the oldest user.
    expect(result.messages.length).toBe(25); // 5 user + 5 * 4 assistant
    const userMessages = result.messages.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(5);
    expect(userMessages[0].content).toBe('user msg 995');
    expect(userMessages[4].content).toBe('user msg 999');
    expect(result.hasMore).toBe(true);
  });

  it('EXPLAIN QUERY PLAN uses idx_messages_session_role_id', () => {
    const sessionId = 's1';
    sessionDb.create(sessionId, 'agent-1', 'A', '/tmp/work');
    // Need at least one row so the planner can pick an index.
    messageDb.add(sessionId, 'user', 'hi', 'user');

    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 5"
      )
      .all(sessionId);

    const text = plan.map(r => r.detail || '').join(' | ');
    // The planner must pick our composite index. If it falls back to the
    // legacy idx_messages_session and post-filters role, this assertion
    // catches it.
    expect(text).toMatch(/idx_messages_session_role_id/);
  });
});

describe('feat-chat-load-perf: bulkAddHistory one-shot rebuild guard', () => {
  function makeBadTimestampSession() {
    const sessionId = 'bad-ts-session';
    sessionDb.create(sessionId, 'agent-1', 'A', '/tmp/work');
    // Seed with > 5 rows all within a 1-second window — this is exactly
    // the shape the heuristic mis-classifies as "bad timestamps".
    db.exec('BEGIN');
    const insert = db.prepare(
      'INSERT INTO messages (session_id, role, content, message_type, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      insert.run(sessionId, role, `msg ${i}`, role, base + i);
    }
    db.exec('COMMIT');
    return sessionId;
  }

  function makeHistoryPayload() {
    // Mock JSONL-style payload: 6 turns, where the last user matches the
    // session's last user content (`msg 8` because user msgs are at even
    // indices). This is the "anchor found" path, so without the rebuild
    // trip there would be 0 inserts.
    const turns = [];
    for (let i = 0; i < 10; i++) {
      const type = i % 2 === 0 ? 'user' : 'assistant';
      const content = `msg ${i}`;
      if (type === 'user') {
        turns.push({ type: 'user', message: { content }, timestamp: new Date(1_700_000_000_000 + i).toISOString() });
      } else {
        turns.push({
          type: 'assistant',
          message: { content: [{ type: 'text', text: content }] },
          timestamp: new Date(1_700_000_000_000 + i).toISOString()
        });
      }
    }
    // Add one new turn after the anchor so the cheap append path inserts
    // something we can assert on.
    turns.push({ type: 'user', message: { content: 'newcomer' }, timestamp: new Date(1_700_000_000_100).toISOString() });
    turns.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reply' }] },
      timestamp: new Date(1_700_000_000_101).toISOString()
    });
    return turns;
  }

  it('rebuilds once, stamps ts_rebuilt_at, skips on next resume', () => {
    const sessionId = makeBadTimestampSession();
    const history = makeHistoryPayload();

    // Before any resume, sentinel is 0.
    const before = db.prepare('SELECT ts_rebuilt_at FROM sessions WHERE id = ?').get(sessionId);
    expect(before.ts_rebuilt_at).toBe(0);

    // First resume: heuristic trips, rebuild runs.
    messageDb.bulkAddHistory(sessionId, history);
    const afterFirst = db.prepare('SELECT ts_rebuilt_at FROM sessions WHERE id = ?').get(sessionId);
    expect(afterFirst.ts_rebuilt_at).toBeGreaterThan(0);
    // After rebuild + insert, all 10 user/assistant rows from the payload
    // plus the newcomer turn should be in the table.
    const countAfterFirst = messageDb.getCount(sessionId);
    expect(countAfterFirst).toBe(12);

    // Capture the existing row ids so we can prove the second call did
    // NOT delete-and-rebuild.
    const idsBefore = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);

    // Second resume with the SAME payload: the sentinel must block the
    // rebuild. Anchor-based append also returns 0 (newcomer is now the
    // anchor; nothing after it).
    messageDb.bulkAddHistory(sessionId, history);
    const idsAfterSecond = db
      .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId);
    expect(idsAfterSecond.length).toBe(idsBefore.length);
    expect(idsAfterSecond[0].id).toBe(idsBefore[0].id);
    expect(idsAfterSecond[idsAfterSecond.length - 1].id).toBe(idsBefore[idsBefore.length - 1].id);

    // Sentinel timestamp is preserved (not re-stamped).
    const afterSecond = db.prepare('SELECT ts_rebuilt_at FROM sessions WHERE id = ?').get(sessionId);
    expect(afterSecond.ts_rebuilt_at).toBe(afterFirst.ts_rebuilt_at);
  });
});
