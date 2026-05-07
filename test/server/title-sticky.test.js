/**
 * fix-chat-title-sticky regression tests.
 *
 * The bug: a per-message auto-title write in
 * `server/handlers/client-conversation.js:351` overwrites the session
 * title on every user prompt. It is gated by `convInfo.customTitle`, but
 * `customTitle` only ever lived in agent-process memory — every rebuild
 * path (agent reconnect, server restart, conversation_list, agent_sync,
 * etc.) reset it to `undefined`, so a user-renamed title got clobbered
 * the next time the user typed.
 *
 * The fix:
 *   1. Persist the bit in the DB column `sessions.is_custom_title`.
 *   2. Expose it through `sessionDb.get()` as `customTitle: boolean`.
 *   3. Have every convInfo-rebuild site hydrate `customTitle` from the
 *      DB.
 *   4. Have the rename handler write `isCustomTitle: 1` to the DB
 *      (and `0` when the user clears the custom title).
 *
 * These tests pin (a) the DB persistence + exposure, (b) the auto-title
 * gate honouring the bit, and (c) the bulk-sync path skipping
 * user-renamed sessions.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

let db, sessionDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
});

afterAll(() => { cleanupTestDb(); });

describe('sessionDb — sticky title persistence', () => {
  it('exposes customTitle=false on a freshly created session', () => {
    sessionDb.create('s1', 'a1', 'A1', '/d', null, 'auto title', 'u1');
    const s = sessionDb.get('s1');
    expect(s.customTitle).toBe(false);
    expect(s.is_custom_title).toBe(0);
  });

  it('persists isCustomTitle=1 across update + re-read', () => {
    sessionDb.create('s2', 'a1', 'A1', '/d', null, 'old', 'u1');
    sessionDb.update('s2', { title: 'User Rename', isCustomTitle: 1 });
    const s = sessionDb.get('s2');
    expect(s.title).toBe('User Rename');
    expect(s.customTitle).toBe(true);
    expect(s.is_custom_title).toBe(1);
  });

  it('clears the sticky bit when isCustomTitle=0 is passed explicitly', () => {
    sessionDb.create('s3', 'a1', 'A1', '/d', null, 'old', 'u1');
    sessionDb.update('s3', { title: 'Renamed', isCustomTitle: 1 });
    expect(sessionDb.get('s3').customTitle).toBe(true);

    // User clears the custom title — return to auto mode.
    sessionDb.update('s3', { isCustomTitle: 0 });
    const s = sessionDb.get('s3');
    expect(s.customTitle).toBe(false);
    expect(s.title).toBe('Renamed'); // title untouched, only the bit changes
  });

  it('preserves the sticky bit when an unrelated update arrives', () => {
    sessionDb.create('s4', 'a1', 'A1', '/d', 'cs_old', 'Renamed', 'u1');
    sessionDb.update('s4', { isCustomTitle: 1 });

    // Subsequent claudeSessionId-only update must NOT clear the bit
    // because `is_custom_title` arg is null and SQL uses COALESCE.
    sessionDb.update('s4', { claudeSessionId: 'cs_new' });
    const s = sessionDb.get('s4');
    expect(s.claude_session_id).toBe('cs_new');
    expect(s.customTitle).toBe(true);
  });

  it('exposes customTitle on getByUser / getActive list reads', () => {
    sessionDb.create('s5', 'a1', 'A1', '/d', null, 't', 'u1');
    sessionDb.update('s5', { isCustomTitle: 1 });

    const byUser = sessionDb.getByUser('u1');
    expect(byUser.length).toBe(1);
    expect(byUser[0].customTitle).toBe(true);

    const active = sessionDb.getActive();
    expect(active.find(s => s.id === 's5').customTitle).toBe(true);
  });
});

describe('auto-title gate — `!(convInfo?.customTitle)` semantics', () => {
  // The actual production gate sits in client-conversation.js:351:
  //
  //   if (msg.prompt && msg.prompt.trim() && !(convInfo?.customTitle)) {
  //     sessionDb.update(convId, { title });
  //   }
  //
  // Below we model the identical guard against the new DB-backed flag.
  // If convInfo.customTitle is reliably set (which the rebuild-path fixes
  // ensure), the auto-title write is skipped and the user's renamed
  // title is preserved — even after a synthetic "rebuild" that drops
  // the in-memory convInfo.

  function maybeAutoTitle(convInfo, convId, prompt) {
    if (prompt && prompt.trim() && !(convInfo?.customTitle)) {
      const title = prompt.trim().substring(0, 100);
      sessionDb.update(convId, { title });
      if (convInfo) convInfo.title = title;
    }
  }

  it('writes auto-title on every prompt when customTitle is unset', () => {
    sessionDb.create('s10', 'a', 'A', '/d', null, null, 'u');
    const convInfo = { title: null, customTitle: false };

    maybeAutoTitle(convInfo, 's10', 'first question with detail');
    expect(sessionDb.get('s10').title).toBe('first question with detail');

    maybeAutoTitle(convInfo, 's10', 'second question even longer');
    // Auto-title keeps following the latest prompt — this is the
    // intended default behaviour.
    expect(sessionDb.get('s10').title).toBe('second question even longer');
  });

  it('preserves a user-renamed title across subsequent prompts', () => {
    sessionDb.create('s11', 'a', 'A', '/d', null, 'auto-default', 'u');
    sessionDb.update('s11', { title: 'My Custom Title', isCustomTitle: 1 });

    // Simulate the rebuild path hydrating convInfo.customTitle from DB.
    const dbSession = sessionDb.get('s11');
    const convInfo = { title: dbSession.title, customTitle: !!dbSession.customTitle };
    expect(convInfo.customTitle).toBe(true);

    maybeAutoTitle(convInfo, 's11', 'a brand new user prompt');
    expect(sessionDb.get('s11').title).toBe('My Custom Title');
  });

  it('regression: rebuilt convInfo without hydration would clobber the title (proves hydration matters)', () => {
    sessionDb.create('s12', 'a', 'A', '/d', null, 'auto', 'u');
    sessionDb.update('s12', { title: 'User Title', isCustomTitle: 1 });

    // Simulate the OLD broken code path: rebuild forgot to hydrate
    // customTitle, so it stays undefined.
    const brokenConvInfo = { title: 'User Title' /* customTitle missing */ };
    maybeAutoTitle(brokenConvInfo, 's12', 'next user message');
    // ★ This is the bug we fixed: without hydration, the auto-title
    //   write fires and clobbers the renamed title in the DB.
    expect(sessionDb.get('s12').title).toBe('next user message');

    // And here is the post-fix path: rebuild hydrates customTitle from
    // the DB, so the gate skips the write.
    sessionDb.update('s12', { title: 'User Title', isCustomTitle: 1 }); // restore
    const dbSession = sessionDb.get('s12');
    const fixedConvInfo = {
      title: dbSession.title,
      customTitle: !!dbSession.customTitle
    };
    maybeAutoTitle(fixedConvInfo, 's12', 'another user message');
    expect(sessionDb.get('s12').title).toBe('User Title');
  });
});

