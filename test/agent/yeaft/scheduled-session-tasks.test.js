import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSession, openSession } from '../../../agent/yeaft/sessions/session-store.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const setup = () => (root = mkdtempSync(join(tmpdir(), 'yeaft-scheduled-')));
const task = (extra = {}) => ({ prompt: 'Check the repository', enabled: true, trigger: { type: 'manual' }, ...extra });

it('persists an optional task with defaults without changing ordinary Sessions', () => {
  setup();
  const ordinary = createSession(join(root, 'sessions'), { id: 'session_chat', roster: [] });
  expect(ordinary.getMeta()).not.toHaveProperty('task');
  ordinary.close();
  const scheduled = createSession(join(root, 'sessions'), { id: 'session_task', roster: [], task: task() });
  expect(scheduled.getMeta().task).toMatchObject({ ...task(), notify: true, nextRunAt: null, lastRun: null, _revision: expect.any(String) });
  scheduled.close();
});

it('rejects invalid task specs before creating any Session or discovery metadata', () => {
  setup();
  for (const invalid of [task({ prompt: '  ' }), task({ enabled: 'yes' }), task({ notify: 1 }),
    task({ lastRun: { status: 'completed' } }), task({ nextRunAt: 0 }), task({ revision: 'forged' }),
    task({ _revision: 'forged' }), task({ prompt: 'x'.repeat(65537) }),
    task({ trigger: { type: 'schedule', scheduledFor: -1 } }), task({ trigger: { type: 'cron' } })]) {
    expect(() => createSessionFromSpec(root, { name: 'Invalid', roster: [], task: invalid })).toThrow();
  }
  expect(existsSync(join(root, 'sessions'))).toBe(false);
  expect(existsSync(join(root, 'sessions-manifest.json'))).toBe(false);
});

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
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, dispatch: () => {}, isActive: () => false });
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
});

it('derives stable legacy revisions without writes and excludes runtime from config identity', async () => {
  setup(); seed();
  const { ScheduledTaskScheduler } = await schedulerModule();
  const { publicScheduledTask, scheduledTaskRevision } = await import('../../../agent/yeaft/sessions/scheduled-task-definition.js');
  const { snapshotSessions } = await import('../../../agent/yeaft/sessions/session-crud.js');
  const path = join(root, 'sessions/session_task/session.json');
  const legacy = read(); delete legacy.task._revision;
  writeFileSync(path, JSON.stringify(legacy));
  const bytes = readFileSync(path);
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => 1000, dispatch: () => {}, isActive: () => false });
  const revision = snapshotSessions(root)[0].task.revision;
  expect(revision).toEqual(expect.any(String));
  expect(scheduler.read('session_task').meta.task._revision).toBe(revision);
  expect(snapshotSessions(root)[0].task.revision).toBe(revision);
  expect(readFileSync(path)).toEqual(bytes);
  expect(scheduledTaskRevision({ ...legacy.task, nextRunAt: 123, _scheduledRuns: 20,
    lastRun: { status: 'completed' } })).toBe(revision);
  for (const patch of [{ prompt: 'Changed' }, { enabled: false }, { notify: false },
    { trigger: { type: 'schedule', scheduledFor: 2000, recurrence: null } }]) {
    expect(scheduledTaskRevision({ ...legacy.task, ...patch })).not.toBe(revision);
  }
  const running = scheduler.run('session_task').task;
  expect(running.revision).toBe(revision);
  expect(publicScheduledTask(running).revision).toBe(revision);
  scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
  await Promise.resolve(); await scheduler.tick();
  expect(snapshotSessions(root)[0].task.revision).toBe(revision);
  expect(scheduler.update('session_task', { notify: false }, revision).task.revision).not.toBe(revision);
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

