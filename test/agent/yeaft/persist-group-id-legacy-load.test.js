import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore, parseMessage } from '../../../agent/yeaft/conversation/persist.js';

/**
 * Regression for the yeaft-history-not-loading bug:
 *
 *  - Bug source: PR #881 renamed the groups → sessions surface but did NOT
 *    add a `case 'groupId':` alias to the persist parser switch. The user
 *    had ~4k pre-rename `.md` files in ~/.yeaft/conversation/messages/
 *    that stamp `groupId: grp_x` in frontmatter; the parser silently
 *    dropped that key, msg.sessionId stayed undefined, and the legacy-
 *    flat-dir filter `.filter(m => m?.sessionId)` rejected every row.
 *    Effect: every fresh session boot replayed an EMPTY history into the
 *    LLM request — chat history "disappeared".
 *
 *  - Both halves matter:
 *    1. The parser hydrates msg.sessionId from a legacy `groupId:` line.
 *    2. ConversationStore.loadRecentBySession actually returns rows that
 *       came in via that path.
 *
 *  Tests below pin both halves so the next rename can't silently break
 *  history again.
 */
describe('persist: legacy groupId frontmatter alias', () => {
  it('parseMessage hydrates msg.sessionId from a legacy groupId: line', () => {
    const raw = [
      '---',
      'id: m4076',
      'role: assistant',
      'time: 2026-06-02T09:13:28.338Z',
      'model: gpt-5.5',
      'threadId: thr_legacy',
      'groupId: grp_fun',
      'tokens_est: 0',
      '---',
      '',
      'hello from legacy',
    ].join('\n');

    const parsed = parseMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed.sessionId).toBe('grp_fun');
    expect(parsed.id).toBe('m4076');
    expect(parsed.threadId).toBe('thr_legacy');
  });

  it('sessionId takes precedence over groupId when both are present', () => {
    // Hand-edited or migration-in-progress file with both keys — the new
    // name wins so we never regress to the legacy id.
    const raw = [
      '---',
      'id: m1',
      'role: user',
      'sessionId: grp_new',
      'groupId: grp_old',
      '---',
      '',
      'mixed-keys',
    ].join('\n');

    const parsed = parseMessage(raw);
    expect(parsed.sessionId).toBe('grp_new');
  });

  it('loadRecentBySession returns legacy-groupId rows from ~/.yeaft/conversation/messages/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-legacy-groupid-'));
    try {
      // Mirror the on-disk layout that production left behind: legacy
      // flat dir with frontmatter that stamps `groupId:` (not sessionId).
      const legacyDir = join(dir, 'conversation', 'messages');
      mkdirSync(legacyDir, { recursive: true });

      const write = (seq, role, body, groupId) => {
        const id = `m${String(seq).padStart(4, '0')}`;
        const raw = [
          '---',
          `id: ${id}`,
          `role: ${role}`,
          `time: 2026-06-02T09:00:0${seq}.000Z`,
          'threadId: main',
          `groupId: ${groupId}`,
          '---',
          '',
          body,
        ].join('\n');
        writeFileSync(join(legacyDir, `${id}.md`), raw, 'utf8');
      };

      write(1, 'user', 'hi from grpA', 'grpA');
      write(2, 'assistant', 'reply in grpA', 'grpA');
      write(3, 'user', 'hi from grpB', 'grpB');

      const store = new ConversationStore(dir);
      const recent = store.loadRecentBySession('grpA', Infinity);

      // Pre-fix: this returned [] because the parser dropped groupId and
      // the legacy filter `.filter(m => m?.sessionId)` rejected every row.
      expect(recent.length).toBe(2);
      expect(recent.every(m => m.sessionId === 'grpA')).toBe(true);
      expect(recent.map(m => m.content)).toEqual(['hi from grpA', 'reply in grpA']);

      // Sanity: the unrelated grpB row didn't bleed into grpA.
      const recentB = store.loadRecentBySession('grpB', Infinity);
      expect(recentB.length).toBe(1);
      expect(recentB[0].content).toBe('hi from grpB');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ConversationStore exposes loadRecentBySession (catches the rename mismatch)', () => {
    // Pre-fix (PR #881 only renamed callers, not the method): the bridge
    // called store.loadRecentBySession which didn't exist, and the catch
    // in hydrateGroupHistory swallowed the TypeError. Pin the new API
    // name so a future revert is loud, not silent.
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-api-shape-'));
    try {
      const store = new ConversationStore(dir);
      expect(typeof store.loadRecentBySession).toBe('function');
      expect(typeof store.loadAllBySession).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
