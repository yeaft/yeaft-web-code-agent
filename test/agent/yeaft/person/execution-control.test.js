import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';

import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check) {
  for (let i = 0; i < 300; i++) { const result = await read(); if (check(result)) return result; await sleep(10); }
  throw new Error('Execution did not reach expected boundary');
}
function proposal(input, next = null) {
  const p = finalProposal(input.state.version); p.concepts = []; p.state.focusConceptIds = []; p.reply = null;
  p.next = next ? { model: 'test/first', effort: null, reason: 'Continue authorized work.', capability: next.id ? next : null } : null;
  return p;
}
async function create(stream, more = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'person-control-')); directories.push(dir);
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter: { stream }, leaseMs: 1500,
    embedding: { enabled: false }, ...more }); services.push(service);
  await call(service, 'open'); return service;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person unlimited main execution controls', () => {
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
      const input = JSON.parse(params.messages[0].content); count++;
      if (count === 1) {
        yield { type: 'usage', inputTokens: 7, outputTokens: 11 };
        entered.resolve(); await release.promise;
      }
      const next = count === 1 ? { id: 'catalog.view', args: { id: 'FileRead' } }
        : count === 2 ? { id: 'FileRead', args: { file_path: '/unused-by-fake' } } : null;
      yield { type: 'text_delta', text: JSON.stringify(proposal(input, next)) };
      yield { type: 'stop', stopReason: 'end_turn' };
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

  it('fences controls by owner and exact live episode, and prevents late cleanup from deleting a replacement job', async () => {
    const entered = deferred(), release = deferred();
    const service = await create(async function* (params) {
      entered.resolve(); await release.promise;
      yield { type: 'text_delta', text: JSON.stringify(proposal(JSON.parse(params.messages[0].content))) };
      yield { type: 'stop', stopReason: 'end_turn' };
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
