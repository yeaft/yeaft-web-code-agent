import { expect, it, vi } from 'vitest';
import { handleMessage } from '../../agent/connection/message-router.js';
import { createFullRegistry } from '../../agent/yeaft/tools/index.js';
import { sendToServer } from '../../agent/connection/buffer.js';

vi.mock('../../agent/connection/buffer.js', () => ({ sendToServer: vi.fn(), flushMessageBuffer: vi.fn() }));

it('does not expose the WorkItem producer and rejects commands from a stale Server', async () => {
  const tools = createFullRegistry().getToolDefs().map(tool => tool.name);
  expect(tools).not.toContain('CreateWorkItem');
  expect(tools).toEqual(expect.arrayContaining(['FileRead', 'RouteForward', 'SpawnAgent']));
  for (const [type, responseType, expected, op] of [
    ['person_request', 'person_response', { ok: false, errorCode: 'feature_disabled' }, 'open'],
    ['work_center_request', 'work_center_response', { ok: false, errorCode: 'feature_disabled' }, 'create'],
    ['get_work_center_feature_settings', 'work_center_feature_settings', { enabled: false, effective: false }],
    ['update_work_center_feature_settings', 'work_center_feature_settings_updated', { effective: false, persisted: false }],
  ]) {
    await handleMessage({ type, requestId: type, op, settings: { enabled: true } });
    expect(sendToServer).toHaveBeenLastCalledWith(expect.objectContaining({ type: responseType, requestId: type, ...expected }));
  }
});
