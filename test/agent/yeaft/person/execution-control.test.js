import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from './fixture-adapter.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';

import { config } from './fixtures.js';

const services = [], directories = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

});
