/**
 * TaskManager tests — persistent Session background tasks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskManager } from '../../../../agent/yeaft/tasks/manager.js';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-tasks-'));
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

  it('applies the same owner fence to status, waits, logs, and cancellation', async () => {
    const manager = new TaskManager({ yeaftDir: dir });
    const task = manager.startTask({ sessionId: 'session_owner', ownerVpId: 'vp_owner', kind: 'shell' });
    const ownerless = manager.startTask({ sessionId: 'session_owner', kind: 'shell' });
    expect(manager.listActiveTasks('session_owner', 'vp_other')).toEqual([]);
    expect(manager.getTask('session_owner', ownerless.id, 'vp_other')).toBeNull();
    expect(manager.getTask('session_owner', task.id, 'vp_other')).toBeNull();
    expect(manager.getTask('session_other', task.id, 'vp_owner')).toBeNull();
    expect(manager.readTaskLog('session_owner', task.id, {}, 'vp_other')).toBeNull();
    expect(manager.readTaskLog('session_owner', ownerless.id, {}, 'vp_other')).toBeNull();
    expect(manager.cancelTask('session_owner', task.id, 'vp_other')).toMatchObject({ ok: false });
    expect(manager.cancelTask('session_owner', ownerless.id, 'vp_other')).toMatchObject({ ok: false });
    await expect(manager.waitForTask('session_owner', task.id, { ownerVpId: 'vp_other' }))
      .resolves.toMatchObject({ ok: false, error: `Unknown task: ${task.id}` });
    await expect(manager.waitForTask('session_owner', ownerless.id, { ownerVpId: 'vp_other' }))
      .resolves.toMatchObject({ ok: false, error: `Unknown task: ${ownerless.id}` });
    await expect(manager.waitForTask('session_other', task.id, { ownerVpId: 'vp_owner' }))
      .resolves.toMatchObject({ ok: false, error: `Unknown task: ${task.id}` });
    manager.completeTask('session_owner', task.id, { status: 'succeeded', exitCode: 0 });
    manager.completeTask('session_owner', ownerless.id, { status: 'succeeded', exitCode: 0 });
  });
});
