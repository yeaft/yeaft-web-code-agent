import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

// fix-copilot-provider-persist: the conversation's code-agent provider
// (claude-code / copilot / ...) must survive an agent process restart. It
// used to live only in the agent's in-memory ctx.conversations Map, so a
// restart lost it: the UI marker vanished and copilot sends mis-routed to
// Claude. These tests cover the persistence primitive the fix adds.

let db, sessionDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  const result = createTestDb();
  db = result.db;
  sessionDb = createDbOperations(db).sessionDb;
});

afterAll(() => { cleanupTestDb(); });

describe('sessionDb provider persistence', () => {
  it('round-trips a non-default provider through create()', () => {
    sessionDb.create('conv-1', 'agent-1', 'A1', '/w', null, null, 'user-1', 'copilot');
    expect(sessionDb.get('conv-1').provider).toBe('copilot');
  });

  it('defaults provider to null when omitted (claude-code is implicit)', () => {
    sessionDb.create('conv-2', 'agent-1', 'A1', '/w', null, null, 'user-1');
    expect(sessionDb.get('conv-2').provider).toBeNull();
  });

  it('setProvider() updates an existing row', () => {
    sessionDb.create('conv-3', 'agent-1', 'A1', '/w', null, null, 'user-1');
    expect(sessionDb.get('conv-3').provider).toBeNull();
    sessionDb.setProvider('conv-3', 'copilot');
    expect(sessionDb.get('conv-3').provider).toBe('copilot');
  });

  it('setProvider(null) clears the column', () => {
    sessionDb.create('conv-4', 'agent-1', 'A1', '/w', null, null, 'user-1', 'copilot');
    sessionDb.setProvider('conv-4', null);
    expect(sessionDb.get('conv-4').provider).toBeNull();
  });

  it('provider survives an unrelated update() (title write does not clobber it)', () => {
    // Simulates the per-message auto-title write that runs on every send —
    // it must not wipe the provider binding.
    sessionDb.create('conv-5', 'agent-1', 'A1', '/w', null, null, 'user-1', 'copilot');
    sessionDb.update('conv-5', { title: 'hello world' });
    const row = sessionDb.get('conv-5');
    expect(row.title).toBe('hello world');
    expect(row.provider).toBe('copilot');
  });
});
