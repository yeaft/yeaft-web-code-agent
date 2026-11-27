import { afterEach, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, webClients } from '../../server/context.js';
import { handleWebConnection } from '../../server/ws-client.js';
import { createMockAgent, MockWebSocket } from '../helpers/mockWs.js';

const originalSkipAuth = CONFIG.skipAuth;
afterEach(() => {
  for (const client of webClients.values()) client.ws.close(1000);
  agents.clear();
  CONFIG.skipAuth = originalSkipAuth;
  vi.useRealTimers();
});

it('hides legacy capabilities and rejects stale browser requests without reaching the Agent', async () => {
  vi.useFakeTimers();
  CONFIG.skipAuth = true;
  const retired = ['digital_person', 'work_center', 'work_center_feature_settings', 'work_center_message_v2', 'work_center_workbench', 'work_item_attachments'];
  const active = ['scheduled_tasks', 'workbench_session_routes', 'creations'];
  const agent = createMockAgent({ capabilities: [...retired, ...active] });
  agents.set('legacy-agent', agent);
  const web = new MockWebSocket();
  handleWebConnection(web, new URL('ws://localhost/'));
  web.simulateMessage({ type: 'client_hello', plaintextOk: true, workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1 });
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
  expect(agent.ws.getSentMessages()).toEqual([]);
});
