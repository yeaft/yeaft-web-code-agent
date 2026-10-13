import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonNativeRegistry, NATIVE_TOOL_IDS, projectNativeResult } from '../../../../agent/yeaft/person/native-tools.js';
import { runPersonScript } from '../../../../agent/yeaft/person/script-executor.js';
import { bytes, digest, PersonError } from '../../../../agent/yeaft/person/contracts.js';
import { PersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';
import { projectTaskEvidence } from '../../../../agent/yeaft/person/runtime.js';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';

function projectRead(page, liveEpisodeId) {
  const transcript = new ExecutionTranscript([]), traceCallId = randomUUID();
  const group = transcript.response({ text: '', toolCalls: [{ id: 'read-use', name: 'Execution__read', input: page.recovery.read.args }] });
  const projection = transcript.result(group, 'read-use', traceCallId, { id: 'Execution.read', args: page.recovery.read.args }, page, liveEpisodeId);
  expect(projection.executionTraceCallId).toBe(traceCallId);
  expect(projection.executionEpisodeId).toBe(liveEpisodeId);
  expect(projection.recovery).toEqual(page.recovery);
  expect(group.receipts[0].recovery.input).toEqual(page.recovery.read.args);
  expect(projection).toMatchObject({ rawBytes: page.rawBytes, sha256: page.sha256,
    nextOffset: page.nextOffset, eof: page.eof, outputSpan: { start: page.offset, end: page.nextOffset, totalBytes: page.rawBytes } });
  return projection;
}

const admission = () => ({ kind: 'think', text: 'Inspect existing evidence.', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 16 } });
async function persist(repository, episode, invocation, result, { code, terminalCode } = {}) {
  const callId = randomUUID();
  await repository.startCall(episode, { callId, requested: { model: 'test/model', effort: null } });
  await repository.finalizeCall(episode, { callId, output: { text: '{}' } });
  await repository.startCapability(episode, { callId, capability: invocation });
  await repository.finalizeCapability(episode, { callId, capability: invocation, result, code, terminalCode });
  return callId;
}
async function prepare(repository, episode, taskHost) {
  const cap = new PersonCapabilities(repository, episode.ownerId, { episode, taskHost });
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
    const first = projectRead(await read(cap, { callId, maxBytes: 4096 }), episode.id);
    const shortened = projectNativeResult(first, 2048);
    expect(shortened.truncated).toBe(true);
    expect(shortened.recovery).toEqual(first.recovery);
    expect(shortened.hiddenRange.start).toBeGreaterThanOrEqual(first.offset);
    expect(shortened.hiddenRange.end).toBeLessThanOrEqual(first.nextOffset);
    let descriptor = { ...shortened.recovery.read.args, maxBytes: 997 };
    for (;;) {
      const page = await read(cap, descriptor);
      const projection = projectRead(page, episode.id);
      expect(projection.truncated).not.toBe(true);
      expect(page).toMatchObject({ ok: true, code: null, errorEffect: null, sourceRef: result.sourceRef,
        rawBytes: bytes(output), sha256: digest(output), historical: false, authority: 'evidence-only',
        args: { file_path: 'artifact', content: 'do not replay' }, argsTruncated: false });
      expect(bytes(page)).toBeLessThanOrEqual(8192);
      expect(bytes(page.output)).toBe(page.returnedBytes); expect(page.returnedBytes).toBeLessThanOrEqual(997);
      expect(page.nextOffset).toBe(offset + bytes(page.output)); expect(page.output).not.toContain('\ufffd');
      restored += page.output; pages++;
      if (page.eof) { expect(page.nextOffset).toBe(bytes(output)); break; }
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
      descriptor = { ...projection.recovery.read.args, offset: projection.nextOffset };
    }
    expect(pages).toBeGreaterThan(50); expect(restored).toBe(output);
    expect(await read(cap, { callId, offset: bytes(output) })).toMatchObject({ output: '', returnedBytes: 0, eof: true, replaySafe: false });
    const invalid = await read(cap, { callId, offset: bytes(output) + 1 });
    expect(invalid).toMatchObject({ ok: false, code: 'INVALID_REQUEST', errorEffect: 'none', replaySafe: true });
    expect(invalid.output).toContain('only this read invocation, not the original operation');
    expect(await read(cap, { callId, maxBytes: 4 })).toMatchObject({ ok: true, errorEffect: null, replaySafe: false, capabilityId: 'FileWrite' });
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
      expect(await read(cap, args)).toMatchObject({ ok: false, code: 'NOT_FOUND', errorEffect: 'none', replaySafe: true });
    }
    await expect(repository.executionRead({ ...live, personId: bob.personId }, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    await expect(foreign.executionRead(live, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    await expect(repository.executionRead(prior, { callId: priorId })).rejects.toMatchObject({ code: 'STALE' });
    const executionRead = repository.executionRead.bind(repository);
    const cancelOnMiss = vi.spyOn(repository, 'executionRead').mockImplementation(async (...args) => {
      try { return await executionRead(...args); }
      catch (error) { await repository.cancel('alice', live.id); throw error; }
    });
    await expect(read(cap, { callId: 'missing', episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    cancelOnMiss.mockRestore();
    await expect(read(cap, { callId: priorId, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
  });

  it('recovers historical task-host archives by exact sourceRef across restart, with Unicode pages and fail-closed authority', async () => {
    let repository = repo(); await repository.open('alice');
    const prior = (await repository.admit('alice', admission())).episode;
    let host = new PersonTaskHost({ yeaftDir: root, namespace: 'default' });
    const context = await host.context({ episode: prior, cwd: root });
    const output = 'HEAD中😀"\\\n'.repeat(1600) + 'TAIL';
    // Real task-host archive writer, not guessed fixtures or a SQLite trace ID.
    await writeFile(join(root, 'fixture.txt'), output);
    await context.nativeRegistry.execute('FileRead', { file_path: 'fixture.txt' }, context);
    const archive = host.snapshot('alice').toolResults.find(result => result.tool === 'FileRead');
    const archivePath = archive.rawPath, original = JSON.parse(await readFile(archivePath, 'utf8'));
    expect(original.sourceRef).toBe(archive.sourceRef);
    const preview = projectTaskEvidence(host.snapshot('alice'));
    const archivePreview = preview.items.find(item => item.sourceRef === archive.sourceRef);
    expect(archivePreview).toMatchObject({
      episodeId: prior.id, tool: 'FileRead', childId: null, ok: true, truncated: true,
      recovery: { read: { id: 'Execution.read', args: { sourceRef: archive.sourceRef, episodeId: prior.id, offset: 0, maxBytes: 4096 } } },
      outputSpan: { start: 0, end: bytes(archive.output), totalBytes: bytes(original.output) },
      omittedSuffix: { start: bytes(archive.output), end: bytes(original.output) },
    });
    expect(archivePreview.notice).toContain('PREFIX');
    expect(archivePreview.hiddenRange.end).toBeLessThanOrEqual(archivePreview.outputSpan.end);
    expect(archivePreview.output).not.toContain('TAIL');
    await repository.finish(prior, 'failed', 'INTERRUPTED');
    await host.close(); await repository.close();
    repository = repo();
    const live = (await repository.admit('alice', admission())).episode;
    host = new PersonTaskHost({ yeaftDir: root, namespace: 'default' });
    const cap = await prepare(repository, live, host);
    try {
      const descriptor = { sourceRef: archive.sourceRef, episodeId: prior.id };
      await expect(repository.executionRead(live, { callId: archive.id, episodeId: prior.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(archive.output).not.toContain('\ufffd');
      let offset = 0, restored = '', nextRead = { ...archivePreview.recovery.read.args, maxBytes: 127 };
      const largePage = projectRead(await read(cap, { ...descriptor, maxBytes: 4096 }), live.id);
      const shortened = projectNativeResult(largePage, 2048);
      expect(shortened.truncated).toBe(true);
      expect(shortened.recovery).toEqual(largePage.recovery);
      expect(shortened.recovery.read.args).not.toHaveProperty('callId');
      expect(shortened.notice).toContain('PAGE');
      do {
        const page = await read(cap, nextRead);
        const projection = projectRead(page, live.id);
        expect(projection.recovery.read.args).not.toHaveProperty('callId');
        expect(projection.truncated).not.toBe(true);
        expect(page).toMatchObject({ tool: 'FileRead', childId: null, aborted: false, historical: true, sourceRef: archive.sourceRef, authority: 'evidence-only' });
        expect(page).not.toHaveProperty('callId');
        expect(page.output).not.toContain('\ufffd'); expect(bytes(page)).toBeLessThanOrEqual(8192);
        restored += projection.output; offset = projection.nextOffset;
        nextRead = { ...projection.recovery.read.args, offset };
        if (projection.eof) break;
      } while (true);
      expect(restored).toBe(original.output);
      expect(await read(cap, { callId: archive.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(await read(cap, { callId: randomUUID(), episodeId: prior.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      await expect(read(cap, { ...descriptor, episodeId: live.id })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      const compatible = await read(cap, { callId: archive.id, episodeId: prior.id });
      expect(compatible.sourceRef).toBe(archive.sourceRef); expect(original.output.startsWith(compatible.output)).toBe(true);
      const unicodeOffset = Buffer.from(original.output).indexOf(Buffer.from('中')) + 1;
      for (const badOffset of [unicodeOffset, bytes(original.output) + 1]) {
        expect(await read(cap, { ...descriptor, offset: badOffset })).toMatchObject({ ok: false, code: 'INVALID_REQUEST', errorEffect: 'none', replaySafe: true });
      }
      for (const sourceRef of ['person-tool:../../secret', archive.sourceRef + ':extra', archive.sourceRef + '\n']) {
        expect(await read(cap, { sourceRef, episodeId: prior.id })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
      }
      for (const args of [{ ...descriptor, callId: archive.id }, {}]) {
        expect(await read(cap, args)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
      }
      const cancelled = new AbortController(); cancelled.abort();
      await expect(read(cap, descriptor, { signal: cancelled.signal })).rejects.toBe(cancelled.signal.reason);
      const during = new AbortController(), check = repository.checkExecutionRead.bind(repository);
      let checks = 0;
      const fence = vi.spyOn(repository, 'checkExecutionRead').mockImplementation(async (...args) => {
        const result = await check(...args);
        if (++checks === 2) during.abort();
        return result;
      });
      await expect(host.readToolResult(live, descriptor, { repository, signal: during.signal })).rejects.toMatchObject({ name: 'AbortError' });
      fence.mockRestore();
      const missing = host.toolResultRef(live, randomUUID());
      expect(await read(cap, { sourceRef: missing, episodeId: prior.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      const wrongScope = archive.sourceRef.replace(/:[a-f0-9]{64}:/, ':' + '0'.repeat(64) + ':');
      await expect(read(cap, { ...descriptor, sourceRef: wrongScope })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      for (const forged of [{ ...live, ownerId: 'bob' }, { ...live, personId: 'wrong' }, { ...live, namespace: 'other' }]) {
        await expect(host.readToolResult(forged, descriptor, { repository })).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      }
      await repository.open('bob'); const bob = (await repository.admit('bob', admission())).episode;
      expect(await read(cap, { ...descriptor, episodeId: bob.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      const scope = 'a'.repeat(64), episodeId = randomUUID(), jobId = randomUUID();
      const sourceRef = `person-tool:${scope}:${jobId}`, rawOutput = '中😀\n'.repeat(4000);
      const preview = projectTaskEvidence({ namespace: scope, toolResults: [{ id: jobId, episodeId, tool: 'FileRead', childId: 'child', ok: false, code: 'TOOL_FAILED', errorEffect: 'none', sourceRef, output: rawOutput }] });
      expect(preview.items[0]).toMatchObject({ episodeId, tool: 'FileRead', childId: 'child', ok: false,
        recovery: { read: { id: 'Execution.read', args: { sourceRef, episodeId, offset: 0, maxBytes: 4096 } } }, truncated: true });
      expect(preview.items[0].recovery.read.args).not.toHaveProperty('callId');
      const task = projectNativeResult({ kind: 'task', callId: jobId, sourceRef: `person-task:${scope}:${jobId}`, output: rawOutput }, 1024);
      expect(task.recovery).not.toHaveProperty('read');
      const trace = projectNativeResult({ ...preview.items[0], executionTraceCallId: 'actual-trace', executionEpisodeId: 'live', output: rawOutput }, 2048);
      expect(trace.recovery.read.args).toEqual({ callId: 'actual-trace', episodeId: 'live', offset: 0, maxBytes: 4096 });
      const saved = original.output;
      // Preserve archived error/child provenance; reading never executes it.
      await writeFile(archivePath, JSON.stringify({ ...original, childId: 'child', ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown', aborted: true }));
      expect(await read(cap, descriptor)).toMatchObject({ ok: false, tool: 'FileRead', childId: 'child', code: 'TOOL_FAILED', errorEffect: 'unknown', aborted: true });
      await rm(archivePath); await writeFile(join(root, 'secret'), saved); await symlink(join(root, 'secret'), archivePath);
      await expect(read(cap, descriptor)).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      await rm(archivePath); await writeFile(archivePath, '{broken');
      await expect(read(cap, descriptor)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await writeFile(archivePath, JSON.stringify(original));
      let postReadChecks = 0;
      const postReadFence = vi.spyOn(repository, 'checkExecutionRead').mockImplementation(async (...args) => {
        if (++postReadChecks === 2) await repository.cancel('alice', live.id);
        return check(...args);
      });
      await expect(host.readToolResult(live, descriptor, { repository })).rejects.toMatchObject({ code: 'STALE' });
      postReadFence.mockRestore();
      await expect(read(cap, { sourceRef: missing, episodeId: prior.id })).rejects.toMatchObject({ code: 'STALE' });
    } finally { await host.close(); }
  });

});

describe('Person Execution.read discovery and native projection', () => {
  it('never starts a canceled read or returns a result after cancellation, and never exposes this authority to Script/child tools', async () => {
    const executionRead = vi.fn(), tool = vi.fn();
    const cap = new PersonCapabilities({ executionRead, checkExecutionRead: async () => true }, 'alice', { episode: { id: 'episode', ownerId: 'alice' }, toolHost: { execute: tool } });
    await cap.execute({ id: 'catalog.view', args: { id: 'Execution.read' } });
    const controller = new AbortController(); controller.abort();
    await expect(read(cap, { callId: 'original' }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(executionRead).not.toHaveBeenCalled(); expect(tool).not.toHaveBeenCalled();
    const during = new AbortController(), reason = new Error('cancelled during read');
    executionRead.mockImplementation(async () => { during.abort(reason); return { output: 'late' }; });
    await expect(read(cap, { callId: 'original' }, { signal: during.signal })).rejects.toBe(reason);
    const child = createPersonNativeRegistry();
    expect(child.has('Execution.read')).toBe(false); expect(NATIVE_TOOL_IDS).not.toContain('Execution.read');
    await expect(child.execute('Execution.read', { callId: 'original' }, {})).rejects.toThrow();
    expect(await runPersonScript('return [typeof Execution, typeof repository, typeof require, typeof tools];', {})).toMatchObject({ ok: true, output: ['undefined', 'undefined', 'undefined', 'undefined'] });
    expect(await runPersonScript('return Execution.read(input);', { callId: 'original' })).toMatchObject({ ok: false });
    expect(executionRead).toHaveBeenCalledTimes(1); expect(tool).not.toHaveBeenCalled();
    for (const code of ['STALE', 'STORAGE_UNAVAILABLE']) {
      executionRead.mockRejectedValue(new PersonError(code));
      await expect(read(cap, { callId: 'original' })).rejects.toMatchObject({ code });
    }
    executionRead.mockRejectedValue(Object.assign(new Error('unknown IO effect'), { code: 'INVALID_REQUEST' }));
    await expect(read(cap, { callId: 'original' })).rejects.toThrow('unknown IO effect');

  });
});
