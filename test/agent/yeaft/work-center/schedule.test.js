import { mkdtempSync, rmSync, mkdirSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkItemSummary, projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';

import { nextOccurrence, latestOccurrence, normalizeRecurrence, MAX_SCHEDULE_TIMESTAMP } from '../../../../agent/yeaft/work-center/recurrence.js';
import { cloneWorkItemAttachments, readWorkItemAttachment } from '../../../../agent/yeaft/work-center/attachments.js';

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
      recurrence: null, runCount: 0, lastWorkItemId: null,
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
  it('spawns separate durable occurrences without consuming the draft plan', async () => {
    const { store, service, controller, setNow } = fixture();
    const plan = await service.handle('create', {
      goal: 'Daily report', workDir: '/tmp', scheduledFor: epoch('2026-03-06T14:00:00Z'), recurrence: daily,
    });
    expect(plan.schedule.recurrence).toMatchObject(daily);
    expect(() => controller.start(plan.id)).toThrow(/recurring/i);
    setNow('2026-03-09T15:00:00Z');
    const occurrence = controller.startScheduled(plan.id, epoch('2026-03-09T15:00:00Z'));
    expect(occurrence).toMatchObject({ status: 'running', sourceScheduleId: plan.id,
      scheduledOccurrenceAt: epoch('2026-03-09T13:00:00Z'), schedule: null });
    expect(store.getWorkItemDetail(plan.id)).toMatchObject({ status: 'draft', actions: [],
      schedule: { runCount: 1, lastWorkItemId: occurrence.id, scheduledFor: epoch('2026-03-10T13:00:00Z') } });
    expect(controller.startScheduled(plan.id, epoch('2026-03-09T15:00:00Z'))).toBeNull();
    setNow('2026-03-10T15:00:00Z');
    expect(controller.startScheduled(plan.id, epoch('2026-03-10T15:00:00Z'))).toBeNull();
    expect(store.getWorkItem(plan.id).schedule).toMatchObject({ runCount: 1, scheduledFor: epoch('2026-03-11T13:00:00Z') });
  });
  const createPlan = (service, recurrence = daily, extra = {}, context = {}) => service.handle('create', {
    goal: 'Daily report', workDir: '/tmp', scheduledFor: epoch('2026-03-06T14:00:00Z'), recurrence, ...extra,
  }, context);

  it('pauses overdue plans, resumes in the future, fences stale edits, and cannot restart cancelled plans', async () => {
    const { service, controller, store, setNow } = fixture();
    const plan = await createPlan(service);
    setNow('2026-03-09T15:00:00Z');
    const paused = await service.handle('update_schedule', { id: plan.id, enabled: false, revision: plan.revision });
    expect(paused.schedule.status).toBe('paused');
    await expect(service.handle('update_schedule', { id: plan.id, enabled: true, revision: plan.revision })).rejects.toThrow(/changed/);
    const resumed = await service.handle('update_schedule', { id: plan.id, enabled: true, revision: paused.revision });
    expect(resumed.schedule.scheduledFor).toBe(epoch('2026-03-10T13:00:00Z'));
    expect(controller.startScheduled(plan.id, epoch('2026-03-09T15:00:00Z'))).toBeNull();
    controller.cancel(plan.id);
    expect(store.listDueScheduledWorkItemIds(epoch('2026-03-20T15:00:00Z'))).toEqual([]);
    expect(() => controller.start(plan.id)).toThrow(/recurring/i);
    expect(() => store.resumeWorkItemAtomic(plan.id)).toThrow(/recurring/i);
    await expect(service.handle('update_schedule', { id: plan.id, enabled: true })).rejects.toThrow(/pending/);
  });

  it('edits a draft plan without starting coordination or creating Actions', async () => {
    const { service, controller, store } = fixture();
    const plan = await createPlan(service);
    const edited = controller.update(plan.id, { goal: 'A better report' });
    expect(edited).toMatchObject({ status: 'draft', actions: [], goal: 'A better report' });
    expect(store.canAutomaticallyCoordinate(plan.id, { userMessage: true })).toBe(false);
    expect(() => store.beginCoordinatorTurn(plan.id, 'start now', {})).toThrow(/Recurring/);
    const occurrence = controller.startScheduled(plan.id, epoch('2026-03-06T14:00:00Z'));
    expect(occurrence).toMatchObject({ goal: 'A better report', requirement: 'A better report' });
  });

  it('handles overdue one-shot pause/resume explicitly and keeps manual start atomic with dispatch', async () => {
    const { service, controller, setNow } = fixture();
    const item = await createPlan(service, null);
    setNow('2026-03-09T15:00:00Z');
    expect((await service.handle('update_schedule', { id: item.id, enabled: false })).schedule.status).toBe('paused');
    await expect(service.handle('update_schedule', { id: item.id, enabled: true })).rejects.toThrow(/future scheduledFor/);
    const updated = await service.handle('update_schedule', { id: item.id, enabled: true, scheduledFor: epoch('2026-03-10T15:00:00Z') });
    expect(updated.schedule.recurrence).toBeNull();
    controller.start(item.id);
    expect(controller.startScheduled(item.id, epoch('2026-03-11T15:00:00Z'))).toBeNull();
    await expect(service.handle('update_schedule', { id: item.id, enabled: false })).rejects.toThrow(/pending/);
  });

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

  it.each(['failed', 'error', 'cancelled'])('allows the next occurrence after terminal %s', async status => {
    const { service, controller, store, setNow } = fixture();
    const plan = await createPlan(service);
    const first = controller.startScheduled(plan.id, epoch('2026-03-06T14:00:00Z'));
    store.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, first.id);
    setNow('2026-03-07T14:00:00Z');
    expect(controller.startScheduled(plan.id, epoch('2026-03-07T14:00:00Z')).id).not.toBe(first.id);
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

  it('preserves trusted provenance, authority, settings and securely re-owns attachment bytes', async () => {
    const { service, controller, store, setNow } = fixture();
    const plan = await createPlan(service, daily, {
      deliveryTarget: 'merge', reuseMemory: false,
      origin: { sessionId: 'trusted-session', messageId: 'message', createdBy: 'vp' },
      linkedSessionIds: ['trusted-session'], acceptanceCriteria: ['Report includes evidence'],
      files: [{ name: 'input.txt', mimeType: 'text/plain', data: Buffer.from('trusted bytes').toString('base64') }],
    }, { userOriginated: true, trustedProducer: true });
    setNow('2026-03-06T14:00:00Z');
    const item = controller.startScheduled(plan.id, epoch('2026-03-06T14:00:00Z'),
      (source, id) => cloneWorkItemAttachments(source, id, { root: service.attachmentRoot }));
    expect(item).toMatchObject({ origin: plan.origin, deliveryTarget: 'merge', reuseMemory: false,
      acceptanceCriteria: plan.acceptanceCriteria, workflowSnapshot: plan.workflowSnapshot, linkedSessionIds: plan.linkedSessionIds });
    expect(item.attachments[0].id).not.toBe(plan.attachments[0].id);
    expect(readWorkItemAttachment(item, item.attachments[0].id, { root: service.attachmentRoot }).data).toBe(Buffer.from('trusted bytes').toString('base64'));
    expect(() => readWorkItemAttachment(item, plan.attachments[0].id, { root: service.attachmentRoot })).toThrow(/not found/);
    expect(projectWorkItemSummary(item)).toMatchObject({ sourceScheduleId: plan.id, scheduledOccurrenceAt: item.scheduledOccurrenceAt });
    expect(projectWorkItemDetail(item)).toMatchObject({ sourceScheduleId: plan.id, scheduledOccurrenceAt: item.scheduledOccurrenceAt });
    const untrusted = await createPlan(service, daily, { scheduledFor: epoch('2026-03-07T14:00:00Z'), deliveryTarget: 'merge', origin: { sessionId: 'spoofed' } });
    const child = controller.startScheduled(untrusted.id, epoch('2026-03-07T14:00:00Z'));
    expect(child.deliveryTarget).toBeNull();
    expect(child.origin.trustedSession).toBe(false);
    const path = join(service.attachmentRoot, plan.id, plan.attachments[0].storageName);
    unlinkSync(path);
    symlinkSync('/etc/passwd', path);
    controller.cancel(item.id);
    expect(() => controller.startScheduled(plan.id, epoch('2026-03-07T14:00:00Z'),
      (source, id) => cloneWorkItemAttachments(source, id, { root: service.attachmentRoot }))).toThrow();
    expect(store.getWorkItem(plan.id).schedule.runCount).toBe(1);
  });

  it('dispatches recurring plans through the service and cleans copied attachments after transaction failure', async () => {
    const { service, store, setNow } = fixture();
    const plan = await createPlan(service, daily, {
      files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('input').toString('base64') }],
    });
    store.db.exec(`CREATE TRIGGER fail_advance BEFORE UPDATE OF schedule_run_count ON work_items
      WHEN NEW.schedule_run_count > 0 BEGIN SELECT RAISE(ABORT, 'injected rollback'); END`);
    const events = [];
    service.onEvent = event => events.push(event);
    setNow('2026-03-06T14:00:00Z');
    service.start();
    expect(events.some(event => event.type === 'work_item.schedule_failed')).toBe(true);
    expect(store.listWorkItems()).toHaveLength(1);
    expect(readdirSync(service.attachmentRoot)).toEqual([plan.id]);
    store.db.exec('DROP TRIGGER fail_advance');
    // A second service using the same durable DB simulates a fresh startup scan.
    const restartStore = new WorkItemStore(join(service.yeaftDir, 'work-center', 'work-center.db'),
      { now: () => epoch('2026-03-06T14:00:00Z') });
    const restarted = new WorkCenterService({ yeaftDir: service.yeaftDir, store: restartStore,
      controller: new WorkflowController(restartStore), now: () => epoch('2026-03-06T14:00:00Z') });
    restarted.start();
    expect(store.getWorkItem(plan.id).schedule.runCount).toBe(1);
    expect(store.listWorkItems()).toHaveLength(2);
    await restarted.shutdown();
    await service.shutdown();
    cleanups.pop();
    rmSync(service.yeaftDir, { recursive: true, force: true });
  });

  it('migrates schema 40 one-shot data additively', async () => {
    const { service, store, dir } = fixture();
    const plan = await createPlan(service, null);
    store.db.exec(`DROP INDEX idx_work_items_schedule_occurrence;
      DELETE FROM schema_migrations WHERE name = '41-recurring-schedules';
      UPDATE schema_meta SET value = '40' WHERE key = 'schema_version';`);
    for (const column of ['schedule_recurrence', 'schedule_run_count', 'schedule_last_work_item_id', 'source_schedule_id', 'scheduled_occurrence_at']) {
      store.db.exec(`ALTER TABLE work_items DROP COLUMN ${column}`);
    }
    const migrated = new WorkItemStore(join(dir, 'work-center', 'work-center.db'));
    try {
      expect(migrated.getWorkItem(plan.id)).toMatchObject({ status: 'draft', goal: plan.goal,
        schedule: { status: 'scheduled', scheduledFor: plan.schedule.scheduledFor, recurrence: null, runCount: 0 } });
      expect(migrated.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value).toBe('41');
    } finally { migrated.close(); }
  });

  it.each([
    { frequency: 'yearly' }, { time: '24:00' }, { time: '9:00' }, { timeZone: 'Not/A_Zone' },
    { timeZone: '+01:00' }, { weekdays: [7] }, { weekdays: [1, 1] }, { frequency: 'weekly', weekdays: [] },
    { frequency: 'monthly' }, { dayOfMonth: 32 }, { dayOfMonth: 0 }, { maxRuns: 0 }, { maxRuns: 1001 },
    { maxRuns: '2' }, { endsAt: Infinity }, { endsAt: MAX_SCHEDULE_TIMESTAMP + 1 }, { cron: '*' },
  ])('rejects invalid recurrence %j at create and update', async invalid => {
    const { service } = fixture();
    await expect(createPlan(service, { ...daily, ...invalid })).rejects.toThrow();
    const plan = await createPlan(service);
    await expect(service.handle('update_schedule', { id: plan.id, enabled: true, recurrence: { ...daily, ...invalid } })).rejects.toThrow();
  });

  it('validates timestamps and toggles rather than coercing arbitrary API input', async () => {
    const { service } = fixture();
    for (const scheduledFor of [Infinity, MAX_SCHEDULE_TIMESTAMP + 1, '1800000000000', true]) {
      await expect(createPlan(service, daily, { scheduledFor })).rejects.toThrow();
    }
    await expect(createPlan(service, daily, { scheduledFor: null })).rejects.toThrow(/requires scheduledFor/);
    await expect(createPlan(service, daily, { scheduleEnabled: 'false' })).rejects.toThrow(/boolean/);
    const plan = await createPlan(service);
    await expect(service.handle('update_schedule', { id: plan.id, enabled: 'false' })).rejects.toThrow(/boolean/);
    await expect(service.handle('update_schedule', { id: plan.id, enabled: true, recurrence: null })).rejects.toThrow(/converted/);
  });

});


