import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSession, openSession } from '../../../agent/yeaft/sessions/session-store.js';

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const setup = () => (root = mkdtempSync(join(tmpdir(), 'yeaft-scheduled-')));
const task = (extra = {}) => ({ prompt: 'Check the repository', enabled: true, trigger: { type: 'manual' }, ...extra });

const schedulerModule = () => import('../../../agent/yeaft/sessions/scheduled-task-scheduler.js');
const read = (id = 'session_task') => JSON.parse(readFileSync(join(root, 'sessions', id, 'session.json'), 'utf8'));
function seed(definition = task(), id = 'session_task') {
  const h = createSession(join(root, 'sessions'), { id, roster: ['alpha'], defaultVpId: 'alpha', task: definition });
  h.close();
}

it('holds a run across routing and active work, rejects reentry, and preserves edits at completion', async () => {
  setup(); seed();
  const { ScheduledTaskScheduler } = await schedulerModule();
  let busy = false, finishDispatch;
  const dispatch = new Promise(resolve => { finishDispatch = resolve; });
  const notifications = [], snapshots = [];
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => 1000,
    dispatch: () => { busy = true; return dispatch; }, isActive: () => busy,
    onChange: () => snapshots.push(read().task.lastRun.status), notify: event => notifications.push(event) });
  scheduler.start();
  const originalRevision = read().task._revision;
  const accepted = scheduler.run('session_task');
  expect(accepted.task.revision).toBe(originalRevision);
  expect(accepted.task.lastRun.status).toBe('running');
  expect(() => scheduler.run('session_task')).toThrow(/running|busy/);
  finishDispatch(); await Promise.resolve();
  await scheduler.tick();
  expect(read().task.lastRun.status).toBe('running');
  scheduler.update('session_task', { prompt: 'New prompt', enabled: false }, originalRevision);
  const editedRevision = read().task._revision;
  expect(editedRevision).not.toBe(originalRevision);
  busy = false; scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
  await scheduler.tick();
  expect(read().task).toMatchObject({ prompt: 'New prompt', enabled: false, lastRun: { status: 'completed', trigger: 'manual' } });
  expect(read().task._revision).toBe(editedRevision);
  expect(notifications).toHaveLength(1);
  expect(snapshots).toContain('completed');
  scheduler.stop();
});

it('uses fresh config revisions so stale tabs cannot undo pauses or overwrite trigger edits', async () => {
  setup(); seed();
  const { ScheduledTaskScheduler } = await schedulerModule();
  const calls = [];
  let now = Date.now();
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, dispatch: msg => calls.push(msg), isActive: () => false });
  const firstTab = scheduler.snapshot(scheduler.read('session_task').meta).task;
  const secondTab = structuredClone(firstTab);
  const trigger = { type: 'schedule', scheduledFor: Date.now() + 86400000, recurrence: null };
  const paused = scheduler.update('session_task', { enabled: false, trigger }, secondTab.revision).task;
  const pausedBytes = readFileSync(join(root, 'sessions/session_task/session.json'));
  const staleEdit = { prompt: 'Old tab edit', enabled: firstTab.enabled, notify: firstTab.notify, trigger: firstTab.trigger };
  for (const revision of [firstTab.revision, undefined, null, 123, '']) {
    expect(() => scheduler.update('session_task', staleEdit, revision)).toThrow(expect.objectContaining({ code: 'task_conflict' }));
    expect(readFileSync(join(root, 'sessions/session_task/session.json'))).toEqual(pausedBytes);
  }
  expect(paused).toMatchObject({ enabled: false, trigger });
  expect(paused).not.toHaveProperty('_revision');
  const noOp = scheduler.update('session_task', { enabled: false }, paused.revision).task;
  expect(noOp.revision).toBe(paused.revision);
  const freshEdit = scheduler.update('session_task', { prompt: 'Fresh tab edit' }, paused.revision).task;
  expect(freshEdit).toMatchObject({ prompt: 'Fresh tab edit', enabled: false, trigger });
  expect(freshEdit.revision).not.toBe(paused.revision);
  // The same minimal header patch blocks the due occurrence without erasing
  // the schedule; an explicit manual preview still works while disabled.
  now = trigger.scheduledFor + 1000;
  await scheduler.tick(); await scheduler.tick();
  expect(calls).toHaveLength(0);
  expect(read().task).toMatchObject({ enabled: false, trigger, nextRunAt: trigger.scheduledFor });
  const preview = scheduler.run('session_task').task;
  expect(calls).toHaveLength(1);
  expect(preview).toMatchObject({ enabled: false, trigger, lastRun: { status: 'running', trigger: 'manual' } });
  scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
  await Promise.resolve(); // Dispatch completion settles before scheduler quiescence.
  await scheduler.tick();
  expect(read().task).toMatchObject({ enabled: false, trigger, lastRun: { status: 'completed', trigger: 'manual' } });
  expect(calls).toHaveLength(1);
  scheduler.stop();
});