describe('bulk session sync — agent must not overwrite user-renamed titles', () => {
  // Mirror of agent-sync.js: only update title when `lastModified >
  // existing.updated_at && !existing.customTitle`. This test pins the
  // sticky-bit guard added by the fix.
  function bulkSync(syncedSessions) {
    for (const s of syncedSessions) {
      const existing = sessionDb.get(s.sessionId);
      if (!existing) {
        sessionDb.create(s.sessionId, 'a', 'A', '/d', s.sessionId, s.title, 'u');
      } else if (s.lastModified > existing.updated_at && !existing.customTitle) {
        sessionDb.update(s.sessionId, { title: s.title });
      }
    }
  }

  it('updates auto-title sessions from agent bulk sync', async () => {
    sessionDb.create('s20', 'a', 'A', '/d', null, 'old auto', 'u');
    await new Promise(r => setTimeout(r, 5));
    bulkSync([{ sessionId: 's20', title: 'fresh from agent', lastModified: Date.now() }]);
    expect(sessionDb.get('s20').title).toBe('fresh from agent');
  });

  it('skips renamed sessions during agent bulk sync', async () => {
    sessionDb.create('s21', 'a', 'A', '/d', null, 'old', 'u');
    sessionDb.update('s21', { title: 'My Custom', isCustomTitle: 1 });
    await new Promise(r => setTimeout(r, 5));
    bulkSync([{ sessionId: 's21', title: 'agent-claimed-title', lastModified: Date.now() }]);
    expect(sessionDb.get('s21').title).toBe('My Custom');
  });
});
