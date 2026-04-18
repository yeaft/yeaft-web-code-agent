/**
 * Crew — built-in role actions (task-330a §B)
 *
 * These two actions replace the "PM 给自己发闭环消息" anti-pattern that
 * task-330a §A now rejects at the routing layer:
 *
 *   • taskClose(session, { taskId, summary, fromRole })
 *       — directly mark the task complete on the kanban + broadcast a
 *         status card via sendCrewMessage. No ROUTE round-trip.
 *
 *   • roleStandby(session, { role, reason, fromRole })
 *       — flip a role's runtime state to 'standby' and broadcast.
 *         Persistence to .crew/context/role-states.json is a 330d
 *         concern — we only define the in-memory contract here.
 *
 * Both functions are pure server-side helpers. They do NOT consume a
 * routing turn (no session.round++, no dispatchToRole). Callers that
 * choose to expose them as Claude tools (via canCallTool / mcp) must
 * wire that separately — task-330a defines the contract; tool-binding
 * lands in 330d alongside the role-state persistence layer.
 *
 * Red lines (per PM dispatch):
 *   - Do not mutate routing protocol shape (.routes / displayBody).
 *   - Do not break task-319/328 (parser tests stay green).
 *   - Old session replay must keep working — we only add new keys to
 *     session.roleStates[role], never remove.
 */

import { sendCrewMessage, sendStatusUpdate } from './ui-messages.js';
import { updateKanban, appendChangelog, updateFeatureIndex, isValidTaskId } from './task-files.js';

/** Valid standby reasons — extend with care; consumers may grep for these. */
export const STANDBY_REASONS = Object.freeze([
  'task_closed', 'awaiting_input', 'manual', 'idle', 'paused',
]);

/**
 * Mark a task as complete on the kanban + broadcast a status card.
 *
 * Mirrors the side-effects that role-output.js performs when it detects a
 * completed TASKS block, so the two paths converge on the same kanban
 * state regardless of which one fires.
 *
 * @param {object} session
 * @param {{ taskId: string, summary?: string, fromRole?: string }} params
 * @returns {Promise<{ ok: boolean, taskId: string, reason?: string }>}
 */
export async function taskClose(session, { taskId, summary, fromRole }) {
  if (!session) {
    return { ok: false, taskId: taskId || null, reason: 'no_session' };
  }
  if (!taskId || !isValidTaskId(taskId)) {
    return { ok: false, taskId: taskId || null, reason: 'invalid_task_id' };
  }

  // Mark in the in-memory completion set so future kanban rebuilds keep it.
  if (!session._completedTaskIds) session._completedTaskIds = new Set();
  const wasAlreadyCompleted = session._completedTaskIds.has(taskId);
  session._completedTaskIds.add(taskId);

  const feature = session.features?.get(taskId);
  const taskTitle = feature?.taskTitle || taskId;
  const cleanSummary = (summary && String(summary).trim()) || '已完成';

  // Persist to the kanban file (best-effort; warns on failure).
  try {
    await updateKanban(session, { taskId, completed: true, summary: cleanSummary });
  } catch (e) {
    console.warn(`[Crew] taskClose: updateKanban failed for ${taskId}:`, e.message);
  }

  // Append to features index + changelog only on first close (idempotent).
  if (!wasAlreadyCompleted) {
    updateFeatureIndex(session)
      .catch(e => console.warn('[Crew] taskClose: updateFeatureIndex failed:', e.message));
    appendChangelog(session, taskId, taskTitle)
      .catch(e => console.warn(`[Crew] taskClose: appendChangelog failed for ${taskId}:`, e.message));
  }

  // Broadcast status card so the UI reflects the close immediately.
  try {
    sendCrewMessage({
      type: 'crew_task_closed',
      sessionId: session.id,
      taskId,
      taskTitle,
      summary: cleanSummary,
      fromRole: fromRole || null,
      timestamp: Date.now(),
    });
    sendStatusUpdate(session);
  } catch (e) {
    console.warn(`[Crew] taskClose: broadcast failed for ${taskId}:`, e.message);
  }

  return { ok: true, taskId };
}

/**
 * Flip a role into 'standby' (in-memory) and broadcast.
 *
 * 330a defines the contract; 330d wires the .crew/context/role-states.json
 * persistence. We DO mutate `session.roleStates[role].standby` here so the
 * UI / status pipeline can reflect the change immediately, and 330d can
 * snapshot it on the next debounced save.
 *
 * @param {object} session
 * @param {{ role: string, reason?: string, fromRole?: string }} params
 * @returns {{ ok: boolean, role: string, reason?: string }}
 */
export function roleStandby(session, { role, reason, fromRole }) {
  if (!session) {
    return { ok: false, role: role || null, reason: 'no_session' };
  }
  if (!role || typeof role !== 'string') {
    return { ok: false, role: role || null, reason: 'invalid_role' };
  }
  if (!session.roles || !session.roles.has(role)) {
    return { ok: false, role, reason: 'unknown_role' };
  }

  const normalizedReason = reason && STANDBY_REASONS.includes(reason)
    ? reason
    : 'manual';

  // Ensure the roleState bucket exists (cold-start safe).
  let roleState = session.roleStates?.get?.(role);
  if (!roleState) {
    roleState = {};
    session.roleStates?.set?.(role, roleState);
  }
  // New keys only — never delete legacy fields (replay safety).
  roleState.standby = {
    reason: normalizedReason,
    since: Date.now(),
    setBy: fromRole || null,
  };

  try {
    sendCrewMessage({
      type: 'crew_role_standby',
      sessionId: session.id,
      role,
      reason: normalizedReason,
      fromRole: fromRole || null,
      timestamp: Date.now(),
    });
    sendStatusUpdate(session);
  } catch (e) {
    console.warn(`[Crew] roleStandby: broadcast failed for ${role}:`, e.message);
  }

  return { ok: true, role, reason: normalizedReason };
}
