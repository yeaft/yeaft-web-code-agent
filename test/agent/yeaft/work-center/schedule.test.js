import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { nextOccurrence, latestOccurrence, normalizeRecurrence, MAX_SCHEDULE_TIMESTAMP } from '../../../../agent/yeaft/work-center/recurrence.js';

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
    const events = [];
    service.onEvent = event => events.push(event);
    service.start();
    expect(events.filter(event => event.type.startsWith('work_item.schedule_')).map(event => event.type))
      .toEqual(['work_item.schedule_triggered']);
    expect(events.filter(event => event.type === 'work_item.created')).toEqual([]);
    const triggered = store.getWorkItemDetail(item.id);
    expect(triggered).toMatchObject({ status: 'running', schedule: { status: 'triggered', triggeredAt: 2_000 } });
    expect(store.listDueScheduledWorkItemIds(2_000)).toEqual([]);
    expect(triggered.events.filter(event => event.type === 'work_item.started')).toHaveLength(1);
    await service.shutdown();
    cleanups.pop();
    rmSync(service.yeaftDir, { recursive: true, force: true });
  });
});

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

  it('never overlaps waiting/error-recovery WorkItems, counts only spawns, and preserves completed results', async () => {
    const { service, controller, store, setNow } = fixture();
    const plan = await createPlan(service, { ...daily, maxRuns: 2 });
    const tick = date => { setNow(date); return controller.startScheduled(plan.id, epoch(date)); };
    const first = tick('2026-03-06T14:00:00Z');
    for (const [status, date] of [['waiting', '2026-03-07T15:00:00Z'], ['needs_attention', '2026-03-08T15:00:00Z']]) {
      store.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, first.id);
      expect(tick(date)).toBeNull();
    }
    expect(store.getWorkItem(plan.id).schedule.runCount).toBe(1);
    store.db.prepare("UPDATE work_items SET status = 'done', final_result = ? WHERE id = ?").run(JSON.stringify({ summary: 'immutable result' }), first.id);
    const second = tick('2026-03-09T15:00:00Z');
    expect(second.id).not.toBe(first.id);
    expect(store.getWorkItem(first.id)).toMatchObject({ status: 'done', finalResult: { summary: 'immutable result' } });
    expect(store.getWorkItem(plan.id).schedule).toMatchObject({ status: 'completed', runCount: 2, lastWorkItemId: second.id });
    expect(tick('2026-03-10T15:00:00Z')).toBeNull();
  });

  it('does not execute after endsAt even when offline, and permits the exact end instant', async () => {
    const { service, controller, store, setNow } = fixture();
    const endsAt = epoch('2026-03-07T14:00:00Z');
    const expired = await createPlan(service, { ...daily, endsAt });
    setNow('2026-03-08T14:00:00Z');
    expect(controller.startScheduled(expired.id, epoch('2026-03-08T14:00:00Z'))).toBeNull();
    expect(store.getWorkItem(expired.id).schedule).toMatchObject({ status: 'completed', runCount: 0 });
    const alreadyExpired = await createPlan(service, { ...daily, endsAt }, { scheduledFor: epoch('2026-03-09T13:00:00Z') });
    expect(alreadyExpired.schedule.status).toBe('completed');
    setNow('2026-03-06T12:00:00Z');
    const exact = await createPlan(service, { ...daily, endsAt });
    setNow('2026-03-07T14:00:00Z');
    expect(controller.startScheduled(exact.id, endsAt)).not.toBeNull();
    expect(store.getWorkItem(exact.id).schedule).toMatchObject({ status: 'completed', runCount: 1 });
  });

  it('migrates schema 40 one-shot data additively', async () => {
    const { service, store, dir } = fixture();
    const plan = await createPlan(service, null);
    store.db.exec(`DROP INDEX idx_work_items_schedule_occurrence;
      DELETE FROM schema_migrations WHERE name = '42-recurring-schedules';
      UPDATE schema_meta SET value = '40' WHERE key = 'schema_version';`);
    for (const column of ['schedule_recurrence', 'schedule_run_count', 'schedule_last_work_item_id', 'source_schedule_id', 'scheduled_occurrence_at']) {
      store.db.exec(`ALTER TABLE work_items DROP COLUMN ${column}`);
    }
    const migrated = new WorkItemStore(join(dir, 'work-center', 'work-center.db'));
    try {
      expect(migrated.getWorkItem(plan.id)).toMatchObject({ status: 'draft', goal: plan.goal,
        schedule: { status: 'scheduled', scheduledFor: plan.schedule.scheduledFor, recurrence: null, runCount: 0 } });
      expect(migrated.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value).toBe('42');
    } finally { migrated.close(); }
  });
});

describe('schedule calendar in the persisted browser timezone', () => {
  it.each([
    [{ ...daily, time: '02:30' }, '2026-03-07T07:30:00Z', '2026-03-09T06:30:00Z'],
    [{ ...daily, time: '01:30' }, '2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
    [{ ...daily, frequency: 'monthly', dayOfMonth: 31, timeZone: 'Asia/Kolkata' }, '2026-01-31T03:30:00Z', '2026-02-28T03:30:00Z'],
    [{ ...daily, frequency: 'monthly', dayOfMonth: 31, timeZone: 'Asia/Kolkata' }, '2028-01-31T03:30:00Z', '2028-02-29T03:30:00Z'],
    [{ ...daily, timeZone: 'Australia/Lord_Howe', time: '02:15' }, '2026-10-02T15:45:00Z', '2026-10-04T15:15:00Z'],
  ])('computes %j after %s', (input, after, expected) => {
    expect(nextOccurrence(normalizeRecurrence(input), epoch(after))).toBe(epoch(expected));
  });
  it('coalesces a DST fold to the first instant and bounds the maximum date', () => {
    const rule = normalizeRecurrence({ ...daily, time: '01:30' });
    expect(latestOccurrence(rule, epoch('2026-11-01T06:45:00Z'))).toBe(epoch('2026-11-01T05:30:00Z'));
    expect(nextOccurrence(rule, MAX_SCHEDULE_TIMESTAMP)).toBeNull();
  });
});
