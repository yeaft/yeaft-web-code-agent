// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  WORK_CENTER_WORKBENCH_CAPABILITIES,
  createWorkCenterWorkbenchContext,
  workCenterOutputTarget,
} from '../../web/utils/work-center-workbench.js';

function context(overrides = {}) {
  return createWorkCenterWorkbenchContext({
    agentId: 'agent-1',
    workItem: { id: 'work-1', workbench: { workDir: '/workspace/repo' } },
    routeProtocolSupported: true,
    hasAgentCapability: (_agentId, capability) => WORK_CENTER_WORKBENCH_CAPABILITIES.includes(capability),
    ...overrides,
  });
}

describe('Work Center Workbench context', () => {
  it('uses Agent and WorkItem ownership without a chat Session identity', () => {
    const value = context();
    expect(value.available).toBe(true);
    expect(value.ownerRoute).toEqual({
      runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1',
    });
    expect(value.ownerRoute).not.toHaveProperty('sessionId');
    expect(value.ownerWorkDir).toBe('/workspace/repo');
    expect(value.browserAvailable).toBe(false);
  });

  it('gates old clients and Agents before exposing Workbench', () => {
    expect(context({ routeProtocolSupported: false }).available).toBe(false);
    const value = context({ hasAgentCapability: () => false });
    expect(value.available).toBe(false);
    expect(value.missingCapabilities).toEqual(WORK_CENTER_WORKBENCH_CAPABILITIES);
  });

  it('opens only workspace-confined file outputs on the WorkItem route', () => {
    const listener = vi.fn();
    window.addEventListener('open-file-in-explorer', listener);
    const value = context();
    expect(value.openOutput({ kind: 'file', ref: 'dist/result.txt' })).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      filePath: '/workspace/repo/dist/result.txt',
      agentId: 'agent-1',
      workbenchRouteKey: 'work-center:agent-1:work-1',
      workbenchRoute: { runtimeProvider: 'work-center', agentId: 'agent-1', workItemId: 'work-1' },
    });
    expect(value.openOutput({ kind: 'file', ref: '../secret.txt' })).toBe(false);
    expect(value.openOutput({ kind: 'link', ref: 'https://example.test/result' })).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('open-file-in-explorer', listener);
  });
});

describe('Work Center output classification', () => {
  it('keeps URL and local file targets distinct', () => {
    expect(workCenterOutputTarget({ kind: 'link', ref: 'https://example.test/a' }, '/workspace/repo'))
      .toEqual({ type: 'url', url: 'https://example.test/a' });
    expect(workCenterOutputTarget({ kind: 'file', ref: 'https://example.test/a' }, '/workspace/repo'))
      .toEqual({ type: 'url', url: 'https://example.test/a' });
    expect(workCenterOutputTarget({ kind: 'file', ref: '/workspace/other/a.txt' }, '/workspace/repo'))
      .toBeNull();
    expect(workCenterOutputTarget({ kind: 'commit', ref: 'abc123' }, '/workspace/repo'))
      .toBeNull();
  });
});


it('resolves root and Windows workspaces, rejecting traversal and relative roots', () => {
  expect(workCenterOutputTarget({ kind: 'file', ref: 'tmp/result.md' }, '/'))
    .toEqual({ type: 'file', filePath: '/tmp/result.md' });
  expect(workCenterOutputTarget({ kind: 'file', ref: 'src/result.md' }, 'C:/repo'))
    .toEqual({ type: 'file', filePath: 'C:/repo/src/result.md' });
  expect(workCenterOutputTarget({ kind: 'file', ref: '../../secret' }, '/tmp/repo')).toBeNull();
  expect(workCenterOutputTarget({ kind: 'file', ref: 'result.md' }, 'relative')).toBeNull();
});
