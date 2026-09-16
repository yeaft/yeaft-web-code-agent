import { beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../server/context.js';
import {
  __testResetWorkItemWorkspaces,
  rememberWorkItemWorkspace,
  updateWorkItemWorkspaces,
  getWorkItemWorkspace,
} from '../../server/work-center-workspace-cache.js';
import {
  resolveWorkbenchRequest,
  workbenchPathWithinWorkspace,
  workbenchRouteKey,
} from '../../server/workbench-route.js';

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

  it('uses WorkItem identity in route keys and confines lexical paths', () => {
    expect(workbenchRouteKey({
      runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1', sessionId: 'chat-1',
    })).toBe('work-center:agent-1:work-1');
    expect(workbenchPathWithinWorkspace('src/main.js', '/workspace/repo')).toBe(true);
    expect(workbenchPathWithinWorkspace('/workspace/repo/src/main.js', '/workspace/repo')).toBe(true);
    expect(workbenchPathWithinWorkspace('../secret', '/workspace/repo')).toBe(false);
    expect(workbenchPathWithinWorkspace('/workspace/other/file', '/workspace/repo')).toBe(false);
  });
});


describe('WorkItem workspace routing lifecycle', () => {
  it('fails closed for old Server negotiation and changes to the workspace', () => {
    expect(resolveWorkbenchRequest(
      { userId: 'user-1', workbenchRouteProtocol: 1 },
      { workbenchRoute: { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' } },
      'agent-1',
    )).toBeNull();
    const previous = request().workspaceGeneration;
    updateWorkItemWorkspaces('agent-1', {
      type: 'work_item.updated', workItem: { id: 'work-1', workbench: { workDir: '/workspace/next' } },
    });
    expect(request({ workbenchWorkspaceGeneration: previous })).toBeNull();
    expect(request().workDir).toBe('/workspace/next');
    updateWorkItemWorkspaces('agent-1', { type: 'work_item.deleted', workItem: { id: 'work-1' } });
    expect(request()).toBeNull();
  });

  it('does not transfer grants across reconnect or create grants from broadcasts', () => {
    updateWorkItemWorkspaces('agent-1', {
      type: 'work_item.created', workItem: { id: 'unseen', workbench: { workDir: '/workspace/repo' } },
    });
    expect(getWorkItemWorkspace('user-1', 'agent-1', 'unseen')).toBeNull();
    agents.set('agent-1', { capabilities: [...capabilities] });
    expect(request()).toBeNull();
  });

  it('revokes missing workspaces and bounds cached entries', () => {
    rememberWorkItemWorkspace('user-1', 'agent-1', { id: 'work-1', workbench: null });
    expect(request()).toBeNull();
    for (let index = 0; index <= 1000; index++) {
      rememberWorkItemWorkspace('user-1', 'agent-1', { id: `work-${index}`, workbench: { workDir: '/workspace' } });
    }
    expect(getWorkItemWorkspace('user-1', 'agent-1', 'work-0')).toBeNull();
    expect(getWorkItemWorkspace('user-1', 'agent-1', 'work-1000')).not.toBeNull();
  });

  it('uses the Agent path convention rather than the Server OS', () => {
    expect(workbenchPathWithinWorkspace('src/file.js', 'C:/repo')).toBe(true);
    expect(workbenchPathWithinWorkspace('C:/repo/src/file.js', 'C:/repo')).toBe(true);
    expect(workbenchPathWithinWorkspace('C:/other/file.js', 'C:/repo')).toBe(false);
    expect(workbenchPathWithinWorkspace('../secret', 'C:/repo')).toBe(false);
    expect(workbenchPathWithinWorkspace('/tmp/file', '/')).toBe(true);
    expect(workbenchPathWithinWorkspace('file.js', 'relative-root')).toBe(false);
  });
});
