import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ctx from '../../../agent/context.js';
import { sendToServer, flushMessageBuffer } from '../../../agent/connection/buffer.js';
import { renderSessionScene } from '../../../agent/yeaft/sessions/scene-prompts.js';
import * as bridge from '../../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { hydratePersistedSessionTurns } from '../../../agent/yeaft/sessions/turn-recovery.js';
import { closeConversationHistoryIndexes, searchConversationIndex } from '../../../agent/yeaft/conversation/history-index.js';
import { DebugTrace, NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { createSessionFromSpec, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';
import { openSession } from '../../../agent/yeaft/sessions/session-store.js';
import { pruneDeletedSessionTurnsOffline } from '../../../agent/yeaft/cli.js';
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
function setup(adapter, roster = ['omni'], config = {}, sceneId) {
  root = mkdtempSync(join(tmpdir(), 'session-parallel-'));
  seedDefaultVps(join(root, 'virtual-persons'));
  const meta = createSessionFromSpec(root, { name: 'Parallel', roster, defaultVpId: 'omni', sceneId });
  const store = new ConversationStore(root);
  ctx.CONFIG = { yeaftDir: root };
  ctx.serverCapabilities = new Set(['session_history_chunk_errors']);
  const sent = [];
  ctx.ws = { readyState: 1, send(encoded) { sent.push(JSON.parse(encoded)); }, sent }; ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = []; ctx.outboundSendQueueBytes = 0; ctx.outboundSendQueueActive = false;
  ctx.messageBuffer = []; ctx.messageBufferBytes = 0;
  bridge.__testSetSession({ adapter, trace: new NullTrace(), conversationStore: store,
    config: { model: 'test-model', maxOutputTokens: 1024, ...config }, toolRegistry: new ToolRegistry(), yeaftDir: root });
  return { store, sessionId: meta.id, send: (id, text) => bridge.handleYeaftSessionSend({ sessionId: meta.id, id, text }) };
}
const frames = () => [...(ctx.ws?.sent || []), ...ctx.outboundSendQueue.map(item => item.msg)];
const events = type => frames().filter(frame => frame.event?.type === type);

it('defers to live root state and only attributes durable execution evidence to its own root', () => {
  const liveStates = ['submitted', 'queued', 'waiting', 'running', 'completed'];
  const turns = new Map(liveStates.map(state => [state, { state, executions: new Map() }]));
  const user = userTurnId => ({ id: `row-${userTurnId}`, userTurnId, role: 'user', userAuthored: true, relation: 'new' });
  const causalReply = { role: 'assistant', causalRootId: 'row-answered', content: 'legacy keyed answer' };
  hydratePersistedSessionTurns(turns, [
    ...liveStates.map(user), user('answered'), user('orphan'), causalReply,
    { role: 'assistant', content: 'not evidence for the nearest user' },
    { ...user('supplement'), relation: 'supplement' },
  ]);
  expect(liveStates.map(state => turns.get(state).state)).toEqual(liveStates);
  expect(turns.get('answered').state).toBe('completed');
  expect(turns.get('supplement').state).toBe('completed');
  expect(turns.get('orphan')).toMatchObject({ state: 'interrupted', executions: new Map() });
  hydratePersistedSessionTurns(turns, [user('orphan'), { role: 'assistant', userTurnId: 'orphan', content: 'answer now durable' }]);
  expect(turns.get('orphan').state).toBe('completed');
});

it('shows a persisted native input without execution evidence as interrupted after runtime restart, without replaying it', async () => {
  let queries = 0;
  const adapter = { async *stream() {
    queries++;
    yield { type: 'text_delta', text: 'durable answer' };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const { send, sessionId, store } = setup(adapter);
  const legacy = store.append({ sessionId, role: 'user', content: 'legacy input', userTurnId: 'legacy' });
  store.append({ sessionId, role: 'assistant', content: 'legacy answer without an execution id', userTurnId: 'legacy' });
  const orphan = store.append({ sessionId, role: 'user', content: 'orphan', userAuthored: true,
    clientMessageId: 'orphan', userTurnId: 'orphan', relation: 'new' });
  const toolRoot = store.append({ sessionId, role: 'user', content: 'tool was dispatched', userAuthored: true,
    clientMessageId: 'tool-root', userTurnId: 'tool-root', relation: 'new' });
  store.append({ sessionId, role: 'assistant', content: '', userTurnId: 'tool-root', causalRootId: toolRoot.id,
    turnId: 'omni:inflight-tool', incomplete: true, toolCalls: [{ id: 'tool-1', name: 'Write', input: {} }] });
  await send('healthy', 'answered input');
  await bridge.__testDrainVpDrivers();
  expect(queries).toBe(1);

  // Drop the bridge's entire runtime projection and re-open the on-disk tape.
  await bridge.__testResetVpState();
  const reopened = new ConversationStore(root);
  bridge.__testSetSession({ adapter, trace: new NullTrace(), conversationStore: reopened,
    config: { model: 'test-model', maxOutputTokens: 1024 }, toolRegistry: new ToolRegistry(), yeaftDir: root });
  for (const requestId of ['restart-history', 'repeat-history']) {
    await bridge.handleYeaftLoadHistory({ sessionId, requestId, limit: 10 });
    const snapshot = events('session_turns').find(frame => frame.requestId === requestId).event.turns;
    expect(snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ userTurnId: 'orphan', state: 'interrupted', executions: [] }),
      expect.objectContaining({ userTurnId: 'tool-root', executions: [expect.objectContaining({ turnId: 'omni:inflight-tool' })] }),
      expect.objectContaining({ userTurnId: 'healthy', state: 'completed' }),
      expect.objectContaining({ userTurnId: 'legacy', state: 'completed' }),
    ]));
    const history = frames().find(frame => frame.type === 'yeaft_history_chunk' && frame.requestId === requestId);
    expect(history.messages.map(row => row.id)).toEqual(expect.arrayContaining([legacy.id, orphan.id]));
    expect(history.messages.some(row => row.content === 'durable answer')).toBe(true);
  }
  expect(queries).toBe(1);
});

