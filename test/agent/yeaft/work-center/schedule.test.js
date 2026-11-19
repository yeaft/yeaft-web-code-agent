import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';

const epoch = value => Date.parse(value);
const daily = { frequency: 'daily', timeZone: 'America/New_York', time: '09:00' };
describe('recurring schedules', () => {
  const cleanups = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()(); });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'recurring-schedule-'));
    mkdirSync(join(dir, 'work-center'));
    let clock = epoch('2026-03-06T12:00:00Z');
    const store = new WorkItemStore(join(dir, 'work-center', 'work-center.db'), { now: () => clock });
    const controller = new WorkflowController(store);
    const service = new WorkCenterService({ yeaftDir: dir, store, controller, now: () => clock });
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { dir, store, service, controller, setNow: value => { clock = epoch(value); } };
  }

  const createPlan = (service, recurrence = daily, extra = {}, context = {}) => service.handle('create', {
    goal: 'Daily report', workDir: '/tmp', scheduledFor: epoch('2026-03-06T14:00:00Z'), recurrence, ...extra,
  }, context);

  it('rolls back spawn and advancement together and survives reopening without duplicates', async () => {
    const { service, controller, store, dir, setNow } = fixture();
    const plan = await createPlan(service);
    const now = epoch('2026-03-06T14:00:00Z');
    setNow('2026-03-06T14:00:00Z');
    store.db.exec(`CREATE TRIGGER fail_schedule_advance BEFORE UPDATE OF schedule_run_count ON work_items
      WHEN NEW.schedule_run_count > OLD.schedule_run_count BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => controller.startScheduled(plan.id, now)).toThrow('injected failure');
    expect(store.listWorkItems()).toHaveLength(1);
    expect(store.getWorkItem(plan.id).schedule.runCount).toBe(0);
    store.db.exec('DROP TRIGGER fail_schedule_advance');
    const occurrence = controller.startScheduled(plan.id, now);
    const reopened = new WorkItemStore(join(dir, 'work-center', 'work-center.db'), { now: () => now });
    try {
      expect(new WorkflowController(reopened).startScheduled(plan.id, now)).toBeNull();
      expect(reopened.getWorkItem(plan.id).schedule.lastWorkItemId).toBe(occurrence.id);
      expect(reopened.getWorkItem(occurrence.id).sourceScheduleId).toBe(plan.id);
      expect(reopened.listWorkItems()).toHaveLength(2);
    } finally { reopened.close(); }
  });

});
