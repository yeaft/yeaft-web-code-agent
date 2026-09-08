import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes, searchConversationIndex } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { writeContent } from '../../../agent/yeaft/memory/store.js';

class MockAdapter {
  calls = [];
  responses = [];
  async *stream(params) {
    this.calls.push({ ...params, messages: structuredClone(params.messages) });
    for (const event of this.responses.shift() || [
      { type: 'text_delta', text: 'done' }, { type: 'stop', stopReason: 'end_turn' },
    ]) yield event;
  }
}
let root;
let store;
let adapter;
let trace;
const sessionId = 'session_engine_recall';
const append = (role, content, extra = {}) => store.append({ role, content, sessionId, ...extra });
const texts = call => call.messages.map(m => m.content);
const warm = () => searchConversationIndex(root, sessionId, '', { limit: 1 });
const run = async (engine, params = {}) => {
  const events = [];
  for await (const event of engine.query({ sessionId, prompt: 'Revisit retry_budget', ...params })) events.push(event);
  expect(events.filter(e => e.type === 'error')).toEqual([]);
  expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toHaveLength(1);
  return events;
};
const createEngine = (config = {}) => new Engine({
  adapter, conversationStore: store, yeaftDir: root, sessionId, trace,
  config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 128000,
    messageTokenBudget: 12000, archive: { toolResults: false }, ...config },
});
function seed(recentCount = 25) {
  const old = append('user', 'Revisit retry_budget', { clientMessageId: 'earlier-client' });
  append('assistant', 'Old retry_budget answer, complete and useful.');
  for (let i = 0; i < recentCount; i += 1) {
    append('user', `Recent question ${i}`);
    append('assistant', `Recent answer ${i}`);
  }
  return old;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeaft-engine-recall-'));
  store = new ConversationStore(root);
  adapter = new MockAdapter();
  trace = new NullTrace();
  trace.log = vi.fn();
});
afterEach(async () => {
  await closeConversationHistoryIndexes();
  rmSync(root, { recursive: true, force: true });
});

