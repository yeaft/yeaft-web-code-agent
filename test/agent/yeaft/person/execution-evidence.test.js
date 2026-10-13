import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities, CAPABILITY_LIMITS, foundationCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonNativeRegistry, NATIVE_TOOL_IDS, projectNativeResult } from '../../../../agent/yeaft/person/native-tools.js';
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

  it('preserves failure/effect semantics and original failed args, and serializes internal results without output', async () => {
    const repository = repo(); await repository.open('alice'); const { episode } = await repository.admit('alice', admission());
    const args = { command: 'failed effect', content: '中\\\"'.repeat(3000) };
    const result = { ok: false, code: 'TOOL_TIMEOUT', errorEffect: 'unknown', output: 'observed partial output', sourceRef: 'original-source', rawBytes: 1, sha256: 'wrong-legacy-count' };
    const callId = await persist(repository, episode, { id: 'Bash', args }, result);
    const cap = await prepare(repository, episode), page = await read(cap, { callId });
    expect(page).toMatchObject({ capabilityId: 'Bash', ok: false, code: 'TOOL_TIMEOUT', errorEffect: 'unknown', args: null, argsTruncated: true,
      argsRawBytes: bytes(JSON.stringify(args)), rawBytes: bytes(result.output), sha256: digest(result.output), sourceRef: 'original-source' });
    expect(bytes(JSON.stringify(page.argsPreview))).toBeLessThanOrEqual(1024); expect(page.argsPreview).not.toContain('\ufffd');
    const internal = { items: [1, { text: '中文😀' }], nextCursor: null };
    const internalId = await persist(repository, episode, { id: 'Recall', args: { kind: 'concepts' } }, internal);
    expect(await read(cap, { callId: internalId })).toMatchObject({ outputFormat: 'result-json', output: JSON.stringify(internal), ok: true, sha256: digest(internal) });
    const thrown = await persist(repository, episode, { id: 'Think', args: {} }, undefined, { code: 'UNSUPPORTED' });
    expect(await read(cap, { callId: thrown })).toMatchObject({ ok: false, code: 'UNSUPPORTED', outputFormat: 'result-json' });
    const script = await persist(repository, episode, { id: 'Script.echo', args: { input: [1] } }, { ok: true, output: [1, '😀'] });
    expect(await read(cap, { callId: script })).toMatchObject({ outputFormat: 'output-json', output: JSON.stringify([1, '😀']) });
  });

  it('rejects non-boundary/invalid offsets, unbounded pages and owner/path injection at both capability and repository boundaries', async () => {
    const repository = repo(); await repository.open('alice'); const { episode } = await repository.admit('alice', admission());
    const callId = await persist(repository, episode, { id: 'Think', args: {} }, { output: '中😀end' });
    const cap = await prepare(repository, episode);
    for (const args of [{ callId, offset: 1 }, { callId, offset: 4 }, { callId, offset: 11 }, { callId, offset: -1 }, { callId, offset: 0.5 },
      { callId, maxBytes: 0 }, { callId, maxBytes: 3 }, { callId, maxBytes: 4097 }, { callId, ownerId: 'bob' }, { callId, path: '/private.db' }, { callId, episodeId: null }]) {
      await expect(read(cap, args)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(repository.executionRead(episode, args)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(await read(cap, { callId, offset: 3, maxBytes: 4 })).toMatchObject({ output: '😀', nextOffset: 7, eof: false });
    // Escaping a raw byte may need six JSON bytes. The response shrinks without losing pagination.
    const escapedId = await persist(repository, episode, { id: 'Think', args: {} }, { output: '\u0001'.repeat(10000) });
    const escaped = await read(cap, { callId: escapedId, maxBytes: 4096 });
    expect(bytes(escaped)).toBeLessThanOrEqual(8192); expect(escaped.returnedBytes).toBeGreaterThan(0); expect(escaped.returnedBytes).toBeLessThan(4096);
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

  it('can inspect after-terminal captured output in a later live episode without treating it as accepted behavior', async () => {
    const repository = repo(); await repository.open('alice'); const prior = (await repository.admit('alice', admission())).episode;
    const callId = randomUUID(), invocation = { id: 'FileWrite', args: { file_path: 'x', content: 'effect' } };
    await repository.startCall(prior, { callId, requested: { model: 'test/model', effort: null } });
    await repository.finalizeCall(prior, { callId, output: { text: '{}' } });
    await repository.startCapability(prior, { callId, capability: invocation });
    await repository.cancel('alice', prior.id);
    expect(await repository.finalizeCapability(prior, { callId, capability: invocation, result: { ok: false, output: 'joined evidence', errorEffect: 'unknown', code: 'TOOL_FAILED' } })).toBe(false);
    const live = (await repository.admit('alice', admission())).episode, cap = await prepare(repository, live);
    expect(await read(cap, { callId, episodeId: prior.id })).toMatchObject({ output: 'joined evidence', historical: true, afterTerminal: true, accepted: false, terminalCode: 'CANCELLED', errorEffect: 'unknown' });
  });
});

describe('Person Execution.read discovery and native projection', () => {
  it('demand-loads the contract within the foundation budget and requires actual rendered activation', async () => {
    const executionRead = vi.fn(async () => ({ output: 'evidence' }));
    const cap = new PersonCapabilities({ executionRead }, 'alice', { episode: { id: 'episode', ownerId: 'alice' } });
    expect(foundationCapabilities().map(m => m.id)).not.toContain('Execution.read');
    expect(cap.catalog().nativeToolNotice).toContain('Execution.read');
    await expect(read(cap, { callId: 'original' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const found = await cap.execute({ id: 'catalog.search', args: { query: 'execution evidence' } });
    expect(found.contracts.map(m => m.id)).toContain('Execution.read');
    expect(bytes(cap.context())).toBeLessThanOrEqual(CAPABILITY_LIMITS.activeBytes);
    expect(await read(cap, { callId: 'original' })).toEqual({ output: 'evidence' });
    expect(executionRead).toHaveBeenCalledWith(cap.episode, { callId: 'original', offset: 0, maxBytes: 4096 }, { signal: undefined });
    cap.activate(foundationCapabilities());
    await expect(read(cap, { callId: 'original' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

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

  it.each(['中😀\\\"\n', '\u0001', 'ASCII'])('keeps exact head/tail hidden ranges and callable recovery within escaped JSON bytes for %j', pattern => {
    const output = 'HEAD' + pattern.repeat(18000) + 'TAIL', raw = Buffer.from(output, 'utf8');
    const result = { id: 'FileWrite', callId: 'original-call', episodeId: 'original-episode', ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown', output,
      rawBytes: raw.length, sha256: digest(output), sourceRef: `tool:original-episode:original-call:FileWrite:${digest(output)}` };
    const projected = projectNativeResult(result);
    expect(bytes(projected)).toBeLessThanOrEqual(8192); expect(projected.output).not.toContain('\ufffd');
    expect(projected).toMatchObject({ truncated: true, ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown', rawBytes: raw.length, sha256: result.sha256,
      recovery: {  read: { id: 'Execution.read', args: { callId: 'original-call', episodeId: 'original-episode', offset: 0, maxBytes: 4096 } } } });
    const { start, end } = projected.hiddenRange;
    expect(start).toBeGreaterThan(0); expect(end).toBeLessThan(raw.length); expect(end).toBeGreaterThan(start);
    expect(projected.output).toBe(raw.subarray(0, start).toString('utf8') + `\n[omitted UTF-8 bytes ${start}..${end} of ${raw.length}]\n` + raw.subarray(end).toString('utf8'));
    expect(projected.output.startsWith('HEAD')).toBe(true); expect(projected.output.endsWith('TAIL')).toBe(true);
    expect(result.output).toBe(output); expect(result).not.toHaveProperty('hiddenRange');
  });

  it('attaches recovery even to small/legacy native output and sheds only oversized ancillary preview metadata', () => {
    const result = { id: 'Bash', ok: true, output: 'small', sourceRef: 'tool:episode:call:Bash:hash', source: { notes: '中'.repeat(10000) } };
    const projected = projectNativeResult(result);
    expect(bytes(projected)).toBeLessThanOrEqual(8192);
    expect(projected).toMatchObject({ metadataTruncated: true, recovery: { read: { args: { callId: 'call', episodeId: 'episode' } } } });
    const small = projectNativeResult({ ...result, source: {} });
    expect(small).toMatchObject({ output: 'small', recovery: { read: { id: 'Execution.read' } } });
    expect(small).not.toHaveProperty('truncated');
  });
});
