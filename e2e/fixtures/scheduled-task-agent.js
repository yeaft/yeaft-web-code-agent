// Deterministic Agent boundary only: Browser -> real Server -> MockAgent and
// all inventory, CRUD, history and notifications travel over real WebSockets.
import { randomUUID } from 'node:crypto';

export const TASK_CAPABILITIES = ['work_center', 'plaintext-ok', 'workbench_session_routes', 'scheduled_tasks', 'scheduled_task_month_days'];
export const TASK_SESSION_ID = 'shared-task-session';
export const CHAT_SESSION_ID = 'ordinary-session';

export function taskSession(overrides = {}) {
  return {
    id: TASK_SESSION_ID, name: 'Daily workspace review', roster: ['omni'], defaultVpId: 'omni',
    workDir: '/tmp/test/review-workspace', createdAt: Date.now(),
    task: { revision: randomUUID(), prompt: 'Review ownership and recovery.', enabled: true, notify: true,
      trigger: { type: 'manual' }, nextRunAt: null, lastRun: null },
    ...overrides,
  };
}

export function scheduledTaskAgent(agent, { sessions = [taskSession(), {
  id: CHAT_SESSION_ID, name: 'Ordinary conversation', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
}], marker = agent.agentName, capabilities = TASK_CAPABILITIES } = {}) {
  const state = {
    sessions: new Map(sessions.map(session => [session.id, structuredClone(session)])),
    requests: [], updateError: '', holdUpdates: false, heldUpdates: [], createdCount: 0,
    publish() {
      agent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [...state.sessions.values()] } });
    },
    reply(request, op, session, error = '') {
      agent.send({ type: 'yeaft_output', requestId: request.requestId,
        _requestClientId: request._requestClientId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        event: { type: 'session_crud_result', op, requestId: request.requestId,
          ok: !error, ...(error ? { error: typeof error === 'string' ? { code: 'task_fixture_rejected', message: error } : error } : { session }) } });
    },
    replyUpdate(request, error = state.updateError) {
      const previous = state.sessions.get(request.sessionId);
      if (request.expectedRevision !== previous.task.revision) {
        state.reply(request, 'update_task', null, { code: 'task_conflict', message: 'Task changed; reload before saving.' });
      } else if (error) state.reply(request, 'update_task', null, error);
      else {
        const task = structuredClone(previous.task);
        for (const key of ['prompt', 'trigger', 'enabled', 'notify']) {
          if (Object.hasOwn(request.task, key)) task[key] = structuredClone(request.task[key]);
        }
        task.revision = randomUUID();
        task.nextRunAt = task.enabled && task.trigger?.type === 'schedule' ? task.trigger.scheduledFor : null;
        const session = { ...previous, task };
        state.sessions.set(session.id, session);
        state.reply(request, 'update_task', session);
        state.publish();
      }
    },
    notify({ sessionId = TASK_SESSION_ID, runId = 'task-run-1', status = 'completed', taskName = 'Daily workspace review', error } = {}) {
      agent.send({ type: 'yeaft_output', event: { type: 'scheduled_task_notification',
        sessionId, runId, status, taskName, ...(error ? { error } : {}) } });
    },
  };
  agent._messageHandlers.push(request => {
    state.requests.push(structuredClone(request));
    if (request.type === 'yeaft_vp_subscribe') {
      agent.send({ type: 'yeaft_output', requestId: request.requestId, event: {
        type: 'vp_snapshot', emptyLibrary: false, vps: [
          { vpId: 'omni', displayName: 'Omni', role: 'General assistant', traits: [], isStock: true },
          { vpId: 'reviewer', displayName: `${marker} reviewer`, role: 'Code reviewer', traits: [], isStock: false },
        ],
      } });
    } else if (request.type === 'yeaft_list_sessions') {
      state.publish();
      agent.send({ type: 'yeaft_output', event: { type: 'session_crud_result', op: 'list',
        ok: true, requestId: request.requestId, sessions: [...state.sessions.values()] } });
    } else if (request.type === 'list_directory' && request.conversationId === '_workdir_picker') {
      agent.send({ type: 'directory_listing', requestId: request.requestId,
        _workbenchRequestId: request._workbenchRequestId,
        conversationId: request.conversationId, dirPath: request.dirPath,
        entries: request.dirPath.endsWith('/review-workspace') ? [] : [{ name: 'review-workspace', type: 'directory' }] });
    } else if (request.type === 'yeaft_create_session') {
      const { payload } = request;
      const session = { id: `created-task-${++state.createdCount}`, ...structuredClone(payload), createdAt: Date.now(),
        ...(payload.task ? { task: { ...structuredClone(payload.task), revision: randomUUID(), nextRunAt: payload.task.trigger?.scheduledFor || null, lastRun: null } } : {}) };
      state.sessions.set(session.id, session);
      state.reply(request, 'create', session);
      state.publish();
    } else if (request.type === 'yeaft_rename_session') {
      const previous = state.sessions.get(request.sessionId);
      if (!previous) return;
      const session = { ...previous, name: request.name };
      state.sessions.set(session.id, session);
      state.reply(request, 'rename', session);
      state.publish();
    } else if (request.type === 'yeaft_scheduled_task' && request.op === 'update') {
      if (state.holdUpdates) state.heldUpdates.push(request);
      else state.replyUpdate(request);
    } else if (request.type === 'yeaft_scheduled_task' && request.op === 'run') {
      const previous = state.sessions.get(request.sessionId);
      const session = { ...previous, task: { ...previous.task,
        lastRun: { id: 'manual-run-1', status: 'completed', finishedAt: Date.now() } } };
      state.sessions.set(session.id, session);
      state.reply(request, 'run_task', session);
      state.publish();
    } else if (request.type === 'yeaft_load_history' && request.limit !== 0) {
      agent.send({ type: 'yeaft_history_chunk', sessionId: request.sessionId, requestId: request.requestId,
        _requestClientId: request._requestClientId, mode: request.mode || 'recent', messages: [{
          id: 'm1', seq: 1, turnId: 'completed-turn', role: 'assistant', speakerVpId: 'omni',
          sessionId: request.sessionId, content: `${marker}: persistent conversation for ${request.sessionId}`, ts: Date.now(),
        }], oldestSeq: 1, latestSeq: 1, hasMore: false });
    }
  });
  agent.send({ type: 'agent_capabilities_updated', capabilities });
  state.publish();
  return state;
}
