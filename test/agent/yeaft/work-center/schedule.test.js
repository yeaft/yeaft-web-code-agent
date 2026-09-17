import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkItemSummary } from '../../../../agent/yeaft/work-center/projection.js';

describe('scheduled WorkItems', () => {
  const cleanups = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()(); });

  function fixture(now = 1_000) {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-schedule-'));
    let clock = now;
    const store = new WorkItemStore(join(dir, 'work-center.db'), { now: () => clock });
    const service = new WorkCenterService({
      yeaftDir: dir,
      store,
      controller: new WorkflowController(store),
      coordinator: null,
      runner: null,
      now: () => clock,
    });
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { store, service, setNow: value => { clock = value; } };
  }

  it('persists a scheduled WorkItem and atomically triggers it once when due', async () => {
    const { store, service, setNow } = fixture();
    const item = await service.handle('create', {
      goal: 'Run the release audit', workDir: '/tmp', start: true, scheduledFor: 2_000,
    }, { userOriginated: true });

    expect(item).toMatchObject({ status: 'draft', schedule: { status: 'scheduled', scheduledFor: 2_000 } });
    expect(store.listDueScheduledWorkItemIds(1_999)).toEqual([]);
    setNow(2_000);
    service.start();
    const triggered = store.getWorkItemDetail(item.id);
    expect(triggered).toMatchObject({ status: 'running', schedule: { status: 'triggered', triggeredAt: 2_000 } });
    expect(store.listDueScheduledWorkItemIds(2_000)).toEqual([]);
    expect(triggered.events.filter(event => event.type === 'work_item.started')).toHaveLength(1);
    await service.shutdown();
    cleanups.pop();
    rmSync(service.yeaftDir, { recursive: true, force: true });
  });

  it('supports pause, reschedule, resume, and browser projection', async () => {
    const { service } = fixture();
    let item = await service.handle('create', {
      goal: 'Check dependencies', workDir: '/tmp', scheduledFor: 5_000,
    }, { userOriginated: true });
    item = await service.handle('update_schedule', { id: item.id, enabled: false });
    expect(item.schedule.status).toBe('paused');
    item = await service.handle('update_schedule', { id: item.id, scheduledFor: 8_000, enabled: true });
    expect(projectWorkItemSummary(item).schedule).toEqual({
      status: 'scheduled', scheduledFor: 8_000, triggeredAt: null,
    });
  });

  it('rejects schedules in the past and leaves ordinary WorkItems compatible', async () => {
    const { service } = fixture();
    await expect(service.handle('create', {
      goal: 'Too late', workDir: '/tmp', scheduledFor: 999,
    }, { userOriginated: true })).rejects.toThrow('scheduledFor must be in the future');
    const ordinary = await service.handle('create', {
      goal: 'Normal item', workDir: '/tmp', start: false,
    }, { userOriginated: true });
    expect(ordinary.schedule).toBeNull();
  });
});
