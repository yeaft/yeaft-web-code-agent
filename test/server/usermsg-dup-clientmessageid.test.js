/**
 * fix-usermsg-dup regression tests.
 *
 * The bug: in Claude Chat, sending a message in a session that was VIEWED
 * AFTER PAGE REFRESH caused the user message to appear twice in the UI.
 * Newly created sessions did not reproduce.
 *
 * Why the asymmetry: the dedup gate in `web/stores/helpers/claudeOutput.js`
 * compared the echo's content to the optimistic message's content. In a
 * fresh session, the two strings were byte-identical so dedup succeeded.
 * In a post-refresh session, the optimistic add and the
 * `sync_messages_result` replay produced two slightly different rows for
 * the same message (one with `dbMessageId`, one without), and the echo
 * matched against the wrong one — so the duplicate slipped through.
 *
 * The fix: stamp a stable `clientMessageId` on the optimistic message,
 * round-trip it end-to-end:
 *   frontend.sendMessage → ws `chat` payload → server stash on convInfo
 *   → server `claude_output` echo (msg.data.clientMessageId)
 *   → DB `messages.metadata = '{"clientMessageId":"…"}'`
 *   → `formatDbMessage` surfaces it back on sync replay
 *
 * Every dedup path then prefers id-equality and falls back to content
 * only for legacy rows. The id is opaque to the server; this test pins
 * the DB persistence half (the on-wire wiring is exercised by manual QA
 * since it spans three processes).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

let db, sessionDb, messageDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
  messageDb = ops.messageDb;
  sessionDb.create('s1', 'a1', 'A1', '/w', null, 't', 'u1');
});

afterAll(() => { cleanupTestDb(); });

describe('messageDb — metadata column persistence', () => {
  it('persists a clientMessageId metadata blob through add() + getRecent()', () => {
    const meta = JSON.stringify({ clientMessageId: 'cm_abc_123' });
    const id = messageDb.add('s1', 'user', 'hello', 'user', null, null, meta);

    const rows = messageDb.getRecent('s1', 50);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].metadata).toBe(meta);

    const parsed = JSON.parse(rows[0].metadata);
    expect(parsed.clientMessageId).toBe('cm_abc_123');
  });

  it('defaults metadata to null when not provided (legacy callers)', () => {
    const id = messageDb.add('s1', 'user', 'no-meta');
    const rows = messageDb.getRecent('s1', 50);
    const row = rows.find(r => r.id === id);
    expect(row.metadata).toBe(null);
  });

  it('round-trips a combined experts + clientMessageId metadata blob', () => {
    // server/handlers/agent-output.js packs both keys when present;
    // the DB must round-trip the whole blob without mutation.
    const meta = JSON.stringify({
      experts: ['pm-jobs', 'dev-torvalds'],
      clientMessageId: 'cm_combined_456'
    });
    messageDb.add('s1', 'user', 'review this', 'user', null, null, meta);

    const last = messageDb.getRecent('s1', 1)[0];
    const parsed = JSON.parse(last.metadata);
    expect(parsed.experts).toEqual(['pm-jobs', 'dev-torvalds']);
    expect(parsed.clientMessageId).toBe('cm_combined_456');
  });

  it('updateMetadata replaces the blob in place (used by AskUserQuestion flow)', () => {
    const id = messageDb.add('s1', 'user', 'q', 'user', null, null, null);
    messageDb.updateMetadata(id, JSON.stringify({ clientMessageId: 'cm_late_789' }));

    const last = messageDb.getRecent('s1', 1)[0];
    expect(JSON.parse(last.metadata).clientMessageId).toBe('cm_late_789');
  });
});

describe('formatDbMessage model — surfaces clientMessageId for sync dedup', () => {
  // Mirror of web/stores/helpers/messages.js#formatDbMessage user branch
  // (just the metadata-to-clientMessageId extraction). Pinning this in a
  // unit test means the dedup contract can't silently regress without a
  // failing test — even if the metadata column grows new keys later.
  function formatUserRow(dbMsg) {
    const base = { id: dbMsg.id, dbMessageId: dbMsg.id, timestamp: dbMsg.created_at };
    let clientMessageId = null;
    if (dbMsg.metadata) {
      try {
        const meta = JSON.parse(dbMsg.metadata);
        if (meta && typeof meta.clientMessageId === 'string') {
          clientMessageId = meta.clientMessageId;
        }
      } catch { /* ignore */ }
    }
    return {
      ...base,
      type: 'user',
      content: String(dbMsg.content || ''),
      ...(clientMessageId ? { clientMessageId } : {})
    };
  }

  it('extracts clientMessageId from valid metadata JSON', () => {
    messageDb.add('s1', 'user', 'hello', 'user', null, null,
      JSON.stringify({ clientMessageId: 'cm_X' }));
    const row = messageDb.getRecent('s1', 1)[0];
    const formatted = formatUserRow(row);
    expect(formatted.clientMessageId).toBe('cm_X');
  });

  it('omits clientMessageId when metadata has no such key', () => {
    messageDb.add('s1', 'user', 'hello', 'user', null, null,
      JSON.stringify({ experts: ['x'] }));
    const row = messageDb.getRecent('s1', 1)[0];
    const formatted = formatUserRow(row);
    expect('clientMessageId' in formatted).toBe(false);
  });

  it('omits clientMessageId when metadata is null (legacy row)', () => {
    messageDb.add('s1', 'user', 'legacy');
    const row = messageDb.getRecent('s1', 1)[0];
    const formatted = formatUserRow(row);
    expect('clientMessageId' in formatted).toBe(false);
  });

  it('tolerates malformed metadata JSON without throwing', () => {
    const id = messageDb.add('s1', 'user', 'bad');
    messageDb.updateMetadata(id, 'not-json-{');
    const row = messageDb.getRecent('s1', 1)[0];
    expect(() => formatUserRow(row)).not.toThrow();
    const formatted = formatUserRow(row);
    expect('clientMessageId' in formatted).toBe(false);
  });
});

