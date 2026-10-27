import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { addOrUpdateManifestSession } from '../../../agent/yeaft/sessions/session-manifest.js';
import { copySession, mergeSessions, sessionsRoot, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';
import { buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import {
  __testHooks, __testDrainVpDrivers, __testResetVpState, __testSetSession,
  __testEnqueueForVp, __testGetVpThreads, __testSetThreadClassifier, __testSetVpThreadEngine,
  __testWaitForRoutePromises, handleYeaftCopySession, handleYeaftMergeSessions,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';

// Runtime contract tests: native ingress/routing/drivers/tasks below are real.
// Persistence owns durable raw-row traversal and transactional copy/merge; these
// doubles deliberately isolate its boundary contract until integration lands.
const persistence = vi.hoisted(() => ({ copies: new Map(), captures: [] }));
vi.mock('../../../agent/yeaft/conversation/persist.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, ConversationStore: class extends actual.ConversationStore {
    captureSessionCopyBoundary(sessionId) {
      const boundary = { sessionId, rows: this.loadAllBySession(sessionId) };
      persistence.captures.push(boundary);
      return boundary;
    }
  } };
});
vi.mock('../../../agent/yeaft/sessions/session-crud.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual,
    copySession: vi.fn((root, sessionId, options) => {
      const all = new ConversationStore(root).loadAllBySession(sessionId);
      let rows = options.throughBoundary ? options.throughBoundary.rows : all;
      if (Object.hasOwn(options, 'throughTurnId')) {
        const turnId = options.throughTurnId;
        let code;
        const matching = all.filter(row => row.role === 'assistant' && row.turnId === turnId);
        if (typeof turnId !== 'string' || !turnId.trim()) code = 'invalid_fork_boundary';
        else if (!matching.length) code = 'fork_boundary_not_found';
        else if (!matching.some(row => row.stopReason === 'end_turn')
            || matching.some(row => !rows.some(candidate => candidate.id === row.id))) code = 'incomplete_fork_boundary';
        if (code) throw new actual.SessionCrudError(code, sessionId);
        rows = rows.slice(0, rows.findLastIndex(row => row.turnId === turnId) + 1);
      }
      const id = `copy_${persistence.copies.size}`;
      persistence.copies.set(id, rows);
      return { id, copiedMessageCount: rows.length };
    }),
    mergeSessions: vi.fn((_root, _sessionId, _otherId, options) => ({ id: 'merged', name: options.name })),
  };
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const original = Object.fromEntries(['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired'].map(key => [key, ctx[key]]));
let root, store, calls, runtime;
const id = 'session_source';

function seedSession(sessionId = id) {
  const handle = createSession(sessionsRoot(root), { id: sessionId, name: sessionId, roster: ['alpha', 'beta'], defaultVpId: 'alpha' });
  addOrUpdateManifestSession(root, handle.getMeta(), join(sessionsRoot(root), sessionId));
  handle.close();
}
function completedTurn(turnId = 'historic', sessionId = id) {
  store.append({ sessionId, role: 'user', content: `question ${turnId}`, threadId: 'old' });
  store.append({ sessionId, role: 'assistant', content: `answer ${turnId}`, threadId: 'old', speakerVpId: 'alpha', turnId, stopReason: 'end_turn' });
}
const rows = sessionId => persistence.copies.get(sessionId) || store.loadAllBySession(sessionId);
function result(requestId) {
  return ctx.outboundSendQueue.map(item => item.msg.event).find(frame => frame?.requestId === requestId && frame.op);
}
function copy(requestId, extra = {}) {
  handleYeaftCopySession({ sessionId: id, requestId, ...extra });
  return result(requestId);
}
const send = (messageId, mentions = ['alpha']) => __testHooks.runYeaftSessionSendForTest({ sessionId: id, id: messageId, text: `${mentions.map(vpId => `@${vpId}`).join(' ')} ${messageId}`, mentions });
const waitCalls = count => vi.waitFor(() => expect(calls).toHaveLength(count));
const contents = sessionId => rows(sessionId).map(row => row.content);

