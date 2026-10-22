import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from './fixture-adapter.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

import { _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';

import { bytes } from '../../../../agent/yeaft/person/contracts.js';
import { config, finalProposal, goalInput } from './fixtures.js';

const services = [], directories = [];
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-async-service-')); directories.push(dir); return dir; }
async function idle(service) {
  for (let i = 0; i < 400; i++) {
    const snapshot = await call(service, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await pause(10);
  }
  throw new Error('Person cognition did not finish');
}
function proposal(input) {
  const p = finalProposal(input.state.version);
  p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
  return p;
}
function use(p, id, args, model = 'test/first', effort = null) {
  p.next = { model, effort, reason: 'Execute the scoped native operation.', capability: { id, args } };
}
function service(dir, adapter, extra = {}) {
  const s = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false }, ...extra });
  services.push(s); return s;
}
function parentAdapter(fn, child) {
  return { async *stream(params) {
    if (!params.requestIdentity?.threadId || !params.requestIdentity.threadId.match(/^[0-9a-f-]{36}$/)) { yield* child(params); return; }
    const input = JSON.parse(params.messages[0].content), p = proposal(input);
    await fn(input, p, params);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
}
beforeEach(() => { _resetAgentRegistry(); _resetNotifications(); });
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.close()));
  vi.restoreAllMocks(); _resetAgentRegistry(); _resetNotifications();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person async native service integration', () => {
  it('joins owned background work before normal commit and preserves completion evidence and raw logs across episodes and restart', async () => {
    const dir = await directory(), inputs = []; let taskId;
    const adapter = parentAdapter((input, p) => {
      inputs.push(input);
      if (input.trigger.text === 'launch') {
        if (inputs.length === 1) use(p, 'catalog.view', { id: 'Bash' });
        if (inputs.length === 2) use(p, 'Bash', { command: command("console.log('started');setTimeout(()=>console.log('completed'),300)"), background: true });
        if (inputs.length === 3) {
          taskId = input.capabilityResult.output.match(/Started background task (\S+)\./)[1];
          use(p, 'catalog.view', { id: 'WaitTask' });
        }
        if (inputs.length === 4) use(p, 'WaitTask', { taskId, timeout_ms: 3000 });
      } else {
        const n = inputs.filter(item => item.trigger.text === 'inspect').length;
        if (n === 1) use(p, 'catalog.view', { id: 'WaitTask' });
        if (n === 2) use(p, 'WaitTask', { taskId, timeout_ms: 3000 });
        if (n === 3) use(p, 'catalog.view', { id: 'ReadTaskLog' });
        if (n === 4) use(p, 'ReadTaskLog', { taskId, offset: 0, maxBytes: 4096 });
        if (n === 5) p.reply = JSON.parse(input.capabilityResult.output).text;
      }
    }, async function* () { throw new Error('no child expected'); });
    const s = service(dir, adapter);
    await call(s, 'open'); await call(s, 'think', { text: 'launch', clientMessageId: 'launch' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    expect(inputs[2].capabilityResult.output).toContain('Started background task');
    // Wait on observed task state rather than assuming a busy CI host finishes in 550ms.
    let completed;
    for (let attempt = 0; attempt < 200; attempt++) {
      completed = (await call(s, 'tasks')).tasks.find(task => task.id === taskId);
      if (completed?.status === 'succeeded') break;
      await pause(20);
    }
    expect(completed?.status).toBe('succeeded');
    expect(inputs).toHaveLength(5); // Completion must not reenter the provider.
    await call(s, 'think', { text: 'inspect', clientMessageId: 'inspect' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    const evidence = inputs[5].taskEvidence;
    expect(evidence.items.some(item => item.kind === 'completion' && item.output.includes(taskId))).toBe(true);
    expect(bytes(evidence)).toBeLessThanOrEqual(8192);
    expect((await call(s, 'messages')).items.some(m => m.text.includes('completed'))).toBe(true);
    await s.close();
    let recovered;
    const next = service(dir, parentAdapter((input, p) => { recovered = input.taskEvidence; p.reply = 'Recovered evidence.'; }, async function* () {}));
    await call(next, 'think', { text: 'recover', clientMessageId: 'recover' });
    expect((await idle(next)).latestEpisode.status).toBe('completed');
    expect(recovered.items.some(item => item.kind === 'completion' && item.output.includes(taskId))).toBe(true);
    const tasksRoot = join(dir, 'person', 'tasks');
    const roots = await readdir(tasksRoot);
    const logs = join(tasksRoot, roots[0], 'tasks', 'sessions');
    const sessionDirs = await readdir(logs);
    expect(await readFile(join(logs, sessionDirs[0], `${taskId}.log`), 'utf8')).toContain('completed');
  });

  it.each(['joining', 'joined'])('fences an in-flight new admission when cancellation of the previous committed episode is %s', async phase => {
    const dir = await directory(), committed = deferred(), commitRelease = deferred(), admitEntered = deferred(), admitRelease = deferred();
    let runtime, parentCalls = 0, cancellation, sending;
    const originalStart = PersonRuntime.prototype.start;
    const starts = vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      runtime = this;
      return originalStart.call(this, episode);
    });
    const originalCommit = SqlitePersonRepository.prototype.commit;
    vi.spyOn(SqlitePersonRepository.prototype, 'commit').mockImplementation(async function (...args) {
      const result = await originalCommit.apply(this, args);
      if (args[0].clientMessageId === 'previous') {
        committed.resolve();
        await commitRelease.promise; // SQLite is inactive, but the old local job still needs joining.
      }
      return result;
    });
    const originalAdmit = SqlitePersonRepository.prototype.admit;
    vi.spyOn(SqlitePersonRepository.prototype, 'admit').mockImplementation(async function (ownerId, input) {
      if (input.clientMessageId === 'racing-send') {
        admitEntered.resolve();
        await admitRelease.promise;
      }
      return originalAdmit.call(this, ownerId, input);
    });
    const s = service(dir, parentAdapter(() => { parentCalls++; }, async function* () { throw new Error('no child expected'); }));
    await call(s, 'open');
    const previous = await call(s, 'send', { text: 'previous input', clientMessageId: 'previous' });
    try {
      await committed.promise;
      expect((await call(s, 'snapshot')).busy).toBe(false);
      expect(runtime.running.has(previous.episodeId)).toBe(true);
      sending = call(s, 'send', { text: 'must not execute', clientMessageId: 'racing-send' });
      await admitEntered.promise;
      cancellation = call(s, 'cancel', { episodeId: previous.episodeId });
      await vi.waitFor(() => expect(runtime.running.get(previous.episodeId)?.status).toBe('cancelling'));
      expect(runtime.pendingCancellations.has('alice')).toBe(true);
      await expect(call(s, 'send', { text: 'also blocked', clientMessageId: 'later-send' })).rejects.toMatchObject({ code: 'BUSY' });
      expect(await call(s, 'receipt', { clientMessageId: 'later-send' })).toMatchObject({ found: false });
      if (phase === 'joined') {
        commitRelease.resolve(); await cancellation;
        expect(runtime.pendingCancellations.has('alice')).toBe(false);
      }
      admitRelease.resolve();
      const ack = await sending;
      expect(ack).toMatchObject({ duplicate: false, status: 'cancelled', deliveryState: 'received' });
      expect(ack.episodeId).not.toBe(previous.episodeId);
      expect(parentCalls).toBe(1); expect(starts).toHaveBeenCalledTimes(1);
      expect(runtime.running.has(ack.episodeId)).toBe(false);
      expect(await call(s, 'receipt', { clientMessageId: 'racing-send' })).toMatchObject({
        found: true, episodeId: ack.episodeId, messageId: ack.messageId, status: 'cancelled', deliveryState: 'received',
      });
      expect(await call(s, 'send', { text: 'must not execute', clientMessageId: 'racing-send' })).toEqual({ ...ack, duplicate: true });
      if (phase === 'joining') {
        expect(runtime.pendingCancellations.has('alice')).toBe(true);
        await expect(call(s, 'send', { text: 'still blocked', clientMessageId: 'joining-send' })).rejects.toMatchObject({ code: 'BUSY' });
      }
      commitRelease.resolve(); await cancellation;
      const snapshot = await call(s, 'snapshot');
      expect(snapshot).toMatchObject({ busy: false, state: { version: 1 }, latestEpisode: { id: ack.episodeId, status: 'cancelled' } });
      expect((await call(s, 'messages')).items.filter(message => message.role === 'user')).toEqual(expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'previous', text: 'previous input', deliveryState: 'received' }),
        expect.objectContaining({ id: ack.messageId, clientMessageId: 'racing-send', text: 'must not execute', deliveryState: 'received' }),
      ]));
      expect(await call(s, 'receipt', { clientMessageId: 'previous' })).toMatchObject({ episodeId: previous.episodeId, status: 'completed' });
      await call(s, 'send', { text: 'allowed after cancellation', clientMessageId: 'after-race' });
      expect((await idle(s)).latestEpisode.status).toBe('completed');
      expect(parentCalls).toBe(2);
    } finally {
      commitRelease.resolve(); admitRelease.resolve();
      await Promise.allSettled([sending, cancellation].filter(Boolean));
    }
  });

  it('fences owner admission throughout cancellation of a waiting goal and overlapping joins', async () => {
    const dir = await directory(), toolStarted = deferred(), toolRelease = deferred(), toolAborted = deferred();
    const durableEntered = [deferred(), deferred()], durableRelease = [deferred(), deferred()];
    let parentCalls = 0, childCalls = 0, runtime;
    const originalStart = PersonRuntime.prototype.start;
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      runtime = this;
      if (!parentCalls) {
        const tool = this.parentToolRegistry.get('FileRead');
        this.parentToolRegistry.register({ ...tool, execute: async (_args, ctx) => {
          ctx.signal.addEventListener('abort', () => toolAborted.resolve(), { once: true });
          toolStarted.resolve();
          await toolRelease.promise; // Intentionally ignores abort until the actual effect finishes.
          return 'late read observation';
        } });
      }
      return originalStart.call(this, episode);
    });
    const originalCancel = SqlitePersonRepository.prototype.cancel;
    let cancelCalls = 0;
    vi.spyOn(SqlitePersonRepository.prototype, 'cancel').mockImplementation(async function (...args) {
      const index = cancelCalls++;
      durableEntered[index].resolve(); await durableRelease[index].promise;
      return originalCancel.apply(this, args);
    });
    const adapter = parentAdapter(async (input, p) => {
      parentCalls++;
      if (parentCalls === 1) use(p, 'catalog.view', { id: 'SpawnAgent' });
      if (parentCalls === 2) use(p, 'SpawnAgent', { name: 'blocked-reader', task: 'Read the workspace.', persona: 'explorer' });
      if (parentCalls === 3) {
        await toolStarted.promise;
        use(p, 'Execution.goal', goalInput([input.trigger.ref], { kind: 'work', status: 'waiting',
          reason: 'The owned child is still reading.', nextStep: 'Collect the child result.',
          waitFor: [JSON.parse(input.capabilityResult.output).agentId] }));
      }
    }, async function* () {
      childCalls++;
      yield { type: 'tool_call', id: 'blocked-read', name: 'FileRead', input: { file_path: 'unused' } };
      yield { type: 'stop', stopReason: 'tool_use' };
    });
    const s = service(dir, adapter);
    await call(s, 'open');
    await call(s, 'think', { text: 'launch', clientMessageId: 'blocked-launch' });
    const payload = {};
    let first, second;
    const assertBusy = async suffix => {
      for (const op of ['think', 'send', 'dream']) {
        await expect(call(s, op, { clientMessageId: `${op}-${suffix}`, ...(op === 'dream' ? {} : { text: 'do not start yet' }) })).rejects.toMatchObject({ code: 'BUSY' });
      }
      expect(runtime.isOwnerRunning('alice')).toBe(true);
      expect(parentCalls).toBe(3); expect(childCalls).toBe(1);
    };
    try {
      await vi.waitFor(async () => expect((await call(s, 'executions')).main?.phase).toBe('waiting'));
      expect((await call(s, 'snapshot')).state.version).toBe(0);
      first = call(s, 'cancel', payload);
      await durableEntered[0].promise;
      await assertBusy('durable'); // Fence must exist before repository.cancel resolves.
      durableRelease[0].resolve();
      await toolAborted.promise;
      await assertBusy('joining'); // The waiting goal cannot end until its real child effect has joined.
      second = call(s, 'cancel', payload);
      await durableEntered[1].promise;
      toolRelease.resolve(); await first;
      await assertBusy('overlapping'); // First release must not clear the second cancellation's fence.
      durableRelease[1].resolve(); await second;
      expect(runtime.isOwnerRunning('alice')).toBe(false);
      await call(s, 'think', { text: 'now allowed', clientMessageId: 'after-cancel' });
      expect((await idle(s)).latestEpisode.status).toBe('completed');
      expect(parentCalls).toBe(4); expect(childCalls).toBe(1);
    } finally {
      toolRelease.resolve(); for (const gate of durableRelease) gate.resolve();
      await Promise.allSettled([first, second].filter(Boolean));
    }
  });

});