it('runs overlapping same-VP user turns with visible partial peer context, supplements and isolated stop; replays durable grouping', async () => {
  const first = deferred(); const second = deferred();
  const requests = [];
  const { send, sessionId, store } = setup({ async *stream(params) {
    requests.push(structuredClone(params.messages));
    const n = requests.length;
    if (n === 1) {
      yield { type: 'usage', inputTokens: 123, outputTokens: 5 };
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
  // The actual bridge replays live metrics on load, without a new provider event.
  const liveProgress = events('query_progress').find(frame => frame.turnId === starts[0].turnId)?.event;
  expect(liveProgress).toMatchObject({ inputTokens: 123, outputTokens: 5, modelRequests: 1 });
  const snapshotCount = events('vp_status_snapshot').length;
  await bridge.handleYeaftLoadHistory({ sessionId, limit: 0 });
  await until(() => events('vp_status_snapshot').length > snapshotCount);
  expect(events('vp_status_snapshot').at(-1).event.queryProgress).toContainEqual(liveProgress);
  bridge.__testSetThreadClassifier(({ runningThreads }) => ({ decision: 'related', targetThreadId: runningThreads.find(t => t.userTurnId === 'root-b').threadId }));
  await send('extra-b', 'additional details');
  expect(events('user_message_routed').at(-1).event).toMatchObject({ messageId: 'extra-b', userTurnId: 'root-b', relation: 'supplement' });
  bridge.handleYeaftAbortTurn({ sessionId, turnId: starts[0].turnId });
  await until(() => events('vp_turn_end').some(f => f.turnId === starts[0].turnId));
  expect(events('vp_turn_end').some(f => f.turnId === starts[1].turnId)).toBe(false);
  second.resolve(); first.resolve();
  await bridge.__testDrainVpDrivers();
  const settledSnapshotCount = events('vp_status_snapshot').length;
  await bridge.handleYeaftLoadHistory({ sessionId, limit: 0 });
  await until(() => events('vp_status_snapshot').length > settledSnapshotCount);
  expect(events('vp_status_snapshot').at(-1).event.queryProgress).toBeUndefined();
  const settledThreads = events('vp_status_snapshot').at(-1).event.statuses.flatMap(row => row.threads);
  for (const { turnId, threadId } of starts) {
    expect(settledThreads).toContainEqual(expect.objectContaining({ threadId, turnId: null, settledTurnId: turnId }));
  }
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
  // Live roots (including a stopping one) never carry an end time; finished
  // roots do, in the order they ended, and never carry a live span.
  const publishedTurns = () => events('session_turns').flatMap(f => f.event.turns);
  expect(publishedTurns().some(t => t.state === 'cancelling')).toBe(true);
  expect(publishedTurns().every(t => (['running', 'cancelling'].includes(t.state) ? t.endedAt === undefined : t.activeSince === undefined))).toBe(true);
  const settled = events('session_turns').at(-1).event.turns;
  const endedA = settled.find(t => t.userTurnId === 'root-a');
  const endedB = settled.find(t => t.userTurnId === 'root-b');
  expect(endedA).toMatchObject({ state: 'aborted' });
  expect(endedA.endedAt).toBeGreaterThanOrEqual(endedA.startedAt);
  expect(endedB.endedAt).toBeGreaterThanOrEqual(endedA.endedAt);
  // A background result reopens finished root-b: the question start is kept,
  // the new live span starts after its earlier end, and it ends again later.
  // Only frames published after the rescue count, and the clock must move past
  // the earlier end so a stale endedAt cannot pass as the new one.
  expect(publishedTurns().some(t => t.userTurnId === 'root-b' && t.activeSince)).toBe(false);
  const framesBeforeRescue = events('session_turns').length;
  const rescuedTurns = () => events('session_turns').slice(framesBeforeRescue).flatMap(f => f.event.turns);
  await until(() => Date.now() > endedB.endedAt);
  expect(bridge.__testHooks.scheduleTaskResultRescue({ taskId: 'bg-result', sessionId, vpId: 'omni',
    content: 'background result', userTurnId: 'root-b' })).toBe(true);
  await until(() => rescuedTurns().some(t => t.userTurnId === 'root-b' && t.activeSince));
  await bridge.__testDrainVpDrivers();
  const reopened = rescuedTurns().find(t => t.userTurnId === 'root-b' && t.activeSince);
  expect(reopened).toMatchObject({ state: 'running', startedAt: endedB.startedAt });
  expect(reopened.activeSince).toBeGreaterThan(endedB.endedAt);
  expect(reopened.endedAt).toBeUndefined();
  const closed = events('session_turns').at(-1).event.turns.find(t => t.userTurnId === 'root-b');
  expect(closed.activeSince).toBeUndefined();
  expect(closed.endedAt).toBeGreaterThanOrEqual(reopened.activeSince);
  await bridge.__testResetVpState();
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'hydrate-groups', limit: 10 });
  expect(events('session_turns').some(frame => frame.event.turns.some(turn => turn.userTurnId === 'root-b' && turn.executions.length))).toBe(true);
  // A replayed root has no runtime end event; its last durable row bounds the end.
  const replayedB = events('session_turns').at(-1).event.turns.find(turn => turn.userTurnId === 'root-b');
  expect(replayedB.endedAt).toBeGreaterThanOrEqual(replayedB.startedAt);
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

it('pins each Turn to its selected scene while sharing a durable transcript across a switch', async () => {
  const writingFinish = deferred();
  const requests = [];
  const { send, sessionId, store } = setup({ async *stream(params) {
    requests.push({ prompt: params.system, messages: structuredClone(params.messages) });
    if (requests.length === 1) {
      yield { type: 'text_delta', text: 'shared architectural conclusion' };
    } else if (requests.length === 2) {
      yield { type: 'text_delta', text: 'old scene still running' };
      if (!params.signal.aborted) await new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }));
      const error = Error('aborted'); error.name = 'AbortError'; throw error;
    } else if (requests.length === 3) {
      yield { type: 'text_delta', text: 'new scene draft' };
      await writingFinish.promise;
    } else {
      yield { type: 'text_delta', text: 'incorporated writing supplement' };
    }
    yield { type: 'stop', stopReason: 'end_turn' };
  } }, ['omni', 'linus'], { language: 'en' }, 'software');

  await send('scene-history', '@all review the design');
  await bridge.__testDrainVpDrivers();
  expect(requests).toHaveLength(1);
  expect(requests[0].prompt).toContain(renderSessionScene('software', 'en'));
  expect(requests[0].prompt).not.toContain('## Soul');
  expect(requests[0].prompt).not.toContain('multi_vp_routing');
  expect(JSON.stringify(requests[0].messages)).toContain('@all review the design');
  expect(JSON.stringify(requests[0].messages)).not.toContain('@vp-omni');
  await send('scene-old', 'keep working from the conclusion');
  await until(() => requests.length === 2);
  const old = events('vp_turn_start').at(-1);
  const classified = [];
  bridge.__testSetThreadClassifier(({ runningThreads }) => {
    classified.push(runningThreads.map(t => t.userTurnId));
    return { decision: 'related', targetThreadId: runningThreads[0].threadId };
  });
  bridge.handleYeaftUpdateSessionConfig({ sessionId, config: { sceneId: 'writing' } });
  expect(snapshotSessions(root).find(row => row.id === sessionId)).toMatchObject({ roster: ['omni', 'linus'], config: { sceneId: 'writing' } });
  expect(events('vp_turn_end').some(frame => frame.turnId === old.turnId)).toBe(false);
  await send('scene-new', 'write about that conclusion');
  await until(() => requests.length === 3);
  const current = events('vp_turn_start').at(-1);
  expect(current).toMatchObject({ userTurnId: 'scene-new', vpId: old.vpId });
  expect(current.threadId).not.toBe(old.threadId);
  expect(requests[2].prompt).toContain(renderSessionScene('writing', 'en'));
  expect(requests[2].prompt).not.toContain(renderSessionScene('software', 'en'));
  expect(JSON.stringify(requests[2].messages)).toContain('shared architectural conclusion');
  await send('scene-extra', 'use shorter sentences');
  expect(classified).toEqual([['scene-new']]);
  expect(events('user_message_routed').at(-1).event).toMatchObject({ userTurnId: 'scene-new', relation: 'supplement' });
  bridge.handleYeaftAbortTurn({ sessionId, turnId: old.turnId });
  await until(() => events('vp_turn_end').some(frame => frame.turnId === old.turnId));
  expect(events('vp_turn_end').some(frame => frame.turnId === current.turnId)).toBe(false);
  writingFinish.resolve();
  await bridge.__testDrainVpDrivers();
  expect(requests.at(-1).prompt).toContain(renderSessionScene('writing', 'en'));
  expect(store.loadAllBySession(sessionId).find(row => row.clientMessageId === 'scene-extra'))
    .toMatchObject({ userTurnId: 'scene-new', relation: 'supplement' });
  await bridge.__testResetVpState();
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'replay-scenes', limit: 10 });
  expect(frames().find(frame => frame.type === 'yeaft_history_chunk' && frame.requestId === 'replay-scenes').messages)
    .toEqual(expect.arrayContaining([expect.objectContaining({ userTurnId: 'scene-old' }), expect.objectContaining({ userTurnId: 'scene-new', relation: 'supplement' })]));

  const budget = ctx.outboundSendQueueMaxBytes = 64 * 1024;
  const append = (role, content) => store.append({ sessionId, role, content });
  const anchor = append('user', 'paged tail');
  const first = append('assistant', '界'.repeat(14_000));
  const last = append('assistant', '🌍'.repeat(10_000));
  const seq = row => store.getMessageSeqById(row.id);
  const chunk = requestId => frames().find(frame => frame.type === 'yeaft_history_chunk' && frame.requestId === requestId);
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'byte-recent', limit: 1 });
  expect(chunk('byte-recent')).toMatchObject({ messages: [expect.objectContaining({ id: last.id })], nextBeforeSeq: seq(last), hasMore: true });
  await bridge.handleYeaftLoadMoreHistory({ sessionId, requestId: 'byte-gap', beforeSeq: seq(last), pageKind: 'gap', gapStopAtSeq: seq(first), cacheEpoch: 5 });
  expect(chunk('byte-gap')).toMatchObject({ messages: [expect.objectContaining({ id: first.id })], nextBeforeSeq: seq(first), hasMore: false, pageKind: 'gap', gapStopAtSeq: seq(first), cacheEpoch: 5 });
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'byte-delta', afterSeq: seq(anchor) });
  expect(chunk('byte-delta')).toMatchObject({ messages: [expect.objectContaining({ id: first.id })], latestSeq: seq(first), hasMoreAfter: true });
  for (const id of ['byte-recent', 'byte-gap', 'byte-delta']) expect(Buffer.byteLength(JSON.stringify(chunk(id)))).toBeLessThanOrEqual(budget);

  // Saturate the real outbound byte accounting; only the small error fits.
  ctx.outboundSendQueueBytes = budget - 16 * 1024;
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'byte-dropped', _requestClientId: 'browser', limit: 1 });
  ctx.outboundSendQueueBytes = 0;
  expect(chunk('byte-dropped')).toMatchObject({ messages: [], error: 'history_delivery_failed', _requestClientId: 'browser' });
  expect(events('history_loaded').some(frame => frame.requestId === 'byte-dropped')).toBe(false);

  const oversized = append('assistant', 'too large to reveal ' + '界'.repeat(23_000));
  const lookup = async (query, requestId) => {
    const { results: [match] } = await searchConversationIndex(root, sessionId, query);
    await bridge.handleYeaftLoadHistoryWindow({ sessionId, requestId, anchorMessageId: match.messageId,
      anchorSeq: match.seq, entryId: match.entryId, entryStartSeq: match.entryStartSeq, indexGeneration: match.indexGeneration });
    return frames().find(frame => frame.type === 'yeaft_history_window' && frame.requestId === requestId);
  };
  const window = await lookup('paged tail', 'byte-window');
  expect(window).toMatchObject({ anchorMessageId: anchor.id, messages: [expect.objectContaining({ id: anchor.id })] });
  expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThanOrEqual(budget);
  expect(await lookup('too large to reveal', 'byte-window-oversized')).toMatchObject({ anchorMessageId: oversized.id, messages: [], error: 'history_payload_too_large' });
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'byte-oversized', _requestClientId: 'browser', limit: 1 });
  expect(chunk('byte-oversized')).toMatchObject({ messages: [], error: 'history_payload_too_large', _requestClientId: 'browser' });
  expect(events('history_loaded').some(frame => frame.requestId === 'byte-oversized')).toBe(false);

  ctx.serverCapabilities = new Set();
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'old-server-oversized', _requestClientId: 'browser', limit: 1 });
  expect(chunk('old-server-oversized')).toBeUndefined();
  expect(events('history_loaded').some(frame => frame.requestId === 'old-server-oversized')).toBe(false);
  ctx.serverCapabilities.add('session_history_chunk_errors');

  // A queued/buffered error must not cross onto a newly connected old Server.
  const oldSocket = ctx.ws;
  const errorFrame = { type: 'yeaft_history_chunk', sessionId, requestId: 'stale-error',
    messages: [], error: 'history_payload_too_large' };
  const queued = sendToServer(errorFrame);
  expect(ctx.outboundSendQueue.at(-1)?.msg).toEqual(errorFrame);
  ctx.ws = null;
  expect(await sendToServer(errorFrame)).toBe('dropped');
  ctx.serverCapabilities = new Set();
  const sentAfterReconnect = [];
  ctx.ws = { readyState: 1, send: encoded => sentAfterReconnect.push(JSON.parse(encoded)) };
  expect(await queued).toBe('dropped');
  await flushMessageBuffer();
  expect(sentAfterReconnect.filter(frame => frame.requestId === errorFrame.requestId)).toEqual([]);
  ctx.ws = oldSocket;
  ctx.serverCapabilities.add('session_history_chunk_errors');

  append('user', 'Interleaved question');
  const askScope = { sessionId, speakerVpId: 'omni', turnId: 'ask-turn', threadId: 'ask-thread' };
  const ask = store.append({ ...askScope, role: 'assistant', content: '界'.repeat(10_000),
    toolCalls: [{ id: 'ask-before-page-cut', name: 'AskUser', input: { question: 'Continue?' } }] });
  const interleaved = store.append({ role: 'assistant', sessionId, speakerVpId: 'linus', content: '界'.repeat(14_000) });
  store.append({ ...askScope, role: 'tool', toolCallId: 'ask-before-page-cut',
    content: JSON.stringify({ answers: { 'Continue?': 'Yes' } }) });
  const unpagedAsk = store.loadVisibleBySession(sessionId, null, 1).messages.find(message => message.id === ask.id);
  expect(unpagedAsk.askUserResults).toEqual([expect.objectContaining({ status: 'answered', answers: { 'Continue?': 'Yes' } })]);
  await bridge.handleYeaftLoadHistory({ sessionId, requestId: 'ask-newer', limit: 1 });
  expect(chunk('ask-newer')).toMatchObject({ nextBeforeSeq: seq(interleaved), hasMore: true });
  await bridge.handleYeaftLoadMoreHistory({ sessionId, requestId: 'ask-older', beforeSeq: seq(interleaved), turns: 1 });
  expect(chunk('ask-older').messages.find(message => message.id === ask.id).askUserResults).toEqual(unpagedAsk.askUserResults);
});

