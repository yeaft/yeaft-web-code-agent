import {
  workbenchConversationId,
  workbenchRouteKey,
  workbenchWorkspaceGeneration,
} from './workbench-route.js';

export const WORK_CENTER_WORKBENCH_CAPABILITIES = Object.freeze([
  'workbench_session_routes',
  'workbench_request_correlation',
  'workbench_terminal_cleanup_fence',
  'work_center_workbench',
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function normalizePath(value) {
  const raw = clean(value).replace(/\\/g, '/');
  const drive = raw.match(/^[A-Za-z]:/)?.[0] || '';
  const absolute = raw.startsWith('/') || Boolean(drive);
  const parts = raw.slice(drive.length).split('/');
  const resolved = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return '';
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return `${drive}${absolute && !drive ? '/' : drive ? '/' : ''}${resolved.join('/')}`;
}

export function workCenterOutputTarget(output, workDir) {
  const ref = clean(output?.ref);
  if (!ref) return null;
  const url = httpUrl(ref);
  if (output?.kind === 'link' || output?.kind === 'pr' || url) {
    return url ? { type: 'url', url } : null;
  }
  if (output?.kind !== 'file') return null;

  if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(clean(workDir))) return null;
  const root = normalizePath(workDir);
  const absoluteRef = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(ref);
  const filePath = normalizePath(absoluteRef ? ref : `${root}/${ref}`);
  if (!root || !filePath) return null;
  const comparableRoot = /^[A-Za-z]:/.test(root) ? root.toLowerCase() : root;
  const comparablePath = /^[A-Za-z]:/.test(filePath) ? filePath.toLowerCase() : filePath;
  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (comparablePath !== comparableRoot && !comparablePath.startsWith(rootPrefix)) return null;
  return { type: 'file', filePath };
}

/** Build an owner-scoped Workbench context without reading or changing chat Session state. */
export function createWorkCenterWorkbenchContext({
  agentId,
  workItem,
  routeProtocolSupported = false,
  hasAgentCapability = () => false,
} = {}) {
  const workItemId = clean(workItem?.id);
  const workDir = clean(workItem?.workbench?.workDir);
  const ownerRoute = { runtimeProvider: 'work-center', agentId: clean(agentId), workItemId };
  const routeKey = workbenchRouteKey(ownerRoute);
  const missingCapabilities = WORK_CENTER_WORKBENCH_CAPABILITIES
    .filter(capability => !hasAgentCapability(ownerRoute.agentId, capability));
  const available = routeProtocolSupported === true
    && Boolean(routeKey && workDir)
    && missingCapabilities.length === 0;
  const workspaceGeneration = available ? workbenchWorkspaceGeneration(routeKey, workDir) : '';

  return {
    available,
    browserAvailable: false,
    missingCapabilities,
    ownerRoute,
    ownerWorkDir: workDir,
    routeKey,
    workspaceGeneration,
    openOutput(output) {
      if (!available) return false;
      const target = workCenterOutputTarget(output, workDir);
      if (target?.type !== 'file') return false;
      window.dispatchEvent(new CustomEvent('open-file-in-explorer', {
        detail: {
          filePath: target.filePath,
          agentId: ownerRoute.agentId,
          conversationId: workbenchConversationId(routeKey),
          workbenchRoute: ownerRoute,
          workbenchRouteKey: routeKey,
          workspaceGeneration,
        },
      }));
      return true;
    },
  };
}
