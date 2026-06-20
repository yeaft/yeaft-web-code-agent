import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testDrainVpDrivers,
  __testGetOrCreateVpEngine,
  __testHandleEngineEvent,
  __testResetVpState,
  __testSetSession,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import ctx from '../../../agent/context.js';

class IdleAdapter {
  async *stream() {
    yield { type: 'text_delta', text: 'idle' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: {} }; }
}

/**
 * Manual TaskManager stub — same shape as the real one, but the test
 * drives the event sink directly so we don't have to spin up real
 * subprocesses just to verify wiring.
 */
function makeTaskManagerStub() {
  let sink = null;
  return {
    setEventSink(fn) { sink = fn; },
    emit(event) {
      if (!sink) throw new Error('task event sink not installed');
      sink(event);
    },
    listActiveTasks() { return []; },
    renderActiveTasksForPrompt() { return ''; },
  };
}

describe('web-bridge — same-turn async task injection', () => {
  let tempDir = null;

  afterEach(async () => {
    __testSetSession(null);
    await __testResetVpState();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('routes a task completed event to the owning engine via notifyAsyncTaskCompleted when the engine still holds the task', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-bridge-async-'));
    const adapter = new IdleAdapter();
    const taskManager = makeTaskManagerStub();
    const sessionLike = {
      adapter,
      trace: new NullTrace(),
      config: {
        model: 'test-model',
        maxOutputTokens: 1024,
        _readOnly: true,
        language: 'en',
      },
      conversationStore: {
        append(record) { return { id: 'id', ...record }; },
        loadRecentBySession() { return []; },
        readCompactSummary() { return ''; },
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: new ToolRegistry(),
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };

    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);

    const engine = __testGetOrCreateVpEngine('sess-1', 'vp-1', 'main');

    // The engine must expose the new same-turn API on top of the
    // coordinator install path.
    expect(typeof engine.notifyAsyncTaskCompleted).toBe('function');
    expect(typeof engine.ownsPendingAsyncTask).toBe('function');

    // Pretend a tool inside this engine just registered a background
    // task. The cleanest path through the production stack is to add
    // a fake tool to the SAME ToolRegistry the engine consults, then
    // queue an adapter response that asks the model to call it.
    let registered = false;
    sessionLike.toolRegistry.register({
      name: 'spawnBg',
      description: 'spawn a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-bridge-1');
        registered = true;
        return 'started';
      },
    });

    // Queue adapter responses by swapping in a richer adapter — the
    // IdleAdapter only knows one reply, so replace its stream method.
    const responses = [
      [
        { type: 'tool_call', id: 'c1', name: 'spawnBg', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'parking' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'task acknowledged' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];
    let streamCallCount = 0;
    const streamInputs = [];
    adapter.stream = async function* (params) {
      streamInputs.push(JSON.parse(JSON.stringify(params.messages || [])));
      const events = responses[streamCallCount++];
      if (!events) throw new Error('adapter exhausted');
      for (const ev of events) yield ev;
    };

    const emittedEvents = [];
    const queryPromise = (async () => {
      for await (const ev of engine.query({ prompt: 'go', messages: [] })) {
        emittedEvents.push(ev);
        if (ev.type === 'async_task_wait_start') {
          // Fire a TaskManager `completed` event through the bridge
          // sink installed by installYeaftRuntimeBridge. This is the
          // real production path — the test does not call
          // notifyAsyncTaskCompleted directly.
          taskManager.emit({
            type: 'yeaft_task_event',
            event: 'completed',
            task: {
              id: 'task-bridge-1',
              sessionId: 'sess-1',
              ownerVpId: 'vp-1',
              kind: 'shell',
              title: 'fake bg',
              status: 'succeeded',
              source: { threadId: 'main' },
              runtime: { command: 'echo' },
              result: { exitCode: 0, summary: 'okay' },
              log: { path: '/tmp/x.log', preview: 'output' },
            },
          });
        }
      }
    })();
    await queryPromise;

    expect(registered).toBe(true);
    // Same-turn delivery means the third adapter call was made. If the
    // bridge had fallen through to the legacy enqueueForVp rescue path,
    // a separate driver would have opened a NEW turn — the engine here
    // would have stopped at 2 calls.
    expect(streamCallCount).toBe(3);
    const updateEvent = emittedEvents.find(ev => ev.type === 'tool_result_update');
    expect(updateEvent).toMatchObject({
      taskId: 'task-bridge-1',
      toolCallId: 'c1',
    });
    expect(streamInputs[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'c1',
        content: expect.stringContaining('<task-result id="task-bridge-1" kind="shell" status="succeeded">'),
      }),
    ]));
    expect(JSON.stringify(streamInputs[2])).toContain('summary: okay');
    // The bridge should NOT have left an enqueued envelope for the
    // legacy rescue path (we did not let any driver run after query()
    // finished).
    await __testDrainVpDrivers();
    // After drain the engine must show no pending async tasks.
    expect(engine.hasPendingAsyncTasks()).toBe(false);
  });

  it('falls back to the legacy enqueueForVp rescue path when the engine never registered the task', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-bridge-async-rescue-'));
    const adapter = new IdleAdapter();
    const taskManager = makeTaskManagerStub();
    const persisted = [];
    const sessionLike = {
      adapter,
      trace: new NullTrace(),
      config: {
        model: 'test-model',
        maxOutputTokens: 1024,
        _readOnly: true,
        language: 'en',
      },
      conversationStore: {
        append(record) { persisted.push(record); return { id: `r-${persisted.length}`, ...record }; },
        loadRecentBySession() { return []; },
        readCompactSummary() { return ''; },
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: new ToolRegistry(),
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };
    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);

    // No engine has registered task-orphan-1 — emitting completed
    // should fall through to the legacy rescue path (new turn).
    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: {
        id: 'task-orphan-1',
        sessionId: 'sess-rescue',
        ownerVpId: 'vp-rescue',
        kind: 'shell',
        title: 'orphan',
        status: 'succeeded',
        source: { threadId: 'main' },
        runtime: {},
        result: { exitCode: 0, summary: 'orphaned ok' },
        log: { path: '/tmp/x.log', preview: '' },
      },
    });

    await new Promise(r => setTimeout(r, 0));
    await __testDrainVpDrivers();

    // Legacy rescue persists an internal assistant message with the
    // task result. Same-turn delivery would NOT (it stays in the
    // engine's already-running query() and persistence is tied to
    // the engine's stop-hooks, not the bridge sink).
    const internalRows = persisted.filter(r => r.internal === true);
    expect(internalRows.length).toBe(1);
    expect(internalRows[0]).toMatchObject({
      role: 'assistant',
      sessionId: 'sess-rescue',
      threadId: 'main',
    });
    expect(internalRows[0].content).toContain('task-orphan-1');
  });

  it('forwards async_task_wait_start / async_task_wait_end engine events as vp_async_task_wait_* wire frames', async () => {
    // Pure event-routing test — bypasses the engine to confirm the
    // bridge case branches actually emit on the wire. Uses the message
    // buffer (which collects `yeaft_output` when no ws is connected) as
    // the observation channel.
    ctx.messageBuffer.length = 0;

    const hctx = {
      sessionId: 'sess-evt',
      vpId: 'vp-evt',
      threadId: 'thr-1',
      turnId: 'turn-abc',
      resetQueryTimer() { /* no-op for routing test */ },
    };

    __testHandleEngineEvent(
      {
        type: 'async_task_wait_start',
        turnId: 'turn-abc',
        threadId: 'thr-1',
        loopNumber: 7,
        pendingTaskIds: ['task-a', 'task-b'],
      },
      hctx,
    );
    __testHandleEngineEvent(
      {
        type: 'async_task_wait_end',
        turnId: 'turn-abc',
        threadId: 'thr-1',
        loopNumber: 7,
        aborted: false,
        remainingTaskIds: [],
      },
      hctx,
    );

    const events = ctx.messageBuffer
      .filter(m => m && m.type === 'yeaft_output' && m.event && (m.event.type === 'vp_async_task_wait_start' || m.event.type === 'vp_async_task_wait_end'));
    expect(events).toHaveLength(2);

    const start = events.find(e => e.event.type === 'vp_async_task_wait_start');
    expect(start.sessionId).toBe('sess-evt');
    expect(start.vpId).toBe('vp-evt');
    expect(start.event.turnId).toBe('turn-abc');
    expect(start.event.threadId).toBe('thr-1');
    expect(start.event.loopNumber).toBe(7);
    expect(start.event.pendingTaskIds).toEqual(['task-a', 'task-b']);
    expect(typeof start.event.ts).toBe('number');

    const end = events.find(e => e.event.type === 'vp_async_task_wait_end');
    expect(end.event.aborted).toBe(false);
    expect(end.event.remainingTaskIds).toEqual([]);

    ctx.messageBuffer.length = 0;
  });
});
