import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ctx from '../../../agent/context.js';
import * as bridge from '../../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

let root;
const gates = [];
const previous = { ...ctx };
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve();
  await bridge.__testResetVpState();
  bridge.__testSetSession(null);
  await closeConversationHistoryIndexes();
  Object.assign(ctx, previous);
  if (root) rmSync(root, { recursive: true, force: true });
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); const gate = { promise, resolve }; gates.push(gate); return gate; }
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('condition timed out'); }
function setup(adapter, roster = ['omni'], config = {}) {
  root = mkdtempSync(join(tmpdir(), 'session-parallel-'));
  seedDefaultVps(join(root, 'virtual-persons'));
  const meta = createSessionFromSpec(root, { name: 'Parallel', roster, defaultVpId: 'omni' });
  const store = new ConversationStore(root);
  ctx.CONFIG = { yeaftDir: root };
  ctx.ws = { readyState: 1, send() {} }; ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = []; ctx.outboundSendQueueActive = true;
  bridge.__testSetSession({ adapter, trace: new NullTrace(), conversationStore: store,
    config: { model: 'test-model', maxOutputTokens: 1024, ...config }, toolRegistry: new ToolRegistry(), yeaftDir: root });
  return { store, sessionId: meta.id, send: (id, text) => bridge.handleYeaftSessionSend({ sessionId: meta.id, id, text }) };
}
const frames = () => ctx.outboundSendQueue.map(item => item.msg);
const events = type => frames().filter(frame => frame.event?.type === type);

it('runs overlapping same-VP user turns with visible partial peer context, supplements and isolated stop; replays durable grouping', async () => {
  const first = deferred(); const second = deferred();
  const requests = [];
  const { send, sessionId, store } = setup({ async *stream(params) {
    requests.push(structuredClone(params.messages));
    const n = requests.length;
    if (n === 1) {
      yield { type: 'text_delta', text: 'already visible first output' };
      await Promise.race([first.promise, new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }))]);
      if (params.signal.aborted) { const error = Error('aborted'); error.name = 'AbortError'; throw error; }
    } else if (n === 2) {
      yield { type: 'text_delta', text: 'second peer visible' };
      await second.promise;
    } else yield { type: 'text_delta', text: 'supplement processed' };
    yield { type: 'stop', stopReason: 'end_turn' };
  } });
  bridge.__testSetThreadClassifier(() => ({ decision: 'unrelated', targetThreadId: null }));
  await send('root-a', 'first request');
  await until(() => frames().some(f => f.data && JSON.stringify(f.data).includes('already visible')));
  await send('root-b', 'independent request');
  await until(() => requests.length === 2);
  expect(JSON.stringify(requests[1])).toContain('already visible first output');
  const starts = events('vp_turn_start');
  expect(starts.map(f => f.userTurnId)).toEqual(['root-a', 'root-b']);
  expect(new Set(starts.map(f => f.threadId)).size).toBe(2);
  bridge.__testSetThreadClassifier(({ runningThreads }) => ({ decision: 'related', targetThreadId: runningThreads.find(t => t.userTurnId === 'root-b').threadId }));
  await send('extra-b', 'additional details');
  expect(events('user_message_routed').at(-1).event).toMatchObject({ messageId: 'extra-b', userTurnId: 'root-b', relation: 'supplement' });
  bridge.handleYeaftAbortTurn({ sessionId, turnId: starts[0].turnId });
  await until(() => events('vp_turn_end').some(f => f.turnId === starts[0].turnId));
  expect(events('vp_turn_end').some(f => f.turnId === starts[1].turnId)).toBe(false);
  second.resolve(); first.resolve();
  await bridge.__testDrainVpDrivers();
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(requests.at(-1))).toContain('additional details');
  expect(JSON.stringify(requests.at(-1))).toContain('already visible first output');
  const peerNotes = requests.at(-1).filter(row => row.role === 'user' && String(row.content).includes('[Session peer context')).map(row => row.content).join('\n');
  expect(peerNotes).toContain('state=aborted');
  expect(peerNotes.match(/already visible first output/g)).toHaveLength(1);
  const rows = store.loadAllBySession(sessionId);
  expect(rows.find(r => r.clientMessageId === 'extra-b')).toMatchObject({ userTurnId: 'root-b', relation: 'supplement' });
  expect(rows.filter(r => r.role === 'assistant').every(r => ['root-a', 'root-b'].includes(r.userTurnId))).toBe(true);
  expect(events('session_turns').some(f => f.event.turns.filter(t => t.state === 'running').length === 2)).toBe(true);
  await bridge.__testResetVpState();
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'hydrate-groups', limit: 10 });
  expect(events('session_turns').some(frame => frame.event.turns.some(turn => turn.userTurnId === 'root-b' && turn.executions.length))).toBe(true);
  const chunk = frames().find(frame => frame.type === 'yeaft_history_chunk' && frame.requestId === 'hydrate-groups');
  expect(chunk.messages.find(row => row.relation === 'supplement')).toMatchObject({ userTurnId: 'root-b' });
  const hydrated = bridge.__testGroupHistory(sessionId);
  expect(hydrated.find(r => r.content.includes('additional details'))).toMatchObject({ userTurnId: 'root-b', relation: 'supplement' });
});

