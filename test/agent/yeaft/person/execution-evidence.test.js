import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonNativeRegistry, NATIVE_TOOL_IDS } from '../../../../agent/yeaft/person/native-tools.js';
import { runPersonScript } from '../../../../agent/yeaft/person/script-executor.js';
import { bytes, digest } from '../../../../agent/yeaft/person/contracts.js';

const admission = () => ({ kind: 'think', text: 'Inspect existing evidence.', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 16 } });
async function persist(repository, episode, invocation, result, { code, terminalCode } = {}) {
  const callId = randomUUID();
  await repository.startCall(episode, { callId, requested: { model: 'test/model', effort: null } });
  await repository.finalizeCall(episode, { callId, output: { text: '{}' } });
  await repository.startCapability(episode, { callId, capability: invocation });
  await repository.finalizeCapability(episode, { callId, capability: invocation, result, code, terminalCode });
  return callId;
}
async function prepare(repository, episode) {
  const cap = new PersonCapabilities(repository, episode.ownerId, { episode });
  await cap.execute({ id: 'catalog.view', args: { id: 'Execution.read' } });
  cap.activate(cap.context());
  return cap;
}
const read = (cap, args, options) => cap.execute({ id: 'Execution.read', args }, options);

// Only fresh temporary DBs are used; never inspect the running instance's data.
describe('Person Execution.read durable scoped evidence', () => {
  let root, repositories;
  const repo = (namespace = 'default') => {
    const repository = new SqlitePersonRepository({ yeaftDir: root, namespace, leaseMs: 60000 });
    repositories.push(repository); return repository;
  };
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'person-execution-evidence-')); repositories = []; });
  afterEach(async () => { await Promise.all(repositories.map(r => r.close())); await rm(root, { recursive: true, force: true }); });

  it('pages large Unicode/escaped raw output exactly across reopen, without executing a tool/model or writing a copy', async () => {
    const repository = repo(); await repository.open('alice');
    const { episode } = await repository.admit('alice', admission());
    const output = 'HEAD\n' + '中😀\"\\\n'.repeat(5500) + '\nTAIL';
    const result = { id: 'FileWrite', ok: true, output, rawBytes: bytes(output), sha256: digest(output), sourceRef: 'tool:original-evidence', replaySafe: false };
    const callId = await persist(repository, episode, { id: 'FileWrite', args: { file_path: 'artifact', content: 'do not replay' } }, result);
    await repository.close();
    const reopened = repo(), cap = await prepare(reopened, episode);
    const tool = vi.fn(); cap.toolHost = { execute: tool };
    const sql = new DatabaseSync(reopened.dbPath);
    const before = sql.prepare('SELECT count(*) AS n FROM traces').get().n;
    const personBefore = await reopened.getPerson('alice');
    let offset = 0, restored = '', pages = 0;
    for (;;) {
      const page = await read(cap, { callId, offset, maxBytes: 997 });
      expect(page).toMatchObject({ ok: true, code: null, errorEffect: null, sourceRef: result.sourceRef,
        rawBytes: bytes(output), sha256: digest(output), historical: false, authority: 'evidence-only',
        args: { file_path: 'artifact', content: 'do not replay' }, argsTruncated: false });
      expect(bytes(page)).toBeLessThanOrEqual(8192);
      expect(bytes(page.output)).toBe(page.returnedBytes); expect(page.returnedBytes).toBeLessThanOrEqual(997);
      expect(page.nextOffset).toBe(offset + bytes(page.output)); expect(page.output).not.toContain('\ufffd');
      restored += page.output; pages++;
      if (page.eof) { expect(page.nextOffset).toBe(bytes(output)); break; }
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(50); expect(restored).toBe(output);
    expect(await read(cap, { callId, offset: bytes(output) })).toMatchObject({ output: '', returnedBytes: 0, eof: true });
    expect(sql.prepare('SELECT count(*) AS n FROM traces').get().n).toBe(before); sql.close();
    expect(await reopened.getPerson('alice')).toEqual(personBefore); expect(tool).not.toHaveBeenCalled();
  });

  it('restricts historical reads to existing same namespace/owner/person episodes while keeping the current live fence', async () => {
    const repository = repo(), foreign = repo('foreign'); await repository.open('alice'); await repository.open('bob'); await foreign.open('alice');
    const prior = (await repository.admit('alice', admission())).episode;
    const priorId = await persist(repository, prior, { id: 'FileWrite', args: { file_path: 'x' } }, { ok: true, output: 'historical effect' });
    await repository.finish(prior, 'failed', 'INTERRUPTED');
    const live = (await repository.admit('alice', admission())).episode;
    const bob = (await repository.admit('bob', admission())).episode;
    const other = (await foreign.admit('alice', admission())).episode;
    const bobId = await persist(repository, bob, { id: 'Think', args: {} }, { output: 'bob secret' });
    const otherId = await persist(foreign, other, { id: 'Think', args: {} }, { output: 'namespace secret' });
    const cap = await prepare(repository, live);
    expect(await read(cap, { callId: priorId, episodeId: prior.id })).toMatchObject({ output: 'historical effect', historical: true, authority: 'evidence-only' });
    for (const args of [{ callId: priorId }, { callId: bobId, episodeId: bob.id }, { callId: otherId, episodeId: other.id }, { callId: priorId, episodeId: 'nonexistent' }, { callId: 'missing', episodeId: prior.id }]) {
      await expect(read(cap, args)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(repository.executionRead({ ...live, personId: bob.personId }, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    await expect(foreign.executionRead(live, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    await expect(repository.executionRead(prior, { callId: priorId })).rejects.toMatchObject({ code: 'STALE' });
    await repository.cancel('alice', live.id);
    await expect(read(cap, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
  });
});

describe('Person Execution.read discovery and native projection', () => {
  it('never starts a canceled read or returns a result after cancellation, and never exposes this authority to Script/child tools', async () => {
    const executionRead = vi.fn(), tool = vi.fn();
    const cap = new PersonCapabilities({ executionRead }, 'alice', { episode: { id: 'episode', ownerId: 'alice' }, toolHost: { execute: tool } });
    await cap.execute({ id: 'catalog.view', args: { id: 'Execution.read' } });
    const controller = new AbortController(); controller.abort();
    await expect(read(cap, { callId: 'original' }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(executionRead).not.toHaveBeenCalled(); expect(tool).not.toHaveBeenCalled();
    const during = new AbortController(); executionRead.mockImplementation(async () => { during.abort(); return { output: 'late' }; });
    await expect(read(cap, { callId: 'original' }, { signal: during.signal })).rejects.toBe(during.signal.reason);
    const child = createPersonNativeRegistry();
    expect(child.has('Execution.read')).toBe(false); expect(NATIVE_TOOL_IDS).not.toContain('Execution.read');
    await expect(child.execute('Execution.read', { callId: 'original' }, {})).rejects.toThrow();
    expect(await runPersonScript('return [typeof Execution, typeof repository, typeof require, typeof tools];', {})).toMatchObject({ ok: true, output: ['undefined', 'undefined', 'undefined', 'undefined'] });
    expect(await runPersonScript('return Execution.read(input);', { callId: 'original' })).toMatchObject({ ok: false });
    expect(executionRead).toHaveBeenCalledTimes(1); expect(tool).not.toHaveBeenCalled();
  });
});
