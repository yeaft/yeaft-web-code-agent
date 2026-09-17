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
