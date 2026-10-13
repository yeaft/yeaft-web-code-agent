import { beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../server/context.js';
import {
  __testResetWorkItemWorkspaces,
  rememberWorkItemWorkspace,
  updateWorkItemWorkspaces,
  getWorkItemWorkspace,
} from '../../server/work-center-workspace-cache.js';
import { resolveWorkbenchRequest } from '../../server/workbench-route.js';

const capabilities = [
  'workbench_session_routes',
  'workbench_request_correlation',
  'workbench_terminal_cleanup_fence',
  'work_center_workbench',
];

function request(overrides = {}) {
  const route = {
    runtimeProvider: 'work-center',
    agentId: 'agent-1',
    workItemId: 'work-1',
  };
  return resolveWorkbenchRequest(
    { userId: 'user-1', role: 'pro', workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1 },
    {
      agentId: 'agent-1',
      workDir: '/forged',
      conversationId: '_workbench:yeaft:agent-1:chat-session',
      workbenchRoute: route,
      ...overrides,
    },
    'agent-1',
  );
}

beforeEach(() => {
  agents.clear();
  __testResetWorkItemWorkspaces();
  agents.set('agent-1', { capabilities: [...capabilities] });
  rememberWorkItemWorkspace('user-1', 'agent-1', {
    id: 'work-1', workbench: { workDir: '/workspace/repo' },
  });
});

describe('Work Center Workbench route', () => {
  it('binds the route and cwd to the owned WorkItem projection', () => {
    const resolved = request();
    expect(resolved).toMatchObject({
      route: { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' },
      routeKey: 'work-center:agent-1:work-1',
      conversationId: '_workbench:work-center:agent-1:work-1',
      workDir: '/workspace/repo',
      requestedWorkDir: '/workspace/repo',
    });
    expect(resolved.route).not.toHaveProperty('sessionId');
  });

  it('rejects a different owner, unknown WorkItem, and old Agent', () => {
    expect(request({ workbenchRoute: {
      runtimeProvider: 'work-center', agentId: 'agent-2', workItemId: 'work-1',
    } })).toBeNull();
    expect(request({ workbenchRoute: {
      runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'unknown',
    } })).toBeNull();
    agents.get('agent-1').capabilities = ['workbench_session_routes'];
    expect(request()).toBeNull();
  });

  it('does not let a second user reuse cached WorkItem ownership', () => {
    const route = { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' };
    expect(resolveWorkbenchRequest(
      { userId: 'user-2', role: 'pro', workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1 },
      { agentId: 'agent-1', workbenchRoute: route },
      'agent-1',
    )).toBeNull();
  });
});

describe('WorkItem workspace routing lifecycle', () => {
  it('does not transfer grants across reconnect or create grants from broadcasts', () => {
    updateWorkItemWorkspaces('agent-1', {
      type: 'work_item.created', workItem: { id: 'unseen', workbench: { workDir: '/workspace/repo' } },
    });
    expect(getWorkItemWorkspace('user-1', 'agent-1', 'unseen')).toBeNull();
    agents.set('agent-1', { capabilities: [...capabilities] });
    expect(request()).toBeNull();
  });
});
