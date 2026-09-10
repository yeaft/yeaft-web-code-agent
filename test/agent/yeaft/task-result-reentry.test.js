import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testDrainVpDrivers,
  __testEnqueueForVp,
  __testResetVpState,
  __testSetSession,
  __testWaitForRoutePromises,
  __testHooks,
  ensureSessionLoaded,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import { TASK_RESULT_DELIVERY } from '../../../agent/yeaft/tasks/store.js';
import bashTool from '../../../agent/yeaft/tools/bash.js';
import agentTool, { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import ctx from '../../../agent/context.js';

class RecordingAdapter {
  constructor(responses = []) {
    this.responses = responses;
    this.streamCalls = [];
  }

  async *stream(params) {
    this.streamCalls.push({
      system: params.system,
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    const response = this.responses.shift();
    if (!response) throw new Error('RecordingAdapter: no response queued');
    for (const event of response) yield event;
  }

  async call() {
    return { text: 'ok', usage: {} };
  }
}

function createStoreFactory() {
  const instances = new Map();
  return (id, options) => () => {
    if (instances.has(id)) return instances.get(id);
    const instance = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter.call(instance, instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    instances.set(id, instance);
    return instance;
  };
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function makeTaskManagerStub({ yeaftDir }) {
  let sink = null;
  const started = [];
  const persisted = new TaskManager({ yeaftDir });
  return {
    started,
    setEventSink(fn) {
      sink = fn;
      persisted.setEventSink(fn);
    },
    startShellTask(input) {
      const task = {
        id: 'task_service_1',
        sessionId: input.sessionId,
        ownerVpId: input.ownerVpId,
        kind: 'shell',
        title: input.title,
        status: 'running',
        resultDelivery: 'status_only',
        source: input.source || {},
        runtime: { command: input.command, cwd: input.cwd },
        result: {},
        log: { path: '/tmp/task_service_1.log', preview: '' },
      };
      started.push(task);
      sink?.({ type: 'yeaft_task_event', event: 'started', task });
      return task;
    },
    emit(event) {
      if (!sink) throw new Error('task event sink not installed');
      sink(event);
    },
    startTask(input) { return persisted.startTask(input); },
    startLegacyTask(input) {
      const task = persisted.startTask({
        ...input,
        resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
      });
      const stored = persisted.store.readTask(task.sessionId, task.id);
      delete stored.resultDelivery;
      persisted.store.writeTask(stored);
      persisted.active.delete(`${task.sessionId}::${task.id}`);
      return task;
    },
    completeTask(sessionId, taskId, opts) { return persisted.completeTask(sessionId, taskId, opts); },
    getTask(sessionId, taskId) { return persisted.getTask(sessionId, taskId); },
    listActiveTasks() { return persisted.listActiveTasks(); },
  };
}

async function drainVpDriversWithin(timeoutMs = 2000) {
  let timer = null;
  try {
    await Promise.race([
      __testDrainVpDrivers(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('VP turn did not finish')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectEngineEvents(engine, query, timeoutMs = 2000) {
  const events = [];
  let timer = null;
  try {
    await Promise.race([
      (async () => {
        for await (const event of engine.query(query)) events.push(event);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Engine query did not finish')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return events;
}

function readTaskEvents(taskManager, sessionId) {
  try {
    return readFileSync(taskManager.store.eventPath(sessionId), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('task result re-entry', () => {
  let tempDir = null;
  let originalMessageBuffer = [];

  beforeEach(() => {
    originalMessageBuffer = ctx.messageBuffer.slice();
    ctx.messageBuffer.length = 0;
    _resetAgentRegistry();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __testHooks.resetRuntimeFactoriesForTest();
    __testSetSession(null);
    await __testResetVpState();
    _resetAgentRegistry();
    ctx.messageBuffer.splice(0, ctx.messageBuffer.length, ...originalMessageBuffer);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function verifyShellTaskTitleSafety() {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-prompt-shell-'));
    const taskManager = new TaskManager({ yeaftDir: tempDir });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(bashTool);
    const adapter = new RecordingAdapter([[
      { type: 'text_delta', text: 'The background command is still running.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]]);
    const sessionId = 'session-shell-safe-label';
    const command = 'node -e "setTimeout(() => {}, 30000)"';
    const taskTitle = 'Run echo explicit-shell-secret';

    await toolRegistry.execute('Bash', {
      command,
      cwd: tempDir,
      background: true,
      taskTitle,
    }, {
      cwd: tempDir,
      sessionId,
      currentVpId: 'vp-owner',
      threadId: 'main',
      taskManager,
    });

    const task = taskManager.listActiveTasks(sessionId)[0];
    expect(task.title).toBe(taskTitle);
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
      toolRegistry,
      yeaftDir: tempDir,
      taskManager,
      sessionId,
      vpId: 'vp-owner',
    });
    await collectEngineEvents(engine, {
      prompt: 'Report the background task status.',
      messages: [],
      sessionId,
      senderVpId: 'vp-owner',
      threadId: 'main',
    });

    expect(adapter.streamCalls).toHaveLength(1);
    const system = adapter.streamCalls[0].system;
    expect(system).not.toContain('- background command (background command, running)');
    expect(system).not.toContain('echo');
    expect(system).not.toContain('explicit-shell-secret');
    expect(system).not.toContain(command);

    const cancelled = taskManager.cancelTask(sessionId, task.id);
    expect(cancelled.ok).toBe(true);
    const deadline = Date.now() + 2000;
    while (taskManager.getTask(sessionId, task.id)?.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(taskManager.getTask(sessionId, task.id)?.status).toBe('cancelled');
  }

  async function verifySpawnAgentMissionSafety() {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-prompt-agent-'));
    const taskManager = new TaskManager({ yeaftDir: tempDir });
    const childAdapter = {
      streamCalls: [],
      async *stream(params) {
        this.streamCalls.push(params);
        while (!params.signal?.aborted) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(agentTool);
    const sessionId = 'session-agent-safe-label';
    const missions = [
      ['path-reviewer', 'Inspect path=/private/events.jsonl'],
      ['make-reviewer', 'Please run make deploy TOKEN=make-secret'],
      ['markdown-reviewer', 'Inspect [log](/private/markdown/events.jsonl)'],
      ['windows-reviewer', String.raw`Inspect C:\Program Files\Yeaft\events.jsonl`],
      ['log-reviewer', '2026-08-03T08:00:00Z INFO worker token=log-secret'],
    ];
    const spawnedAgents = [];
    for (const [name, mission] of missions) {
      const spawned = JSON.parse(await toolRegistry.execute('SpawnAgent', {
        name,
        mission,
      }, {
        cwd: tempDir,
        sessionId,
        senderVpId: 'vp-owner',
        threadId: 'main',
        taskManager,
        parentEngineDeps: {
          adapter: childAdapter,
          trace: new NullTrace(),
          config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
          parentToolRegistry: toolRegistry,
          yeaftDir: tempDir,
          subAgentLogDir: join(tempDir, 'sub-agent-logs'),
          parentSessionId: sessionId,
          parentVpId: 'vp-owner',
          parentThreadId: 'main',
          taskManager,
          idleAbandonMs: 10_000,
        },
      }));
      expect(spawned.success).toBe(true);
      expect(taskManager.getTask(sessionId, spawned.taskId)).toMatchObject({
        kind: 'sub_agent',
        title: mission,
        runtime: { name },
      });
      spawnedAgents.push(spawned);
    }

    const parentAdapter = new RecordingAdapter([[
      { type: 'text_delta', text: 'The delegated task is running.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]]);
    const engine = new Engine({
      adapter: parentAdapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
      toolRegistry,
      yeaftDir: tempDir,
      taskManager,
      sessionId,
      vpId: 'vp-owner',
    });
    await collectEngineEvents(engine, {
      prompt: 'Report the delegated task status.',
      messages: [],
      sessionId,
      senderVpId: 'vp-owner',
      threadId: 'main',
    });

    expect(parentAdapter.streamCalls).toHaveLength(1);
    const system = parentAdapter.streamCalls[0].system;
    for (const [name] of missions) {
      expect(system).not.toContain(`- sub-agent ${name} (sub-agent, running)`);
    }
    for (const [, mission] of missions) expect(system).not.toContain(mission);
    expect(system).not.toContain('make-secret');
    expect(system).not.toContain('/private');
    expect(system).not.toContain(String.raw`C:\Program Files`);
    expect(system).not.toContain('log-secret');

    for (const { agentId } of spawnedAgents) {
      const agent = getAgentRegistry().get(agentId);
      agent?.abortController?.abort('test complete');
      if (agent) agent.status = 'closed';
    }
    const deadline = Date.now() + 1000;
    while (spawnedAgents.some(({ agentId }) => getAgentRegistry().get(agentId)?.__driverStarted)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(spawnedAgents.some(({ agentId }) => getAgentRegistry().get(agentId)?.__driverStarted)).toBe(false);
  }

  it('keeps active task details out of prompts while preserving persistent result delivery', async () => {
    await verifyShellTaskTitleSafety();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    await verifySpawnAgentMissionSafety();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-reentry-'));
    const adapter = new RecordingAdapter([
      [
        {
          type: 'tool_call',
          id: 'call_service_1',
          name: 'Bash',
          input: {
            command: 'node server.js',
            cwd: tempDir,
            background: true,
            taskTitle: 'Dev server',
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'The service is ready.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'This is a separate user turn.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The delegated result was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The legacy delegated result was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The recovered explicit task was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The recovered legacy task was received.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const taskManager = makeTaskManagerStub({ yeaftDir: tempDir });
    const persisted = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(bashTool);
    expect(bashTool.timeoutMs).toBe(0);
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
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
        loadRecentBySession() { return []; },
      },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry,
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };

    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);

    const sessionId = 'session-task-result';
    const vpId = 'vp-owner';
    const firstMessageId = 'msg-start-service';
    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: firstMessageId,
        from: 'user',
        role: 'user',
        text: 'Start the service and tell me when it is ready.',
        meta: {},
      },
    });
    await __testWaitForRoutePromises(firstMessageId);
    await drainVpDriversWithin();

    expect(taskManager.started).toHaveLength(1);
    expect(taskManager.started[0]).toMatchObject({
      id: 'task_service_1',
      resultDelivery: 'status_only',
      status: 'running',
    });
    expect(adapter.streamCalls).toHaveLength(2);

    // Stopping a detached service updates task state only. It must not wake the
    // completed engine turn or create a synthetic model turn of its own.
    const legacyShellCompletion = {
      ...taskManager.started[0],
      status: 'cancelled',
      result: { signal: 'SIGTERM' },
    };
    delete legacyShellCompletion.resultDelivery;
    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: legacyShellCompletion,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(adapter.streamCalls).toHaveLength(2);
    expect(persisted.filter(row => row.internal === true)).toHaveLength(0);

    // The next user input owns a clean new turn. It is not fused with the task
    // cancellation event and receives no hidden <task-result> prompt.
    const secondMessageId = 'msg-after-service-stop';
    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: secondMessageId,
        from: 'user',
        role: 'user',
        text: 'Now explain the next step.',
        meta: {},
      },
    });
    await __testWaitForRoutePromises(secondMessageId);
    await drainVpDriversWithin();

    expect(adapter.streamCalls).toHaveLength(3);
    const userTurnWire = JSON.stringify(adapter.streamCalls[2].messages);
    expect(userTurnWire).toContain('Now explain the next step.');
    expect(userTurnWire).not.toContain('<task-result');

    // Result-producing async work remains opt-in. Sub-agent completion keeps
    // the existing re-entry path instead of being treated like a service task.
    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: {
        id: 'task_delegate_1',
        sessionId,
        ownerVpId: vpId,
        kind: 'sub_agent',
        title: 'Review implementation',
        status: 'succeeded',
        resultDelivery: 'model_reentry',
        source: { threadId: 'main' },
        runtime: { subAgentId: 'agent-reviewer' },
        result: { summary: 'Review passed' },
        log: { path: '/tmp/task_delegate_1.log', preview: 'APPROVE' },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();

    expect(adapter.streamCalls).toHaveLength(4);
    const rendered = JSON.stringify(adapter.streamCalls[3].messages);
    expect(rendered).toContain('<task-result id=\\"task_delegate_1\\" kind=\\"sub_agent\\" status=\\"succeeded\\">');
    expect(rendered).toContain('Review passed');
    expect(rendered).toContain('This is an asynchronous tool result from a background task, not a user message');

    const internalRows = persisted.filter(row => row.internal === true);
    expect(internalRows).toHaveLength(1);
    expect(internalRows[0]).toMatchObject({
      role: 'assistant',
      threadId: 'main',
      sessionId,
    });
    expect(internalRows[0].content).toContain('task_delegate_1');

    // A persisted legacy sub-agent without the field keeps the compatibility
    // fallback and still opens exactly one rescue turn.
    const legacyTask = taskManager.startLegacyTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'sub_agent',
      title: 'Legacy delegate',
      source: { threadId: 'main' },
    });
    taskManager.completeTask(sessionId, legacyTask.id, {
      status: 'succeeded',
      summary: 'Legacy review passed',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(taskManager.getTask(sessionId, legacyTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
    });
    expect(adapter.streamCalls).toHaveLength(5);
    expect(JSON.stringify(adapter.streamCalls[4].messages)).toContain('Legacy review passed');

    // Unknown kinds and explicit unknown delivery modes are status-only.
    // Drive them through the real TaskManager persistence/completion path and
    // prove neither gains the side effect of starting an adapter turn.
    const invalidTask = taskManager.startTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'sub_agent',
      title: 'Invalid delivery',
      resultDelivery: 'future_delivery_mode',
      source: { threadId: 'main' },
    });
    expect(invalidTask.resultDelivery).toBe(TASK_RESULT_DELIVERY.STATUS_ONLY);
    taskManager.completeTask(sessionId, invalidTask.id, {
      status: 'succeeded',
      summary: 'Must not re-enter',
    });

    const unknownKindTask = taskManager.startTask({
      sessionId,
      ownerVpId: vpId,
      kind: 'future_task_kind',
      title: 'Unknown task kind',
      source: { threadId: 'main' },
    });
    expect(unknownKindTask.resultDelivery).toBe(TASK_RESULT_DELIVERY.STATUS_ONLY);
    taskManager.completeTask(sessionId, unknownKindTask.id, {
      status: 'succeeded',
      summary: 'Must not re-enter',
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(taskManager.getTask(sessionId, invalidTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY,
    });
    expect(taskManager.getTask(sessionId, unknownKindTask.id)).toMatchObject({
      status: 'succeeded',
      resultDelivery: TASK_RESULT_DELIVERY.STATUS_ONLY,
    });
    expect(adapter.streamCalls).toHaveLength(5);
    expect(persisted.filter(row => row.internal === true)).toHaveLength(2);

    // Production constructs TaskManager before installing the web bridge. A
    // restart must retain recovered completion events until that sink exists,
    // then deliver every UI status exactly once while only opted-in tasks wake
    // the model.
    const restartDir = join(tempDir, 'restart');
    const beforeRestart = new TaskManager({ yeaftDir: restartDir });
    const restartSessionId = 'session-restart-task-result';
    const restartVpId = 'vp-restart-owner';
    const explicitRestartTask = beforeRestart.startTask({
      sessionId: restartSessionId,
      ownerVpId: restartVpId,
      kind: 'sub_agent',
      title: 'Explicit restart delegate',
      resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
      source: { threadId: 'main' },
    });
    const legacyRestartTask = beforeRestart.startTask({
      sessionId: restartSessionId,
      ownerVpId: restartVpId,
      kind: 'sub_agent',
      title: 'Legacy restart delegate',
      resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
      source: { threadId: 'main' },
    });
    const legacyStored = beforeRestart.store.readTask(restartSessionId, legacyRestartTask.id);
    delete legacyStored.resultDelivery;
    beforeRestart.store.writeTask(legacyStored);
    const shellRestartTask = beforeRestart.startTask({
      sessionId: restartSessionId,
      ownerVpId: restartVpId,
      kind: 'shell',
      title: 'Detached shell',
      source: { threadId: 'main' },
    });
    const invalidRestartTask = beforeRestart.startTask({
      sessionId: restartSessionId,
      ownerVpId: restartVpId,
      kind: 'sub_agent',
      title: 'Invalid restart delivery',
      resultDelivery: 'future_delivery_mode',
      source: { threadId: 'main' },
    });
    const unknownRestartTask = beforeRestart.startTask({
      sessionId: restartSessionId,
      ownerVpId: restartVpId,
      kind: 'future_task_kind',
      title: 'Unknown restart task',
      source: { threadId: 'main' },
    });

    const shellStored = beforeRestart.store.readTask(restartSessionId, shellRestartTask.id);
    delete shellStored.resultDelivery;
    beforeRestart.store.writeTask(shellStored);
    const invalidStored = beforeRestart.store.readTask(restartSessionId, invalidRestartTask.id);
    invalidStored.resultDelivery = 'future_delivery_mode';
    beforeRestart.store.writeTask(invalidStored);
    const unknownStored = beforeRestart.store.readTask(restartSessionId, unknownRestartTask.id);
    delete unknownStored.resultDelivery;
    beforeRestart.store.writeTask(unknownStored);

    const restartTaskIds = [
      explicitRestartTask.id,
      legacyRestartTask.id,
      shellRestartTask.id,
      invalidRestartTask.id,
      unknownRestartTask.id,
    ];

    const restartedTaskManager = new TaskManager({ yeaftDir: restartDir });
    expect(restartedTaskManager.listActiveTasks(restartSessionId)).toHaveLength(0);
    const restartedSessionLike = {
      ...sessionLike,
      status: { skills: 0, mcpServers: [], tools: toolRegistry.size },
      taskManager: restartedTaskManager,
    };
    const runtimeSkillManager = { size: 0, list: () => [], load: () => ({ changed: false, loaded: 0, errors: [] }) };
    __testSetSession(null);
    __testHooks.setRuntimeFactoriesForTest({
      loadSession: async () => restartedSessionLike,
      createSkillManager: () => runtimeSkillManager,
      createMcpManager: () => ({
        async connectAll() { return { connected: [], failed: [] }; },
        async disconnectAll() {},
      }),
      loadMcpConfig: () => ({ servers: [], skipped: [] }),
    });
    const bufferStart = ctx.messageBuffer.length;
    await ensureSessionLoaded({ sessionId: restartSessionId });
    const baseRuntimeLoad = __testHooks.scheduleBaseRuntimeLoadForTest();
    if (baseRuntimeLoad) await baseRuntimeLoad;
    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();

    const restartFrames = ctx.messageBuffer.slice(bufferStart).filter(message => (
      message.type === 'yeaft_output'
      && (message.event?.type === 'session_ready' || message.event?.type === 'yeaft_task_event')
    ));
    const readyIndex = restartFrames.findIndex(message => message.event?.type === 'session_ready');
    const restartCompletionFrames = restartFrames.filter(message => (
      message.type === 'yeaft_output'
      && message.event?.type === 'yeaft_task_event'
      && message.event?.event === 'completed'
      && restartTaskIds.includes(message.event.task?.id)
    ));
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(restartCompletionFrames).toHaveLength(5);
    for (const taskId of restartTaskIds) {
      const matchingFrames = restartCompletionFrames.filter(message => message.event.task.id === taskId);
      expect(matchingFrames).toHaveLength(1);
      expect(restartFrames.indexOf(matchingFrames[0])).toBeLessThan(readyIndex);
      expect(restartedTaskManager.getTask(restartSessionId, taskId)?.status).toBe('orphaned');
    }
    expect(restartedTaskManager.getTask(restartSessionId, explicitRestartTask.id)?.resultDelivery).toBe('model_reentry');
    expect(restartedTaskManager.getTask(restartSessionId, legacyRestartTask.id)?.resultDelivery).toBe('model_reentry');
    expect(restartedTaskManager.getTask(restartSessionId, shellRestartTask.id)?.resultDelivery).toBe('status_only');
    expect(restartedTaskManager.getTask(restartSessionId, invalidRestartTask.id)?.resultDelivery).toBe('status_only');
    expect(restartedTaskManager.getTask(restartSessionId, unknownRestartTask.id)?.resultDelivery).toBe('status_only');

    const sessionsStore = {
      sessionById: id => (id === restartSessionId ? { id, agentId: 'agent-restart' } : null),
    };
    const webPinia = {
      defineStore: createStoreFactory(),
      useSessionsStore: () => sessionsStore,
    };
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('document', {
      addEventListener() {},
      removeEventListener() {},
      documentElement: { setAttribute() {}, classList: { toggle() {} } },
    });
    vi.stubGlobal('window', {
      Pinia: webPinia,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    });
    vi.stubGlobal('Pinia', webPinia);
    const { useChatStore } = await import('../../../web/stores/chat.js');
    const chatStore = useChatStore();
    chatStore.currentView = 'yeaft';
    chatStore.currentAgent = 'agent-restart';
    chatStore.yeaftActiveSessionFilter = restartSessionId;
    chatStore.yeaftSessionAgentById = { [restartSessionId]: 'agent-restart' };
    const restartTaskKey = `agent-restart\u001f${restartSessionId}`;
    chatStore.yeaftActiveTasksBySession = {
      [restartTaskKey]: {
        stale_running: {
          id: 'stale_running', sessionId: restartSessionId, agentId: 'agent-restart', status: 'running',
        },
      },
    };
    chatStore.sendWsMessage = vi.fn();
    for (const frame of restartFrames) chatStore.handleYeaftOutput(frame);

    expect(chatStore.yeaftActiveTasksBySession[restartTaskKey]).toBeUndefined();

    const readyFrame = restartFrames[readyIndex];
    chatStore.handleYeaftOutput(readyFrame);
    expect(chatStore.yeaftActiveTasksBySession[restartTaskKey]).toBeUndefined();

    expect(adapter.streamCalls).toHaveLength(7);
    const restartRescueWire = JSON.stringify(adapter.streamCalls.slice(5).map(call => call.messages));
    expect(restartRescueWire).toContain(explicitRestartTask.id);
    expect(restartRescueWire).toContain(legacyRestartTask.id);
    expect(restartRescueWire).not.toContain(shellRestartTask.id);
    expect(restartRescueWire).not.toContain(invalidRestartTask.id);
    expect(restartRescueWire).not.toContain(unknownRestartTask.id);

    const bufferedAfterFirstInstall = ctx.messageBuffer.length;
    installYeaftRuntimeBridge(restartedSessionLike);
    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    expect(ctx.messageBuffer).toHaveLength(bufferedAfterFirstInstall);
    expect(chatStore.yeaftActiveTasksBySession[restartTaskKey]).toBeUndefined();
    expect(adapter.streamCalls).toHaveLength(7);
    expect(persisted.filter(row => row.internal === true)).toHaveLength(4);
  });

  it('delivers terminal-first and defer-first completions exactly once with real Engine and TaskManager', async () => {
    for (const completionDelayMs of [0, 35]) {
      tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-race-'));
      const sessionId = `session-task-race-${completionDelayMs}`;
    const vpId = 'vp-task-race';
    const resultText = `race-result-${completionDelayMs}`;
    const childAdapter = completionDelayMs > 0
      ? {
          streamCalls: [],
          async *stream(params) {
            this.streamCalls.push({ messages: JSON.parse(JSON.stringify(params.messages || [])) });
            await new Promise(resolve => setTimeout(resolve, completionDelayMs));
            yield { type: 'text_delta', text: resultText };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
          async call() { return { text: 'ok', usage: {} }; },
        }
      : new RecordingAdapter([[
          { type: 'text_delta', text: resultText },
          { type: 'stop', stopReason: 'end_turn' },
        ]]);
    const parentAdapter = new RecordingAdapter([
      [
        { type: 'tool_call', id: 'call_spawn', name: 'SpawnAgent', input: {
          name: `race-child-${completionDelayMs}`,
          mission: 'Return the race result.',
        } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'The task is running.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      [
        { type: 'text_delta', text: 'The task result was delivered.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const taskManager = new TaskManager({ yeaftDir: tempDir });
    const persisted = [];
    const conversationStore = {
      append(record) {
        const row = { id: `race-row-${persisted.length + 1}`, ...record };
        persisted.push(row);
        return row;
      },
      update(message, patch) {
        const index = persisted.findIndex(row => row.id === message.id);
        if (index < 0) return null;
        persisted[index] = { ...persisted[index], ...patch };
        return persisted[index];
      },
      loadRecentBySession() { return []; },
    };
    const registry = new ToolRegistry();
    registry.register({
      ...agentTool,
      execute: (input, toolCtx) => agentTool.execute(input, {
        ...toolCtx,
        parentEngineDeps: {
          ...toolCtx.parentEngineDeps,
          adapter: childAdapter,
          subAgentLogDir: join(tempDir, 'sub-agent-logs'),
        },
      }),
    });
    const config = {
      model: 'test-model',
      maxOutputTokens: 1024,
      asyncTaskWaitTimeoutMs: 20,
      _readOnly: true,
      language: 'en',
      subAgentLogDir: join(tempDir, 'sub-agent-logs'),
    };
    const sessionLike = {
      adapter: parentAdapter,
      trace: new NullTrace(),
      config,
      conversationStore,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: registry,
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };
    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);
    const engine = new Engine({
      adapter: parentAdapter,
      trace: sessionLike.trace,
      config,
      conversationStore,
      toolRegistry: registry,
      yeaftDir: tempDir,
      taskManager,
      sessionId,
      vpId,
    });
    const coordinator = __testHooks.asyncTaskCoordinatorForTest();
    engine.setAsyncTaskCoordinator(coordinator);
    engine.setSubAgentEventSink(() => {});

    const terminalEvents = [];
    const bridgeSink = taskManager.onEvent;
    let taskId = null;
    taskManager.setEventSink(event => {
      if (event?.event === 'started' && event.task?.kind === 'sub_agent') {
        taskId = event.task.id;
      }
      if (event?.event === 'completed' && event.task) terminalEvents.push(event);
      bridgeSink?.(event);
    });
    const eventsPromise = collectEngineEvents(engine, {
      prompt: 'Run the task.',
      messages: [],
      sessionId,
      senderVpId: vpId,
      threadId: 'main',
    });
    while (!taskId) {
      taskId = taskManager.listActiveTasks(sessionId)
        .find(task => task.kind === 'sub_agent')?.id || null;
      if (!taskId) await new Promise(resolve => setTimeout(resolve, 0));
    }

    const events = await eventsPromise;
    const completionDeadline = Date.now() + 1000;
    while (terminalEvents.length === 0 && Date.now() < completionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    await drainVpDriversWithin();
    const providerDeliveries = parentAdapter.streamCalls.filter(call => {
      const wire = JSON.stringify(call.messages);
      return wire.includes(taskId) && wire.includes(resultText);
    });
    const rescueRows = persisted.filter(row => (
      row.internal === true
      && String(row.content || '').includes(taskId)
      && String(row.content || '').includes(resultText)
    ));
    // A rescue row is the durable transcript for the same provider request,
    // not a second model delivery. Exactly once means exactly one provider
    // input containing this taskId; a wait that actually deferred additionally
    // persists one internal rescue row. A zero-delay completion can still cross
    // the wait deadline under load, so assert the observed boundary rather than
    // inferring it from the configured child delay.
    expect(providerDeliveries).toHaveLength(1);
    const waitEnd = events.filter(event => event.type === 'async_task_wait_end');
    expect(waitEnd).toHaveLength(1);
    const waitTimedOut = waitEnd[0].timedOut === true;
    if (completionDelayMs > 0) expect(waitTimedOut).toBe(true);
    expect(rescueRows).toHaveLength(waitTimedOut ? 1 : 0);
    expect(waitEnd[0]).toMatchObject(waitTimedOut
      ? { timedOut: true, deferredTaskIds: [taskId] }
      : { timedOut: false, deferredTaskIds: [] });
      expect(terminalEvents.filter(event => event.task.id === taskId)).toHaveLength(1);
      expect(readTaskEvents(taskManager, sessionId).filter(event => (
        event.event === 'completed' && event.taskId === taskId
      ))).toHaveLength(1);
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
      _resetAgentRegistry();
      __testSetSession(null);
      await __testResetVpState();
    }

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-startup-failure-'));
    const sessionId = 'session-task-startup-failure';
    const vpId = 'vp-task-startup-failure';
    const failedResult = 'Windows runner setup failed';
    const parentAdapter = new RecordingAdapter([
      [
        { type: 'tool_call', id: 'call_spawn_failure', name: 'SpawnAgent', input: {
          name: 'startup-failure-child',
          mission: 'Fail during child registry setup.',
        } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'The startup failure was handled.' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const taskManager = new TaskManager({ yeaftDir: tempDir });
    const persisted = [];
    const conversationStore = {
      append(record) {
        const row = { id: `startup-row-${persisted.length + 1}`, ...record };
        persisted.push(row);
        return row;
      },
      update(message, patch) {
        const index = persisted.findIndex(row => row.id === message.id);
        if (index < 0) return null;
        persisted[index] = { ...persisted[index], ...patch };
        return persisted[index];
      },
      loadRecentBySession() { return []; },
    };
    const registry = new ToolRegistry();
    let childRegistryCalls = 0;
    registry.register({
      ...agentTool,
      execute: (input, toolCtx) => agentTool.execute(input, {
        ...toolCtx,
        parentEngineDeps: {
          ...toolCtx.parentEngineDeps,
          parentToolRegistry: {
            getAllTools() {
              childRegistryCalls += 1;
              throw new Error(failedResult);
            },
          },
        },
      }),
    });
    const config = {
      model: 'test-model',
      maxOutputTokens: 1024,
      asyncTaskWaitTimeoutMs: 20,
      _readOnly: true,
      language: 'en',
    };
    const sessionLike = {
      adapter: parentAdapter,
      trace: new NullTrace(),
      config,
      conversationStore,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: registry,
      skillManager: null,
      mcpManager: null,
      yeaftDir: tempDir,
      taskManager,
      toolStats: null,
    };
    __testSetSession(sessionLike);
    installYeaftRuntimeBridge(sessionLike);
    const engine = new Engine({
      adapter: parentAdapter,
      trace: sessionLike.trace,
      config,
      conversationStore,
      toolRegistry: registry,
      yeaftDir: tempDir,
      taskManager,
      sessionId,
      vpId,
    });
    engine.setAsyncTaskCoordinator(__testHooks.asyncTaskCoordinatorForTest());
    engine.setSubAgentEventSink(() => {});
    const terminalEvents = [];
    const bridgeSink = taskManager.onEvent;
    let failedTaskId = null;
    taskManager.setEventSink(event => {
      if (event?.event === 'started' && event.task?.kind === 'sub_agent') {
        failedTaskId = event.task.id;
      }
      if (event?.event === 'completed' && event.task) terminalEvents.push(event);
      bridgeSink?.(event);
    });

    const events = await collectEngineEvents(engine, {
      prompt: 'Start the child that fails synchronously.',
      messages: [],
      sessionId,
      senderVpId: vpId,
      threadId: 'main',
    });
    expect(childRegistryCalls).toBe(1);
    expect(failedTaskId).toBeTruthy();
    expect(events.filter(event => event.type === 'async_task_wait_start')).toHaveLength(0);
    expect(events.filter(event => event.type === 'async_task_wait_end')).toHaveLength(0);
    expect(taskManager.listActiveTasks(sessionId)).toEqual([]);
    expect(taskManager.getTask(sessionId, failedTaskId)).toMatchObject({
      status: 'failed',
      resultDelivery: TASK_RESULT_DELIVERY.MODEL_REENTRY,
    });
    expect(engine.hasPendingAsyncTasks()).toBe(false);
    expect(engine.ownsPendingAsyncTask(failedTaskId)).toBe(false);
    expect(__testHooks.asyncTaskOwnerForTest(failedTaskId)).toBeNull();
    expect(terminalEvents.filter(event => event.task.id === failedTaskId)).toHaveLength(1);
    expect(readTaskEvents(taskManager, sessionId).filter(event => (
      event.event === 'completed' && event.taskId === failedTaskId
    ))).toHaveLength(1);
    const providerFailureDeliveries = parentAdapter.streamCalls.filter(call => {
      const wire = JSON.stringify(call.messages);
      return wire.includes(failedTaskId) && wire.includes(failedResult);
    });
    expect(providerFailureDeliveries).toHaveLength(1);
    expect(parentAdapter.streamCalls).toHaveLength(2);
    const failedAgent = Array.from(getAgentRegistry().values())
      .find(agent => agent.taskId === failedTaskId);
    expect(failedAgent).toMatchObject({
      status: 'failed',
      error: failedResult,
      __driverStarted: false,
      subEngine: null,
      outputLog: null,
      outputFile: null,
    });
  });
});
