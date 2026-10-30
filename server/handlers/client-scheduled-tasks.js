import { agents } from '../context.js';
import { yeaftProjectDb, yeaftSessionDb } from '../database.js';
import { forwardToAgent, resolveAgentAccessError, sendToWebClient } from '../ws-utils.js';

const CREATE_TYPES = new Set(['yeaft_create_session', 'yeaft_create_group', 'unify_create_group', 'unify_create_session']);
const TASK_TYPES = new Set(['yeaft_scheduled_task', 'unify_scheduled_task']);
const CREATE_FIELDS = ['name', 'roster', 'defaultVpId', 'workDir', 'config'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Only user-authored configuration crosses this boundary. Runtime state is Agent-owned. */
function projectTaskInput(source) {
  if (!isRecord(source)) throw new Error('task must be an object');
  if (Buffer.byteLength(JSON.stringify(source)) > 96 * 1024) throw new Error('Task input is too large');
  const task = {};
  if (Object.hasOwn(source, 'prompt')) {
    if (typeof source.prompt !== 'string' || !source.prompt.trim() || source.prompt.length > 65536) {
      throw new Error('Task prompt must be non-empty text of at most 65536 characters');
    }
    task.prompt = source.prompt;
  }
  for (const key of ['enabled', 'notify']) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
    task[key] = source[key];
  }
  if (Object.hasOwn(source, 'trigger')) {
    const trigger = source.trigger;
    if (!isRecord(trigger) || !['manual', 'schedule'].includes(trigger.type)) throw new Error('Invalid task trigger');
    task.trigger = { type: trigger.type };
    if (trigger.type === 'schedule') {
      if (!Number.isSafeInteger(trigger.scheduledFor) || trigger.scheduledFor < 0) throw new Error('Invalid scheduledFor');
      task.trigger.scheduledFor = trigger.scheduledFor;
      if (Object.hasOwn(trigger, 'recurrence')) {
        if (trigger.recurrence !== null && !isRecord(trigger.recurrence)) throw new Error('Invalid recurrence');
        // Calendar-rule validation belongs to the Agent; never forward shared input objects.
        const recurrence = JSON.stringify(trigger.recurrence);
        if (recurrence.length > 4096) throw new Error('Recurrence is too large');
        task.trigger.recurrence = JSON.parse(recurrence);
      }
    }
  }
  if (!Object.keys(task).length) throw new Error('No editable task fields supplied');
  return task;
}

/** Task creation shares Session CRUD, but must never fall through to an older Agent. */
export async function handleClientScheduledTasks(clientId, client, msg) {
  const isCreate = CREATE_TYPES.has(msg.type) && isRecord(msg.payload) && Object.hasOwn(msg.payload, 'task');
  if (!isCreate && !TASK_TYPES.has(msg.type)) return false;
  const agentId = msg.agentId;
  const sessionId = isCreate ? null : msg.sessionId;
  const requestId = validIdentity(msg.requestId) ? msg.requestId : null;
  const op = isCreate ? 'create' : (msg.op === 'update' ? 'update_task' : 'run_task');
  const reject = async (code, message) => {
    await sendToWebClient(client, {
      type: 'yeaft_output', agentId: typeof agentId === 'string' ? agentId : null,
      ...(sessionId != null ? { sessionId } : {}), requestId,
      event: { type: 'session_crud_result', op, requestId, ok: false, error: { code, message } },
    });
    return true;
  };
  // No currentAgent fallback: a task action must name its full durable identity.
  if (!validIdentity(agentId) || (!isCreate && !validIdentity(sessionId))) {
    return reject('invalid_identity', 'An explicit Agent and Session identity is required');
  }
  if (!requestId || (!isCreate && !['update', 'run'].includes(msg.op))) {
    return reject('invalid_request', 'A requestId and valid operation are required');
  }
  const accessError = resolveAgentAccessError(agentId, client.userId, client.role);
  if (!client.authenticated || accessError) {
    const denied = !client.authenticated || accessError === 'Agent access denied';
    return reject(denied ? 'agent_access_denied' : 'agent_offline', denied ? 'Agent access denied' : 'Agent is offline');
  }
  const agent = agents.get(agentId);
  if (!agent?.capabilities?.includes('scheduled_tasks')) {
    return reject('scheduled_tasks_unsupported', 'This Agent does not support scheduled tasks; upgrade it first');
  }
  if (!isCreate && !yeaftSessionDb.getForAgent(client.userId, agentId, sessionId)) {
    return reject('session_access_denied', 'Session not found or access denied');
  }
  const outbound = {
    type: isCreate ? 'yeaft_create_session' : 'yeaft_scheduled_task',
    requestId, _requestClientId: clientId,
  };
  try {
    if (isCreate) {
      outbound.payload = Object.fromEntries(CREATE_FIELDS.filter(key => Object.hasOwn(msg.payload, key)).map(key => [key, msg.payload[key]]));
      outbound.payload.task = projectTaskInput(msg.payload.task);
    } else {
      outbound.op = msg.op;
      outbound.sessionId = sessionId;
      if (msg.op === 'update') {
        if (typeof msg.expectedRevision !== 'string' || !msg.expectedRevision) {
          return reject('task_conflict', 'A task revision is required; refresh before editing');
        }
        outbound.expectedRevision = msg.expectedRevision;
        outbound.task = projectTaskInput(msg.task);
      } else {
        if (Object.hasOwn(msg, 'task')) throw new Error('run does not accept task configuration');
        // Never relay a browser-supplied Project; this authority comes only from SQLite.
        outbound.projectContext = yeaftProjectDb.contextForSession(client.userId, agentId, sessionId);
      }
    }
  } catch (error) {
    return reject('invalid_task', error.message);
  }
  // Override private routing instead of accepting any browser-provided identity.
  // A socket may disappear between the access check and the write.
  try {
    if (await forwardToAgent(agentId, outbound)) return true;
  } catch { /* Report a correlated failure instead of leaving the CRUD promise pending. */ }
  return reject('agent_offline', 'Agent delivery could not be confirmed; refresh before retrying');
}
