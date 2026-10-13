import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../../agent/yeaft/conversation/history-index.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-conv-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await closeConversationHistoryIndexes();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('durable folded transcript', () => {
  it('publishes a folded range atomically and restores only its reflection', () => {
    const store = new ConversationStore(TEST_DIR);
    const user = store.append({ role: 'user', content: 'use tools', sessionId: 'session_fold' });
    const assistant = store.append({
      role: 'assistant',
      content: '',
      sessionId: 'session_fold',
      turnId: 'turn_fold',
      toolCalls: [{ id: 'call_fold', name: 'demo', input: {} }],
    });
    const tool = store.append({
      role: 'tool',
      content: 'raw tool result',
      sessionId: 'session_fold',
      turnId: 'turn_fold',
      toolCallId: 'call_fold',
    });

    const reflection = store.foldMessages([assistant, tool], {
      role: 'user',
      content: 'The previous tool call has been folded.',
      sessionId: 'session_fold',
      _reflection: true,
    });

    expect(reflection).toMatchObject({
      _reflection: true,
      foldedMessageIds: [assistant.id, tool.id],
    });
    expect(store.loadRecentBySession('session_fold', Infinity)).toEqual([
      expect.objectContaining({ id: user.id, role: 'user', content: 'use tools' }),
    ]);
    expect(store.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id, role: 'user', content: 'use tools' }),
      expect.objectContaining({ id: reflection.id, role: 'user', _reflection: true }),
    ]);

    const restarted = new ConversationStore(TEST_DIR);
    expect(restarted.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({ id: reflection.id, _reflection: true }),
    ]);
    expect(restarted.loadOlderBySession('session_fold', reflection.seq, 10).messages.map(row => row.id))
      .toEqual([user.id, assistant.id, tool.id]);

    const indexPath = join(TEST_DIR, 'sessions', 'session_fold', 'conversation', 'index.json');
    const staleIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    staleIndex.segments.at(-1).bytes -= 1;
    staleIndex.foldedMessageIds = [];
    writeFileSync(indexPath, `${JSON.stringify(staleIndex, null, 2)}\n`);
    const recovered = new ConversationStore(TEST_DIR);
    expect(recovered.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({ id: reflection.id, _reflection: true }),
    ]);
  });
});