describe('Engine canonical message recall integration', () => {
  it('recalls warm append-only history in old/recent/current order without replacing repeated prompts', async () => {
    const old = seed();
    await warm();
    const before = store.loadAllBySession(sessionId);
    // Matches the bridge: append accepted input before entering Engine, then
    // pass its durable identity alongside an incomplete runtime snapshot.
    const current = append('user', 'Revisit retry_budget', { clientMessageId: 'new-client' });
    await run(createEngine(), { userAlreadyPersisted: true, currentUserMessage: current,
      messages: [{ role: 'user', content: 'lossy bridge placeholder' }] });
    const call = adapter.calls[0];
    expect(texts(call)).toEqual([
      old.content, 'Old retry_budget answer, complete and useful.',
      ...Array.from({ length: 20 }, (_, i) => [`Recent question ${i + 5}`, `Recent answer ${i + 5}`]).flat(),
      current.content,
    ]);
    expect(call.messages.filter(m => m.content === current.content)).toHaveLength(2);
    const meta = trace.log.mock.calls.find(([name]) => name === 'history_buckets')[1];
    expect(meta.recent.turnCount).toBe(20);
    expect(meta.related.turnCount).toBe(1);
    expect(meta.budget.relatedTurnCap).toBe(8);
    expect(store.loadAllBySession(sessionId).slice(0, before.length)).toEqual(before);
    expect(store.loadAllBySession(sessionId).filter(m => m.role === 'user' && m.content === current.content)).toHaveLength(2);
  });

  it('uses the client identity fallback, not equal prompt text, to fence the canonical tail', async () => {
    seed(3);
    await warm();
    const current = append('user', 'Revisit retry_budget', { clientMessageId: 'client-current' });
    append('user', 'FUTURE QUESTION');
    append('assistant', 'FUTURE ANSWER');
    await run(createEngine(), { userAlreadyPersisted: true,
      inboundEnvelope: { msg: { meta: { clientMessageId: current.clientMessageId } } } });
    expect(texts(adapter.calls[0])).not.toContain('FUTURE QUESTION');
    expect(texts(adapter.calls[0])).not.toContain('FUTURE ANSWER');
    expect(texts(adapter.calls[0]).filter(text => text === current.content)).toHaveLength(2);
  });

  it.each([1, 25])('anchors 20 recent turns before current input despite %i queued future turns', async futureCount => {
    seed(20);
    const current = append('user', 'Revisit retry_budget', { clientMessageId: 'queued-current' });
    for (let i = 0; i < futureCount; i += 1) {
      append('user', `Future question ${i}`);
      append('assistant', `Future answer ${i}`);
    }
    await run(createEngine({ yeaft: { recentTurnsLimit: 20, relatedTurnsLimit: 0 } }), {
      userAlreadyPersisted: true, currentUserMessage: current,
    });
    expect(texts(adapter.calls[0])).toEqual([
      ...Array.from({ length: 20 }, (_, i) => [`Recent question ${i}`, `Recent answer ${i}`]).flat(),
      current.content,
    ]);
  });

  it('degrades cold index to recent rows and never auto-loads Dream Session history', async () => {
    seed();
    await writeContent({ kind: 'session', id: sessionId }, 'DREAM_PRIVATE_HISTORY', { root: join(root, 'memory') });
    await run(createEngine());
    expect(texts(adapter.calls[0])).not.toContain('Old retry_budget answer, complete and useful.');
    expect(texts(adapter.calls[0])).toContain('Recent answer 24');
    expect(adapter.calls[0].system).not.toContain('DREAM_PRIVATE_HISTORY');
    expect(trace.log.mock.calls.find(([name]) => name === 'history_buckets')[1].status).toBe('not_ready');
  });

  it('projects foreign VP text across threads without foreign tool arcs, hidden rows or thinking', async () => {
    append('user', 'Previous question', { threadId: 'other-thread' });
    append('assistant', 'Other VP visible answer', { speakerVpId: 'other', threadId: 'other-thread',
      thinkingBlocks: [{ type: 'thinking', thinking: 'FOREIGN_THINKING' }],
      toolCalls: [{ id: 'foreign-tool', name: 'private', input: {} }] });
    append('tool', 'FOREIGN_TOOL_RESULT', { speakerVpId: 'other', toolCallId: 'foreign-tool' });
    append('assistant', 'HIDDEN_CONTROL', { internal: true });
    await run(createEngine(), { vpPersona: { vpId: 'ours', name: 'Ours' }, threadId: 'current-thread' });
    expect(texts(adapter.calls[0])).toContain('Other VP visible answer');
    expect(JSON.stringify(adapter.calls[0].messages)).not.toMatch(/FOREIGN_|HIDDEN_CONTROL|foreign-tool/);
  });

  it('recomputes both buckets at the second provider boundary while preserving active tool results', async () => {
    seed();
    await warm();
    adapter.responses.push([
      { type: 'tool_call', id: 'live-tool', name: 'grow_context', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    const config = { messageTokenBudget: 12000 };
    const engine = createEngine(config);
    engine.registerTool({ name: 'grow_context', description: 'grow live context',
      parameters: { type: 'object', properties: {} }, execute: async () => 'LIVE_RESULT '.repeat(200) });
    await run(engine);
    expect(adapter.calls).toHaveLength(2);
    const metas = trace.log.mock.calls.filter(([name]) => name === 'history_buckets').map(([, meta]) => meta);
    expect(metas).toHaveLength(2);
    expect(metas[1].current.originalTokenCount).toBeGreaterThan(metas[0].current.originalTokenCount);
    expect(metas[1].budget.availableHistoryTokens).toBeLessThan(metas[0].budget.availableHistoryTokens);
    expect(adapter.calls[1].messages.find(m => m.role === 'tool')).toMatchObject({
      toolCallId: 'live-tool', content: 'LIVE_RESULT '.repeat(200),
    });
    expect(texts(adapter.calls[1])).toContain('Old retry_budget answer, complete and useful.');
  });
});
