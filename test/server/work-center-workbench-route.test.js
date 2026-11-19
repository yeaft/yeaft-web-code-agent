import { beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../server/context.js';
import {
  __testResetWorkItemWorkspaces,
  rememberWorkItemWorkspace,
} from '../../server/work-center-workspace-cache.js';
import { resolveWorkbenchRequest } from '../../server/workbench-route.js';

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

describe('Work Center Workbench route', () => {
  it('does not let a second user reuse cached WorkItem ownership', () => {
    const route = { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' };
    expect(resolveWorkbenchRequest(
      { userId: 'user-2', role: 'pro', workbenchRouteProtocol: 1, workCenterWorkbenchProtocol: 1 },
      { agentId: 'agent-1', workbenchRoute: route },
      'agent-1',
    )).toBeNull();
  });
});