describe('ConversationStore', () => {
  let store;

  beforeEach(() => {
    store = new ConversationStore(TEST_DIR);
  });

  describe('append', () => {
    it('copies the complete durable Session transcript with independent message ids', () => {
      const sourceSessionId = 'session_copy_source';
      const targetSessionId = 'session_copy_target';
      const user = store.append({
        role: 'user',
        content: 'original question',
        sessionId: sourceSessionId,
        clientMessageId: 'client-stable',
      });
      const assistant = store.append({
        role: 'assistant',
        content: 'original answer',
        sessionId: sourceSessionId,
        causalRootId: user.id,
        sourceMessageIds: [user.id, 'external-message-id'],
        toolCalls: [{ id: 'tool-call-stable', name: 'Read', input: {} }],
      });
      const reflection = store.foldMessages([user, assistant], {
        role: 'assistant',
        content: 'folded summary',
        sessionId: sourceSessionId,
        _reflection: true,
        causalRootId: user.id,
      });
      store.moveToCold(user.id);

      // A migration crash can leave an older markdown copy beside segments.
      // It must not create a duplicate in the cloned transcript.
      const legacyDir = join(TEST_DIR, 'sessions', sourceSessionId, 'conversation', 'messages');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, `${assistant.id}.md`), `---\nid: ${assistant.id}\nrole: assistant\nsessionId: ${sourceSessionId}\n---\nstale duplicate`);

      const { copiedCount, idMap } = store.copySession(sourceSessionId, targetSessionId);
      expect(copiedCount).toBe(3);
      expect(idMap.size).toBe(3);
      const copiedRows = new ConversationStore(TEST_DIR)
        .copySession(targetSessionId, 'session_copy_probe');
      expect(copiedRows.copiedCount).toBe(3);

      const targetSegment = join(TEST_DIR, 'sessions', targetSessionId, 'conversation', 'segments', '000001.jsonl');
      const physicalRows = readFileSync(targetSegment, 'utf8').trim().split('\n').map(JSON.parse);
      expect(physicalRows.map(row => row.content)).toEqual([
        'original question',
        'original answer',
        'folded summary',
      ]);
      expect(physicalRows.map(row => row.id)).toEqual([
        idMap.get(user.id),
        idMap.get(assistant.id),
        idMap.get(reflection.id),
      ]);
      expect(physicalRows[0]).toMatchObject({
        sessionId: targetSessionId,
        clientMessageId: 'client-stable',
        cold: true,
      });
      expect(physicalRows[1]).toMatchObject({
        sessionId: targetSessionId,
        causalRootId: idMap.get(user.id),
        sourceMessageIds: [idMap.get(user.id), 'external-message-id'],
        toolCalls: [{ id: 'tool-call-stable', name: 'Read', input: {} }],
      });
      expect(physicalRows[2]).toMatchObject({
        sessionId: targetSessionId,
        _reflection: true,
        causalRootId: idMap.get(user.id),
        foldedMessageIds: [idMap.get(user.id), idMap.get(assistant.id)],
      });
      expect(store.loadRecentBySession(sourceSessionId, 10).map(row => row.id))
        .not.toContain(idMap.get(reflection.id));
    });

    it('fails closed for invalid, unknown, ambiguous, and incomplete fork boundaries', () => {
      const sourceSessionId = 'session_fork_invalid_source';
      store.append({ role: 'user', content: 'prompt', sessionId: sourceSessionId });
      store.append({ role: 'assistant', content: 'a', sessionId: sourceSessionId, turnId: 'shared', speakerVpId: 'vp-a' });
      store.append({ role: 'assistant', content: 'b', sessionId: sourceSessionId, turnId: 'shared', speakerVpId: 'vp-b' });
      store.append({
        role: 'assistant', content: 'calling', sessionId: sourceSessionId, turnId: 'incomplete',
        speakerVpId: 'vp-a', toolCalls: [{ id: 'missing-result', name: 'Read', input: {} }],
      });

      const expectCode = (target, throughTurnId, code) => {
        try {
          store.copySession(sourceSessionId, target, { throughTurnId });
          throw new Error('expected copy to fail');
        } catch (error) {
          expect(error).toMatchObject({ code });
        }
      };
      expectCode('target-empty', ' ', 'invalid_fork_boundary');
      expectCode('target-missing', 'missing', 'fork_boundary_not_found');
      expectCode('target-ambiguous', 'shared', 'ambiguous_fork_boundary');
      expectCode('target-incomplete', 'incomplete', 'incomplete_fork_boundary');
      for (const target of ['target-empty', 'target-missing', 'target-ambiguous', 'target-incomplete']) {
        expect(existsSync(join(TEST_DIR, 'sessions', target, 'conversation'))).toBe(false);
      }
    });

    it('recovers a corrupt sequence sidecar by scanning durable messages and invalidates old reservations', () => {
      const firstStore = new ConversationStore(TEST_DIR);
      const recoveryStore = new ConversationStore(TEST_DIR);
      const first = firstStore.append({ role: 'user', content: 'before corruption', sessionId: 'session_sequence_recovery' });
      writeFileSync(join(TEST_DIR, 'message-sequence.json'), '{not-json');

      const recovered = recoveryStore
        .append({ role: 'assistant', content: 'after corruption', sessionId: 'session_sequence_recovery' });
      const later = firstStore
        .append({ role: 'user', content: 'from old live store', sessionId: 'session_sequence_recovery' });

      expect(new Set([first.id, recovered.id, later.id]).size).toBe(3);
      expect(Number(recovered.id.slice(1))).toBeGreaterThan(Number(first.id.slice(1)));
      expect(Number(later.id.slice(1))).toBeGreaterThan(Number(recovered.id.slice(1)));
      expect(JSON.parse(readFileSync(join(TEST_DIR, 'message-sequence.json'), 'utf8'))).toMatchObject({
        version: 1,
        epoch: expect.any(String),
      });
    });

    it('reserves non-overlapping message ranges across Agent processes', async () => {
      const moduleUrl = new URL('../../../../agent/yeaft/conversation/persist.js', import.meta.url).href;
      const childScript = `
        const { ConversationStore } = await import(process.env.PERSIST_MODULE_URL);
        const store = new ConversationStore(process.env.CONVERSATION_ROOT);
        const rows = Array.from({ length: 300 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          content: process.env.SESSION_ID + '-' + index,
          sessionId: process.env.SESSION_ID,
        }));
        store.appendBatch(rows);
      `;
      const runChild = sessionId => new Promise((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
          env: {
            ...process.env,
            PERSIST_MODULE_URL: moduleUrl,
            CONVERSATION_ROOT: TEST_DIR,
            SESSION_ID: sessionId,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', rejectChild);
        child.once('exit', code => {
          if (code === 0) resolveChild();
          else rejectChild(new Error(`sequence child exited ${code}: ${stderr}`));
        });
      });

      await Promise.all([
        runChild('session_process_left'),
        runChild('session_process_right'),
      ]);

      const reader = new ConversationStore(TEST_DIR);
      const ids = [
        ...reader.loadAllBySession('session_process_left'),
        ...reader.loadAllBySession('session_process_right'),
      ].map(row => row.id);
      expect(ids).toHaveLength(600);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('preserves a first committed row and stream identity when its index target fails', () => {
      const sessionId = 'session_first_commit_index';
      const before = store.getSessionHistoryMetadata(sessionId);
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const indexPath = join(conversationDir, 'index.json');
      // A directory target injects a real EISDIR write failure on every platform.
      mkdirSync(indexPath);
      const committed = store.append({ role: 'assistant', content: 'first publication', sessionId }, { strict: true });
      const restarted = new ConversationStore(TEST_DIR);
      expect(restarted.loadAllBySession(sessionId)).toEqual([expect.objectContaining(committed)]);
      expect(restarted.getSessionHistoryMetadata(sessionId)).toEqual({
        ...before, headSeq: Number(committed.id.slice(1)),
      });
      rmSync(indexPath, { recursive: true });
      expect(new ConversationStore(TEST_DIR).loadAllBySession(sessionId)).toHaveLength(1);
      expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toMatchObject({
        totalMessages: 1, lastMessageId: committed.id,
        streamId: before.streamId.replace(/:visible-v2$/, ''), revision: before.revision,
      });
    });

    it.skipIf(process.platform === 'win32')('rejects strict lineage preparation and JSONL failures before transcript commit', () => {
      const sessionId = 'session_precommit_failure';
      const user = store.append({ role: 'user', content: 'original', sessionId });
      const before = store.getSessionHistoryMetadata(sessionId);
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const segmentPath = join(conversationDir, 'segments', '000001.jsonl');
      const original = readFileSync(segmentPath, 'utf8');

      // A fold needs an atomic lineage write. Deny that write, not JSONL, to
      // prove a lineage error cannot occur after publishing its reflection.
      chmodSync(conversationDir, 0o555);
      try {
        expect(() => store.append({
          role: 'user', content: 'must not commit', sessionId,
          _reflection: true, foldedMessageIds: [user.id],
        }, { strict: true })).toThrow(/EACCES/);
        expect(readFileSync(segmentPath, 'utf8')).toBe(original);
      } finally {
        chmodSync(conversationDir, 0o755);
      }
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(before);

      chmodSync(segmentPath, 0o444);
      try {
        expect(() => store.append({ role: 'assistant', content: 'strict failure', sessionId }, { strict: true }))
          .toThrow(/EACCES/);
        expect(store.append({ role: 'assistant', content: 'best-effort fallback', sessionId }))
          .toMatchObject({ content: 'best-effort fallback', id: expect.stringMatching(/^m\d+$/) });
        expect(() => store.append({
          role: 'user', content: 'uncommitted fold', sessionId,
          _reflection: true, foldedMessageIds: [user.id],
        }, { strict: true })).toThrow(/EACCES/);
        expect(readFileSync(segmentPath, 'utf8')).toBe(original);
      } finally {
        chmodSync(segmentPath, 0o644);
      }
      const restarted = new ConversationStore(TEST_DIR);
      expect(restarted.loadAllBySession(sessionId).map(row => row.id)).toEqual([user.id]);
      expect(restarted.loadRecentBySession(sessionId, Infinity, { includeReflections: true }).map(row => row.id))
        .toEqual([user.id]);
      // The pre-written fence is allowed to invalidate caches conservatively,
      // but it must not remove a source row when JSONL never committed the fold.
      expect(restarted.getSessionHistoryMetadata(sessionId)).toEqual({ ...before, revision: before.revision + 1 });
    });
  });

    it("should write session messages under that session's conversation history", () => {
      const msg = store.append({ role: 'user', content: 'Hello session', sessionId: 's_fun' });
      expect(msg.id).toBe('m0001');
      expect(existsSync(join(TEST_DIR, 'sessions', 's_fun', 'conversation', 'segments', '000001.jsonl'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'groups', 's_fun', 'conversation', 'messages', 'm0001.md'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0001.md'))).toBe(false);
      expect(store.loadRecent(10)).toEqual([]);
      expect(store.loadRecentBySession('s_fun', 10)).toHaveLength(1);
    });

    it('should read legacy conversation paths without mixing chat and session records', () => {
      const legacyMessages = join(TEST_DIR, 'conversation', 'messages');
      mkdirSync(legacyMessages, { recursive: true });
      writeFileSync(join(legacyMessages, 'm0001.md'), `---
id: m0001
role: user
time: 2026-06-26T00:00:00Z
threadId: main
tokens_est: 3
---

legacy chat`, { encoding: 'utf8' });
      writeFileSync(join(legacyMessages, 'm0002.md'), `---
id: m0002
role: user
time: 2026-06-26T00:00:01Z
threadId: main
sessionId: s_fun
tokens_est: 4
---

legacy session`, { encoding: 'utf8' });

      const compatStore = new ConversationStore(TEST_DIR);
      expect(compatStore.loadRecent(10).map(m => m.content)).toEqual(['legacy chat']);
      // Per-session load paths no longer fall back to the legacy flat dir.
      expect(compatStore.loadRecentBySession('s_fun', 10).map(m => m.content)).toEqual([]);
    });

  describe('Session visible history search', () => {
    it('searches only visible rows in the requested Session, newest first', () => {
      const first = store.append({ role: 'user', content: 'Needle in the first turn', sessionId: 'session_search' });
      store.append({ role: 'assistant', content: 'irrelevant', sessionId: 'session_search' });
      const latest = store.append({ role: 'assistant', content: 'Latest NEEDLE answer', sessionId: 'session_search', speakerVpId: 'maker' });
      store.append({ role: 'user', content: 'needle from another session', sessionId: 'session_other' });
      store.append({ role: 'system', content: 'needle in hidden metadata', sessionId: 'session_search' });

      const page = store.searchVisibleBySession('session_search', 'needle', { limit: 10 });

      expect(page.results.map(result => result.messageId)).toEqual([latest.id, first.id]);
      expect(page.results[0]).toMatchObject({ role: 'assistant', speakerVpId: 'maker' });
      expect(page.results[0].snippet).toContain('NEEDLE');
      expect(page.hasMore).toBe(false);
    });
  });

  // Group-history-isolation (Bug 7): group-scoped loaders.
  describe('loadRecentBySession / loadAllBySession', () => {
    it('keeps an AskUser call and result atomic at the default delta limit', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_ask' });
      store.appendBatch(Array.from({ length: 499 }, (_, index) => ({
        role: 'assistant',
        content: `filler-${index}`,
        sessionId: 'grp_delta_ask',
      })));
      const call = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_delta_ask',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCalls: [{ id: 'ask_boundary', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      const result = store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'grp_delta_ask',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCallId: 'ask_boundary',
      });
      const trailing = store.append({ role: 'assistant', content: 'after pair', sessionId: 'grp_delta_ask' });

      const firstPage = store.loadAfterSeqByGroup('grp_delta_ask', store.getMessageSeqById(cursor.id));
      expect(firstPage.messages.find(message => message.id === call.id)?.askUserResults).toEqual([
        expect.objectContaining({
          toolCallId: 'ask_boundary',
          status: 'answered',
          answers: { 'Continue?': 'Yes' },
        }),
      ]);
      expect(firstPage.latestSeq).toBe(store.getMessageSeqById(result.id));
      expect(firstPage.hasMoreAfter).toBe(true);

      const secondPage = store.loadAfterSeqByGroup('grp_delta_ask', firstPage.latestSeq);
      expect(secondPage.messages.map(message => message.id)).toEqual([trailing.id]);
      expect(secondPage.hasMoreAfter).toBe(false);
    });

    it('pages a long delta by row and byte budgets without skipping the tail', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_pages' });
      const rows = store.appendBatch(Array.from({ length: 7 }, (_, index) => ({
        role: 'assistant',
        content: `page-${index}-${'x'.repeat(80)}`,
        sessionId: 'grp_delta_pages',
      })));

      const seen = [];
      let afterSeq = store.getMessageSeqById(cursor.id);
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = store.loadAfterSeqByGroup('grp_delta_pages', afterSeq, {
          limit: 2,
          maxBytes: 220,
        });
        seen.push(...page.messages.map(message => message.id));
        expect(page.latestSeq).toBeGreaterThan(afterSeq);
        afterSeq = page.latestSeq;
        if (!page.hasMoreAfter) break;
      }

      expect(seen).toEqual(rows.map(row => row.id));
      expect(afterSeq).toBe(store.getMessageSeqById(rows.at(-1).id));
    });

    it('loadRecentBySession preserves full tool pairs in the bounded engine window', () => {
      for (let i = 0; i < 200; i++) {
        store.append({ role: 'user', content: `old ${i}`, sessionId: 'grp_a' });
        store.append({ role: 'assistant', content: `old answer ${i}`, sessionId: 'grp_a' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: 'running tool',
        sessionId: 'grp_a',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
      });
      store.append({ role: 'tool', content: 'ok', sessionId: 'grp_a', toolCallId: 'toolu_1' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'grp_a' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };

      const recent = store.loadRecentBySession('grp_a', 1);
      expect(recent.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(recent[1].toolCalls).toHaveLength(1);
      expect(recent[2].toolCallId).toBe('toolu_1');
      expect(readCounts.count).toBeLessThan(10);
    });

    it('keeps same-id AskUser results isolated by Session turn identity', () => {
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [{ id: 'shared_call', name: 'AskUser', input: { question: 'Continue?' } }],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Wrong' } }),
        sessionId: 'grp_b',
        threadId: 'thread-b',
        turnId: 'turn-b',
        speakerVpId: 'vp-b',
        toolCallId: 'shared_call',
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Right' } }),
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'shared_call',
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages[1].askUserResults).toEqual([
        expect.objectContaining({ answers: { 'Continue?': 'Right' } }),
      ]);
    });
  });

  // Cascade delete + orphan compaction.

  describe('compactOrphans', () => {
    it('deletes messages whose sessionId is missing or unknown', () => {
      store.appendBatch([
        { role: 'user', content: 'live',     sessionId: 'grp_live' },
        { role: 'user', content: 'orphan-a', sessionId: 'grp_dead' },
        { role: 'user', content: 'orphan-b' },                       // no sessionId
        { role: 'user', content: 'live-2',   sessionId: 'grp_live' },
      ]);

      const result = store.compactOrphans({ keepGroupIds: ['grp_live'] });
      expect(result.skipped).toBe(false);
      expect(result.scanned).toBe(4);
      expect(result.removed).toBe(2);
      expect(store.loadAll().map(m => m.content).sort()).toEqual(['live', 'live-2']);
    });
  });

  describe('JSONL cold rows', () => {
    it('keeps archived session rows readable while excluding them from hot counts', () => {
      const user = store.append({ role: 'user', content: 'cold question', sessionId: 'session_cold', threadId: 'main' });
      store.append({ role: 'assistant', content: 'hot answer', sessionId: 'session_cold', speakerVpId: 'vp-linus', threadId: 'main' });

      store.moveToCold(user.id);

      expect(store.countHot()).toBe(1);
      expect(store.countCold()).toBe(1);
      expect(store.loadAllBySession('session_cold').map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadOlderBySession('session_cold', null, 10).messages.map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadVisibleBySession('session_cold', null, 10).messages.map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadSessionHistoryForVp('session_cold', 'vp-linus').map(m => m.content)).toEqual(['cold question', 'hot answer']);
    });
  });

  describe('clear', () => {
    it('does not reuse global message ids or reset the allocator after clearing transcript rows', () => {
      const old = store.append({ role: 'user', content: 'Old' });
      const sequencePath = join(TEST_DIR, 'message-sequence.json');
      const before = JSON.parse(readFileSync(sequencePath, 'utf8'));
      store.clear();
      const afterClear = JSON.parse(readFileSync(sequencePath, 'utf8'));
      const msg = new ConversationStore(TEST_DIR).append({ role: 'user', content: 'New' });

      expect(afterClear).toEqual(before);
      expect(Number(msg.id.slice(1))).toBeGreaterThan(Number(old.id.slice(1)));
    });
  });

  // ─── Legacy flat dir regression guard: the legacy
  //     conversation/messages/ and conversation/cold/ flat directories
  //     are NEVER scanned when loading session history.  All session
  //     messages now live exclusively in per-session directories, and
  //     scanning the flat dirs would be a pure-performance regression.
  describe('legacy dir is never scanned', () => {
    function writeLegacyMessage(baseDir, seq, sessionId, role, content) {
      const msgDir = join(baseDir, 'conversation', 'messages');
      mkdirSync(msgDir, { recursive: true });
      const id = `m${String(seq).padStart(4, '0')}`;
      const raw = `---
id: ${id}
role: ${role}
time: 2026-06-21T10:00:00Z
threadId: main
sessionId: ${sessionId}
tokens_est: 5
---

${content}`;
      writeFileSync(join(msgDir, `${id}.md`), raw, { encoding: 'utf8', mode: 0o644 });
    }

    it('loadVisibleBySession respects turn window without legacy interference', () => {
      const store = new ConversationStore(TEST_DIR);
      writeLegacyMessage(TEST_DIR, 1, 'grp_window', 'user', 'legacy');

      // Write 3 dedicated user turns.
      store.append({ role: 'user', content: 'turn0', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply0', sessionId: 'grp_window' });
      store.append({ role: 'user', content: 'turn1', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply1', sessionId: 'grp_window' });
      store.append({ role: 'user', content: 'turn2', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply2', sessionId: 'grp_window' });

      // Limit to 2 turns — only turn1 and turn2 should appear.
      const visible = store.loadVisibleBySession('grp_window', null, 2);
      expect(visible.messages.map(m => m.content)).toEqual([
        'turn1', 'reply1', 'turn2', 'reply2',
      ]);
      expect(visible.hasMore).toBe(true);
    });
  });
});
