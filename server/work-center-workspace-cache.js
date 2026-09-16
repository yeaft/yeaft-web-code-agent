import { agents } from './context.js';

// Ephemeral routing metadata, never a second WorkItem catalog. A fresh detail
// request repopulates it after reconnect/restart; old Agent connections expire.
const workspaces = new Map();
const MAX_WORKSPACES = 1000;

function clean(value, maxLength = 4096) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result && result.length <= maxLength ? result : '';
}

function key(userId, agentId, workItemId) {
  const parts = [userId, agentId, workItemId].map(value => clean(value, 300));
  return parts.every(Boolean) ? JSON.stringify(parts) : '';
}

/** Remember Agent-projected workspace metadata only after an owner-scoped request. */
export function rememberWorkItemWorkspace(userId, agentId, detail) {
  const cacheKey = key(userId, agentId, detail?.id);
  const workDir = clean(detail?.workbench?.workDir);
  if (!cacheKey) return false;
  workspaces.delete(cacheKey);
  if (!workDir || !agents.has(agentId)) return false;
  workspaces.set(cacheKey, { id: detail.id, agentId, agent: agents.get(agentId), workDir, isArchived: false });
  while (workspaces.size > MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value);
  return true;
}

export function getWorkItemWorkspace(userId, agentId, workItemId) {
  const cacheKey = key(userId, agentId, workItemId);
  const row = workspaces.get(cacheKey);
  if (!row || row.agent !== agents.get(agentId)) {
    workspaces.delete(cacheKey);
    return null;
  }
  return row;
}

export function forgetWorkItemWorkspace(userId, agentId, workItemId) {
  workspaces.delete(key(userId, agentId, workItemId));
}

/** Events may refresh existing owner grants, never create grants for new users. */
export function updateWorkItemWorkspaces(agentId, event) {
  const detail = event?.workItem;
  if (!detail?.id) return;
  for (const [cacheKey, row] of workspaces) {
    if (row.agentId !== agentId || row.id !== detail.id) continue;
    if (event.type === 'work_item.deleted' || row.agent !== agents.get(agentId)) {
      workspaces.delete(cacheKey);
    } else if (Object.hasOwn(detail, 'workbench')) {
      const workDir = clean(detail.workbench?.workDir);
      if (!workDir) workspaces.delete(cacheKey);
      else row.workDir = workDir;
    }
  }
}

export function __testResetWorkItemWorkspaces() {
  workspaces.clear();
}