it('runs a late one-shot once and records terminal errors without retry loops', async () => {
  setup(); seed(task({ trigger: { type: 'schedule', scheduledFor: 500, recurrence: null } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  let calls = 0;
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => 1000,
    dispatch: () => { calls++; throw new Error('provider unavailable'); }, isActive: () => false });
  scheduler.start(); await scheduler.tick(); await scheduler.tick(); await scheduler.tick();
  expect(calls).toBe(1);
  expect(read().task).toMatchObject({ nextRunAt: null, lastRun: { status: 'failed', error: 'provider unavailable' } });
  scheduler.stop();
});

it('does not resurrect deleted or archived Sessions and reads fresh definitions at dispatch', async () => {
  setup(); seed();
  const { ScheduledTaskScheduler } = await schedulerModule();
  const { archiveSession, deleteSession } = await import('../../../agent/yeaft/sessions/session-crud.js');
  let busy = true;
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, dispatch: () => {}, isActive: () => busy });
  scheduler.start(); busy = false; scheduler.run('session_task'); busy = true;
  archiveSession(root, 'session_task'); busy = false; await scheduler.tick();
  expect(existsSync(join(root, 'sessions/session_task'))).toBe(false);
  seed(); scheduler.run('session_task');
  deleteSession(root, 'session_task', { memoryRoot: join(root, 'memory') });
  await scheduler.tick();
  expect(existsSync(join(root, 'sessions/session_task'))).toBe(false);
  seed();
  scheduler.update('session_task', { prompt: 'Fresh prompt', notify: false }, read().task._revision);
  expect(scheduler.run('session_task').task.prompt).toBe('Fresh prompt');
  scheduler.stop();
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

it('fences edits during delayed runtime boot and never dispatches an obsolete prompt', async () => {
  setup(); seed();
  const { ScheduledTaskScheduler, SCHEDULED_TASK_DISPATCH_GUARD } = await schedulerModule();
  let bootDone, executions = 0;
  const boot = new Promise(resolve => { bootDone = resolve; });
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, isActive: () => false,
    dispatch: async msg => { await boot; msg[SCHEDULED_TASK_DISPATCH_GUARD](); executions++; } });
  scheduler.start(); scheduler.run('session_task');
  scheduler.update('session_task', { enabled: false, prompt: 'Do not execute the old prompt' }, read().task._revision);
  bootDone(); await Promise.resolve(); await Promise.resolve();
  await scheduler.tick();
  expect(executions).toBe(0);
  expect(read().task).toMatchObject({ enabled: false, prompt: 'Do not execute the old prompt', lastRun: { status: 'failed' } });
  scheduler.stop();
});

