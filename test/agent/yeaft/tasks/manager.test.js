/**
 * TaskManager tests — persistent Session background tasks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskManager } from '../../../../agent/yeaft/tasks/manager.js';
import { buildWindowsTaskkillArgs } from '../../../../agent/yeaft/tasks/shell-runner.js';

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
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs shell tasks in the background, persists logs, and emits task events without chat messages', async () => {
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

    expect(task).toMatchObject({
      status: 'running',
      resultDelivery: 'status_only',
    });
    expect(manager.listActiveTasks('session_test')).toHaveLength(1);

    await waitFor(() => manager.getTask('session_test', task.id)?.status === 'succeeded');

    const completed = manager.getTask('session_test', task.id);
    expect(completed.status).toBe('succeeded');
    expect(manager.listActiveTasks('session_test')).toHaveLength(0);

    const log = manager.readTaskLog('session_test', task.id, { tail: true });
    expect(log.text).toContain('task-ok');
    expect(messages).toHaveLength(0);
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
    expect(task).toMatchObject({ status: 'running', resultDelivery: 'status_only' });

    const taskPath = manager.store.taskPath('session_restart', task.id);
    const legacyTask = JSON.parse(readFileSync(taskPath, 'utf8'));
    delete legacyTask.resultDelivery;
    writeFileSync(taskPath, `${JSON.stringify(legacyTask, null, 2)}\n`, 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidTask = manager.startTask({
      sessionId: 'session_invalid_delivery',
      ownerVpId: 'vp_linus',
      kind: 'sub_agent',
      title: 'Invalid delivery',
      resultDelivery: 'future_delivery_mode',
    });
    expect(invalidTask.resultDelivery).toBe('status_only');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid task resultDelivery'));

    const unknownTask = manager.startTask({
      sessionId: 'session_unknown_kind',
      ownerVpId: 'vp_linus',
      kind: 'future_task_kind',
      title: 'Unknown task kind',
    });
    expect(unknownTask.resultDelivery).toBe('status_only');

    const restarted = new TaskManager({
      yeaftDir: dir,
      conversationStore: { append: msg => messages.push(msg) },
    });

    const firstSinkEvents = [];
    restarted.setEventSink(event => firstSinkEvents.push(event));
    expect(firstSinkEvents).toHaveLength(3);
    expect(firstSinkEvents.every(event => event.event === 'completed')).toBe(true);
    expect(firstSinkEvents.map(event => event.task.id).sort()).toEqual([
      task.id,
      invalidTask.id,
      unknownTask.id,
    ].sort());
    expect(firstSinkEvents.map(event => event.task.resultDelivery).sort()).toEqual([
      'model_reentry',
      'status_only',
      'status_only',
    ].sort());

    const replacementSinkEvents = [];
    restarted.setEventSink(event => replacementSinkEvents.push(event));
    expect(replacementSinkEvents).toHaveLength(0);
    expect(firstSinkEvents).toHaveLength(3);

    expect(restarted.listActiveTasks('session_restart')).toHaveLength(0);
    const restored = restarted.getTask('session_restart', task.id);
    expect(restored).toMatchObject({ status: 'orphaned', resultDelivery: 'model_reentry' });
    expect(restarted.getTask('session_invalid_delivery', invalidTask.id)).toMatchObject({
      status: 'orphaned',
      resultDelivery: 'status_only',
    });
    expect(restarted.getTask('session_unknown_kind', unknownTask.id)).toMatchObject({
      status: 'orphaned',
      resultDelivery: 'status_only',
    });
    expect(messages).toHaveLength(0);
  });

  it('builds Windows process-tree kill arguments', () => {
    expect(buildWindowsTaskkillArgs(1234)).toEqual(['/pid', '1234', '/t', '/f']);
  });

  it('waits for process exit before marking a cancelled shell task terminal', async () => {
    const manager = new TaskManager({ yeaftDir: dir, cancelEscalationMs: 1000 });
    const markerPath = join(dir, 'term-ignored');
    const command = `trap 'echo ignored-term; touch ${JSON.stringify(markerPath)}' TERM; echo started; while true; do echo tick; sleep 0.05; done`;
    const task = manager.startShellTask({
      command,
      cwd: dir,
      sessionId: 'session_cancel_live',
      ownerVpId: 'vp_linus',
      title: 'Ignore SIGTERM',
    });

    await waitFor(() => manager.readTaskLog('session_cancel_live', task.id, { tail: true }).text.includes('started'));
    const cancelResult = manager.cancelTask('session_cancel_live', task.id);

    expect(cancelResult).toMatchObject({ ok: true, pending: true });
    expect(cancelResult.task.status).toBe('running');
    expect(cancelResult.task.runtime.cancelRequestedAt).toBeTruthy();
    expect(manager.getTask('session_cancel_live', task.id).status).toBe('running');

    await waitFor(() => existsSync(markerPath), { timeoutMs: 500 });
    expect(manager.getTask('session_cancel_live', task.id).status).toBe('running');

    await waitFor(() => manager.getTask('session_cancel_live', task.id)?.status === 'cancelled', { timeoutMs: 5000 });
    const completed = manager.getTask('session_cancel_live', task.id);
    expect(completed.status).toBe('cancelled');
    expect(completed.result.signal).toBe('SIGKILL');
    expect(completed.runtime.cancelEscalatedSignal).toBe('SIGKILL');
    expect(manager.listActiveTasks('session_cancel_live')).toHaveLength(0);
  });

  it('does not mark cancel complete when process-tree kill fails', () => {
    const manager = new TaskManager({ yeaftDir: dir });
    const task = manager.startTask({
      sessionId: 'session_cancel',
      ownerVpId: 'vp_linus',
      kind: 'shell',
      title: 'Unattached task',
    });
    expect(task.resultDelivery).toBe('status_only');

    const result = manager.cancelTask('session_cancel', task.id);
    expect(result.ok).toBe(false);
    expect(result.task.status).toBe('running');
    expect(manager.getTask('session_cancel', task.id).status).toBe('running');
  });

  it('reads log tails without requiring a whole-file read', () => {
    const manager = new TaskManager({ yeaftDir: dir });
    const task = manager.startTask({
      sessionId: 'session_log',
      ownerVpId: 'vp_linus',
      kind: 'shell',
      title: 'Large log',
    });
    writeFileSync(join(dir, 'tasks', 'sessions', 'session_log', `${task.id}.log`), `${'x'.repeat(128 * 1024)}tail-end`, 'utf8');

    const log = manager.readTaskLog('session_log', task.id, { tail: true, maxBytes: 16 });
    expect(log.text).toBe('xxxxxxxxtail-end');
    expect(log.bytes).toBe(128 * 1024 + 'tail-end'.length);
    expect(log.offset).toBe(log.bytes - 16);
    expect(log.nextOffset).toBe(log.bytes);
    expect(log.truncated).toBe(false);
  });

  it('keeps a larger live preview for sub-agent task output than shell task output', () => {
    const manager = new TaskManager({ yeaftDir: dir });
    const payload = `${'x'.repeat(5000)}sub-agent-tail`;
    const subAgentTask = manager.startTask({
      sessionId: 'session_sub_log',
      ownerVpId: 'vp_linus',
      kind: 'sub_agent',
      title: 'Verbose sub-agent',
      resultDelivery: 'model_reentry',
    });
    expect(subAgentTask.resultDelivery).toBe('model_reentry');
    writeFileSync(join(dir, 'tasks', 'sessions', 'session_sub_log', `${subAgentTask.id}.log`), payload, 'utf8');

    const refreshedSubAgent = manager.refreshTaskLog('session_sub_log', subAgentTask.id);
    expect(refreshedSubAgent.log.preview).toBe(payload);

    const shellTask = manager.startTask({
      sessionId: 'session_shell_log',
      ownerVpId: 'vp_linus',
      kind: 'shell',
      title: 'Verbose shell',
    });
    writeFileSync(join(dir, 'tasks', 'sessions', 'session_shell_log', `${shellTask.id}.log`), payload, 'utf8');

    const refreshedShell = manager.refreshTaskLog('session_shell_log', shellTask.id);
    expect(refreshedShell.log.preview).not.toBe(payload);
    expect(refreshedShell.log.preview).toHaveLength(4096);
    expect(refreshedShell.log.preview.endsWith('sub-agent-tail')).toBe(true);
  });
});