describe('schedule calendar in the persisted browser timezone', () => {
  it.each([
    [{ ...daily, time: '02:30' }, '2026-03-07T07:30:00Z', '2026-03-09T06:30:00Z'],
    [{ ...daily, time: '01:30' }, '2026-10-31T05:30:00Z', '2026-11-01T05:30:00Z'],
    [{ ...daily, time: '01:30' }, '2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
    [{ ...daily, frequency: 'weekdays' }, '2026-03-06T14:00:00Z', '2026-03-09T13:00:00Z'],
    [{ ...daily, frequency: 'weekly', weekdays: [0, 2] }, '2026-03-06T14:00:00Z', '2026-03-08T13:00:00Z'],
    [{ ...daily, frequency: 'monthly', dayOfMonth: 31, timeZone: 'Asia/Kolkata' }, '2026-01-31T03:30:00Z', '2026-02-28T03:30:00Z'],
    [{ ...daily, frequency: 'monthly', dayOfMonth: 31, timeZone: 'Asia/Kolkata' }, '2028-01-31T03:30:00Z', '2028-02-29T03:30:00Z'],
    [{ ...daily, frequency: 'monthly', dayOfMonth: 31, timeZone: 'Asia/Kolkata' }, '2026-12-31T03:30:00Z', '2027-01-31T03:30:00Z'],
    [{ ...daily, timeZone: 'Pacific/Apia' }, '2011-12-29T19:00:00Z', '2011-12-30T19:00:00Z'],
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
