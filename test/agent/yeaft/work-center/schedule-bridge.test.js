import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../agent/yeaft/web-bridge.js', () => ({
  ensureSessionLoaded: vi.fn(async () => ({ config: {} })),
  resetYeaftSession: vi.fn(async () => {}),
}));
vi.mock('../../../../agent/connection/buffer.js', () => ({ sendToServer: vi.fn() }));
import ctx from '../../../../agent/context.js';
import { sendToServer } from '../../../../agent/connection/buffer.js';
import { __testSetWorkCenterService, handleWorkCenterRequest } from '../../../../agent/yeaft/work-center/bridge.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkCenterEvent, projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';

let root;
let service;
const originalConfig = ctx.CONFIG;
afterEach(async () => {
  __testSetWorkCenterService(null);
  await service?.shutdown();
  service = null;
  ctx.CONFIG = originalConfig;
  if (root) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.useRealTimers();
});
function setup() {
  root = mkdtempSync(join(tmpdir(), 'schedule-bridge-'));
  ctx.CONFIG = { ...originalConfig, yeaftDir: root, workDir: root };
  service = new WorkCenterService({ yeaftDir: root, runner: null, coordinator: null });
  __testSetWorkCenterService(service);
}
async function request(op, payload = {}) {
  await handleWorkCenterRequest({ requestId: op, op, payload });
  const frame = sendToServer.mock.calls.at(-1)[0];
  expect(frame).toMatchObject({ type: 'work_center_response', requestId: op, op, ok: true });
  return frame.data;
}

describe('real browser schedule bridge contract', () => {
  it('advertises repetition on settings, updates, refresh and direct runtime without starting an engine', async () => {
    setup();
    let settings;
    for (const op of ['get_settings', 'update_settings', 'refresh_runtime']) {
      const data = await request(op, op === 'update_settings' ? { settings: { ...settings, startImmediately: false } } : {});
      expect(data.runtime.recurringSchedules).toBe(true);
      settings = data.settings;
    }
    expect((await service.runtimeInfo()).recurringSchedules).toBe(true);
  });

  it('projects safe identified failures from raw service events and keeps retry state across restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2090-09-18T08:00:00Z'));
    setup();
    const scheduledFor = Date.parse('2090-09-18T09:00:00Z');
    const plan = await request('create', { goal: 'Daily report', workDir: root, scheduledFor,
      recurrence: { frequency: 'daily', timeZone: 'UTC', time: '09:00' } });
    const secret = '/private/attachments/input.txt Bearer credential-secret';
    const raw = [];
    const frames = [];
    const connect = () => {
      // Same raw-service -> production projection boundary used by bridge.js.
      service.onEvent = event => {
        raw.push(event);
        frames.push({ type: 'work_center_event', event: projectWorkCenterEvent(event) });
      };
      return vi.spyOn(service.controller, 'startScheduled').mockImplementation(() => { throw new Error(secret); });
    };
    connect();
    vi.setSystemTime(scheduledFor);
    service.start();
    const failure = frames.find(frame => frame.event.type === 'work_item.schedule_failed').event;
    const lastError = failure.workItem.schedule.lastError;
    expect(lastError).toEqual({ code: 'schedule_dispatch_failed', at: scheduledFor,
      message: 'Scheduled execution could not start. The plan will retry automatically; check its configuration and attachments.' });
    expect(failure.workItem).toMatchObject({ id: plan.id, revision: plan.revision + 1, status: 'draft' });
    expect(raw.find(event => event.type === failure.type).workItem.id).toBe(plan.id);
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(lastError.message.length).toBeLessThan(256);
    expect((await request('get', { id: plan.id })).schedule.lastError).toEqual(lastError);
    expect((await request('list')).items.find(item => item.id === plan.id).schedule.lastError).toEqual(lastError);
    const contaminated = service.store.getWorkItemDetail(plan.id);
    contaminated.schedule.lastError = { ...lastError, message: secret, stack: secret, path: secret };
    expect(projectWorkItemDetail(contaminated).schedule.lastError).toEqual(lastError);
    expect(projectWorkCenterEvent({ type: failure.type, workItem: contaminated }).workItem.schedule.lastError).toEqual(lastError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames.filter(frame => frame.event.type === failure.type)).toHaveLength(1);
    expect(service.store.getWorkItemDetail(plan.id).events.filter(event => event.type === failure.type)).toHaveLength(1);
    await service.shutdown();
    service = new WorkCenterService({ yeaftDir: root, runner: null, coordinator: null });
    __testSetWorkCenterService(service);
    expect((await request('get', { id: plan.id })).schedule.lastError).toEqual(lastError);
    const retry = connect();
    service.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(retry.mock.calls.length).toBeGreaterThan(1);
    expect(frames.filter(frame => frame.event.type === failure.type)).toHaveLength(1);
    retry.mockRestore();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await request('get', { id: plan.id })).schedule).toMatchObject({ lastError: null, runCount: 1 });
    expect(frames.find(frame => frame.event.type === 'work_item.schedule_triggered').event.workItem)
      .toMatchObject({ id: plan.id, schedule: { lastError: null } });
  });

  it('preserves once/repeated create fields through the whitelist and projects revisioned schedule updates', async () => {
    setup();
    const scheduledFor = Date.parse('2090-09-18T09:00:00Z');
    const recurrence = { frequency: 'daily', timeZone: 'UTC', time: '09:00', maxRuns: 2 };
    for (const repeat of [null, recurrence]) {
      const item = await request('create', { goal: 'Report project health', workDir: root,
        start: true, scheduledFor, recurrence: repeat, scheduleEnabled: false,
        origin: { sessionId: 'untrusted' }, sourceSessionId: 'untrusted', attachments: [{ path: '/untrusted' }] });
      expect(item).toMatchObject({ status: 'draft', schedule: { status: 'paused', scheduledFor, runCount: 0 } });
      expect(item.schedule.recurrence).toEqual(repeat ? { ...repeat, endsAt: null } : null);
      expect(item.origin?.sessionId).not.toBe('untrusted');
      const resumed = await request('update_schedule', { id: item.id, schedule: { enabled: true, revision: item.revision } });
      expect(resumed).toMatchObject({ id: item.id, schedule: { status: 'scheduled' } });
      expect(resumed).not.toHaveProperty('workflowSnapshot');
      const cancelled = await request('cancel', { id: item.id });
      expect(cancelled).toMatchObject({ status: 'cancelled', schedule: { status: 'cancelled' } });
      const board = await service.handle('list', {});
      expect(board.items.find(row => row.id === item.id).schedule.status).toBe('cancelled');
    }
  });
});
