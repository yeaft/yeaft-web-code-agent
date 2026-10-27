import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { addOrUpdateManifestSession } from '../../../agent/yeaft/sessions/session-manifest.js';
import { loadSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { sessionsRoot, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';
import { buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import {
  __testHooks, __testDrainVpDrivers, __testResetVpState, __testSetSession,
  __testEnqueueForVp, __testGetVpThreads, __testWaitForRoutePromises,
  handleYeaftCopySession, handleYeaftMergeSessions, installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';

// Native ingress, classification, fan-out, drivers, tasks, CRUD and durable
// transcript traversal are real. Only the model query has a terminal gate.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const original = Object.fromEntries(['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired'].map(key => [key, ctx[key]]));
let root, store, calls, runtime, capture;
const id = 'session_source';
const config = { model: 'gpt-4.1', modelEffort: 'low' };

function seedSession(sessionId = id) {
  const handle = createSession(sessionsRoot(root), { id: sessionId, name: sessionId, roster: ['alpha', 'beta'], defaultVpId: 'alpha', announcement: 'Keep source context' });
  addOrUpdateManifestSession(root, handle.getMeta(), join(sessionsRoot(root), sessionId));
  handle.close();
  saveSessionConfig(root, sessionId, config);
}
function completedTurn(turnId = 'historic', sessionId = id) {
  const user = store.append({ sessionId, role: 'user', content: `question ${turnId}`, threadId: 'old', clientMessageId: `client-${turnId}` });
  const answer = store.append({ sessionId, role: 'assistant', content: `answer ${turnId}`, threadId: 'old', speakerVpId: 'alpha', turnId, causalRootId: user.id, stopReason: 'end_turn' });
  return { user, answer };
}
// Read physical JSONL, not a runtime cache or the visible/sanitized projection.
function rows(sessionId) {
  const dir = join(sessionsRoot(root), sessionId, 'conversation', 'segments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()
    .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
const contents = sessionId => rows(sessionId).map(row => row.content);
const history = sessionId => new ConversationStore(root).loadVisibleBySession(sessionId, Infinity, Infinity).messages;
const meta = sessionId => JSON.parse(readFileSync(join(sessionsRoot(root), sessionId, 'session.json'), 'utf8'));
const inventory = () => snapshotSessions(root).map(row => row.id).sort();
function result(requestId) {
  return ctx.outboundSendQueue.map(item => item.msg.event).find(frame => frame?.requestId === requestId && frame.op);
}
function copy(requestId, extra = {}) {
  handleYeaftCopySession({ sessionId: id, requestId, ...extra });
  return result(requestId);
}
function expectFork(fork, sourceRows) {
  expect(fork).toMatchObject({ ok: true, op: 'copy', sourceSessionId: id,
    session: { copiedMessageCount: sourceRows.length, roster: ['alpha', 'beta'], defaultVpId: 'alpha', announcement: 'Keep source context', config } });
  const targetId = fork.session.id;
  expect(targetId).not.toBe(id);
  expect(inventory()).toContain(targetId);
  expect(meta(targetId)).toMatchObject({ id: targetId, roster: ['alpha', 'beta'], defaultVpId: 'alpha', announcement: 'Keep source context' });
  expect(loadSessionConfig(root, targetId)).toEqual(config);
  const copied = rows(targetId);
  expect(copied.map(row => row.content)).toEqual(sourceRows.map(row => row.content));
  expect(copied.every(row => row.sessionId === targetId)).toBe(true);
  expect(copied.map(row => row.origin.messageId)).toEqual(sourceRows.map(row => row.origin?.messageId || row.id));
  expect(copied.every(row => !sourceRows.some(source => source.id === row.id))).toBe(true);
  expect(new ConversationStore(root).captureSessionCopyBoundary(targetId).rowCount).toBe(sourceRows.length);
  return copied;
}
function expectSourceRunning() {
  expect(calls.every(call => !call.signal.aborted)).toBe(true);
  expect(Engine.prototype.abort).not.toHaveBeenCalled();
  expect(Engine.prototype.retireAsyncTasks).not.toHaveBeenCalled();
}
const send = (messageId, mentions = ['alpha']) => __testHooks.runYeaftSessionSendForTest({ sessionId: id, id: messageId, text: `${mentions.map(vpId => `@${vpId}`).join(' ')} ${messageId}`, mentions });
const waitCalls = count => vi.waitFor(() => expect(calls).toHaveLength(count));

beforeEach(() => {
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
  capture = vi.spyOn(ConversationStore.prototype, 'captureSessionCopyBoundary');
  vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (args) {
    const gate = deferred();
    const call = { ...args, engine: this, gate, running: true };
    calls.push(call);
    // query normally owns the private running flag. Model that lifecycle here
    // so the REAL wakeForPendingUserMessage accepts related input on this engine.
    Object.defineProperty(this, 'isRunning', { configurable: true, get: () => call.running });
    const output = { sessionId: id, role: 'assistant', threadId: args.threadId,
      speakerVpId: args.senderVpId, turnId: args.vpTurnId, causalRootId: args.currentUserMessage?.id };
    try {
      store.append({ ...output, content: `partial ${args.prompt}`, incomplete: true });
      yield { type: 'text_delta', text: 'working' };
      await gate.promise;
      store.append({ ...output, content: `done ${args.prompt}`, stopReason: 'end_turn' });
      yield { type: 'turn_end', terminal: true, stopReason: 'end_turn' };
    } finally {
      call.running = false;
      delete this.isRunning;
    }
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
  expect(capture).toHaveBeenCalledExactlyOnceWith(id);
  expect(capture.mock.results[0].value).toMatchObject({ version: 1, sessionId: id, rowCount: 0, lastMessageId: null });
  expect(rows(id)).toEqual([]);
  // This write happens before the async handler resumes from runtime loading.
  store.append({ sessionId: id, role: 'assistant', content: 'after acceptance', threadId: 'other' });
  const fork = copy('before-await');
  expectFork(fork, []);
  expect(history(fork.session.id)).toEqual([]);
  expect(__testHooks.decorateSessionsWithRuntimeState([{ id }])[0].running).toBe(true);
  await pending;
  await waitCalls(1);
  expect(contents(id)).toEqual(['after acceptance', '@alpha first', `partial ${calls[0].prompt}`]);
  expectFork(copy('during-output'), []);
  expectSourceRunning();
  calls[0].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  const source = rows(id);
  const idle = copy('after-terminal');
  expectFork(idle, source);
  expect(history(idle.session.id).map(row => row.content)).toContain(`done ${calls[0].prompt}`);
  expect(rows(id)).toEqual(source);
});

it('keeps the earliest prefix across concurrent VPs and classification-pending related input, then advances only after quiescence', async () => {
  completedTurn();
  const prefix = rows(id);
  await send('fanout', ['alpha', 'beta']);
  await waitCalls(2);
  const variants = rows(id).filter(row => row.clientMessageId === 'fanout');
  expect(variants).toHaveLength(2); // one durable human variant per VP thread
  expect(new Set(variants.map(row => row.threadId)).size).toBe(2);
  expect(new Set(calls.map(call => call.senderVpId))).toEqual(new Set(['alpha', 'beta']));
  const alpha = calls.find(call => call.senderVpId === 'alpha');
  const append = send('related');
  // Runtime loading resumes first; the real no-adapter classifier then yields
  // at its await before deciding that this input belongs to alpha's live thread.
  await Promise.resolve();
  expect(__testGetVpThreads(id, 'alpha')[0].pendingQueries).toHaveLength(0);
  expectFork(copy('pending-classification', { throughTurnId: 'historic' }), prefix);
  expectFork(copy('concurrent'), prefix);
  await append;
  await __testWaitForRoutePromises('related');
  expect(__testGetVpThreads(id, 'alpha')[0].pendingQueries).toHaveLength(1);
  expect(contents(id).filter(content => content === '@alpha related')).toHaveLength(1);
  expectFork(copy('after-append'), prefix);
  calls.find(call => call.senderVpId === 'beta').gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expectFork(copy('one-vp-left'), prefix);
  alpha.gate.resolve();
  await waitCalls(3); // leftover related input is rescued on the original thread
  expect(calls[2].threadId).toBe(alpha.threadId);
  expectFork(copy('append-rescue'), prefix);
  expectSourceRunning();
  calls[2].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  const source = rows(id);
  const idleFork = copy('idle');
  expectFork(idleFork, source);
  expect(history(idleFork.session.id).filter(row => row.role === 'user').map(row => row.content))
    .toEqual(['question historic', '@alpha @beta fanout', '@alpha @beta fanout', '@alpha related']);
  expect(rows(id)).toEqual(source);
  expectSourceRunning();
});

it('retains the prefix across queued envelopes, route handoffs and the task-result microtask gap', async () => {
  completedTurn();
  const prefix = rows(id);
  await send('root');
  await waitCalls(1);
  const threadId = calls[0].threadId;
  __testEnqueueForVp(id, 'alpha', { sessionId: id, trigger: 'task_result', msg: { id: 'queued', from: 'tool',
    text: 'queued result', meta: { injectedBy: 'task_result', sourceThreadId: threadId } } });
  await __testWaitForRoutePromises('queued');
  expect(__testHooks.queuedTurnIds()).toHaveLength(1);
  expectFork(copy('queued'), prefix);
  __testEnqueueForVp(id, 'beta', { sessionId: id, trigger: 'route_forward', msg: { id: 'handoff', from: 'alpha',
    text: 'handoff', meta: { injectedBy: 'route_forward', senderVpId: 'alpha' } } });
  await __testWaitForRoutePromises('handoff');
  await waitCalls(2);
  calls[0].gate.resolve();
  await waitCalls(3);
  expect(calls[2].threadId).toBe(threadId);
  expect(calls[2].prompt).toContain('queued result');
  expect(calls[1].senderVpId).toBe('beta');
  expectFork(copy('handoff-queue'), prefix);
  expect(__testHooks.scheduleTaskResultRescue({ taskId: 'late', sessionId: id, vpId: 'beta', threadId: calls[1].threadId, content: 'late result' })).toBe(true);
  expectFork(copy('rescue-scheduled'), prefix);
  expectSourceRunning();
  calls[1].gate.resolve();
  calls[2].gate.resolve();
  await waitCalls(4);
  expect(calls[3].prompt).toContain('late result');
  expectFork(copy('late-reentry'), prefix);
  calls[3].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  const source = rows(id);
  expectFork(copy('all-routes-terminal'), source);
  expect(source.filter(row => row.role === 'user').map(row => row.content)).toEqual(['question historic', '@alpha root']);
  expectSourceRunning();
});

it('keeps model_reentry tasks in the epoch after drivers finish, while status-only tasks do not block idle merge', async () => {
  completedTurn();
  const prefix = rows(id);
  runtime.taskManager = new TaskManager({ yeaftDir: root });
  installYeaftRuntimeBridge(runtime);
  await send('with-task');
  await waitCalls(1);
  const task = runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry', source: { threadId: calls[0].threadId } });
  calls[0].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(true);
  expectFork(copy('task-wait'), prefix);
  seedSession('session_other');
  completedTurn('other', 'session_other');
  const beforeBusyMerge = inventory();
  handleYeaftMergeSessions({ sessionId: 'session_other', otherSessionId: id, requestId: 'busy-merge' });
  expect(result('busy-merge')).toMatchObject({ op: 'merge', ok: false, error: { code: 'session_running', sessionId: id } });
  expect(inventory()).toEqual(beforeBusyMerge);
  runtime.taskManager.completeTask(id, task.id, { status: 'succeeded', summary: 'ready' });
  // Completion releases the task lease only after queuing the rescue microtask.
  expectFork(copy('task-completion-gap'), prefix);
  await waitCalls(2);
  expect(calls[1].threadId).toBe(calls[0].threadId);
  expect(calls[1].prompt).toContain('ready');
  expectFork(copy('task-reentry'), prefix);
  calls[1].gate.resolve();
  await __testDrainVpDrivers();
  // The real sub-agent runner refreshes the terminal log after completeTask.
  // Completed, failed and cancelled tasks must not resurrect the activity epoch.
  runtime.taskManager.refreshTaskLog(id, task.id);
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  for (const status of ['failed', 'cancelled']) {
    const terminalTask = runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry', source: { threadId: calls[0].threadId } });
    const callCount = calls.length;
    runtime.taskManager.completeTask(id, terminalTask.id, { status, summary: status });
    runtime.taskManager.refreshTaskLog(id, terminalTask.id);
    await waitCalls(callCount + 1);
    calls.at(-1).gate.resolve();
    await __testDrainVpDrivers();
    runtime.taskManager.refreshTaskLog(id, terminalTask.id);
    expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  }
  const statusOnly = runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'status_only' });
  expect(runtime.taskManager.listActiveTasks(id).map(task => task.id)).toEqual([statusOnly.id]);
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  const source = rows(id), other = rows('session_other');
  const sourceMeta = meta(id), otherMeta = meta('session_other');
  const sourceHistory = history(id), otherHistory = history('session_other');
  handleYeaftMergeSessions({ sessionId: id, otherSessionId: 'session_other', name: 'Merged', requestId: 'idle-merge' });
  const merged = result('idle-merge');
  expect(merged).toMatchObject({ op: 'merge', ok: true, sourceSessionId: id, otherSessionId: 'session_other',
    session: { name: 'Merged', copiedMessageCount: source.length + other.length, sharedTurnCount: 0, config } });
  const targetId = merged.session.id;
  expect([id, 'session_other']).not.toContain(targetId);
  expect(meta(targetId)).toMatchObject({ name: 'Merged', roster: ['alpha', 'beta'], defaultVpId: 'alpha', announcement: 'Keep source context' });
  expect(loadSessionConfig(root, targetId)).toEqual(config);
  expect(rows(targetId).map(row => row.content).sort()).toEqual([...source, ...other].map(row => row.content).sort());
  expect(rows(targetId).every(row => row.sessionId === targetId)).toBe(true);
  expect(history(targetId).map(row => row.content).sort()).toEqual([...sourceHistory, ...otherHistory].map(row => row.content).sort());
  expect(inventory()).toEqual(expect.arrayContaining([id, 'session_other', targetId]));
  expect(rows(id)).toEqual(source);
  expect(rows('session_other')).toEqual(other);
  expect(meta(id)).toEqual(sourceMeta);
  expect(meta('session_other')).toEqual(otherMeta);
  expect(history(id)).toEqual(sourceHistory);
  expect(history('session_other')).toEqual(otherHistory);
  expectSourceRunning();
});

it('rejects invalid/incomplete or active message boundaries while permitting completed historical message forks', async () => {
  const user = store.append({ sessionId: id, role: 'user', content: 'question historic', threadId: 'old' });
  const toolOwner = store.append({ sessionId: id, role: 'assistant', content: 'checking', threadId: 'old', speakerVpId: 'alpha', turnId: 'historic',
    causalRootId: user.id, toolCalls: [{ id: 'historic-tool', name: 'Read', input: { file_path: 'note.txt' } }] });
  store.append({ sessionId: id, role: 'tool', content: 'file contents', threadId: 'old', turnId: 'historic', toolCallId: 'historic-tool', causalRootId: user.id });
  const answer = store.append({ sessionId: id, role: 'assistant', content: 'answer historic', threadId: 'old', speakerVpId: 'alpha', turnId: 'historic', causalRootId: user.id, stopReason: 'end_turn' });
  const historic = rows(id);
  // A historical provider tool call without its result is not a complete fork.
  store.append({ sessionId: id, role: 'assistant', content: 'incomplete', threadId: 'old', speakerVpId: 'alpha', turnId: 'incomplete',
    toolCalls: [{ id: 'unfinished-tool', name: 'Read', input: {} }] });
  await send('active');
  await waitCalls(1);
  const source = rows(id);
  const fork = copy('historic', { throughTurnId: 'historic' });
  const copied = expectFork(fork, historic);
  // UI history projects tool results into their owning assistant, while raw
  // persistence above must still contain the complete provider tool pair.
  expect(history(fork.session.id).map(row => row.content)).toEqual(['question historic', 'checking', 'answer historic']);
  expect(new ConversationStore(root).loadAllBySession(fork.session.id).map(row => row.content)).toEqual(historic.map(row => row.content));
  expect(copied.find(row => row.origin.messageId === toolOwner.id).toolCalls[0].id).toBe('historic-tool');
  expect(copied.find(row => row.origin.messageId === answer.id).causalRootId).toBe(copied[0].id);
  const beforeRejected = inventory();
  for (const [requestId, throughTurnId, code] of [
    ['empty', '', 'invalid_fork_boundary'], ['missing', 'missing', 'fork_boundary_not_found'],
    ['incomplete', 'incomplete', 'incomplete_fork_boundary'],
    ['active', calls[0].vpTurnId, 'incomplete_fork_boundary'],
  ]) {
    expect(copy(requestId, { throughTurnId })).toMatchObject({ op: 'copy', ok: false, error: { code, sessionId: id } });
    expect(inventory()).toEqual(beforeRejected); // transactional rollback, no discoverable partial clone
  }
  expect(rows(id)).toEqual(source);
  expectSourceRunning();
});

it('fails closed for untracked legacy activity and guards merge using actual ingress rather than broker state', async () => {
  completedTurn();
  seedSession('session_other');
  const source = rows(id), before = inventory();
  const { ctrl } = __testHooks.seedRunningVpTurn({ sessionId: id, vpId: 'alpha' });
  expect(copy('untracked')).toMatchObject({ op: 'copy', ok: false, error: { code: 'session_running', sessionId: id } });
  expect(copy('untracked-historic', { throughTurnId: 'historic' })).toMatchObject({ ok: false, error: { code: 'session_running' } });
  expect(ctrl.signal.aborted).toBe(false);
  expect(rows(id)).toEqual(source);
  expect(inventory()).toEqual(before);
  __testHooks.resetAbortState();
  const pending = send('ingress-only');
  __testHooks.resetVpStatusBroker();
  for (const [sessionId, otherSessionId, requestId] of [[id, 'session_other', 'ingress-merge'], ['session_other', id, 'other-ingress-merge']]) {
    handleYeaftMergeSessions({ sessionId, otherSessionId, requestId });
    expect(result(requestId)).toMatchObject({ op: 'merge', ok: false, sourceSessionId: sessionId, otherSessionId,
      error: { code: 'session_running', sessionId: id } });
  }
  expect(rows(id)).toEqual(source); // guard ran before input persistence's first await
  expect(inventory()).toEqual(before);
  await pending;
  await waitCalls(1);
  expectFork(copy('tracked-ingress'), source);
  expectSourceRunning();
});