it('recovers running as interrupted without replay and skips missed recurring occurrences', async () => {
  setup();
  const now = Date.UTC(2026, 9, 30, 12);
  seed(task({ trigger: { type: 'schedule', scheduledFor: now - 86400000 * 3,
    recurrence: { frequency: 'daily', timeZone: 'UTC', time: '12:00' } } }));
  const saved = read();
  delete saved.task._revision; // Legacy definitions need a stable revision across boot recovery.
  saved.task.lastRun = { id: 'old', status: 'running', trigger: 'schedule', startedAt: now - 86400000, finishedAt: null };
  writeFileSync(join(root, 'sessions/session_task/session.json'), JSON.stringify(saved));
  // A scheduled one-shot whose claim survived a restart is never replayed.
  seed(task({ trigger: { type: 'schedule', scheduledFor: now - 1000, recurrence: null } }), 'session_once');
  const oneShot = read('session_once');
  oneShot.task.lastRun = { id: 'old-once', status: 'running', trigger: 'schedule', startedAt: now - 500, finishedAt: null };
  writeFileSync(join(root, 'sessions/session_once/session.json'), JSON.stringify(oneShot));
  const { ScheduledTaskScheduler } = await schedulerModule();
  const calls = [];
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, dispatch: msg => calls.push(msg), isActive: () => false });
  const legacyRevision = scheduler.snapshot(scheduler.read('session_task').meta).task.revision;
  scheduler.start(); await scheduler.tick();
  expect(read().task._revision).toBe(legacyRevision);
  expect(scheduler.snapshot(scheduler.read('session_task').meta).task.revision).toBe(legacyRevision);
  expect(read().task.lastRun).toMatchObject({ status: 'interrupted', finishedAt: now });
  expect(read().task.nextRunAt).toBe(now + 86400000);
  expect(read('session_once').task).toMatchObject({ nextRunAt: null, lastRun: { status: 'interrupted' } });
  expect(calls).toEqual([]);
  scheduler.stop();
  // An interrupted manual preview must not consume an unrelated future one-shot.
  const future = read();
  future.task.trigger = { type: 'schedule', scheduledFor: now + 60000, recurrence: null };
  future.task.nextRunAt = now + 60000;
  future.task.lastRun = { id: 'preview', status: 'running', trigger: 'manual', startedAt: now - 1000, finishedAt: null };
  writeFileSync(join(root, 'sessions/session_task/session.json'), JSON.stringify(future));
  const restarted = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, dispatch: msg => calls.push(msg), isActive: () => false, warn: () => {} });
  const save = restarted.save.bind(restarted);
  let failures = 1;
  restarted.save = row => { if (failures-- > 0) throw new Error('Temporary disk failure'); save(row); };
  restarted.start();
  expect(read().task.lastRun.status).toBe('running');
  restarted.retryAfter.clear(); await restarted.tick();
  expect(read().task).toMatchObject({ nextRunAt: now + 60000, lastRun: { status: 'interrupted' } });
  expect(calls).toEqual([]);
  restarted.now = () => now + 60000;
  await restarted.tick();
  expect(calls).toHaveLength(1);
  expect(read().task).toMatchObject({ nextRunAt: null, lastRun: { status: 'running', trigger: 'schedule' } });
  restarted.stop();
});