beforeEach(() => {
  persistence.copies.clear();
  persistence.captures.length = 0;
  copySession.mockClear();
  mergeSessions.mockClear();
  root = mkdtempSync(join(tmpdir(), 'yeaft-fork-runtime-'));
  ctx.CONFIG = { yeaftDir: root };
  ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = [];
  ctx.outboundSendQueueActive = true;
  for (const vpId of ['alpha', 'beta']) {
    const dir = join(root, 'virtual-persons', vpId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.md'), buildRoleMd({ vpId, displayName: vpId, role: 'Test' }));
  }
  seedSession();
  store = new ConversationStore(root);
  runtime = { yeaftDir: root, config: {}, conversationStore: store };
  __testSetSession(runtime);
  calls = [];
  // Exercise native ingress, classification, fan-out, persistence and driver
  // lifecycles; only the model query is held at a deterministic terminal gate.
  vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (args) {
    const gate = deferred();
    const call = { ...args, engine: this, gate };
    calls.push(call);
    store.append({ sessionId: id, role: 'assistant', content: `partial ${args.prompt}`, threadId: args.threadId,
      speakerVpId: args.senderVpId, turnId: args.vpTurnId, incomplete: true });
    yield { type: 'text_delta', text: 'working' };
    await gate.promise;
    store.append({ sessionId: id, role: 'assistant', content: `done ${args.prompt}`, threadId: args.threadId,
      speakerVpId: args.senderVpId, turnId: args.vpTurnId, stopReason: 'end_turn' });
    yield { type: 'turn_end', terminal: true, stopReason: 'end_turn' };
  });
  vi.spyOn(Engine.prototype, 'abort');
  vi.spyOn(Engine.prototype, 'retireAsyncTasks');
});

afterEach(async () => {
  // Resolve both current queries and any append-rescue query they enqueue.
  for (let i = 0; i < 10; i++) {
    for (const call of calls) call.gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  await __testDrainVpDrivers();
  await __testResetVpState();
  __testHooks.resetVpStatusBroker();
  __testSetSession(null);
  await closeConversationHistoryIndexes();
  vi.restoreAllMocks();
  Object.assign(ctx, original);
  rmSync(root, { recursive: true, force: true });
});

it('captures the durable prefix synchronously before the first send await, including an explicit empty prefix', async () => {
  const pending = send('first');
  expect(persistence.captures).toEqual([{ sessionId: id, rows: [] }]);
  // This write happens before the async handler resumes from runtime loading.
  store.append({ sessionId: id, role: 'assistant', content: 'after acceptance', threadId: 'other' });
  const fork = copy('before-await');
  expect(fork).toMatchObject({ ok: true, op: 'copy', sourceSessionId: id });
  expect(copySession.mock.lastCall[2].throughBoundary).toEqual({ sessionId: id, rows: [] });
  expect(rows(fork.session.id)).toEqual([]);
  expect(__testHooks.decorateSessionsWithRuntimeState([{ id }])[0].running).toBe(true);
  await pending;
  await waitCalls(1);
  expect(copy('during-output').session.copiedMessageCount).toBe(0);
  expect(calls[0].signal.aborted).toBe(false);
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
  expect(Engine.prototype.retireAsyncTasks).not.toHaveBeenCalled();
});

it('keeps the earliest prefix across concurrent VPs and classification-pending related input, then advances only after quiescence', async () => {
  completedTurn();
  await send('fanout', ['alpha', 'beta']);
  await waitCalls(2);
  const decision = deferred();
  __testSetThreadClassifier(() => decision.promise);
  const append = send('related');
  await new Promise(resolve => setImmediate(resolve));
  expect(copy('pending-classification', { throughTurnId: 'historic' })).toMatchObject({ ok: true });
  const fork = copy('concurrent');
  expect(contents(fork.session.id)).toEqual(['question historic', 'answer historic']);
  const alpha = calls.find(call => call.senderVpId === 'alpha');
  __testSetVpThreadEngine({ sessionId: id, vpId: 'alpha', threadId: alpha.threadId,
    engine: { wakeForPendingUserMessage: () => true } });
  decision.resolve({ decision: 'related', targetThreadId: alpha.threadId });
  await append;
  expect(__testGetVpThreads(id, 'alpha')[0].pendingQueries).toHaveLength(1);
  expect(contents(copy('after-append').session.id)).toEqual(['question historic', 'answer historic']);
  calls.find(call => call.senderVpId === 'beta').gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(contents(copy('one-vp-left').session.id)).toEqual(['question historic', 'answer historic']);
  alpha.gate.resolve();
  await waitCalls(3); // leftover related input is rescued on the original thread
  expect(contents(copy('append-rescue').session.id)).toEqual(['question historic', 'answer historic']);
  calls[2].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  const idleFork = copy('idle');
  expect(rows(idleFork.session.id).length).toBe(rows(id).length);
  expect(calls.every(call => !call.signal.aborted)).toBe(true);
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
  expect(Engine.prototype.retireAsyncTasks).not.toHaveBeenCalled();
});

it('retains the prefix across queued envelopes, route handoffs and the task-result microtask gap', async () => {
  completedTurn();
  await send('root');
  await waitCalls(1);
  const threadId = calls[0].threadId;
  __testEnqueueForVp(id, 'alpha', { sessionId: id, trigger: 'task_result', msg: { id: 'queued', from: 'tool',
    text: 'queued result', meta: { injectedBy: 'task_result', sourceThreadId: threadId } } });
  await __testWaitForRoutePromises('queued');
  expect(__testHooks.queuedTurnIds()).toHaveLength(1);
  expect(contents(copy('queued').session.id)).toEqual(['question historic', 'answer historic']);
  __testEnqueueForVp(id, 'beta', { sessionId: id, trigger: 'route_forward', msg: { id: 'handoff', from: 'alpha',
    text: 'handoff', meta: { injectedBy: 'route_forward', senderVpId: 'alpha' } } });
  await __testWaitForRoutePromises('handoff');
  await waitCalls(2);
  calls[0].gate.resolve();
  await waitCalls(3);
  expect(contents(copy('handoff-queue').session.id)).toEqual(['question historic', 'answer historic']);
  __testHooks.scheduleTaskResultRescue({ taskId: 'late', sessionId: id, vpId: 'beta', threadId: calls[1].threadId, content: 'late result' });
  expect(contents(copy('rescue-scheduled').session.id)).toEqual(['question historic', 'answer historic']);
  expect(calls.every(call => !call.signal.aborted)).toBe(true);
});

it('keeps model_reentry tasks in the epoch after drivers finish, while status-only tasks do not block idle merge', async () => {
  completedTurn();
  runtime.taskManager = new TaskManager({ yeaftDir: root });
  installYeaftRuntimeBridge(runtime);
  await send('with-task');
  await waitCalls(1);
  const task = runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry', source: { threadId: calls[0].threadId } });
  calls[0].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(true);
  expect(contents(copy('task-wait').session.id)).toEqual(['question historic', 'answer historic']);
  seedSession('session_other');
  handleYeaftMergeSessions({ sessionId: 'session_other', otherSessionId: id, requestId: 'busy-merge' });
  expect(result('busy-merge')).toMatchObject({ op: 'merge', ok: false, error: { code: 'session_running', sessionId: id } });
  expect(mergeSessions).not.toHaveBeenCalled();
  runtime.taskManager.completeTask(id, task.id, { status: 'completed', summary: 'ready' });
  await waitCalls(2);
  expect(contents(copy('task-reentry').session.id)).toEqual(['question historic', 'answer historic']);
  calls[1].gate.resolve();
  await __testDrainVpDrivers();
  runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'status_only' });
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  handleYeaftMergeSessions({ sessionId: id, otherSessionId: 'session_other', name: 'Merged', requestId: 'idle-merge' });
  expect(result('idle-merge')).toMatchObject({ op: 'merge', ok: true, sourceSessionId: id, otherSessionId: 'session_other', session: { name: 'Merged' } });
  expect(mergeSessions).toHaveBeenCalledWith(root, id, 'session_other', expect.objectContaining({ name: 'Merged' }));
  expect(snapshotSessions(root).map(row => row.id)).toEqual(expect.arrayContaining([id, 'session_other']));
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
});

