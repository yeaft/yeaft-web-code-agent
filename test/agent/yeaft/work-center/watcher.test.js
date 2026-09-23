import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemWatcher } from '../../../../agent/yeaft/work-center/watcher.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { isWorkCenterEnabled } from '../../../../agent/yeaft/work-center/feature.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('Work Center feature gate', () => {
  it('is disabled by default and only accepts an explicit true value', () => {
    expect(isWorkCenterEnabled({})).toBe(false);
    expect(isWorkCenterEnabled({ YEAFT_WORK_CENTER_ENABLED: 'false' })).toBe(false);
    expect(isWorkCenterEnabled({ YEAFT_WORK_CENTER_ENABLED: 'TRUE' })).toBe(false);
    expect(isWorkCenterEnabled({ YEAFT_WORK_CENTER_ENABLED: 'true' })).toBe(true);
  });
});

describe('WorkItemWatcher', () => {
  it.each([
    { name: 'single', activityCount: 1, mixed: false },
    { name: 'burst', activityCount: 3, mixed: false },
    { name: 'mixed', activityCount: 2, mixed: true },
  ])('keeps $name provider activity out of durable progress through the real Engine', async ({ activityCount, mixed }) => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-activity-'));
    const store = new WorkItemStore(join(dir, 'work-center.db'));
    const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
    const criterion = 'Provider activity never publishes progress';
    controller.create({
      title: 'Keep activity internal', goal: criterion, acceptanceCriteria: [criterion],
      workflowTemplate: 'software-change', workDir: dir, start: true,
    });
    writeFileSync(join(dir, 'evidence.txt'), 'Normal tool output');
    const events = [];
    const engineEvents = [];
    const observations = [];
    const visibleObservations = [];
    const updateProgress = vi.spyOn(store, 'updateRunProgress');
    let onProgress;
    let runId;
    let requests = 0;
    const projection = () => ({
      callbacks: onProgress.mock.calls.length,
      writes: updateProgress.mock.calls.length,
      broadcasts: events.filter(event => event.type === 'run.progress').length,
      revision: store.getRun(runId).progressRevision,
    });
    const runner = new WorkItemRunner({
      store,
      trace: new NullTrace(),
      runtimeProvider: async () => ({
        defaultWorkDir: dir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: {
          async *stream() {
            requests += 1;
            const count = requests === 1 ? activityCount : 1;
            for (let index = 0; index < count; index += 1) {
              // Cross the real default 200ms progress throttle, including each
              // event of the burst, without overriding the production interval.
              await new Promise(resolve => setTimeout(resolve, 250));
              const before = projection();
              yield { type: 'provider_activity' };
              observations.push({ before, after: projection() });
            }
            const beforeText = projection();
            yield { type: 'text_delta', text: requests === 1 ? 'Inspecting evidence.\n' : 'Finished inspection.\n' };
            visibleObservations.push({ before: beforeText, after: projection() });
            if (mixed && requests === 1) {
              yield { type: 'tool_call', id: 'read-evidence', name: 'FileRead', input: {
                file_path: join(dir, 'evidence.txt'), offset: 0, limit: 10,
              } };
            } else {
              yield { type: 'text_delta', text: JSON.stringify({
                outcome: 'completed', summary: 'Inspection complete', evidence: ['evidence.txt'],
                acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Checked progress isolation' }],
              }) };
            }
            yield { type: 'usage', inputTokens: 10, outputTokens: 3 };
            yield { type: 'stop', stopReason: mixed && requests === 1 ? 'tool_use' : 'end_turn' };
          },
        },
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', traits: [] }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', traits: [] }),
      },
    });
    const run = runner.run.bind(runner);
    const runSpy = vi.spyOn(runner, 'run').mockImplementation(options => {
      runId = options.run.id;
      onProgress = vi.fn(options.onProgress);
      return run({ ...options, onProgress, onEngineEvent: event => { engineEvents.push(event); } });
    });
    const watcher = new WorkItemWatcher({
      store, controller, runner, ownerBootId: 'activity-owner',
      pollIntervalMs: 60_000, leaseMs: 60_000,
      onEvent: event => {
        events.push(event);
        // This fixture executes one Action, not the rest of the workflow.
        if (event.type === 'run.finished') watcher.lifecycle = 'idle';
      },
    });
    try {
      expect(runner.progressIntervalMs).toBe(200);
      await watcher.tick();
      await Promise.all([...watcher.activeRuns.values()].map(entry => entry.promise));
      expect(runSpy).toHaveBeenCalledTimes(1);
      const result = await runSpy.mock.results[0].value;
      expect(observations).toHaveLength(activityCount + (mixed ? 1 : 0));
      for (const { before, after } of observations) expect(after).toEqual(before);
      for (const { before, after } of visibleObservations) {
        expect(after.callbacks).toBeGreaterThan(before.callbacks);
        expect(after.writes).toBeGreaterThan(before.writes);
        expect(after.broadcasts).toBeGreaterThan(before.broadcasts);
        expect(after.revision).toBeGreaterThan(before.revision);
      }
      expect(engineEvents.filter(event => event.type === 'provider_activity')).toHaveLength(observations.length);
      expect(engineEvents).toContainEqual(expect.objectContaining({ type: 'turn_end', terminal: true }));
      expect(result).toMatchObject({
        outcome: 'completed', llmRequestCount: mixed ? 2 : 1,
        toolCount: mixed ? 1 : 0, inputTokens: mixed ? 20 : 10,
        outputTokens: mixed ? 6 : 3, totalTokens: mixed ? 26 : 13,
        response: mixed ? 'Inspecting evidence.\nFinished inspection.' : 'Inspecting evidence.',
      });
      if (mixed) {
        expect(engineEvents).toContainEqual(expect.objectContaining({ type: 'tool_start', name: 'FileRead' }));
        expect(engineEvents).toContainEqual(expect.objectContaining({ type: 'tool_end', isError: false }));
        expect(onProgress.mock.calls.map(([progress]) => progress.toolCount)).toContain(1);
      }
      expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ totalTokens: result.totalTokens });
      expect(store.getRun(runId)).toMatchObject({ status: 'completed', totalTokens: result.totalTokens });
      expect(events).toContainEqual(expect.objectContaining({ type: 'run.finished', runId }));
    } finally {
      await watcher.stop();
      runSpy.mockRestore();
      updateProgress.mockRestore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
