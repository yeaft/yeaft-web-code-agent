import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  __testHooks,
  __testDrainVpDrivers,
  __testResetVpState,
  __testSetSession,
  handleYeaftCopySession,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';

// Native ingress, classification, fan-out, drivers, tasks, CRUD and durable
// transcript traversal are real. Only the model query has a terminal gate.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const original = Object.fromEntries(['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired'].map(key => [key, ctx[key]]));
let root, store, calls, runtime;
const id = 'session_source';
const config = { model: 'gpt-4.1', modelEffort: 'medium' };

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
  vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (args) {
    const gate = deferred();
    const call = { ...args, engine: this, gate, running: true };
    calls.push(call);
    // query normally owns the private running flag. Model that lifecycle here
    // so the REAL wakeForPendingUserMessage accepts related input on this engine.
    Object.defineProperty(this, 'isRunning', { configurable: true, get: () => call.running });
    const output = { sessionId: args.sessionId || id, role: 'assistant', threadId: args.threadId,
      speakerVpId: args.senderVpId, turnId: args.vpTurnId, causalRootId: args.causalRootId || args.currentUserMessage?.id };
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
  __testHooks.resetRuntimeFactoriesForTest();
  await closeConversationHistoryIndexes();
  vi.restoreAllMocks();
  Object.assign(ctx, original);
  rmSync(root, { recursive: true, force: true });
});

it('forks completed history while orphaned tasks resume, restoring checkpoints or recovering a legacy human-root fence', async () => {
  completedTurn();
  const prefix = rows(id);
  const checkpoint = join(sessionsRoot(root), id, 'copy-boundary.json');
  // Exercise a real TaskManager restart, not an injected runtime status. The
  // task is persisted with the source turn and becomes orphaned on reload.
  runtime.taskManager = new TaskManager({ yeaftDir: root });
  installYeaftRuntimeBridge(runtime);
  await send('before-restart');
  await waitCalls(1);
  const activeInput = rows(id).find(row => row.clientMessageId === 'before-restart');
  runtime.taskManager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry',
    source: { threadId: calls[0].threadId, causalRootId: activeInput.id } });
  expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({ sessionId: id, rowCount: prefix.length });
  expect(statSync(checkpoint).mode & 0o777).toBe(0o600);
  calls[0].gate.resolve();
  await __testDrainVpDrivers();
  expect(existsSync(checkpoint)).toBe(true); // the task still owns this epoch
  await __testResetVpState(); // process-local maps are lost, durable files survive
  __testHooks.resetVpStatusBroker();

  // A copy may arrive before the first runtime boot. It must not consume or
  // delete the checkpoint, including tasks without legacy causal provenance.
  __testSetSession(null);
  expectFork(copy('restored-cold-first'), prefix);
  expectFork(copy('restored-cold-second'), prefix);
  expect(existsSync(checkpoint)).toBe(true);
  runtime = { yeaftDir: root, config: {}, conversationStore: store, taskManager: new TaskManager({ yeaftDir: root }) };
  __testSetSession(runtime);
  installYeaftRuntimeBridge(runtime);
  expectFork(copy('restored-before-rescue'), prefix);
  await waitCalls(2);
  expectFork(copy('restored-whole'), prefix);
  expectFork(copy('restored-historic', { throughTurnId: 'historic' }), prefix);
  const beforeRejected = inventory();
  expect(copy('restored-active', { throughTurnId: calls[1].vpTurnId }))
    .toMatchObject({ ok: false, error: { code: 'incomplete_fork_boundary' } });
  expect(inventory()).toEqual(beforeRejected);
  expectSourceRunning();
  calls[1].gate.resolve();
  await __testDrainVpDrivers();
  expect(__testHooks.sessionHasActiveWork(id)).toBe(false);
  expect(existsSync(checkpoint)).toBe(false);
  expectFork(copy('restored-idle'), rows(id));

  // An older Agent had no checkpoint. Recover before the persisted task's
  // human causal root, never by treating its partial assistant as complete.
  await __testResetVpState();
  __testHooks.resetVpStatusBroker();
  const legacyPrefix = rows(id);
  const user = store.append({ sessionId: id, role: 'user', content: 'legacy pending', clientMessageId: 'legacy-input' });
  store.append({ sessionId: id, role: 'assistant', content: 'legacy partial', turnId: 'legacy-active',
    speakerVpId: 'alpha', causalRootId: user.id, incomplete: true });
  const manager = new TaskManager({ yeaftDir: root });
  manager.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry',
    source: { threadId: 'legacy', causalRootId: user.id } });
  runtime = { yeaftDir: root, config: {}, conversationStore: store, taskManager: new TaskManager({ yeaftDir: root }) };
  __testSetSession(runtime);
  installYeaftRuntimeBridge(runtime);
  expectFork(copy('legacy-before-rescue'), legacyPrefix);
  await waitCalls(3);
  const unchanged = rows(id);
  expectFork(copy('legacy-whole'), legacyPrefix);
  expectFork(copy('legacy-historic', { throughTurnId: 'historic' }), prefix);
  expect(rows(id)).toEqual(unchanged);
  expectSourceRunning();
  calls[2].gate.resolve();
  await __testDrainVpDrivers();
  expectFork(copy('legacy-idle'), rows(id));

  // Mixed legacy startup tasks must not let one known root authorize copying
  // another orphan with unknown provenance, including boot ingress that has
  // captured a newer head. Without evidence, keep the explicit error.
  await __testResetVpState();
  __testHooks.resetVpStatusBroker();
  const mixed = new TaskManager({ yeaftDir: root });
  mixed.startTask({ sessionId: id, ownerVpId: 'alpha', resultDelivery: 'model_reentry', source: {} });
  mixed.startTask({ sessionId: id, ownerVpId: 'beta', resultDelivery: 'model_reentry', source: { causalRootId: user.id } });
  runtime = { yeaftDir: root, config: {}, conversationStore: store, taskManager: new TaskManager({ yeaftDir: root }) };
  __testSetSession(runtime);
  installYeaftRuntimeBridge(runtime);
  expect(copy('unknown-mixed')).toMatchObject({ ok: false, error: { code: 'session_running' } });
  expect(copy('unknown-mixed-historic', { throughTurnId: 'historic' }))
    .toMatchObject({ ok: false, error: { code: 'session_running' } });
  expect(existsSync(checkpoint)).toBe(false);
});
