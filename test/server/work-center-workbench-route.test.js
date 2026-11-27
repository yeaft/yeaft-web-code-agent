import { beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../server/context.js';
import {
  __testResetWorkItemWorkspaces,
  rememberWorkItemWorkspace,
} from '../../server/work-center-workspace-cache.js';
import { currentWorkbenchWorkspaceGeneration, resolveWorkbenchRequest } from '../../server/workbench-route.js';

const capabilities = [
  'workbench_session_routes',
  'workbench_request_correlation',
  'workbench_terminal_cleanup_fence',
  'work_center_workbench',
];

beforeEach(() => {
  agents.clear();
  __testResetWorkItemWorkspaces();
  agents.set('agent-1', { capabilities: [...capabilities] });
  rememberWorkItemWorkspace('user-1', 'agent-1', {
    id: 'work-1', workbench: { workDir: '/workspace/repo' },
  });
});

describe('Retired Work Center Workbench route', () => {
  it('rejects legacy routes even for the original owner and terminal cleanup', () => {
    const route = { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' };
    const client = { userId: 'user-1', role: 'pro', workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1 };
    const message = { agentId: 'agent-1', workbenchRoute: route };
    expect(resolveWorkbenchRequest(client, message, 'agent-1')).toBeNull();
    expect(resolveWorkbenchRequest(client, message, 'agent-1', { allowMissingSession: true })).toBeNull();
    expect(currentWorkbenchWorkspaceGeneration({ ...client, route })).toBeNull();
  });
});