it('deletes a finished Session turn without opt-in and excludes it from real Engine requests', async () => {
  const gate = deferred();
  const requests = [];
  const { send, store, sessionId } = setup({ async *stream(params) {
    requests.push(JSON.stringify(params.messages));
    if (requests.length === 1) {
      yield { type: 'text_delta', text: 'deleted-special-reply' };
      await gate.promise;
    } else yield { type: 'text_delta', text: 'retained-answer' };
    yield { type: 'stop', stopReason: 'end_turn' };
  } });
  // Allow the real transport queue to drain while retaining frames for assertions.
  const sent = [];
  ctx.ws.send = encoded => sent.push(JSON.parse(encoded));
  ctx.outboundSendQueueActive = false;
  const { handleMessage } = await import('../../../agent/connection/message-router.js');
  await send('deleted-client-id', 'deleted-special-request');
  await until(() => requests.length === 1);
  const row = store.loadAllBySession(sessionId).find(row => row.clientMessageId === 'deleted-client-id');
  const deletion = { sessionId, messageId: row.id, requestId: 'delete-correlation' };
  const latestAck = () => sent.filter(frame => frame.requestId === deletion.requestId).at(-1);
  await handleMessage({ type: 'session_turn_delete_authorized', ...deletion });
  expect(latestAck()).toMatchObject({ ok: false, errorCode: 'session_running' });
  gate.resolve();
  await bridge.__testDrainVpDrivers();
  const traceId = store.loadAllBySession(sessionId).find(message => message.role === 'assistant').turnId;
  const trace = new DebugTrace(root);
  const loop = trace.startTurn({ sessionId, traceId, messageId: row.id, turnNumber: 1, userPrompt: 'deleted-special-request' });
  trace.endTurn(loop, { rawRequest: { messages: ['deleted-special-request'] }, rawResponse: { text: 'deleted-special-reply' } });
  trace.logTool(loop, { toolName: 'Read', toolInput: 'deleted-special-tool', toolOutput: 'deleted-special-output' });
  await trace.close();
  await handleMessage({ type: 'yeaft_session_delete_turn', ...deletion });
  expect(store.loadAllBySession(sessionId)).toHaveLength(2); // Public name is never executable on the Agent.
  await handleMessage({ type: 'session_turn_delete_authorized', ...deletion });
  const ack = sent.filter(frame => frame.type === 'yeaft_session_delete_turn_result').at(-1);
  expect(ack).toMatchObject({ requestId: deletion.requestId, ok: true, deletedMessageIds: expect.arrayContaining([row.id]) });
  expect(sent.find(frame => frame.type === 'yeaft_session_turn_deleted')).toMatchObject({ turnId: ack.turnId, sessionId });
  expect(store.loadAllBySession(sessionId)).toEqual([]);
  const sessionDir = join(root, 'sessions', sessionId);
  expect(readdirSync(join(sessionDir, 'debug', 'requests'))).toEqual([]);
  await send('deleted-client-id', 'deleted-special-request');
  await bridge.__testDrainVpDrivers();
  expect(requests).toHaveLength(1);
  await bridge.handleYeaftSessionSend({ sessionId, id: 'next-user', text: 'next question', quote: {
    id: row.id, role: 'user', content: 'deleted-special-request',
  } });
  await bridge.__testDrainVpDrivers();
  expect(requests).toHaveLength(2);
  expect(requests[1]).not.toContain('deleted-special');
  const logDir = join(sessionDir, 'messages');
  const readLog = () => readdirSync(logDir).filter(file => file.endsWith('.jsonl')).map(file => readFileSync(join(logDir, file), 'utf8')).join('\n');
  const audit = openSession(join(root, 'sessions'), sessionId);
  expect(Array.from(audit.streamMessages()).map(row => row.text)).toEqual(['next question']);
  audit.close();
  expect(readLog()).toContain('deleted-special'); // Never rewrite shared segments while online.
  await expect(pruneDeletedSessionTurnsOffline(root, sessionId)).resolves.toBe(1);
  expect(readLog()).not.toContain('deleted-special');
  expect(readLog()).toContain('next question');
  await until(() => ctx.outboundSendQueue.length === 0 && !ctx.outboundSendQueueActive);
});