it('executes through native Session ingress and waits past terminal output for real runtime quiescence', async () => {
  setup(); seed();
  const { vi } = await import('vitest');
  const { default: ctx } = await import('../../../agent/context.js');
  const { Engine } = await import('../../../agent/yeaft/engine.js');
  const { ConversationStore } = await import('../../../agent/yeaft/conversation/persist.js');
  const { buildRoleMd } = await import('../../../agent/yeaft/vp/vp-crud.js');
  const bridge = await import('../../../agent/yeaft/web-bridge.js');
  const previous = Object.fromEntries(['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired'].map(key => [key, ctx[key]]));
  ctx.CONFIG = { yeaftDir: root }; ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false; ctx.outboundSendQueue = []; ctx.outboundSendQueueActive = true;
  mkdirSync(join(root, 'virtual-persons/alpha'), { recursive: true });
  writeFileSync(join(root, 'virtual-persons/alpha/role.md'), buildRoleMd({ vpId: 'alpha', displayName: 'Alpha', role: 'Test' }));
  const { saveSessionConfig } = await import('../../../agent/yeaft/sessions/session-config.js');
  const config = saveSessionConfig(root, 'session_task', { model: 'test/model', modelEffort: 'high' });
  const store = new ConversationStore(root);
  bridge.__testSetSession({ yeaftDir: root, config: {}, conversationStore: store });
  let finish, started = false, terminal = false;
  const gate = new Promise(resolve => { finish = resolve; });
  const query = vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* () {
    started = true;
    yield { type: 'text_delta', text: 'Task response' };
    terminal = true;
    yield { type: 'turn_end', terminal: true, stopReason: 'end_turn' };
    await gate;
  });
  try {
    bridge.handleYeaftScheduledTask({ op: 'run', sessionId: 'session_task', requestId: 'run-1', _requestClientId: 'browser-1' });
    const scheduler = bridge.startYeaftScheduledTasks();
    await vi.waitFor(() => expect(started && terminal).toBe(true));
    await scheduler.tick();
    expect(read().task.lastRun.status).toBe('running');
    expect(store.loadVisibleBySession('session_task', Infinity, Infinity).messages.some(row => row.role === 'user' && row.content === task().prompt)).toBe(true);
    const ack = ctx.outboundSendQueue.find(item => item.msg.event?.op === 'run_task' && item.msg.event?.requestId === 'run-1').msg;
    expect(ack).toMatchObject({ _requestClientId: 'browser-1', event: { ok: true, session: { config, task: { revision: read().task._revision } } } });
    const snapshot = ctx.outboundSendQueue.find(item => item.msg.event?.type === 'session_list_updated').msg.event.sessions;
    expect(snapshot.find(row => row.id === 'session_task').config).toEqual(config);
    finish(); await bridge.__testDrainVpDrivers(); await scheduler.tick();
    expect(read().task.lastRun.status).toBe('completed');
    expect(ctx.outboundSendQueue.some(item => item.msg.event?.type === 'scheduled_task_notification' && item.msg.event?.status === 'completed')).toBe(true);
  } finally {
    finish(); await bridge.__testDrainVpDrivers();
    bridge.stopYeaftScheduledTasks(); await bridge.__testResetVpState();
    bridge.__testHooks.resetVpStatusBroker(); bridge.__testSetSession(null);
    query.mockRestore(); Object.assign(ctx, previous);
    const { closeConversationHistoryIndexes } = await import('../../../agent/yeaft/conversation/history-index.js');
    await closeConversationHistoryIndexes();
  }
});

