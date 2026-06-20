import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __testDrainVpDrivers,
  __testResetVpState,
  __testSetSession,
  installYeaftRuntimeBridge,
} from '../../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

class RecordingAdapter {
  constructor(reply = 'I saw the task result.') {
    this.reply = reply;
    this.streamCalls = [];
  }

  async *stream(params) {
    this.streamCalls.push({
      system: params.system,
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async call() {
    return { text: 'ok', usage: {} };
  }
}

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

describe('task result re-entry', () => {
  let tempDir = null;

  afterEach(async () => {
    __testSetSession(null);
    await __testResetVpState();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('actively re-enters the owner VP with an async task tool result', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-task-reentry-'));
    const adapter = new RecordingAdapter('task result acknowledged');
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
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
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

    taskManager.emit({
      type: 'yeaft_task_event',
      event: 'completed',
      task: {
        id: 'task_done_1',
        sessionId: 'session-task-result',
        ownerVpId: 'vp-owner',
        kind: 'shell',
        title: 'Run tests',
        status: 'succeeded',
        source: { threadId: 'thr-source' },
        runtime: { command: 'npm test' },
        result: { exitCode: 0, summary: 'all tests passed' },
        log: { path: '/tmp/task.log', preview: 'PASS test suite' },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await __testDrainVpDrivers();

    expect(adapter.streamCalls).toHaveLength(1);
    const rendered = JSON.stringify(adapter.streamCalls[0].messages);
    expect(rendered).toContain('<task-result id=\\"task_done_1\\" kind=\\"shell\\" status=\\"succeeded\\">');
    expect(rendered).toContain('command: npm test');
    expect(rendered).toContain('all tests passed');
    expect(rendered).toContain('This is an asynchronous tool result from a background task, not a user message');

    const internalRows = persisted.filter(row => row.internal === true);
    expect(internalRows).toHaveLength(1);
    expect(internalRows[0]).toMatchObject({
      role: 'assistant',
      threadId: 'thr-source',
      sessionId: 'session-task-result',
    });
    expect(internalRows[0].content).toContain('<task-result');
  });
});