it('revalidates a supplement target after classifier await instead of appending to a finished execution', async () => {
  const finish = deferred(); const classify = deferred(); let calls = 0;
  const { send } = setup({ async *stream() {
    calls++;
    yield { type: 'text_delta', text: `output ${calls}` };
    if (calls === 1) await finish.promise;
    yield { type: 'stop', stopReason: 'end_turn' };
  } });
  await send('race-a', 'first'); await until(() => calls === 1);
  let receivedAt;
  bridge.__testSetThreadClassifier(async ({ runningThreads }) => {
    receivedAt = Date.now();
    expect(runningThreads[0].summary).toContain('output 1');
    await classify.promise;
    return { decision: 'related', targetThreadId: runningThreads[0].threadId };
  });
  const pending = send('race-b', 'arrives during finish');
  await new Promise(r => setTimeout(r, 20));
  finish.resolve(); await until(() => events('vp_turn_end').length === 1);
  classify.resolve(); await pending; await bridge.__testDrainVpDrivers();
  expect(calls).toBe(2);
  const rootTurn = events('session_turns').at(-1).event.turns.find(turn => turn.userTurnId === 'race-b');
  expect(rootTurn.startedAt).toBeLessThanOrEqual(receivedAt);
  expect(events('user_message_routed').at(-1).event).toMatchObject({ userTurnId: 'race-b', relation: 'new' });
  expect(events('vp_turn_start').map(f => f.userTurnId)).toEqual(['race-a', 'race-b']);
});


it('classifies rapid Session sends once, routes supplements to their active VP, and excludes peer protocol state', async () => {
  const finish = deferred(); const requests = []; let classifications = 0;
  const { send, sessionId, store } = setup({ async *stream(params) {
    requests.push(structuredClone(params.messages));
    const n = requests.length;
    if (n === 1) {
      yield { type: 'text_delta', text: 'visible multi-VP first output' };
      await finish.promise;
    } else yield { type: 'text_delta', text: 'peer finished safely' };
    yield { type: 'stop', stopReason: 'end_turn' };
  } }, ['omni', 'linus']);
  bridge.__testSetThreadClassifier(({ runningThreads, newQuery }) => {
    classifications++;
    return newQuery === 'supplement only omni'
      ? { decision: 'related', targetThreadId: runningThreads.find(t => t.userTurnId === 'rapid-a').threadId }
      : { decision: 'unrelated', targetThreadId: null };
  });
  await send('rapid-a', '@omni initial request');
  await until(() => requests.length === 1 && events('vp_turn_start').length === 1);
  const firstTurn = events('vp_turn_start')[0];
  store.append({ sessionId, role: 'assistant', content: 'durable peer prose', turnId: firstTurn.turnId,
    threadId: firstTurn.threadId, speakerVpId: 'omni', userTurnId: 'rapid-a',
    thinkingBlocks: [{ thinking: 'PRIVATE THINKING', signature: 'PRIVATE SIGNATURE' }],
    providerState: { protocol: 'anthropic', secret: 'PRIVATE STATE' },
    toolCalls: [{ id: 'private-tool', name: 'PrivateTool', input: { secret: 'PRIVATE INPUT' } }] });
  await send('rapid-b', '@linus unrelated request');
  await until(() => requests.length === 2);
  expect(JSON.stringify(requests[1])).toContain('durable peer prose');
  expect(JSON.stringify(requests[1])).not.toContain('PRIVATE');
  await send('rapid-extra', 'supplement only omni');
  expect(classifications).toBe(2);
  expect(events('user_message_routed').at(-1).event).toMatchObject({ userTurnId: 'rapid-a', relation: 'supplement' });
  expect(bridge.__testGetVpThreads(sessionId, 'omni')[0].pendingQueries).toHaveLength(1);
  finish.resolve(); await bridge.__testDrainVpDrivers();
  expect(events('vp_turn_start').map(frame => frame.userTurnId)).toEqual(['rapid-a', 'rapid-b']);
  expect(store.loadAllBySession(sessionId).filter(row => row.clientMessageId === 'rapid-extra')).toHaveLength(1);
});

