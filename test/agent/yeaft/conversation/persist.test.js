import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
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

describe('ConversationStore', () => {
  let store;

  beforeEach(() => {
    store = new ConversationStore(TEST_DIR);
  });

  describe('append', () => {
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

      // Terminate only this test-owned writer while it owns both locks. The
      // next processes must recover automatically without overlapping ranges.
      const crashing = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { DatabaseSync } from 'node:sqlite';
        import { mkdirSync, writeFileSync } from 'node:fs';
        import { hostname } from 'node:os';
        import { join } from 'node:path';
        const root = process.env.CONVERSATION_ROOT;
        const db = new DatabaseSync(join(root, 'message-sequence-lock.db'));
        db.exec('BEGIN IMMEDIATE');
        const lock = join(root, 'message-sequence.lock');
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({pid: process.pid, host: hostname(), token: 'crashed'}));
        console.log('locked');
        setInterval(() => {}, 1000);
      `], { env: { ...process.env, CONVERSATION_ROOT: TEST_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolveChild, rejectChild) => {
        const timer = setTimeout(() => { crashing.kill('SIGKILL'); rejectChild(new Error('Crash fixture did not acquire locks')); }, 5000);
        crashing.stdout.once('data', () => { clearTimeout(timer); resolveChild(); });
        crashing.once('error', error => { clearTimeout(timer); rejectChild(error); });
      });
      const exited = new Promise(resolveChild => crashing.once('exit', resolveChild));
      crashing.kill('SIGKILL');
      await exited;
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
  });

});

describe('Session turn deletion', () => {
  it('removes an interleaved supplemented turn, rebuilding search while preserving neighboring rows and fork history', async () => {
    const { searchMessages } = await import('../../../../agent/yeaft/conversation/search.js');
    const { searchConversationIndex, recallConversationTurns, loadConversationOutlineFromIndex } = await import('../../../../agent/yeaft/conversation/history-index.js');
    const store = new ConversationStore(TEST_DIR);
    const sessionId = 'session_turn_delete';
    const push = (role, content, extra) => store.append({ sessionId, role, content, ...extra });
    const root = push('user', 'tombstone zebra alpha', { userTurnId: 'target', clientMessageId: 'target' });
    const call = push('assistant', '', { userTurnId: 'target', turnId: 'del-vp1', toolCalls: [{ id: 'tool', name: 'read', input: {} }] });
    const neighboring = push('user', 'retain unrelated question', { userTurnId: 'keep', clientMessageId: 'keep' });
    const append = push('user', 'tombstone zebra supplement', { userTurnId: 'target', relation: 'supplement', clientMessageId: 'append' });
    const tool = push('tool', 'tombstone zebra tool', { turnId: 'del-vp1', toolCallId: 'tool' });
    const answer = push('assistant', 'tombstone zebra answer', { userTurnId: 'target', turnId: 'del-vp2' });
    const keptAnswer = push('assistant', 'retain valid answer', { userTurnId: 'keep', turnId: 'keep-vp' });
    const reflection = store.foldMessages([call, tool], { sessionId, role: 'user', content: 'tombstone reflection', _reflection: true });
    const quote = push('user', 'retain reference question', { userTurnId: 'quote', quote: { id: answer.id, content: 'tombstone zebra answer' } });
    const copied = 'session_earlier_copy';
    store.copySession(sessionId, copied);
    const before = store.getSessionHistoryMetadata(sessionId);
    expect((await searchConversationIndex(TEST_DIR, sessionId, 'zebra')).results.length).toBeGreaterThan(0);
    const result = store.deleteSessionTurn(sessionId, append.id);
    expect(new Set(result.messageIds)).toEqual(new Set([root.id, call.id, tool.id, append.id, answer.id, reflection.id]));
    expect(result.executionIds).toEqual(['del-vp1', 'del-vp2']);
    expect(store.deleteSessionTurn(sessionId, root.id)).toEqual(result);
    // Simulate process loss before the physical rewrite: search and forks must
    // already see the committed deletion, including legacy/raw search paths.
    const restart = new ConversationStore(TEST_DIR);
    expect(restart.getSessionHistoryMetadata(sessionId).streamId).not.toBe(before.streamId);
    expect(restart.loadVisibleBySession(sessionId, null, 20).messages.map(row => row.id)).toEqual([neighboring.id, keptAnswer.id, quote.id]);
    expect(searchMessages(TEST_DIR, 'zebra', 20, { sessionIds: [sessionId] })).toEqual([]);
    expect((await searchConversationIndex(TEST_DIR, sessionId, 'zebra')).results).toEqual([]);
    expect((await recallConversationTurns(TEST_DIR, sessionId, 'tombstone zebra', { beforeSeq: quote.seq + 1 })).turns).toEqual([]);
    expect(restart.loadAllBySession(sessionId).at(-1)).not.toHaveProperty('quote');
    push('assistant', 'tombstone late-write', { causalRootId: root.id, turnId: 'old-cli-tail' });
    const outline = await loadConversationOutlineFromIndex(TEST_DIR, sessionId);
    expect(JSON.stringify(outline)).not.toContain('zebra');
    expect(searchMessages(TEST_DIR, 'late-write', 20, { sessionIds: [sessionId] })).toEqual([]);
    expect(restart.loadAllBySession(copied).some(row => row.content.includes('tombstone zebra alpha'))).toBe(true);
    restart.copySession(sessionId, 'session_post_delete_copy');
    expect(restart.loadAllBySession('session_post_delete_copy').map(row => row.content))
      .toEqual(['retain unrelated question', 'retain valid answer', 'retain reference question']);
    restart.pruneDeletedSessionTurnRows(sessionId);
    const segment = join(TEST_DIR, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl');
    expect(readFileSync(segment, 'utf8')).not.toContain('tombstone');
    expect(push('user', 'after deletion', {}).seq).toBeGreaterThan(quote.seq);
  });

  it('does not delete by text, assistant ID, or ambiguous legacy ownership', () => {
    const store = new ConversationStore(TEST_DIR);
    const sessionId = 'session_legacy_delete';
    const push = (role, content, extra) => store.append({ sessionId, role, content, ...extra });
    const first = push('user', 'same prompt', { clientMessageId: 'legacy-id', time: '2026-01-01T00:00:00.000Z' });
    const second = push('user', 'same prompt', { clientMessageId: 'legacy-id', time: '2026-01-02T00:00:00.000Z' });
    const response = push('assistant', 'ambiguous causal owner', { causalRootId: 'legacy-id' });
    expect(() => store.deleteSessionTurn(sessionId, response.id)).toThrow(expect.objectContaining({ code: 'message_not_found' }));
    expect(() => store.deleteSessionTurn(sessionId, second.id)).toThrow(expect.objectContaining({ code: 'ambiguous_turn' }));
    expect(store.loadAllBySession(sessionId).map(row => row.id)).toEqual([first.id, second.id, response.id]);
  });

  it('refuses both legacy roots when an unowned VP execution straddles their boundary', () => {
    const store = new ConversationStore(TEST_DIR);
    const sessionId = 'session_straddled';
    const push = (role, content, extra) => store.append({ sessionId, role, content, ...extra });
    const a = push('user', 'first request');
    const first = push('assistant', 'A first output', { turnId: 'legacy-a', speakerVpId: 'omni' });
    const b = push('user', 'second request');
    const late = push('assistant', 'A trailing output', { turnId: 'legacy-a', speakerVpId: 'omni' });
    const last = push('assistant', 'B output', { turnId: 'legacy-b', speakerVpId: 'omni' });
    for (const id of [a.id, b.id]) {
      expect(() => store.deleteSessionTurn(sessionId, id)).toThrow(expect.objectContaining({ code: 'ambiguous_turn' }));
    }
    expect(store.loadAllBySession(sessionId).map(row => row.id)).toEqual([a.id, first.id, b.id, late.id, last.id]);
  });

  it('refuses deletion when a legacy execution starts emitting only after the next user question', () => {
    const store = new ConversationStore(TEST_DIR);
    const sessionId = 'session_delayed_legacy';
    const push = (role, content, extra) => store.append({ sessionId, role, content, ...extra });
    const a = push('user', 'first request');
    const b = push('user', 'second request');
    const lateA = push('assistant', 'A delayed output', { turnId: 'legacy-a', speakerVpId: 'omni' });
    const lastB = push('assistant', 'B output', { turnId: 'legacy-b', speakerVpId: 'omni' });
    for (const id of [a.id, b.id]) {
      expect(() => store.deleteSessionTurn(sessionId, id)).toThrow(expect.objectContaining({ code: 'ambiguous_turn' }));
    }
    expect(store.loadAllBySession(sessionId).map(row => row.id)).toEqual([a.id, b.id, lateA.id, lastB.id]);
  });

  it('reserves deleted Markdown IDs durably before prune and recovers them without the sequence sidecar', () => {
    const sessionId = 'session_markdown_prune';
    const store = new ConversationStore(TEST_DIR);
    const dir = join(TEST_DIR, 'sessions', sessionId, 'conversation', 'messages');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'm0100.md');
    writeFileSync(old, `---\nid: m0100\nrole: user\nsessionId: ${sessionId}\n---\n\nOld Markdown prompt`);
    const sequencePath = join(TEST_DIR, 'message-sequence.json');
    expect(existsSync(sequencePath)).toBe(false);
    store.deleteSessionTurn(sessionId, 'm0100');
    store.pruneDeletedSessionTurnRows(sessionId);
    expect(existsSync(old)).toBe(false);
    expect(JSON.parse(readFileSync(sequencePath, 'utf8')).nextSeq).toBeGreaterThan(100);
    rmSync(sequencePath);
    const reopened = new ConversationStore(TEST_DIR);
    const kept = reopened.append({ sessionId, role: 'user', content: 'New unrelated prompt' });
    expect(kept.seq).toBeGreaterThan(100);
    reopened.pruneDeletedSessionTurnRows(sessionId);
    expect(new ConversationStore(TEST_DIR).loadAllBySession(sessionId).map(row => [row.id, row.content]))
      .toEqual([[kept.id, 'New unrelated prompt']]);
  });

});
