import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from './fixture-adapter.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { turnView } from '../../../../agent/yeaft/person/turn-diagnostics.js';
import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check) {
  for (let i = 0; i < 300; i++) { const result = await read(); if (check(result)) return result; await sleep(10); }
  throw new Error('Execution did not reach expected boundary');
}
function* tool(index, name, input = {}) {
  yield { type: 'tool_call', id: `tool-${index}`, name, input };
  yield { type: 'stop', stopReason: 'tool_use' };
}
function* finish(params) {
  if (!params.tools.length) {
    const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.reply = null;
    yield { type: 'text_delta', text: JSON.stringify(p) };
  }
  yield { type: 'stop', stopReason: 'end_turn' };
}
async function create(stream, more = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'person-control-')); directories.push(dir);
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter: { stream }, leaseMs: 1500,
    embedding: { enabled: false }, nativeFixture: false, ...more }); services.push(service);
  await call(service, 'open'); return service;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person unlimited main execution controls', () => {
  it.each([
    ['call_output', null, 7, 'completed'],
    ['call_failed', 'PROVIDER_FAILED', 8, 'failed'],
    ['call_failed', 'CANCELLED', 9, 'cancelled'],
    ['call_failed', 'INTERRUPTED', undefined, 'interrupted'],
    ['call_output', null, undefined, 'completed'],
  ])('projects actual duration for %s/%s, keeping unmeasured legacy time unknown', (kind, code, requestElapsedMs, status) => {
    const turn = turnView({ id: 'duration', status: 'completed' }, [
      { kind: 'call_started', callId: 'c', createdAt: '2026-10-12T00:00:00Z', requestedModel: 'm' },
      { kind, code, callId: 'c', createdAt: '2026-10-12T01:00:00Z', requestElapsedMs },
    ]);
    expect(turn.calls[0]).toMatchObject({ status, elapsedMs: requestElapsedMs ?? null });
  });

  it('ignores legacy quotas, runs 45 model calls with bounded requests and diagnostics, retaining original traces', async () => {
    let count = 0, cognitionCalls = 0;
    const service = await create(async function* (params) {
      const input = JSON.parse(params.messages[0].content); count++;
      if (!params.tools.length) cognitionCalls++;
      expect(input.previousProposal).toBeNull(); expect(input.episodeWork).toBeUndefined();
      expect(input.budget).not.toHaveProperty('remainingCalls');
      expect(input.inheritedSourceRefs.length).toBeLessThanOrEqual(128);
      expect(JSON.stringify(input).length).toBeLessThan(30000);
      expect(Buffer.byteLength(JSON.stringify(params.messages)) + Buffer.byteLength(JSON.stringify(params.tools)) + Buffer.byteLength(JSON.stringify(params.system)))
        .toBeLessThanOrEqual(config.availableModels[0].contextWindow - 4096 - 1024);
      yield { type: 'usage', inputTokens: 3, outputTokens: 5 };
      // 43 tool-producing calls + native end_turn + one final cognition = 45
      // provider dispatches; no legacy quota can limit those dispatches.
      if (count <= 43) yield* tool(count, 'catalog__search', { query: 'authorized work' });
      else yield* finish(params);
    }, { maxCalls: 'legacy invalid value ignored' });
    const { episodeId } = await call(service, 'think', { clientMessageId: 'many' });
    const snapshot = await until(() => call(service, 'snapshot'), result => !result.busy);
    expect(snapshot.latestEpisode.status).toBe('completed'); expect(count).toBe(45); expect(cognitionCalls).toBe(1);
    expect(snapshot.state.version).toBe(1);
    const turn = (await call(service, 'turns')).items[0];
    expect(turn.budget.calls).toBeNull(); expect(turn.calls).toHaveLength(32);
    expect(turn.calls[0].index).toBe(14); expect(turn.calls.at(-1).index).toBe(45);
    expect(turn).toMatchObject({ loopCount: 45, callsTruncated: true, usageScope: 'latest-call-window', callWindowLimit: 32 });
    expect(turn.usage).toMatchObject({ inputTokens: 96, outputTokens: 160, totalTokens: 256, reportedCalls: 32, complete: true });
    expect(turn.calls.filter(item => item.protocol === 'cognition')).toHaveLength(1);
    let cursor = null, starts = 0, capabilityStarts = 0, allInputTokens = 0, allOutputTokens = 0;
    do {
      const page = await call(service, 'traces', { limit: 20, cursor });
      const episodeTraces = page.items.filter(trace => trace.episodeId === episodeId);
      starts += episodeTraces.filter(trace => trace.kind === 'call_started').length;
      capabilityStarts += episodeTraces.filter(trace => trace.kind === 'capability_started').length;
      for (const trace of episodeTraces.filter(trace => trace.kind === 'call_output')) {
        allInputTokens += trace.output.usage.inputTokens; allOutputTokens += trace.output.usage.outputTokens;
      }
      expect(page.items.some(trace => trace.kind === 'budget_exhausted')).toBe(false);
      cursor = page.nextCursor;
    } while (cursor);
    expect(starts).toBe(45); expect(capabilityStarts).toBe(43);
    expect(allInputTokens).toBe(135); expect(allOutputTokens).toBe(225);
    expect((await call(service, 'executions')).main).toBeNull();
  });

  it('bounds accumulated execution previews through 40 real tool dispatches without replay or trace loss', async () => {
    let count = 0, effects = 0, sawOmitted = false, cognitionCalls = 0;
    const original = PersonRuntime.prototype.start;
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      const tool = this.parentToolRegistry.get('FileRead');
      this.parentToolRegistry.register({ ...tool, execute: async () => `observation ${++effects}\n${'x'.repeat(6000)}` });
      return original.call(this, episode);
    });
    const service = await create(async function* (params) {
      count++;
      for (const message of params.messages.filter(message => message.role === 'user')) {
        const notice = JSON.parse(message.content);
        if (notice.omittedExecutionGroups) {
          sawOmitted = true;
          expect(notice.capsules.length).toBeLessThanOrEqual(16);
          expect(Buffer.byteLength(JSON.stringify(notice.capsules))).toBeLessThanOrEqual(16384);
          expect(notice.notice).toContain('never repeat effects');
        }
      }
      expect(params.messages[0].content).not.toContain('episodeProgress');
      if (!params.tools.length) cognitionCalls++;
      if (count <= 40) yield* tool(count, 'FileRead', { file_path: '/fake' });
      else yield* finish(params);
    });
    await call(service, 'think', { clientMessageId: 'tool-history' });
    const done = await until(() => call(service, 'snapshot'), result => !result.busy);
    expect(done.latestEpisode.status).toBe('completed');
    expect(count).toBe(42); expect(effects).toBe(40); expect(sawOmitted).toBe(true); expect(cognitionCalls).toBe(1);
    let cursor = null; const results = [];
    do {
      const page = await call(service, 'traces', { limit: 50, cursor });
      results.push(...page.items.filter(trace => trace.kind === 'capability_result' && trace.capability.id === 'FileRead'));
      cursor = page.nextCursor;
    } while (cursor);
    expect(results).toHaveLength(40);
    expect(results.every(trace => trace.result.output.length > 6000)).toBe(true);
  });

  it('recovers an expired persisted pause as interrupted, never as a resumable live job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-abandoned-pause-')); directories.push(dir);
    const repository = new SqlitePersonRepository({ yeaftDir: dir, leaseMs: 300 });
    await repository.open('alice');
    const { episode } = await repository.admit('alice', { kind: 'think', text: '', clientMessageId: 'abandoned',
      workerId: 'lost-worker', budget: { calls: null } });
    await repository.executionControl(episode, { status: 'paused' }); await repository.close();
    await sleep(350);
    const stream = vi.fn();
    const service = createPersonService({ yeaftDir: dir, config, adapter: { stream }, embedding: { enabled: false } });
    services.push(service);
    const untouched = await call(service, 'executions');
    expect(untouched.main).toBeNull();
    expect(untouched.items[0]).toMatchObject({ id: episode.id, status: 'running', controlStatus: 'paused' });
    // Diagnostic polling is read-only even after the lease expires; only the
    // explicit recovery read below marks the lost in-memory job interrupted.
    expect((await call(service, 'executions')).items[0].status).toBe('running');
    await expect(call(service, 'resume', { episodeId: episode.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(service, 'snapshot')).latestEpisode.status).toBe('interrupted');
    expect((await call(service, 'executions')).items[0].controlStatus).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it('pauses an in-flight provider before tool dispatch, reports live usage, keeps lease, resumes without replay', async () => {
    const entered = deferred(), release = deferred(); let count = 0, executions = 0, runtime;
    const original = PersonRuntime.prototype.start;
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      runtime = this;
      const tool = this.parentToolRegistry.get('FileRead');
      this.parentToolRegistry.register({ ...tool, execute: async () => { executions++; return 'observed once'; } });
      return original.call(this, episode);
    });
    const service = await create(async function* (params) {
      count++;
      if (count === 1) {
        yield { type: 'usage', inputTokens: 7, outputTokens: 11 };
        entered.resolve(); await release.promise;
        yield* tool(count, 'FileRead', { file_path: '/unused-by-fake' });
      } else yield* finish(params);
    });
    const { episodeId } = await call(service, 'think', { clientMessageId: 'pause-provider' }); await entered.promise;
    const live = await call(service, 'executions');
    expect(live.main).toMatchObject({ episodeId, status: 'running', phase: 'model', loops: 1,
      models: [{ model: 'test/first', calls: 1, usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 } }] });
    expect(live.main.elapsedMs).toBeGreaterThanOrEqual(0); expect(live.main.startedAt).toBeTruthy();
    expect(await call(service, 'pause', { episodeId })).toEqual({ episodeId, status: 'pausing' });
    expect(runtime.running.get(episodeId).controller.signal.aborted).toBe(false);
    await sleep(30); expect(count).toBe(1);
    release.resolve();
    await until(() => call(service, 'executions'), result => result.main?.status === 'paused');
    await sleep(3200); // More than two complete lease periods: pause must keep ownership.
    const snapshot = await call(service, 'snapshot');
    expect(snapshot).toMatchObject({ busy: true, main: { status: 'paused' }, latestEpisode: { status: 'paused' } });
    expect(count).toBe(1); expect(executions).toBe(0);
    expect(await call(service, 'resume', { episodeId })).toEqual({ episodeId, status: 'running' });
    const done = await until(() => call(service, 'snapshot'), result => !result.busy);
    expect(done.state.version).toBe(1); expect(count).toBe(3); expect(executions).toBe(1);
    await expect(call(service, 'resume', { episodeId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('binds a deferred paused handshake to its gate when resume then pause replaces it', async () => {
    const providerEntered = deferred(), providerRelease = deferred();
    const pausedWriteEntered = deferred(), pausedWriteRelease = deferred(), replacementPaused = deferred();
    const durableStatuses = []; let pausedWrites = 0, effects = 0;
    const repository = { executionControl: vi.fn(async (_episode, { status }) => {
      if (status === 'paused' && ++pausedWrites === 1) {
        pausedWriteEntered.resolve(); await pausedWriteRelease.promise;
      }
      durableStatuses.push(status);
      if (status === 'paused' && pausedWrites === 2) replacementPaused.resolve();
    }), heartbeat: vi.fn().mockResolvedValue() };
    const runtime = new PersonRuntime({ repository, getProvider: () => {} });
    runtime.run = async (_episode, _controller, job) => {
      providerEntered.resolve(); await providerRelease.promise;
      await runtime.boundary(job, 'committing', null, () => { effects++; });
    };
    runtime.start({ id: 'pause-generation', ownerId: 'alice', createdAt: new Date() });
    const job = runtime.running.get('pause-generation');
    try {
      await providerEntered.promise;
      await runtime.control('alice', 'pause-generation', 'pause');
      providerRelease.resolve(); await pausedWriteEntered.promise;
      const oldGate = job.pauseGate;
      const resumed = runtime.control('alice', 'pause-generation', 'resume');
      const repaused = runtime.control('alice', 'pause-generation', 'pause');
      expect(job.pauseGate).not.toBe(oldGate); expect(job.status).toBe('pausing');
      pausedWriteRelease.resolve(); await Promise.all([resumed, repaused]);
      // Flush only the already queued promise reactions, without timers/polling.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(job.status).toBe('paused');
      expect(durableStatuses).toEqual(['pausing', 'paused', 'running', 'pausing', 'paused']);
      await replacementPaused.promise;
      expect(effects).toBe(0); expect(runtime.execution('alice').resumable).toBe(true);
      await runtime.control('alice', 'pause-generation', 'resume'); await job.promise;
      expect(effects).toBe(1);
      expect(durableStatuses.at(-1)).toBe('running');
      expect(runtime.running.size).toBe(0);
    } finally {
      providerRelease.resolve(); pausedWriteRelease.resolve();
      job.controller.abort(); await job.promise;
    }
  });

  it('persists actual provider duration, excluding a pause after durable start but before dispatch', async () => {
    const started = deferred(), releaseStart = deferred(); let dispatched = 0; const measured = [];
    const originalStart = PersonRuntime.prototype.start;
    const originalFinish = PersonRuntime.prototype.finishUsage;
    vi.spyOn(PersonRuntime.prototype, 'finishUsage').mockImplementation(function (...args) {
      const duration = originalFinish.apply(this, args); measured.push(duration); return duration;
    });
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      const startCall = this.repository.startCall.bind(this.repository);
      this.repository.startCall = async (...args) => {
        const result = await startCall(...args); started.resolve(); await releaseStart.promise; return result;
      };
      return originalStart.call(this, episode);
    });
    const service = await create(async function* (params) {
      dispatched++;
      yield* finish(params);
    });
    const { episodeId } = await call(service, 'think', { clientMessageId: 'duration-after-pause' });
    try {
      await started.promise;
      await call(service, 'pause', { episodeId }); releaseStart.resolve();
      await until(() => call(service, 'executions'), result => result.main?.status === 'paused');
      expect(dispatched).toBe(0);
      await sleep(70);
      await call(service, 'resume', { episodeId });
      await until(() => call(service, 'snapshot'), result => !result.busy);
      const recorded = (await call(service, 'turns')).items[0].calls[0];
      expect(dispatched).toBe(2);
      expect(measured.every(Number.isSafeInteger)).toBe(true);
      expect(recorded.elapsedMs).toBe(measured[0]);
      const lifecycleMs = new Date(recorded.endedAt) - new Date(recorded.createdAt);
      expect(lifecycleMs - recorded.elapsedMs).toBeGreaterThanOrEqual(60);
    } finally { releaseStart.resolve(); }
  });

  it('pauses the tools-free final cognition before committing and exposes exact continuous live usage', async () => {
    const entered = deferred(), release = deferred(); let count = 0;
    const service = await create(async function* (params) {
      count++;
      yield { type: 'usage', inputTokens: count * 2, outputTokens: count * 3 };
      if (!params.tools.length) { entered.resolve(); await release.promise; }
      if (count === 1) yield* tool(count, 'catalog__search', { query: 'authorized work' });
      else yield* finish(params);
    });
    const { episodeId } = await call(service, 'think', { clientMessageId: 'pause-commit' });
    await entered.promise;
    const live = (await call(service, 'executions')).main;
    expect(live).toMatchObject({ model: 'test/first', loops: 3, models: [
      { model: 'test/first', calls: 3, completedCalls: 2, usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30, complete: false } },
    ] });
    expect(live.models.every(model => model.elapsedMs >= 0)).toBe(true);
    await call(service, 'pause', { episodeId }); release.resolve();
    await until(() => call(service, 'executions'), result => result.main?.status === 'paused');
    const paused = await call(service, 'snapshot');
    expect(paused.state.version).toBe(0); expect(count).toBe(3);
    const diagnostics = await call(service, 'executions');
    expect(diagnostics.items[0].controlStatus).toBe('paused');
    expect(diagnostics.main.models[0].usage).toMatchObject({ totalTokens: 30, complete: true });
    await call(service, 'resume', { episodeId });
    const done = await until(() => call(service, 'snapshot'), result => !result.busy);
    expect(done.state.version).toBe(1); expect(count).toBe(3);
    expect((await call(service, 'turns')).items[0].controlStatus).toBeNull();
  });

  it.each(['resume', 'cancel', 'close'])('allows in-flight host effects to finish once then pauses before the next model; %s releases the gate', async action => {
    const entered = deferred(), release = deferred(); let count = 0, effects = 0;
    const original = PersonRuntime.prototype.start;
    vi.spyOn(PersonRuntime.prototype, 'start').mockImplementation(function (episode) {
      const tool = this.parentToolRegistry.get('FileWrite');
      this.parentToolRegistry.register({ ...tool, execute: async () => {
        entered.resolve(); await release.promise; effects++; return 'written once';
      } });
      return original.call(this, episode);
    });
    const service = await create(async function* (params) {
      count++;
      if (count === 1) yield* tool(count, 'FileWrite', { file_path: '/fake', content: 'one effect' });
      else yield* finish(params);
    });
    const { episodeId } = await call(service, 'think', { clientMessageId: `tool-${action}` }); await entered.promise;
    expect(await call(service, 'pause', { episodeId })).toEqual({ episodeId, status: 'pausing' });
    expect((await call(service, 'executions')).main).toMatchObject({ phase: 'capability', capability: 'FileWrite', loops: 1 });
    release.resolve(); await until(() => call(service, 'executions'), result => result.main?.status === 'paused');
    expect(count).toBe(1); expect(effects).toBe(1);
    if (action === 'close') {
      await service.close();
      const restarted = createPersonService({ yeaftDir: directories.at(-1), config, adapter: { async *stream() { throw new Error('no restart calls'); } }, embedding: { enabled: false } });
      services.push(restarted);
      expect((await call(restarted, 'snapshot')).latestEpisode.status).toBe('interrupted');
      expect((await call(restarted, 'executions')).main).toBeNull();
      await expect(call(restarted, 'resume', { episodeId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } else {
      await call(service, action, { episodeId });
      const done = await until(() => call(service, 'snapshot'), result => !result.busy);
      expect(done.latestEpisode.status).toBe(action === 'resume' ? 'completed' : 'cancelled');
      expect(count).toBe(action === 'resume' ? 3 : 1); expect(effects).toBe(1);
    }
  });

  it('fences controls by owner and exact live episode, and prevents late cleanup from deleting a replacement job', async () => {
    const entered = deferred(), release = deferred();
    const service = await create(async function* (params) {
      entered.resolve(); await release.promise;
      yield* finish(params);
    });
    const { episodeId } = await call(service, 'think', { clientMessageId: 'identity' }); await entered.promise;
    await call(service, 'open', {}, 'bob');
    expect((await call(service, 'executions', {}, 'bob')).main).toBeNull();
    await expect(call(service, 'pause', { episodeId }, 'bob')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(service, 'resume', { episodeId: 'wrong-episode' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(service, 'pause', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    release.resolve(); await until(() => call(service, 'snapshot'), result => !result.busy);
    const runtime = new PersonRuntime({ repository: {}, getProvider: () => {} }), oldDone = deferred();
    runtime.run = () => oldDone.promise;
    runtime.start({ id: 'same', ownerId: 'alice', createdAt: new Date() });
    const old = runtime.running.get('same'), replacement = { episode: { id: 'same' } };
    runtime.running.set('same', replacement); oldDone.resolve(); await old.promise;
    expect(runtime.running.get('same')).toBe(replacement); runtime.running.clear();
  });
});