it('rejects invalid/incomplete or active message boundaries while permitting completed historical message forks', async () => {
  completedTurn();
  store.append({ sessionId: id, role: 'assistant', content: 'incomplete', threadId: 'old', speakerVpId: 'alpha', turnId: 'incomplete', incomplete: true });
  await send('active');
  await waitCalls(1);
  expect(copy('historic', { throughTurnId: 'historic' })).toMatchObject({ ok: true });
  for (const [requestId, throughTurnId, code] of [
    ['empty', '', 'invalid_fork_boundary'], ['missing', 'missing', 'fork_boundary_not_found'],
    ['incomplete', 'incomplete', 'incomplete_fork_boundary'],
    ['active', calls[0].vpTurnId, 'incomplete_fork_boundary'],
  ]) expect(copy(requestId, { throughTurnId })).toMatchObject({ ok: false, error: { code } });
  expect(calls[0].signal.aborted).toBe(false);
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
});

it('fails closed for untracked legacy activity and guards merge using actual ingress rather than broker state', async () => {
  completedTurn();
  seedSession('session_other');
  const { ctrl } = __testHooks.seedRunningVpTurn({ sessionId: id, vpId: 'alpha' });
  expect(copy('untracked')).toMatchObject({ ok: false, error: { code: 'session_running' } });
  expect(ctrl.signal.aborted).toBe(false);
  __testHooks.resetAbortState();
  const pending = send('ingress-only');
  __testHooks.resetVpStatusBroker();
  handleYeaftMergeSessions({ sessionId: id, otherSessionId: 'session_other', requestId: 'ingress-merge' });
  expect(result('ingress-merge')).toMatchObject({ ok: false, error: { code: 'session_running', sessionId: id } });
  await pending;
  await waitCalls(1);
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
});
