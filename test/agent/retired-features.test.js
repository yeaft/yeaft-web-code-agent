import { expect, it, vi } from 'vitest';
import { handleMessage } from '../../agent/connection/message-router.js';
import { createFullRegistry } from '../../agent/yeaft/tools/index.js';
import { handleBrowserRuntimeMessage } from '../../agent/browser-runtime/messages.js';
import { handleReadFile } from '../../agent/workbench.js';
import { handleTerminalClose } from '../../agent/terminal.js';
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

vi.mock('../../agent/workbench.js', async importOriginal => ({ ...await importOriginal(), handleReadFile: vi.fn() }));
vi.mock('../../agent/terminal.js', async importOriginal => ({ ...await importOriginal(), handleTerminalClose: vi.fn() }));

it('refuses WorkItem-scoped file and browser requests while leaving Session Files and terminal cleanup intact', async () => {
  const file = { type: 'read_file', filePath: '/repo/file', workbenchRoute: { runtimeProvider: 'work-center' } };
  await handleMessage(file);
  await handleMessage({ ...file, workbenchRoute: null, workbenchRouteKey: 'work-center:agent:old-item' });
  expect(handleReadFile).not.toHaveBeenCalled();
  const sessionFile = { ...file, workbenchRoute: { runtimeProvider: 'yeaft' } };
  await handleMessage(sessionFile);
  expect(handleReadFile).toHaveBeenCalledExactlyOnceWith(sessionFile);
  const cleanup = { type: 'terminal_close', workbenchRouteKey: 'work-center:agent:old-item' };
  await handleMessage(cleanup);
  expect(handleTerminalClose).toHaveBeenCalledExactlyOnceWith(cleanup);
  const runtime = { createSession: vi.fn() };
  const send = vi.fn();
  const msg = { type: 'browser_session_create', requestId: 'browser-create', sourceRef: { kind: 'work-item' } };
  await handleBrowserRuntimeMessage(msg, { runtime, send });
  expect(runtime.createSession).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_session_error', requestId: msg.requestId, code: 'feature_disabled' }));
});
