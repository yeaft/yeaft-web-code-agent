import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../agent/yeaft/conversation/persist.js';
import {
  closeConversationHistoryIndexes, searchConversationIndex, recallConversationTurns, __historyIndexForTest,
} from '../agent/yeaft/conversation/history-index.js';
import { extractRecallTerms, scoreRecallTurn, RECALL_LIMITS } from '../agent/yeaft/conversation/recall-relevance.js';

let root;
let store;
const sessionId = 'session_recall';
const append = (role, content, extra = {}) => store.append({ sessionId, role, content, ...extra });
const warm = (id = sessionId) => searchConversationIndex(root, id, '', { limit: 1 });
const recall = (prompt, opts) => recallConversationTurns(root, sessionId, prompt, opts);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeaft-message-recall-'));
  store = new ConversationStore(root);
});
afterEach(async () => {
  await closeConversationHistoryIndexes();
  rmSync(root, { recursive: true, force: true });
});

describe('complete Session turn recall', () => {
  it('returns full answers, aggregates interleaved VP entries and groups by user seq, not turnId', async () => {
    const user = append('user', 'Explain cedar migration', { turnId: 'user-client-turn' });
    const a1 = append('assistant', `cedar migration ${'complete answer '.repeat(100)}`, { turnId: 'vp-a-turn', speakerVpId: 'a' });
    const b = append('assistant', 'A different VP recommendation', { turnId: 'vp-b-turn', speakerVpId: 'b' });
    const a2 = append('assistant', 'Final verification without keyword', { turnId: 'vp-a-turn', speakerVpId: 'a' });
    append('user', 'Next unrelated topic');
    append('assistant', 'Do not include me');
    await warm();
    const result = await recall('What did we decide about cedar migration?');
    expect(result.turns).toHaveLength(1);
    const [turn] = result.turns;
    expect(turn.userSeq).toBe(store.getMessageSeqById(user.id));
    expect(turn.messages).toHaveLength(3);
    expect(turn.messages[0]).toMatchObject({ role: 'user', sourceMessageIds: [user.id], sessionId });
    const vpA = turn.messages.find(message => message.speakerVpId === 'a');
    expect(vpA.sourceMessageIds).toEqual([a1.id, a2.id]);
    expect(vpA.content).toBe(`${a1.content.trim()} ${a2.content}`);
    expect(turn.messages.find(message => message.speakerVpId === 'b').sourceMessageIds).toEqual([b.id]);
    expect(turn.id).toBe(turn.messages[0].id);
    expect(turn.score).toBeGreaterThan(0);
    expect(turn.matchedTerms).toEqual(['cedar', 'migration']);
    expect(result.meta).toMatchObject({ status: 'ready', reason: 'matched', limits: { limit: 8 } });
    expect(turn.messages.every(message => !Object.hasOwn(message, 'snippet'))).toBe(true);
  });

  it('finds assistant-only matches, preserves repeated questions and distinct source identities', async () => {
    const users = [];
    for (let i = 0; i < 3; i += 1) {
      users.push(append('user', 'Tell me more'));
      append('assistant', `retry_budget is ${i}`, { turnId: 'reused-vp-id', speakerVpId: 'a' });
    }
    await warm();
    const result = await recall('Revisit retry_budget');
    expect(result.turns).toHaveLength(3);
    expect(new Set(result.turns.map(turn => turn.id)).size).toBe(3);
    expect(result.turns.map(turn => turn.messages[0].sourceMessageIds[0])).toEqual(users.map(user => user.id).reverse());
    expect(result.turns.every(turn => turn.messages.length === 2)).toBe(true);
  });

  it('excludes internal/model-only/tool text and isolates Session and owner roots', async () => {
    const user = append('user', 'cedar migration');
    append('user', 'private_marker', { internal: true });
    append('user', 'private_marker', { userAuthored: false });
    append('user', '<task-result id="x">private_marker</task-result>');
    append('assistant', 'private_marker', { _reflection: true });
    append('assistant', [{ type: 'text', text: 'Visible answer' }, { type: 'tool_use', name: 'private_marker', input: {} }]);
    append('tool', 'private_marker');
    append('user', 'cedar migration', { sessionId: 'session_other' });
    append('assistant', 'other owner secret', { sessionId: 'session_other' });
    await warm();
    const result = await recall('cedar migration');
    expect(result.turns[0].messages.map(message => message.content)).toEqual(['cedar migration', 'Visible answer']);
    expect(result.turns[0].messages[0].sourceMessageIds).toEqual([user.id]);
    expect((await recall('private_marker')).turns).toEqual([]);
    const otherRoot = join(root, 'other-owner');
    const otherStore = new ConversationStore(otherRoot);
    otherStore.append({ role: 'user', content: 'unrelated topic', sessionId });
    await searchConversationIndex(otherRoot, sessionId, '', { limit: 1 });
    expect((await recallConversationTurns(otherRoot, sessionId, 'cedar migration')).turns).toEqual([]);
  });

  it('rejects generic prompts, single ordinary terms and unrelated matches; supports Chinese and identifiers', async () => {
    append('user', '缓存失效策略：按租户隔离');
    append('assistant', '失效策略使用版本号');
    await warm();
    expect(extractRecallTerms('之前消息说了什么，请帮我回忆一下')).toEqual([]);
    expect(extractRecallTerms('之前讨论的缓存失效策略是什么？')).toEqual(expect.arrayContaining(['缓存', '失效', '策略']));
    for (const query of ['之前消息说了什么，请帮我回忆一下', 'What was the project?', '缓存', 'quartz rollout']) {
      expect((await recall(query)).turns).toEqual([]);
    }
    expect((await recall('之前讨论的缓存失效策略是什么？')).turns).toHaveLength(1);
    expect(scoreRecallTurn('retry_budget', 'retry_budget=4').score).toBeGreaterThan(0);
    expect(scoreRecallTurn('cedar migration', 'cedar migrants').score).toBe(0);
    expect(scoreRecallTurn('cache caching', 'caching cache').score).toBeGreaterThan(0);
    expect(scoreRecallTurn('cedar migration', 'cedar migration', {
      sampleSize: 10, termDocumentFrequency: { cedar: 10, migration: 10 },
    })).toMatchObject({ score: 0, reason: 'low_distinctiveness' });
  });

  it('applies an exclusive seq fence and skips rather than truncates a straddling turn', async () => {
    const first = append('user', 'cedar migration');
    const reply = append('assistant', 'cedar migration answer');
    const second = append('user', 'cedar migration');
    append('assistant', 'second answer');
    await warm();
    const result = await recall('cedar migration', { beforeSeq: store.getMessageSeqById(second.id) });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].messages[0].sourceMessageIds).toEqual([first.id]);
    expect((await recall('cedar migration', { beforeSeq: store.getMessageSeqById(first.id) })).turns).toEqual([]);
    const partial = await recall('cedar migration', { beforeSeq: store.getMessageSeqById(reply.id) });
    expect(partial.turns).toEqual([]);
    expect(partial.meta.skippedFencedTurns).toBe(1);
  });

  it('skips whole oversized turns under row, byte and request budgets; clamps limits', async () => {
    append('user', 'recall_marker');
    append('assistant', `oversized ${'x'.repeat(RECALL_LIMITS.maxTurnBytes + 1)}`);
    append('user', 'recall_marker');
    for (let i = 0; i < RECALL_LIMITS.maxTurnRows; i += 1) append('assistant', `row ${i}`);
    for (let i = 0; i < 12; i += 1) {
      append('user', 'recall_marker');
      append('assistant', `bounded answer ${i}`);
    }
    await warm();
    const result = await recall('recall_marker', { limit: 999 });
    expect(result.turns).toHaveLength(10);
    expect(result.meta.skippedOversizedTurns).toBe(2);
    expect(result.meta.readBytes).toBeLessThanOrEqual(RECALL_LIMITS.maxReadBytes);
    expect(result.turns.every(turn => turn.messages.length === 2)).toBe(true);
    const tiny = await recall('recall_marker', { maxTurnBytes: 10 });
    expect(tiny.turns).toEqual([]);
    expect(tiny.meta.readBytes).toBe(0);
    const oneRow = await recall('recall_marker', { maxTurnRows: 1 });
    expect(oneRow.turns).toEqual([]);
    const small = await recall('recall_marker', { maxReadBytes: 100 });
    expect(small.meta.readBytes).toBeLessThanOrEqual(100);
    expect(small.turns.every(turn => turn.messages.length === 2)).toBe(true);
  });

  it('makes progress after a cold call and rebuilds same-seq edits without serving stale answers', async () => {
    append('user', 'cedar migration');
    const assistant = append('assistant', 'original answer');
    expect(await recall('cedar migration')).toMatchObject({ turns: [], meta: { status: 'not_ready', reason: 'index_building' } });
    // No explicit search/warm between recalls: join the in-flight cold build.
    expect((await recall('cedar migration')).turns).toHaveLength(1);
    store.update(assistant, { content: 'changed answer' });
    const current = await recall('cedar migration');
    expect(current.meta.status).toBe('ready');
    expect(current.turns[0].messages[1].content).toBe('changed answer');
    // Raw edits bypass mutation revision; the worker's source fingerprint must
    // still refuse the stale full answer, even when the seq and size are equal.
    const segments = join(root, 'sessions', sessionId, 'conversation', 'segments');
    const path = join(segments, readdirSync(segments).find(name => name.endsWith('.jsonl')));
    writeFileSync(path, readFileSync(path, 'utf8').replace('changed answer', 'mutated answer'));
    expect(await recall('cedar migration')).toMatchObject({ turns: [], meta: { status: 'not_ready', reason: 'stale_result' } });
    // A raw-source mismatch schedules work too; the next recall joins it.
    expect((await recall('cedar migration')).turns[0].messages[1].content).toBe('mutated answer');
  });

  it('recalls complete older turns after persisting each new user, without an intervening warm/search', async () => {
    const original = append('user', 'cedar migration', { clientMessageId: 'client-original' });
    append('assistant', 'First VP plan', { turnId: 'vp-a-first', speakerVpId: 'a' });
    append('assistant', 'Second VP verification', { turnId: 'vp-b-first', speakerVpId: 'b' });
    await warm();
    for (let i = 0; i < 3; i += 1) {
      // Engine ordering: durable user append, exclusive seq fence, then recall.
      const current = append('user', 'Revisit cedar migration', { clientMessageId: `client-${i}` });
      const result = await recall(current.content, { beforeSeq: store.getMessageSeqById(current.id) });
      expect(result.meta.status).toBe('ready');
      const first = result.turns.find(turn => turn.messages[0].sourceMessageIds.includes(original.id));
      expect(first.messages.map(message => message.content)).toEqual([
        'cedar migration', 'First VP plan', 'Second VP verification',
      ]);
      expect(result.turns.flatMap(turn => turn.messages).every(message => !message.sourceMessageIds.includes(current.id))).toBe(true);
      append('assistant', `Follow-up answer ${i}`, { turnId: `vp-a-${i}`, speakerVpId: 'a' });
    }
  });

  it('never trusts an old prefix after clear followed by append, even when seqs are reused', async () => {
    append('user', 'cedar migration');
    append('assistant', 'deleted private answer');
    await warm();
    store.clear();
    append('user', 'cedar migration');
    append('assistant', 'replacement answer');
    const current = append('user', 'Revisit cedar migration');
    const result = await recall(current.content, { beforeSeq: store.getMessageSeqById(current.id) });
    expect(result.meta.status).toBe('ready');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].messages.map(message => message.content)).toEqual(['cedar migration', 'replacement answer']);
    expect(JSON.stringify(result)).not.toContain('deleted private answer');
  });

  it('times out joining a slow rebuild, leaves it running, and uses its completed generation next time', async () => {
    append('user', 'cedar migration');
    append('assistant', 'original answer');
    await warm();
    const manager = [...__historyIndexForTest.managers.values()].find(item => item.ownerRoot === root);
    // Hold a real query worker so rebuilding must wait for its outstanding
    // request during graceful generation retirement (normally nearly instant).
    const barrier = new SharedArrayBuffer(8);
    const view = new Int32Array(barrier);
    const held = manager.active.request('recall-turns', { prompt: 'cedar migration', _testBarrier: barrier });
    let rebuilding;
    try {
      const deadline = Date.now() + 5000;
      while (!Atomics.load(view, 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(Atomics.load(view, 0)).toBe(1);
      append('user', 'A fresh query');
      const started = Date.now();
      expect(await recall('cedar migration')).toMatchObject({ turns: [], meta: { status: 'not_ready', reason: 'index_building' } });
      expect(Date.now() - started).toBeLessThan(2500);
      rebuilding = manager.rebuildPromise;
      expect(rebuilding).toBeInstanceOf(Promise);
    } finally {
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      await held;
      await rebuilding;
    }
    expect((await recall('cedar migration')).turns[0].messages[1].content).toBe('original answer');
  });

  it('matches terms across messages, omits orphan assistant entries and bounds frequent candidates', async () => {
    append('assistant', 'cedar migration without a visible user');
    append('user', 'cedar');
    append('assistant', 'migration details');
    for (let i = 0; i < 40; i += 1) {
      append('user', 'frequent_marker');
      append('assistant', `answer ${i}`);
    }
    await warm();
    const split = await recall('cedar migration');
    expect(split.turns).toHaveLength(1);
    expect(split.turns[0].messages.map(message => message.content)).toEqual(['cedar', 'migration details']);
    const bounded = await recall('frequent_marker');
    expect(bounded.meta.candidateCapped).toBe(true);
    expect(bounded.meta.candidateRowsRead).toBeLessThanOrEqual(RECALL_LIMITS.candidatesPerTerm);
    expect(bounded.meta.boundaryRowsRead).toBeLessThanOrEqual(RECALL_LIMITS.maxBoundaryRows);
    expect(bounded.meta.turnRowsRead).toBeLessThanOrEqual(RECALL_LIMITS.maxCandidates * (RECALL_LIMITS.maxTurnRows + 1));
    expect(bounded.meta.readBytes).toBeLessThanOrEqual(RECALL_LIMITS.maxReadBytes);
    expect(bounded.turns).toHaveLength(8);
  });

  it('reports bounded discovery, not exhaustive recall, for trigram prefixes and two-character Chinese terms', async () => {
    append('user', 'cedar migration');
    append('assistant', 'An older exact English match');
    append('user', '缓存失效策略');
    append('assistant', 'An older exact Chinese match');
    for (let i = 0; i < RECALL_LIMITS.shortTermRows / 2 + 1; i += 1) {
      // Both edge trigrams match, but neither full English term does. The
      // fixed prefix must not turn into an unbounded scan for exact matches.
      append('user', `cedxxdar migxxion ${i}`);
      append('assistant', `Unrelated reply ${i}`);
    }
    await warm();
    const english = await recall('cedar migration');
    expect(english.turns).toEqual([]);
    expect(english.meta).toMatchObject({ status: 'ready', reason: 'no_match', candidateCapped: true });
    expect(english.meta.candidateRowsRead).toBe(RECALL_LIMITS.candidatesPerTerm * 2);
    const chinese = await recall('缓存失效策略');
    expect(chinese.turns).toEqual([]);
    expect(chinese.meta).toMatchObject({ status: 'ready', reason: 'no_match', candidateCapped: true });
    expect(chinese.meta.candidateRowsRead).toBe(RECALL_LIMITS.shortTermRows);
  });

  it('fences a source mutation during worker recall without returning old turns', async () => {
    append('user', 'cedar migration');
    const assistant = append('assistant', 'old answer');
    await warm();
    const barrier = new SharedArrayBuffer(8);
    const view = new Int32Array(barrier);
    const pending = recall('cedar migration', { _testBarrier: barrier });
    try {
      const deadline = Date.now() + 5000;
      while (!Atomics.load(view, 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(Atomics.load(view, 0)).toBe(1);
      store.update(assistant, { content: 'new answer' });
    } finally {
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
    }
    expect(await pending).toMatchObject({ turns: [], meta: { status: 'not_ready', reason: 'stale_result' } });
  });
});
