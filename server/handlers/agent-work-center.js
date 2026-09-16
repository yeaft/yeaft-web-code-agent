import { updateWorkItemWorkspaces } from '../work-center-workspace-cache.js';
import { forwardAgentEvent } from '../ws-utils.js';
import { deliverWorkCenterResponse } from './client-work-center.js';

const WORK_CENTER_TYPES = new Set([
  'work_center_response',
  'work_center_event',
]);

/**
 * Forward Agent-local Work Center responses and projection events.
 *
 * Responses use a server-owned request map. Events have no requester and are
 * therefore projected only through the authenticated Agent owner boundary.
 */
export async function handleAgentWorkCenter(agentId, msg) {
  if (!WORK_CENTER_TYPES.has(msg?.type)) return false;

  if (msg.type === 'work_center_response') {
    await deliverWorkCenterResponse(agentId, msg);
    return true;
  }

  const { agentId: _untrustedAgentId, _requestUserId, ...payload } = msg;
  updateWorkItemWorkspaces(agentId, payload.event);
  const outgoing = { ...payload, agentId };
  await forwardAgentEvent(agentId, outgoing);
  return true;
}
