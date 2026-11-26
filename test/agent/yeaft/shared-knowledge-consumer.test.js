import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import * as bridge from '../../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import tool from '../../../agent/yeaft/tools/shared-knowledge-search.js';
import { searchSharedKnowledge } from '../../../agent/yeaft/shared-knowledge/store.js';

vi.mock('../../../agent/yeaft/shared-knowledge/store.js', () => ({ searchSharedKnowledge: vi.fn() }));

const capability = 'session_shared_knowledge';
const source = { sessionId: 'owned-prior', seq: 4, messageId: 'm000004' };
const fixture = { id: 'k1', dimension: 'decision', title: 'Fixture decision', body: 'REFERENCE_FIXTURE',
  tags: ['fixture'], updatedAt: 1, sources: [source] };
const originalCtx = { ...ctx };
let root;
afterEach(async () => {
  await bridge.__testResetVpState();
  bridge.__testSetSession(null);
  await closeConversationHistoryIndexes();
  Object.assign(ctx, originalCtx);
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  searchSharedKnowledge.mockReset();
});

it('keeps lookup on demand and delivers authority only on trusted direct and assigned Cosmos turns', async () => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-consumer-'));
  const store = new ConversationStore(root);
  const existing = createSessionFromSpec(root, { name: 'Direct fixture', sceneId: 'general' });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(tool);
  searchSharedKnowledge.mockReturnValue([fixture]);
  Object.assign(ctx, { CONFIG: { yeaftDir: root, workDir: root }, serverCapabilities: new Set([capability]),
    ws: { readyState: 1, send() {} }, serverEncryptionRequired: false,
    outboundSendQueue: [], outboundSendQueueBytes: 0, outboundSendQueueActive: false,
    messageBuffer: [], messageBufferBytes: 0 });

  const requests = [];
  const decision = vi.fn(async () => ({ text: JSON.stringify({ title: 'New fixture', sceneId: 'general', workDir: '' }) }));
  bridge.__testSetSession({ yeaftDir: root, conversationStore: store, trace: new NullTrace(), toolRegistry,
    config: { model: 'test-model', decisionModel: 'test-model', maxOutputTokens: 1024 },
    adapter: { call: decision, async *stream(params) {
      const last = params.messages.at(-1);
      const available = params.tools?.some(t => t.name === tool.name) ?? false;
      requests.push({ last, available, system: params.system });
      if (available && last.role === 'user' && JSON.stringify(last.content).includes('lookup')) {
        yield { type: 'tool_call', id: `search-${requests.length}`, name: tool.name, input: { query: 'fixture' } };
        yield { type: 'stop', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'Fixture answer.' };
      yield { type: 'stop', stopReason: 'end_turn' };
    } },
  });
  const send = async (id, text, auth = {}) => {
    const start = requests.length;
    await bridge.handleYeaftSessionSend({ id, text, sessionId: existing.id, ...auth });
    await bridge.__testDrainVpDrivers();
    return requests.slice(start);
  };
  const authority = { _knowledgeSessionIds: [existing.id, source.sessionId] };
  expect((await send('no-lookup', 'Say hello', authority))[0]).toMatchObject({ available: true });
  expect(searchSharedKnowledge).not.toHaveBeenCalled();
  const [initial, afterTool] = await send('direct', 'lookup direct knowledge', authority);
  expect(initial.available).toBe(true);
  expect(initial.system).not.toContain(fixture.body);
  expect(JSON.stringify(afterTool.last)).toContain(fixture.body);
  const userRow = store.loadAllBySession(existing.id).find(row => row.content === 'lookup direct knowledge');
  expect(searchSharedKnowledge).toHaveBeenLastCalledWith(root, authority._knowledgeSessionIds, expect.objectContaining({
    query: 'fixture', sessionId: existing.id, beforeSeq: Number(userRow.id.slice(1)), signal: expect.any(AbortSignal),
  }));
  expect(userRow).not.toHaveProperty('_knowledgeSessionIds');
  expect((await send('classic', 'lookup classic', { _agentSessionIds: [source.sessionId] }))[0].available).toBe(false);
  ctx.serverCapabilities = new Set();
  expect((await send('old-server', 'lookup old server', authority))[0].available).toBe(false);
  expect(searchSharedKnowledge).toHaveBeenCalledTimes(1);

  ctx.serverCapabilities.add(capability);
  const routed = await bridge.handleYeaftAutoRouteSend({ id: 'quick', text: 'lookup after assignment', forceNew: true,
    _allowedSessionIds: [], _knowledgeSessionIds: [source.sessionId] });
  await bridge.__testDrainVpDrivers();
  expect(routed.decision).toBe('created');
  expect(decision).toHaveBeenCalled();
  expect(JSON.stringify(decision.mock.calls)).not.toContain(source.sessionId);
  expect(JSON.stringify(decision.mock.calls)).not.toContain(fixture.body);
  expect(searchSharedKnowledge).toHaveBeenCalledTimes(2);
  expect(searchSharedKnowledge).toHaveBeenLastCalledWith(root, [source.sessionId], expect.objectContaining({
    sessionId: routed.sessionId, beforeSeq: expect.any(Number),
  }));
});

it('rejects missing authority and cancelled or oversized queries, and bounds referenced content', async () => {
  const context = { yeaftDir: 'test-root', sessionId: 'target', historyBeforeSeq: 8, knowledgeSessionIds: [source.sessionId] };
  const input = { query: 'fixture', limit: 1, allowedIds: ['untrusted'], sessionId: 'forged', beforeSeq: 50 };
  expect(tool.isReadOnly()).toBe(true);
  expect(JSON.parse(await tool.execute(input, { ...context, knowledgeSessionIds: [] }))).toHaveProperty('error');
  expect(JSON.parse(await tool.execute(input, { ...context, historyBeforeSeq: NaN }))).toHaveProperty('error');
  expect(JSON.parse(await tool.execute(input, { ...context, signal: AbortSignal.abort() }))).toHaveProperty('error');
  expect(JSON.parse(await tool.execute({ query: 'x'.repeat(1025) }, context))).toHaveProperty('error');
  expect(searchSharedKnowledge).not.toHaveBeenCalled();
  searchSharedKnowledge.mockReturnValue([{ ...fixture, body: '🚀'.repeat(20000) }]);
  const output = await tool.execute(input, context);
  expect(searchSharedKnowledge).toHaveBeenCalledWith('test-root', [source.sessionId], {
    query: 'fixture', limit: 1, sessionId: 'target', beforeSeq: 8, signal: undefined,
  });
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32 * 1024);
  expect(JSON.parse(output)).toMatchObject({ truncated: true, results: [{ id: fixture.id, sources: [source] }] });
});