it('serializes simultaneous routing decisions and fences a stopped classification without cancelling its unrelated peer', async () => {
  const finish = deferred(); const classify = deferred(); const entered = deferred();
  let calls = 0; let classifications = 0;
  const { send, sessionId } = setup({ async *stream(params) {
    calls++;
    yield { type: 'text_delta', text: 'live peer output' };
    await Promise.race([finish.promise, new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }))]);
    if (params.signal.aborted) { const error = Error('aborted'); error.name = 'AbortError'; throw error; }
    yield { type: 'stop', stopReason: 'end_turn' };
  } });
  bridge.__testSetThreadClassifier(async () => {
    classifications++;
    return { decision: 'unrelated', targetThreadId: null };
  });
  await Promise.all([send('simultaneous-a', 'one'), send('simultaneous-b', 'two')]);
  await until(() => calls === 2);
  expect(classifications).toBe(1);
  expect(events('vp_turn_start').map(frame => frame.userTurnId)).toEqual(['simultaneous-a', 'simultaneous-b']);
  const first = events('vp_turn_start')[0];
  bridge.__testSetThreadClassifier(({ runningThreads }) => ({ decision: 'related',
    targetThreadId: runningThreads.find(thread => thread.userTurnId === 'simultaneous-a').threadId }));
  await send('supplement-before-stop', 'queued additional input');
  expect(bridge.__testGetVpThreads(sessionId, 'omni')[0].pendingQueries).toHaveLength(1);
  bridge.__testSetThreadClassifier(async ({ runningThreads }) => {
    entered.resolve(); await classify.promise;
    return { decision: 'related', targetThreadId: runningThreads.find(thread => thread.userTurnId === 'simultaneous-a').threadId };
  });
  const pending = send('classification-after-stop', 'third request');
  await entered.promise;
  bridge.handleYeaftAbortTurn({ sessionId, userTurnId: first.userTurnId });
  classify.resolve(); await pending;
  expect(calls).toBe(2);
  expect(events('user_message_routed').some(frame => frame.event.messageId === 'classification-after-stop')).toBe(false);
  expect(events('session_turns').some(frame => frame.event.turns.some(turn => turn.userTurnId === first.userTurnId && turn.state === 'cancelling'))).toBe(true);
  expect(events('vp_turn_end').some(frame => frame.userTurnId === 'simultaneous-b')).toBe(false);
  finish.resolve(); await bridge.__testDrainVpDrivers();
  expect(calls).toBe(2); // stopped pending supplement/classification must not resurrect its execution
});

it('bounds a stuck classifier and continues queued sends using visible assistant choices', async () => {
  const finish = deferred(); let calls = 0; let signal;
  const { send, sessionId } = setup({ async *stream(params) {
    calls++;
    yield { type: 'text_delta', text: 'Option 1: red. Option 2: blue.' };
    await Promise.race([finish.promise, new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }))]);
    yield { type: 'stop', stopReason: 'end_turn' };
  } }, ['omni'], { threadClassifierTimeoutMs: 30 });
  await send('timeout-a', 'choose colors'); await until(() => calls === 1);
  bridge.__testSetThreadClassifier(params => {
    expect(params.runningThreads[0].summary).toContain('Option 2: blue');
    signal = params.signal;
    return new Promise(() => {}); // deliberately ignores abort
  });
  const before = Date.now();
  await Promise.all([send('timeout-b', 'use the second option'), send('timeout-c', 'independent queued send')]);
  await until(() => calls === 3);
  expect(Date.now() - before).toBeLessThan(2000);
  expect(signal.aborted).toBe(true);
  bridge.handleYeaftAbortTurn({ sessionId, userTurnId: 'timeout-b' });
  finish.resolve(); await bridge.__testDrainVpDrivers();
});
