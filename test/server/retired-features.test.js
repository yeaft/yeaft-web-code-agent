import { afterEach, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, webClients } from '../../server/context.js';
import { handleWebConnection } from '../../server/ws-client.js';
import { createMockAgent, MockWebSocket } from '../helpers/mockWs.js';

const originalSkipAuth = CONFIG.skipAuth;
const originalBrowserRuntimeEnabled = CONFIG.browserRuntime.enabled;
afterEach(() => {
  for (const client of webClients.values()) client.ws.close(1000);
  agents.clear();
  CONFIG.skipAuth = originalSkipAuth;
  CONFIG.browserRuntime.enabled = originalBrowserRuntimeEnabled;
  vi.useRealTimers();
});

it('hides legacy capabilities and rejects stale browser requests without reaching the Agent', async () => {
  vi.useFakeTimers();
  CONFIG.skipAuth = true;
  const retired = ['digital_person', 'work_center', 'work_center_feature_settings', 'work_center_message_v2', 'work_center_workbench', 'work_item_attachments'];
  const active = ['scheduled_tasks', 'workbench_session_routes', 'creations', 'session_auto_route',
    'browser_runtime', 'browser_webrtc', 'browser_capture_tab'];
  CONFIG.browserRuntime.enabled = true;
  const agent = createMockAgent({ capabilities: [...retired, ...active] });
  agents.set('legacy-agent', agent);
  const web = new MockWebSocket();
  handleWebConnection(web, new URL('ws://localhost/'));
  web.simulateMessage({ type: 'client_hello', plaintextOk: true, workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1, browserRuntimeProtocol: 1 });
  await vi.advanceTimersByTimeAsync(100);
  expect(web.getSentMessages().find(msg => msg.type === 'client_hello_ack')).toMatchObject({ workbenchRouteProtocol: 1 });
  expect(web.getSentMessages().find(msg => msg.type === 'auth_result')).not.toHaveProperty('workCenterWorkbenchProtocol');
  expect(web.getSentMessages().find(msg => msg.type === 'agent_list').agents[0].capabilities).toEqual(active);
  for (const [type, responseType, expected, op] of [
    ['person_request', 'person_response', { ok: false, errorCode: 'feature_disabled' }, 'open'],
    ['work_center_request', 'work_center_response', { ok: false, errorCode: 'feature_disabled' }, 'create'],
    ['get_work_center_feature_settings', 'work_center_feature_settings', { enabled: false, effective: false }],
    ['update_work_center_feature_settings', 'work_center_feature_settings_updated', { effective: false, persisted: false }],
  ]) {
    web.simulateMessage({ type, agentId: 'legacy-agent', requestId: type, op, settings: { enabled: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(web.getLastMessage()).toMatchObject({ type: responseType, requestId: type, agentId: 'legacy-agent', ...expected });
  }
  for (const type of ['yeaft_session_send', 'yeaft_auto_route_send']) {
    web.simulateMessage({ type, agentId: 'legacy-agent', sessionId: 'session_regular', requestId: type, text: 'Hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(web.getLastMessage()).toMatchObject({ type: 'error', code: 'legacy_work_center_active', requestId: type });
  }
  web.simulateMessage({ type: 'browser_session_create', agentId: 'legacy-agent', requestId: 'legacy-browser', sourceRef: { kind: 'work-item' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(web.getLastMessage()).toMatchObject({ type: 'browser_session_error', code: 'feature_disabled', requestId: 'legacy-browser' });
  expect(agent.ws.getSentMessages()).toEqual([]);

  agent.capabilities = active;
  const message = { type: 'yeaft_session_send', agentId: 'legacy-agent', sessionId: 'session_regular', requestId: 'current', text: 'Hello' };
  web.simulateMessage(message);
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.ws.getLastMessage()).toMatchObject({ type: message.type, sessionId: message.sessionId, requestId: message.requestId, text: message.text });
});
