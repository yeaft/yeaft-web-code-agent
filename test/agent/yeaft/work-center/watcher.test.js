import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemWatcher } from '../../../../agent/yeaft/work-center/watcher.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('WorkItemWatcher', () => {
  it('interrupts a claimed Run when stop races with preparation', async () => {
    const prepareGate = deferred();
    const claim = { workItem: { id: 'w1' }, action: { id: 'a1' }, run: { id: 'r1', leaseEpoch: 4 } };
    const prepared = { ...claim, action: { ...claim.action, workspace: { isolated: true } } };
    const cleanup = vi.fn();
    const store = {
      recoverInterruptedRuns: vi.fn(() => 0),
      claimReadyAction: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null),
      renewLease: vi.fn(() => true), interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true), closeRunInput: vi.fn(() => true), getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const runner = {
      prepare: vi.fn(() => prepareGate.promise), cleanup, run: vi.fn(),
    };
    const controller = { submit: vi.fn() };
    const watcher = new WorkItemWatcher({
      store, controller, runner, ownerBootId: 'boot', pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    const tick = watcher.tick();
    await vi.waitFor(() => expect(runner.prepare).toHaveBeenCalledTimes(1));
    const stop = watcher.stop();
    prepareGate.resolve(prepared);
    await tick;
    await expect(stop).resolves.toEqual([]);
    expect(cleanup).toHaveBeenCalledWith(prepared.action);
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 4, 'Work Center watcher stopped during Action preparation', null,
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(watcher.status()).toMatchObject({ enabled: false, activeRuns: 0 });
  });

  it('aborts and settles an active Run before closing its fence', async () => {
    const gate = deferred();
    const events = [];
    let capturedSignal;
    const store = {
      claimReadyAction: vi.fn()
        .mockReturnValueOnce({
          workItem: { id: 'w1' }, action: { id: 'a1' },
          run: { id: 'r1', leaseEpoch: 7 },
        })
        .mockReturnValue(null),
      renewLease: vi.fn(() => true),
      interruptRun: vi.fn(() => true),
      isActiveRun: vi.fn(() => true),
      getWorkItemDetail: vi.fn(id => ({ id })),
    };
    const watcher = new WorkItemWatcher({
      store,
      controller: { submit: vi.fn() },
      runner: { run: vi.fn(options => {
        capturedSignal = options.signal;
        return gate.promise;
      }) },
      ownerBootId: 'boot', onEvent: event => events.push(event),
      pollIntervalMs: 60_000, leaseMs: 60_000,
    });
    await watcher.tick();
    expect(events).toEqual([
      expect.objectContaining({ type: 'run.started', actionId: 'a1', runId: 'r1' }),
    ]);
    const stop = watcher.stop();
    expect(capturedSignal.aborted).toBe(true);
    expect(store.interruptRun).not.toHaveBeenCalled();
    gate.resolve({ outcome: 'completed', summary: '', evidence: [] });
    await expect(stop).resolves.toEqual([{ runId: 'r1', interrupted: true }]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'run.started', actionId: 'a1', runId: 'r1' }),
    ]);
    expect(store.interruptRun).toHaveBeenCalledWith(
      'r1', 'boot', 7, 'Work Center watcher stopped', null,
    );
    expect(watcher.activeRuns.size).toBe(0);
  });

  it('flushes final usage before atomically closing the Run fence on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-watcher-'));
    const store = new WorkItemStore(join(dir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const item = controller.create({
      title: 'Track interrupted usage',
      goal: 'Persist usage received before watcher shutdown',
      acceptanceCriteria: ['Interrupted usage remains visible'],
      workflowTemplate: 'software-change',
      workDir: '/tmp',
      start: true,
    });
    let progressAccepted = null;
    const runner = {
      run: vi.fn(options => new Promise(resolve => {
        options.signal.addEventListener('abort', () => {
          options.registerProgressReader(() => ({
            response: 'Partial response', loopCount: 1, toolCount: 2, llmRequestCount: 1,
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
            totalTokens: 135, checkpoint: null,
          }));
          progressAccepted = options.onProgress({
            response: 'Partial response', loopCount: 1, toolCount: 2, llmRequestCount: 1,
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
            totalTokens: 135, checkpoint: null,
          });
          resolve({ outcome: 'retryable', summary: '', evidence: [] });
        }, { once: true });
      })),
    };
    const events = [];
    const watcher = new WorkItemWatcher({
      store, controller, runner,
      ownerBootId: 'boot', onEvent: event => events.push(event),
      pollIntervalMs: 60_000, leaseMs: 60_000,
    });

    try {
      await watcher.tick();
      const runId = store.getWorkItemDetail(item.id).currentRunId;
      await watcher.stop();

      expect(progressAccepted).toBe(true);
      expect(store.getRun(runId)).toMatchObject({
        status: 'interrupted', response: 'Partial response',
        loopCount: 1, toolCount: 2, llmRequestCount: 1,
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
        totalTokens: 135,
      });
      expect(store.getWorkItemDetail(item.id)).toMatchObject({
        status: 'ready', currentRunId: null,
        actions: [expect.objectContaining({ status: 'ready' })],
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: 'run.started',
          actionId: store.getWorkItemDetail(item.id).actions[0].id,
          runId,
        }),
        expect.objectContaining({
          type: 'run.progress',
          actionId: store.getWorkItemDetail(item.id).actions[0].id,
          runId,
        }),
      ]);
      expect(watcher.activeRuns.size).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
