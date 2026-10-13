import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonToolHost } from '../../../../agent/yeaft/person/native-tools.js';
import { executionEvidencePage } from '../../../../agent/yeaft/person/execution-evidence.js';
import { digest, PersonError } from '../../../../agent/yeaft/person/contracts.js';
import { createBashTool } from '../../../../agent/yeaft/tools/bash.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';
import fileRead from '../../../../agent/yeaft/tools/file-read.js';
import { ToolExecutionTimeoutError } from '../../../../agent/yeaft/tools/registry.js';
import { getRuntimePlatformInfo } from '../../../../agent/yeaft/runtime-platform.js';

const invocation = { episodeId: 'episode', callId: 'call' };
const writeArgs = { file_path: 'never-written.txt', content: 'never written' };
const readArgs = { file_path: 'never-read.txt' };
const config = {};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Exercise the real Bash formatter with a fake process boundary: no child is
// spawned, no command is executed, and no systemd probe is needed for the test.
function bashHost(processResult) {
  const runner = vi.fn().mockResolvedValue({ stdout: 'captured output', stderr: '', timedOut: false, ...processResult });
  const tool = createBashTool({ runProcessImpl: runner });
  const barriers = [];
  const nativeRegistry = { execute: vi.fn((id, args, ctx) => {
    expect(id).toBe('Bash');
    return tool.execute(args, { ...ctx, runtimePlatform: getRuntimePlatformInfo({ platform: 'darwin' }) });
  }) };
  const host = createPersonToolHost({ config, getContext: () => ({ nativeRegistry, requestToolBatchBarrier: reason => barriers.push(reason) }) });
  return { host, runner, barriers };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Person native failure continuation boundary', () => {
  it('a confirmed nonzero Bash exit can continue without claiming rollback or safe replay', async () => {
    const { host, runner, barriers } = bashHost({ code: 2 });
    const result = await host.execute('Bash', { command: 'opaque test input', timeout_ms: 1000 }, invocation);
    expect(result).toMatchObject({ ok: false, code: 'TOOL_FAILED', terminal: false, errorEffect: 'unknown', replaySafe: false });
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'bash_exit_nonzero', failureType: 'exit_nonzero', exitCode: 2,
      terminationConfirmed: true, status: 'Exit code: 2; termination confirmed',
      errorEffect: 'unknown', replaySafe: false, output: 'captured output',
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][2]).toMatchObject({ requireExitConfirmation: true, timeoutMs: 1000 });
    expect(barriers).toEqual([]);
  });

  it.each([
    [{ code: 124, timedOut: true, terminationError: 'tree still active' }, 'timeout_unconfirmed', 'owned_timeout'],
    [{ code: 1, terminationError: 'tree still active' }, 'exit_unconfirmed', 'exit_unconfirmed'],
    [{ code: 0, terminationError: 'tree still active' }, 'exit_unconfirmed', 'exit_unconfirmed'],
    [{ code: null }, 'exit_unconfirmed', 'exit_unconfirmed'],
    [{ code: undefined }, 'exit_unconfirmed', 'exit_unconfirmed'],
  ])('unconfirmed process outcome %j is terminal and preserves the batch barrier', async (outcome, failureType, barrierKind) => {
    const { host, barriers } = bashHost(outcome);
    const result = await host.execute('Bash', { command: 'opaque test input' }, invocation);
    expect(result).toMatchObject({ ok: false, terminal: true, errorEffect: 'unknown', replaySafe: false });
    const failure = JSON.parse(result.output);
    expect(failure).toMatchObject({ code: `bash_${failureType}`, failureType, terminationConfirmed: false, errorEffect: 'unknown', replaySafe: false });
    expect(failure.status).toContain('termination unconfirmed');
    expect(failure.error).not.toBe('Command exited with code 0.');
    expect(failure.output).toContain('The command may still be running.');
    if (!outcome.timedOut) expect(failure.output).not.toContain('command timed out');
    expect(barriers).toEqual([expect.objectContaining({ kind: barrierKind })]);
  });

  it('a confirmed Bash timeout still stops conservatively and reports cleanup separately from timeout', async () => {
    const { host, barriers } = bashHost({ code: 124, timedOut: true, terminationError: null });
    const result = await host.execute('Bash', { command: 'opaque test input', timeout_ms: 1000 }, invocation);
    expect(result).toMatchObject({ ok: false, terminal: true, errorEffect: 'unknown', replaySafe: false });
    expect(JSON.parse(result.output)).toMatchObject({
      code: 'bash_timeout_confirmed', failureType: 'timeout_confirmed', timedOut: true,
      terminationConfirmed: true, exitCode: 124, status: 'Exit code: 124; timed out; termination confirmed',
    });
    expect(barriers).toEqual([expect.objectContaining({ kind: 'owned_timeout' })]);
  });

  it('captured write-tool failures stop with their original effect uncertainty', async () => {
    const output = JSON.stringify({ error: 'write failed after partial effects', errorEffect: 'unknown', replaySafe: false });
    vi.spyOn(fileWrite, 'execute').mockResolvedValue(output);
    const result = await createPersonToolHost({ config }).execute('FileWrite', writeArgs, invocation);
    expect(result).toMatchObject({ ok: false, terminal: true, code: 'TOOL_FAILED', errorEffect: 'unknown', replaySafe: false, output });
  });

  it('a generic write throw without a captured joined result is terminal', async () => {
    vi.spyOn(fileWrite, 'execute').mockRejectedValue(new Error('write failed without an outcome'));
    const archived = [];
    const result = await createPersonToolHost({ config, onResult: value => archived.push(value) }).execute('FileWrite', writeArgs, invocation);
    expect(result).toMatchObject({ ok: false, code: 'TOOL_FAILED', terminal: true, errorEffect: 'unknown', replaySafe: false, outputAvailability: 'unavailable' });
    expect(archived).toEqual([result]);
  });

  it.each([
    new Error('read failed'),
    new ToolExecutionTimeoutError('FileRead', 5),
  ])('read-only throw %s continues with no effects', async error => {
    vi.spyOn(fileRead, 'execute').mockRejectedValue(error);
    const result = await createPersonToolHost({ config }).execute('FileRead', readArgs, invocation);
    expect(result).toMatchObject({ ok: false, terminal: false, errorEffect: 'none', replaySafe: true, outputAvailability: 'unavailable' });
  });

  it('explicit unconfirmed lifecycle evidence is terminal even without a failureType', async () => {
    vi.spyOn(fileWrite, 'execute').mockResolvedValue(JSON.stringify({ error: 'still executing', terminationConfirmed: false, errorEffect: 'unknown' }));
    expect(await createPersonToolHost({ config }).execute('FileWrite', writeArgs, invocation)).toMatchObject({ ok: false, terminal: true, errorEffect: 'unknown', replaySafe: false });
  });

  it.each([
    [fileWrite, writeArgs, true, 'unknown', false],
    [fileRead, readArgs, false, 'none', true],
  ])('registry timeout joins %s and preserves failure/effect classification', async (tool, args, terminal, errorEffect, replaySafe) => {
    vi.useFakeTimers();
    const began = deferred(), gate = deferred(), archived = [];
    vi.spyOn(tool, 'execute').mockImplementation(async () => { began.resolve(); await gate.promise; return 'joined after-effects output 中'; });
    const originalTimeout = tool.timeoutMs;
    tool.timeoutMs = 5;
    try {
      const pending = createPersonToolHost({ config, onResult: value => archived.push(value) }).execute(tool.name, args, invocation);
      await began.promise;
      await vi.advanceTimersByTimeAsync(6);
      expect(archived).toEqual([]);
      gate.resolve();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, code: 'TOOL_TIMEOUT', terminal, errorEffect, replaySafe, outputAvailability: 'captured', output: 'joined after-effects output 中' });
      expect(archived).toEqual([result]);
      expect(result.sha256).toBe(digest(result.output));
    } finally {
      gate.resolve();
      tool.timeoutMs = originalTimeout;
    }
  });

  it('joined failure metadata survives a registry timeout', async () => {
    vi.useFakeTimers();
    const began = deferred(), gate = deferred();
    const output = JSON.stringify({ error: 'effects still active', failureType: 'exit_unconfirmed', errorEffect: 'unknown' });
    vi.spyOn(fileWrite, 'execute').mockImplementation(async () => { began.resolve(); await gate.promise; return output; });
    const originalTimeout = fileWrite.timeoutMs;
    fileWrite.timeoutMs = 5;
    try {
      const pending = createPersonToolHost({ config }).execute('FileWrite', writeArgs, invocation);
      await began.promise;
      await vi.advanceTimersByTimeAsync(6);
      gate.resolve();
      expect(await pending).toMatchObject({ ok: false, code: 'TOOL_TIMEOUT', terminal: true, outputAvailability: 'captured', output, errorEffect: 'unknown', replaySafe: false });
    } finally {
      gate.resolve();
      fileWrite.timeoutMs = originalTimeout;
    }
  });

  it('cancellation waits for joined after-effects and archives before rejecting', async () => {
    const controller = new AbortController(), began = deferred(), gate = deferred(), archived = [];
    const archiveStarted = deferred(), archiveDone = deferred();
    let toolSignal, settled = false;
    vi.spyOn(fileWrite, 'execute').mockImplementation(async (_args, ctx) => {
      toolSignal = ctx.signal;
      began.resolve();
      await gate.promise;
      return 'confirmed after-effects 中';
    });
    const host = createPersonToolHost({ config, onResult: async result => { archived.push(result); archiveStarted.resolve(); await archiveDone.promise; } });
    const pending = host.execute('FileWrite', writeArgs, { ...invocation, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await began.promise;
    controller.abort(new PersonError('CANCELLED'));
    expect(toolSignal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(archived).toEqual([]);
    gate.resolve();
    // Waiting for the archive callback, not an arbitrary sleep or process exit.
    await archiveStarted.promise;
    expect(settled).toBe(false);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ output: 'confirmed after-effects 中', callId: 'call', episodeId: 'episode', replaySafe: false });
    expect(archived[0].sha256).toBe(digest(archived[0].output));
    expect(archived[0].sourceRef).toBe(`tool:episode:call:FileWrite:${digest(archived[0].output)}`);
    archiveDone.resolve();
    await rejection;
  });

  it('cancellation with a rejected write joins and archives unknown effects as terminal', async () => {
    const controller = new AbortController(), began = deferred(), gate = deferred(), archived = [];
    vi.spyOn(fileWrite, 'execute').mockImplementation(async (_args, ctx) => {
      began.resolve();
      await gate.promise;
      throw ctx.signal.reason;
    });
    const pending = createPersonToolHost({ config, onResult: result => archived.push(result) }).execute('FileWrite', writeArgs, { ...invocation, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await began.promise;
    controller.abort(new PersonError('CANCELLED'));
    expect(archived).toEqual([]);
    gate.resolve();
    await rejection;
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ ok: false, terminal: true, errorEffect: 'unknown', replaySafe: false, outputAvailability: 'unavailable' });
  });

  it('Execution.read exposes a historical terminal failure only as evidence, not a current effect failure', () => {
    const trace = { id: 'trace', kind: 'capability_failed', episodeId: 'past', result: {
      id: 'Bash', ok: false, code: 'TOOL_FAILED', terminal: true, errorEffect: 'unknown', replaySafe: false, output: 'past unconfirmed execution',
    } };
    const started = { capability: { id: 'Bash', args: { command: 'past opaque input' } } };
    const before = structuredClone(trace);
    const page = executionEvidencePage(trace, started, { callId: 'past-call', offset: 0, maxBytes: 4096 }, 'current');
    expect(page).toMatchObject({ id: 'Execution.read', capabilityId: 'Bash', ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown', historical: true, authority: 'evidence-only' });
    expect(page).not.toHaveProperty('terminal');
    expect(page).not.toHaveProperty('replaySafe');
    expect(trace).toEqual(before);
  });
});
