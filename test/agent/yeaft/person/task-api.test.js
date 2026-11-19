import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../../agent/yeaft/person/provider.js', async importOriginal => ({
  ...await importOriginal(), createPersonProvider: vi.fn(() => { throw new Error('Provider must not initialize for task APIs'); }),
}));
import { createPersonTaskHost } from '../../../../agent/yeaft/person/task-host.js';

import { _resetAgentRegistry } from '../../../../agent/yeaft/tools/agent.js';
import { _resetNotifications } from '../../../../agent/yeaft/sub-agent/notifications.js';

let root, services, hosts;
const config = { model: 'test/model', primaryModel: 'test/model', maxOutputTokens: 1024, language: 'en', _readOnly: true };
const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

const request = (host, op, payload = {}, scope = {}) => host.request({ ...host.scope, ...scope, op, payload });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'person-task-api-')); services = []; hosts = [];
  vi.clearAllMocks(); _resetAgentRegistry(); _resetNotifications();
});
afterEach(async () => {
  for (const service of services) await service.close();
  for (const host of hosts) await host.close();
  _resetAgentRegistry(); _resetNotifications();
  rmSync(root, { recursive: true, force: true });
});

function host(options = {}) {
  const value = createPersonTaskHost({ yeaftDir: root, ownerId: 'alice', personId: 'person', namespace: 'default', config,
    workDir: root, cancelEscalationMs: 20, ...options });
  hosts.push(value); return value;
}

// Tests intentionally provide no usable Person model/provider configuration.
describe('Digital Person owner-scoped task API', () => {
  it('isolates owner, Person, namespace and instance in every read/control operation', async () => {
    const h = host(), ctx = await h.attach();
    const task = ctx.taskManager.startShellTask({ command: command('setInterval(()=>{},1000)'), cwd: root });
    for (const options of [{ ownerId: 'bob' }, { personId: 'other' }, { namespace: 'other' }, { yeaftDir: join(root, 'other-instance') }]) {
      const foreign = host(options);
      expect((await request(foreign, 'tasks')).tasks).toEqual([]);
      for (const op of ['task_log', 'task_cancel']) await expect(request(foreign, op, { taskId: task.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(request(foreign, 'agent_close', { agentId: 'agent-foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    for (const override of [{ ownerId: 'bob' }, { personId: 'other' }, { namespace: 'other' }]) {
      for (const op of ['tasks', 'task_log', 'task_cancel', 'agent_close']) {
        await expect(request(h, op, op === 'tasks' ? {} : op === 'agent_close' ? { agentId: 'child' } : { taskId: task.id }, override)).rejects.toMatchObject({ code: 'TASK_SCOPE_DENIED' });
      }
    }
    expect(h.taskManager.getTask(h.sessionId, task.id).status).toBe('running');
  });

});