it('rejects path traversal, symlink writes, runtime-field edits and ordinary Session runs', async () => {
  setup(); seed();
  const ordinary = createSession(join(root, 'sessions'), { id: 'session_chat', roster: [] }); ordinary.close();
  const { ScheduledTaskScheduler } = await schedulerModule();
  let calls = 0;
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, dispatch: () => calls++, isActive: () => false });
  const ordinaryPath = join(root, 'sessions/session_chat/session.json');
  const originalBytes = readFileSync(ordinaryPath);
  expect(() => scheduler.update('session_chat', task({ trigger: { type: 'schedule', scheduledFor: 1, recurrence: null } }), read().task._revision)).toThrow(/no task/);
  expect(readFileSync(ordinaryPath)).toEqual(originalBytes);
  await scheduler.tick();
  expect(calls).toBe(0);
  for (const id of ['../outside', '/tmp/session_task', 'session_task/../session_chat']) {
    expect(() => scheduler.update(id, task(), read().task._revision)).toThrow();
    expect(() => scheduler.run(id)).toThrow();
  }
  for (const patch of [{ nextRunAt: 0 }, { revision: 'forged' }, { _revision: 'forged' }, { lastRun: null }]) {
    expect(() => scheduler.update('session_task', patch, read().task._revision)).toThrow(/read-only/);
  }
  expect(() => scheduler.run('session_chat')).toThrow(/task/);
  mkdirSync(join(root, 'outside')); symlinkSync(join(root, 'outside'), join(root, 'sessions/session_link'));
  expect(() => scheduler.update('session_link', task(), read().task._revision)).toThrow();
  expect(read('session_chat')).not.toHaveProperty('task');
  scheduler.stop();
});

it('keeps task state fresh across retained handles, coordinator ingress, rename and roster writes', async () => {
  setup(); seed(task({ trigger: { type: 'schedule', scheduledFor: 2000, recurrence: null } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  const { createCoordinator } = await import('../../../agent/yeaft/sessions/coordinator.js');
  const { renameSession, addMember, removeMember, setSessionDefaultVp, updateSessionAnnouncement } = await import('../../../agent/yeaft/sessions/session-crud.js');
  const handle = openSession(join(root, 'sessions'), 'session_task');
  const stale = handle.getMeta();
  const coordinator = createCoordinator(handle);
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => 1000, dispatch: () => {}, isActive: () => false });
  try {
    scheduler.run('session_task');
    scheduler.update('session_task', { prompt: 'Updated while runtime handle lives', notify: false }, read().task._revision);
    const running = read().task;
    handle.saveMeta({ ...stale, announcement: 'A stale non-task metadata save' });
    expect(read().task).toEqual(running);
    expect(handle.getMeta().task).toEqual(running);
    renameSession(root, 'session_task', 'Renamed task');
    addMember(root, 'session_task', 'beta');
    setSessionDefaultVp(root, 'session_task', 'beta');
    removeMember(root, 'session_task', 'alpha');
    updateSessionAnnouncement(root, 'session_task', 'New announcement');
    expect(coordinator.ingest({ from: 'user', text: 'Use fresh roster' }).dispatched).toEqual(['beta']);
    expect(read().task).toEqual(running);
    scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
    await Promise.resolve(); await scheduler.tick();
    const completed = read().task;
    expect(completed.lastRun.status).toBe('completed');
    handle.saveMeta({ ...stale, name: 'Another retained save' });
    expect(read().task).toEqual(completed);
  } finally { handle.close(); scheduler.stop(); }
});