it('bounds recurring runs, skips occurrences while busy, and keeps bookkeeping private', async () => {
  setup();
  let now = Date.UTC(2026, 9, 30, 11, 59, 59), busy = false;
  seed(task({ trigger: { type: 'schedule', scheduledFor: now + 1000,
    recurrence: { frequency: 'daily', timeZone: 'UTC', time: '12:00', maxRuns: 1 } } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  let calls = 0;
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, isActive: () => busy,
    dispatch: () => { calls++; } });
  scheduler.start();
  now += 1000; busy = true; await scheduler.tick();
  now += 86400000 * 2; busy = false; await scheduler.tick();
  expect(calls).toBe(0);
  expect(read().task.nextRunAt).toBe(now + 86400000);
  now += 86400000; await scheduler.tick();
  expect(calls).toBe(1);
  scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
  await Promise.resolve(); await scheduler.tick();
  expect(read().task.nextRunAt).toBe(null);
  const { snapshotSessions } = await import('../../../agent/yeaft/sessions/session-crud.js');
  expect(snapshotSessions(root)[0].task).not.toHaveProperty('_scheduledRuns');
  expect(snapshotSessions(root)[0].task).not.toHaveProperty('_revision');
  scheduler.stop();
});

it('retries failed persistence with backoff before dispatch, and honors disabled notifications', async () => {
  setup(); seed(task({ notify: false, trigger: { type: 'schedule', scheduledFor: 500, recurrence: null } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  let now = 1000, calls = 0, notifications = 0;
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, isActive: () => false,
    warn: () => {}, notify: () => notifications++, dispatch: () => calls++ });
  scheduler.start();
  const save = scheduler.save.bind(scheduler);
  let saves = 0;
  scheduler.save = row => { saves++; if (saves === 1) throw new Error('disk full'); save(row); };
  await scheduler.tick(); await scheduler.tick();
  expect(calls).toBe(0); expect(saves).toBe(1);
  now += 30000; await scheduler.tick();
  expect(calls).toBe(1);
  scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
  await Promise.resolve(); await scheduler.tick();
  expect(read().task.lastRun.status).toBe('completed');
  expect(notifications).toBe(0);
  scheduler.stop();
});

it('manual runs preserve future one-shot and recurring plans, including scheduled run counts', async () => {
  setup();
  let now = Date.UTC(2026, 9, 30, 11), busy = true;
  const due = now + 3600000;
  seed(task({ trigger: { type: 'schedule', scheduledFor: due, recurrence: null } }), 'session_once');
  seed(task({ trigger: { type: 'schedule', scheduledFor: due,
    recurrence: { frequency: 'daily', timeZone: 'UTC', time: '12:00', maxRuns: 1 } } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, dispatch: () => {}, isActive: () => busy });
  try {
    scheduler.start(); busy = false;
    for (const id of ['session_once', 'session_task']) {
      const before = read(id).task;
      scheduler.run(id); busy = true;
      expect(read(id).task.nextRunAt).toBe(before.nextRunAt);
      expect(read(id).task._scheduledRuns).toBe(before._scheduledRuns);
      scheduler.observe(id, { type: 'vp_turn_end', reason: 'end_turn' });
      await Promise.resolve(); busy = false; now++;
      scheduler.finish(id, scheduler.runs.get(id));
      expect(read(id).task).toMatchObject({ nextRunAt: due, lastRun: { status: 'completed', trigger: 'manual' } });
      expect(read(id).task._scheduledRuns).toBe(before._scheduledRuns);
      expect(read(id).task._revision).toBe(before._revision);
      expect(scheduler.update(id, { prompt: 'Edited after manual completion' }, before._revision).task.revision).not.toBe(before._revision);
    }
    now = due;
    await scheduler.tick();
    expect(read('session_once').task).toMatchObject({ nextRunAt: null, _scheduledRuns: 1, lastRun: { trigger: 'schedule' } });
    expect(read().task).toMatchObject({ nextRunAt: null, _scheduledRuns: 1, lastRun: { trigger: 'schedule' } });
  } finally { scheduler.stop(); }
});

it('only the busy scheduler skips recurring occurrences during manual work; one-shots remain pending', async () => {
  setup();
  let now = Date.UTC(2026, 9, 30, 11, 59, 59), busy = false;
  const due = now + 1000;
  seed(task({ trigger: { type: 'schedule', scheduledFor: due, recurrence: null } }), 'session_once');
  seed(task({ trigger: { type: 'schedule', scheduledFor: due,
    recurrence: { frequency: 'daily', timeZone: 'UTC', time: '12:00', maxRuns: 1 } } }));
  const { ScheduledTaskScheduler } = await schedulerModule();
  const calls = [];
  const scheduler = new ScheduledTaskScheduler({ yeaftDir: root, now: () => now, dispatch: msg => calls.push(msg), isActive: () => busy });
  try {
    scheduler.start();
    scheduler.run('session_once'); scheduler.run('session_task');
    await Promise.resolve(); busy = true; now = due + 1000;
    // Finishing a manual run directly must not advance even an already due plan.
    scheduler.observe('session_task', { type: 'vp_turn_end', reason: 'end_turn' });
    scheduler.finish('session_task', scheduler.runs.get('session_task'));
    expect(read().task.nextRunAt).toBe(due);
    expect(read().task._scheduledRuns || 0).toBe(0);
    await scheduler.tick();
    expect(read().task.nextRunAt).toBe(due + 86400000);
    expect(read().task._scheduledRuns || 0).toBe(0);
    expect(read('session_once').task.nextRunAt).toBe(due);
    // Completion on the same tick cannot cause a stacked one-shot run.
    scheduler.observe('session_once', { type: 'vp_turn_end', reason: 'end_turn' });
    busy = false; await scheduler.tick();
    expect(read('session_once').task.lastRun.status).toBe('completed');
    expect(calls).toHaveLength(2);
    await scheduler.tick();
    expect(calls).toHaveLength(3);
    expect(read('session_once').task.lastRun.trigger).toBe('schedule');
  } finally { scheduler.stop(); }
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

it('correlates task create success and validation failure to the authenticated requester', async () => {
  setup();
  const { default: ctx } = await import('../../../agent/context.js');
  const bridge = await import('../../../agent/yeaft/web-bridge.js');
  const previous = Object.fromEntries(['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired'].map(key => [key, ctx[key]]));
  ctx.CONFIG = { yeaftDir: root }; ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false; ctx.outboundSendQueue = []; ctx.outboundSendQueueActive = true;
  try {
    bridge.handleYeaftCreateSession({ requestId: 'invalid-task', _requestClientId: 'browser-invalid', payload: { name: 'Invalid', task: task({ prompt: '' }) } });
    const failed = ctx.outboundSendQueue.find(item => item.msg.event?.requestId === 'invalid-task').msg;
    expect(failed).toMatchObject({ requestId: 'invalid-task', _requestClientId: 'browser-invalid', event: { op: 'create', ok: false } });
    expect(existsSync(join(root, 'sessions-manifest.json'))).toBe(false);
    bridge.handleYeaftCreateSession({ requestId: 'new-task', _requestClientId: 'browser-valid', payload: { name: 'Valid', task: task(), config: { model: 'test/model', modelEffort: 'high' } } });
    const created = ctx.outboundSendQueue.find(item => item.msg.event?.requestId === 'new-task').msg;
    expect(created).toMatchObject({ requestId: 'new-task', _requestClientId: 'browser-valid', event: { op: 'create', ok: true, session: { task: { prompt: task().prompt } } } });
    const { id, task: createdTask, config } = created.event.session;
    expect(config).toEqual({ model: 'test/model', modelEffort: 'high' });
    expect(createdTask.revision).toBe(read(id).task._revision);
    expect(createdTask).not.toHaveProperty('_revision');
    bridge.handleYeaftScheduledTask({ op: 'update', sessionId: id, task: { enabled: false }, expectedRevision: createdTask.revision, requestId: 'edit-task', _requestClientId: 'browser-valid' });
    const edited = ctx.outboundSendQueue.find(item => item.msg.event?.requestId === 'edit-task').msg;
    expect(edited).toMatchObject({ _requestClientId: 'browser-valid', event: { ok: true, session: { config, task: { enabled: false, revision: read(id).task._revision } } } });
    const snapshots = ctx.outboundSendQueue.filter(item => item.msg.event?.type === 'session_list_updated');
    expect(snapshots.at(-1).msg.event.sessions.find(row => row.id === id).config).toEqual(config);
    for (const expectedRevision of [createdTask.revision, undefined, 1]) {
      bridge.handleYeaftScheduledTask({ op: 'update', sessionId: id, task: { enabled: true }, expectedRevision, requestId: 'conflict-task', _requestClientId: 'browser-stale' });
      expect(ctx.outboundSendQueue.at(-1).msg).toMatchObject({ _requestClientId: 'browser-stale', event: { ok: false, error: { code: 'task_conflict', message: expect.any(String) } } });
      expect(read(id).task.enabled).toBe(false);
    }
    bridge.handleYeaftCreateSession({ requestId: 'ordinary', _requestClientId: 'browser-chat', payload: { name: 'Chat' } });
    const ordinary = ctx.outboundSendQueue.find(item => item.msg.event?.requestId === 'ordinary').msg;
    expect(ordinary.event).toMatchObject({ op: 'create', ok: true });
    expect(ordinary).not.toHaveProperty('_requestClientId');
    bridge.handleYeaftScheduledTask({ op: 'update', sessionId: ordinary.event.session.id, task: task(), expectedRevision: createdTask.revision, requestId: 'ordinary-edit' });
    expect(ctx.outboundSendQueue.at(-1).msg.event).toMatchObject({ ok: false, error: { message: 'Session has no task' } });
  } finally {
    bridge.stopYeaftScheduledTasks();
    Object.assign(ctx, previous);
    const { closeConversationHistoryIndexes } = await import('../../../agent/yeaft/conversation/history-index.js');
    await closeConversationHistoryIndexes();
  }
});