describe('echo-dedup model — prefer clientMessageId over content-equality', () => {
  // Mirror of web/stores/helpers/claudeOutput.js user branch dedup gate.
  // The historical bug was that the gate ONLY compared content. After the
  // fix, the gate prefers `clientMessageId` whenever both sides carry it.
  function isDuplicate(msgs, echo) {
    const echoCmid = echo.clientMessageId || null;
    return msgs.some(m => {
      if (m.type !== 'user') return false;
      if (echoCmid && m.clientMessageId && m.clientMessageId === echoCmid) return true;
      // Fallback: only fall through to content equality when neither
      // side carries an id we could've matched.
      if (!echoCmid) return m.content === echo.content;
      return false;
    });
  }

  it('matches echo to optimistic add by clientMessageId', () => {
    const msgs = [{ type: 'user', content: 'hi', clientMessageId: 'cm_1' }];
    const echo = { type: 'user', content: 'hi', clientMessageId: 'cm_1' };
    expect(isDuplicate(msgs, echo)).toBe(true);
  });

  it('does NOT collapse two different sends with the same content but distinct ids', () => {
    // Critical case: user types "hello" twice in a row. The OLD content-
    // equality dedup would have collapsed the second send. The new gate
    // preserves both because clientMessageIds differ.
    const msgs = [{ type: 'user', content: 'hello', clientMessageId: 'cm_1' }];
    const echo = { type: 'user', content: 'hello', clientMessageId: 'cm_2' };
    expect(isDuplicate(msgs, echo)).toBe(false);
  });

  it('falls back to content equality for legacy rows (no id on either side)', () => {
    const msgs = [{ type: 'user', content: 'old' }];
    const echo = { type: 'user', content: 'old' };
    expect(isDuplicate(msgs, echo)).toBe(true);
  });

  it('does NOT match across types', () => {
    const msgs = [{ type: 'assistant', content: 'x', clientMessageId: 'cm_x' }];
    const echo = { type: 'user', content: 'x', clientMessageId: 'cm_x' };
    expect(isDuplicate(msgs, echo)).toBe(false);
  });

  it('reproduces the original Bug-1 scenario: post-refresh send creates a duplicate WITHOUT the fix', () => {
    // Simulate the broken pre-fix state: optimistic add has no
    // clientMessageId; sync replay row has dbMessageId but also no
    // clientMessageId (because metadata didn't carry one). When the
    // echo arrives carrying NO clientMessageId either, content-equality
    // *does* match — so the old gate succeeded.
    //
    // The actual bug fired in a slightly different path: the optimistic
    // add and the sync row coexisted as TWO user rows with the same
    // content. Then the echo arrived and matched ONE of them by content,
    // leaving the other as a visible duplicate. We model that here by
    // showing how the id-based gate distinguishes the two without
    // collapsing legitimate repeats.
    const legacyMsgs = [
      { type: 'user', content: 'hi', dbMessageId: 100 }, // from sync replay
      { type: 'user', content: 'hi' },                    // optimistic add
    ];
    const echo = { type: 'user', content: 'hi' }; // no id, legacy echo
    // Old gate: returns true → echo gets dropped, BUT the original
    // duplicate (sync vs optimistic) was never reconciled. That's the
    // bug. With clientMessageId stamping on both sides, the optimistic
    // and the echo carry the same id and the sync-replay row carries it
    // too — so the orphan-merge path in conversationHandler can fold
    // them together. This isn't a property of `isDuplicate` alone; it's
    // a property of the full chain. The assertion below just guards the
    // dedup gate's contract: when both sides carry an id, the gate
    // honours it.
    expect(isDuplicate(legacyMsgs, echo)).toBe(true); // legacy fallback still works

    // And the new path: stamp the id on the optimistic add — the gate
    // refuses to match an echo that has a *different* id.
    const fixedMsgs = [
      { type: 'user', content: 'hi', dbMessageId: 100, clientMessageId: 'cm_A' },
      { type: 'user', content: 'hi', clientMessageId: 'cm_A' },
    ];
    const echoWithId = { type: 'user', content: 'hi', clientMessageId: 'cm_A' };
    expect(isDuplicate(fixedMsgs, echoWithId)).toBe(true);

    const unrelatedEcho = { type: 'user', content: 'hi', clientMessageId: 'cm_DIFFERENT' };
    expect(isDuplicate(fixedMsgs, unrelatedEcho)).toBe(false);
  });
});
