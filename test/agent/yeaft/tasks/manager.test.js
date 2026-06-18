/**
 * TaskManager tests — persistent Session background tasks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskManager } from '../../../../agent/yeaft/tasks/manager.js';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-tasks-'));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

describe('TaskManager', () => {
  let dir;
  let messages;

  beforeEach(() => {
    dir = makeTempDir();
    messages = [];
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs shell tasks in the background, persists logs, and emits lifecycle messages', async () => {
    const events = [];
    const manager = new TaskManager({
      yeaftDir: dir,
      conversationStore: { append: msg => messages.push(msg) },
      onEvent: evt => events.push(evt),
    });

    const task = manager.startShellTask({
      command: 'node -e "console.log(\'task-ok\')"',
      cwd: dir,
      sessionId: 'session_test',
      ownerVpId: 'vp_linus',
      title: 'Echo from node',
      source: { threadId: 'main' },
    });

    expect(task.status).toBe('running');
    expect(manager.listActiveTasks('session_test')).toHaveLength(1);

    await waitFor(() => manager.getTask('session_test', task.id)?.status === 'succeeded');

    const completed = manager.getTask('session_test', task.id);
    expect(completed.status).toBe('succeeded');
    expect(manager.listActiveTasks('session_test')).toHaveLength(0);

    const log = manager.readTaskLog('session_test', task.id, { tail: true });
    expect(log.text).toContain('task-ok');
    expect(messages.some(m => m.content.includes('[Task started]'))).toBe(true);
    expect(messages.some(m => m.content.includes('[Task finished]'))).toBe(true);
    expect(events.some(e => e.type === 'yeaft_task_event' && e.event === 'started')).toBe(true);
    expect(events.some(e => e.type === 'yeaft_task_event' && e.event === 'completed')).toBe(true);
  });

  it('marks persisted running tasks as orphaned on restart', () => {
    const manager = new TaskManager({
      yeaftDir: dir,
      conversationStore: { append: msg => messages.push(msg) },
    });
    const task = manager.startTask({
      sessionId: 'session_restart',
      ownerVpId: 'vp_linus',
      kind: 'sub_agent',
      title: 'Long review',
      runtime: { subAgentId: 'agent_1' },
    });
    expect(task.status).toBe('running');

    const restarted = new TaskManager({
      yeaftDir: dir,
      conversationStore: { append: msg => messages.push(msg) },
    });

    expect(restarted.listActiveTasks('session_restart')).toHaveLength(0);
    const restored = restarted.getTask('session_restart', task.id);
    expect(restored.status).toBe('orphaned');
    expect(messages.some(m => m.content.includes('Agent restarted while task was running'))).toBe(true);
  });
});
