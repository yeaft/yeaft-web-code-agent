import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const testDbDir = mkdtempSync(join(tmpdir(), 'yeaft-scheduled-tasks-'));
vi.stubEnv('SERVER_DATA_DIR', undefined);
vi.stubEnv('TEST_DB_PATH', undefined);
vi.stubEnv('TEST_DB_DIR', testDbDir);
// Exercise the nullable migration against a real pre-task catalog.
const legacyDb = new DatabaseSync(join(testDbDir, 'webchat.db'));
legacyDb.exec(`CREATE TABLE yeaft_sessions (
  id TEXT NOT NULL, user_id TEXT, agent_id TEXT NOT NULL, name TEXT,
  roster_json TEXT, default_vp_id TEXT, work_dir TEXT, config_json TEXT,
  announcement TEXT, created_at INTEGER, updated_at INTEGER NOT NULL,
  is_archived INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, sort_order INTEGER,
  PRIMARY KEY (user_id, agent_id, id)
);
INSERT INTO yeaft_sessions (id, user_id, agent_id, name, updated_at)
VALUES ('legacy', 'legacy-owner', 'legacy-agent', 'Ordinary', 1);`);
legacyDb.close();

const sendToWebClient = vi.fn(async (client, msg) => { client.sent.push(msg); });
const forwardToAgent = vi.fn(async () => true);
const broadcastSessionCatalog = vi.fn(async () => {});
vi.mock('../../server/ws-utils.js', async (importOriginal) => ({
  ...(await importOriginal()), sendToWebClient, forwardToAgent, broadcastSessionCatalog,
  broadcastAgentList: vi.fn(async () => {}),
}));
const { default: db, closeDb, userDb, yeaftProjectDb: projects, yeaftSessionDb: sessions } = await import('../../server/database.js');
const { CONFIG } = await import('../../server/config.js');
const { agents, webClients } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const { projectSessionCatalog } = await import('../../server/session-catalog.js');
const owner = userDb.getOrCreate('scheduled-task-owner').id;
const foreignOwner = userDb.getOrCreate('scheduled-task-foreign').id;
const originalSkipAuth = CONFIG.skipAuth;
const task = {
  prompt: 'Check the build', enabled: true, notify: true, revision: 'task-revision-1',
  trigger: { type: 'schedule', scheduledFor: 1893456000000, recurrence: null },
  nextRunAt: 1893456000000,
  lastRun: { id: 'run-1', status: 'succeeded', trigger: 'manual', startedAt: 1, finishedAt: 2 },
};
const allow = vi.fn(async () => true);
function fixture() {
  CONFIG.skipAuth = false;
  const agent = { ownerId: owner, ws: { readyState: 1 }, capabilities: ['scheduled_tasks'] };
  agents.set('agent-a', agent);
  const client = { userId: owner, authenticated: true, currentAgent: 'agent-a', sent: [] };
  webClients.set('client-a', client);
  sessions.upsertFromSnapshot(owner, 'agent-a', { id: 'task-session', name: 'Build', task });
  return { agent, client };
}
function request(overrides = {}) {
  return { type: 'yeaft_scheduled_task', op: 'run', agentId: 'agent-a', sessionId: 'task-session', requestId: 'request-1', expectedRevision: task.revision, ...overrides };
}
function lastError(client) { return client.sent.at(-1)?.event; }
afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  webClients.clear();
  sendToWebClient.mockClear();
  forwardToAgent.mockReset();
  forwardToAgent.mockResolvedValue(true);
  broadcastSessionCatalog.mockClear();
  allow.mockClear();
  db.prepare('DELETE FROM yeaft_sessions WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM yeaft_projects WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM yeaft_project_imports WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
});
afterAll(() => { closeDb(); rmSync(testDbDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('Session-backed scheduled tasks', () => {
  it('migrates ordinary Sessions and roundtrips/reconciles task metadata with compound identity into the catalog', () => {
    expect(db.prepare('PRAGMA table_info(yeaft_sessions)').all().find(column => column.name === 'task_json')).toBeDefined();
    const legacy = sessions.getByAgent('legacy-agent')[0];
    expect(legacy.id).toBe('legacy');
    expect(legacy).not.toHaveProperty('task');
    sessions.upsertFromSnapshot(owner, 'agent-a', { id: 'same-id', name: 'A', task });
    sessions.upsertFromSnapshot(owner, 'agent-b', { id: 'same-id', name: 'B' });
    expect(sessions.getForAgent(owner, 'agent-a', 'same-id').task).toEqual(task);
    expect(sessions.getForAgent(owner, 'agent-b', 'same-id')).not.toHaveProperty('task');
    const catalog = projectSessionCatalog({ yeaftSessions: sessions.getByUser(owner) });
    expect(catalog.find(row => row.agentId === 'agent-a').task).toEqual(task);
    expect(catalog.find(row => row.agentId === 'agent-b')).not.toHaveProperty('task');
    const replacement = { ...task, enabled: false, lastRun: { ...task.lastRun, error: 'failed', status: 'failed' } };
    sessions.reconcileFromSnapshot(owner, 'agent-a', [{ id: 'same-id', task: replacement }]);
    expect(sessions.getForAgent(owner, 'agent-a', 'same-id').task).toEqual(replacement);
    sessions.reconcileFromSnapshot(owner, 'agent-a', []);
    expect(sessions.getForAgent(owner, 'agent-a', 'same-id')).toBeUndefined();
    expect(sessions.getForAgent(owner, 'agent-b', 'same-id').name).toBe('B');
    sessions.reconcileFromSnapshot(owner, 'agent-b', [{ id: 'same-id', task }]);
    sessions.reconcileFromSnapshot(owner, 'agent-b', [{ id: 'same-id' }]);
    expect(sessions.getForAgent(owner, 'agent-b', 'same-id')).not.toHaveProperty('task');
  });

  it('rejects offline, unsupported, foreign-owner, and invalid-identity controls with correlated CRUD errors', async () => {
    const { client, agent } = fixture();
    for (const [changes, code] of [
      [{ agentId: undefined }, 'invalid_identity'], [{ sessionId: undefined }, 'invalid_identity'],
      [{ agentId: ' agent-a ' }, 'invalid_identity'], [{ requestId: undefined }, 'invalid_request'],
      [{ sessionId: 'missing' }, 'session_access_denied'], [{ op: 'delete' }, 'invalid_request'],
    ]) {
      await handleClientConversation('client-a', client, request(changes), allow);
      expect(lastError(client)).toMatchObject({ type: 'session_crud_result', ok: false, error: { code } });
      expect(lastError(client).requestId).toBe(changes.requestId === undefined && Object.hasOwn(changes, 'requestId') ? null : 'request-1');
    }
    agent.capabilities = [];
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client)).toMatchObject({ op: 'run_task', error: { code: 'scheduled_tasks_unsupported' } });
    agent.capabilities = ['scheduled_tasks'];
    agent.ws.readyState = 3;
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client).error.code).toBe('agent_offline');
    agent.ws.readyState = 1;
    agent.ownerId = foreignOwner;
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client).error.code).toBe('agent_access_denied');
    agent.ownerId = owner;
    for (const invalid of [request({ op: 'run', task: {} }), request({ op: 'update', task: { lastRun: task.lastRun } }),
      request({ op: 'update', task: { prompt: '' } }), request({ op: 'update', task: { enabled: 'yes' } }),
      request({ op: 'update', task: { trigger: { type: 'cron' } } })]) {
      await handleClientConversation('client-a', client, invalid, allow);
      expect(lastError(client).error.code).toBe('invalid_task');
    }
    for (const expectedRevision of [undefined, null, 123, {}, '']) {
      await handleClientConversation('client-a', client, request({ op: 'update', task: { enabled: false }, expectedRevision }), allow);
      expect(lastError(client).error.code).toBe('task_conflict');
    }
    agents.delete('agent-a');
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client).error.code).toBe('agent_offline');
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
  });

  it('gates task creation (including legacy aliases) without changing ordinary Session creation', async () => {
    const { client, agent } = fixture();
    const create = { type: 'yeaft_create_session', agentId: 'agent-a', requestId: 'create-1', payload: { name: 'Build', task } };
    agent.capabilities = [];
    await handleClientConversation('client-a', client, create, allow);
    expect(lastError(client)).toMatchObject({ op: 'create', requestId: 'create-1', ok: false, error: { code: 'scheduled_tasks_unsupported' } });
    agent.capabilities = ['scheduled_tasks'];
    agent.ws.readyState = 3;
    await handleClientConversation('client-a', client, create, allow);
    expect(lastError(client).error.code).toBe('agent_offline');
    agent.ws.readyState = 1;
    agent.ownerId = foreignOwner;
    await handleClientConversation('client-a', client, create, allow);
    expect(lastError(client).error.code).toBe('agent_access_denied');
    agent.ownerId = owner;
    agent.capabilities = [];
    await handleClientConversation('client-a', client, { ...create, type: 'unify_create_group' }, allow);
    expect(lastError(client).error.code).toBe('scheduled_tasks_unsupported');
    expect(forwardToAgent).not.toHaveBeenCalled();
    await handleClientConversation('client-a', client, { ...create, payload: { name: 'Ordinary' } }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({ type: 'yeaft_create_session', payload: { name: 'Ordinary' } }));
  });

  it('whitelists authored task fields and trusted routing, and correlates delivery failures', async () => {
    const { client } = fixture();
    for (const type of ['yeaft_project_context_sync', 'unify_project_context_sync']) {
      await handleClientConversation('client-a', client, { type, agentId: 'agent-a', requestId: 'forged-context',
        contexts: [{ sessionId: 'task-session', projectContext: { projectId: 'forged', projectInstruction: 'untrusted' } }] }, allow);
      expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: 'server_only_message', requestId: 'forged-context' });
    }
    expect(forwardToAgent).not.toHaveBeenCalled();
    await handleClientConversation('client-a', client, request({ op: 'update', task: { ...task, ownerId: foreignOwner }, _requestClientId: 'foreign', lastRun: 'forged' }), allow);
    const editableTask = { prompt: task.prompt, enabled: true, notify: true, trigger: task.trigger };
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', {
      type: 'yeaft_scheduled_task', op: 'update', sessionId: 'task-session', requestId: 'request-1',
      task: editableTask, expectedRevision: task.revision, _requestClientId: 'client-a',
    });
    await handleClientConversation('client-a', client, {
      type: 'yeaft_create_session', agentId: 'agent-a', requestId: 'create-1', _requestClientId: 'foreign',
      payload: { name: 'Build', roster: ['vp'], workDir: '/work', task, lastRun: 'forged', _requestClientId: 'foreign' },
    }, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', {
      type: 'yeaft_create_session', requestId: 'create-1', _requestClientId: 'client-a',
      payload: { name: 'Build', roster: ['vp'], workDir: '/work', task: editableTask },
    });
    await handleClientConversation('client-a', client, request({ op: 'update', task: { enabled: false } }), allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', expect.objectContaining({ task: { enabled: false } }));
    const project = projects.create(owner, 'Authoritative');
    projects.updateInstruction(owner, project.id, 'Use only Server instructions');
    projects.moveSession(owner, { agentId: 'agent-a', sessionId: 'task-session', projectId: project.id });
    await handleClientConversation('client-a', client, request({ projectContext: { projectId: 'forged', projectInstruction: 'untrusted' }, projectId: 'forged' }), allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', {
      type: 'yeaft_scheduled_task', op: 'run', sessionId: 'task-session', requestId: 'request-1', _requestClientId: 'client-a',
      projectContext: projects.contextForSession(owner, 'agent-a', 'task-session'),
    });
    projects.moveSession(owner, { agentId: 'agent-a', sessionId: 'task-session', projectId: null });
    await handleClientConversation('client-a', client, request({ projectContext: { projectId: 'forged' } }), allow);
    expect(forwardToAgent.mock.calls.at(-1)[1].projectContext).toBe(null);
    forwardToAgent.mockResolvedValue(false);
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client)).toMatchObject({ op: 'run_task', requestId: 'request-1', error: { code: 'agent_offline' } });
    forwardToAgent.mockRejectedValue(new Error('transport'));
    await handleClientConversation('client-a', client, request(), allow);
    expect(lastError(client)).toMatchObject({ op: 'run_task', requestId: 'request-1', error: { code: 'agent_offline' } });
  });

  it('persists nested CRUD/snapshots and roster deltas without losing task; routes replies only to their requester', async () => {
    const { client, agent } = fixture();
    const sibling = { authenticated: true, userId: owner, sent: [] };
    const foreign = { authenticated: true, userId: foreignOwner, sent: [] };
    webClients.set('sibling', sibling);
    webClients.set('foreign', foreign);
    const config = { model: 'test/model', modelEffort: 'high' };
    const updated = { id: 'task-session', name: 'Build updated', config, task: { ...task, enabled: false, revision: 'task-revision-2' } };
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output', _requestClientId: 'client-a',
      event: { type: 'session_crud_result', op: 'update_task', requestId: 'request-1', ok: true, session: updated },
    });
    expect(client.sent.at(-1)).toMatchObject({ type: 'yeaft_output', agentId: 'agent-a', event: { requestId: 'request-1', session: updated } });
    expect(sibling.sent).toEqual([]);
    expect(foreign.sent).toEqual([]);
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).task).toEqual(updated.task);
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', event: { type: 'session_roster_changed', sessionId: updated.id, roster: ['vp'] } });
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).task).toEqual(updated.task);
    await handleAgentOutput('agent-a', agent, { type: 'session_roster_changed', sessionId: updated.id, roster: ['vp2'] });
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).task).toEqual(updated.task);
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [updated, { id: 'ordinary' }] } });
    expect(sessions.getForAgent(owner, 'agent-a', 'ordinary')).not.toHaveProperty('task');
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).task).toEqual(updated.task);
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).config).toEqual(config);
    client.sent = []; sibling.sent = []; foreign.sent = [];
    await handleAgentOutput('agent-a', agent, {
      type: 'session_crud_result', op: 'run_task', requestId: 'run-request', ok: true,
      session: updated, _requestClientId: 'client-a',
    });
    expect(client.sent).toEqual([expect.objectContaining({ type: 'yeaft_output', agentId: 'agent-a', event: expect.objectContaining({ op: 'run_task', requestId: 'run-request' }) })]);
    expect(sibling.sent).toEqual([]); expect(foreign.sent).toEqual([]);
    expect(client.sent[0].event.session.config).toEqual(config);
    expect(sessions.getForAgent(owner, 'agent-a', updated.id).config).toEqual(config);
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output', _requestClientId: 'foreign',
      event: { type: 'session_crud_result', op: 'run_task', requestId: 'forged-target', ok: false, error: 'failed' },
    });
    expect(foreign.sent).toEqual([]);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith(owner);
  });

  it('restores Server Project context on registration snapshots and task create without any browser', async () => {
    const { agent } = fixture();
    webClients.clear();
    agents.set('agent-b', { ownerId: owner, ws: { readyState: 1 } });
    sessions.upsertFromSnapshot(owner, 'agent-b', { id: 'task-session', task });
    sessions.upsertFromSnapshot(owner, 'agent-a', { id: 'no-project' });
    // Catalog rows can already exist before this Agent's first legacy import.
    sessions.upsertFromSnapshot(owner, 'agent-a', { id: 'normal-session' });
    const projectA = projects.create(owner, 'A');
    const projectB = projects.create(owner, 'B');
    projects.updateInstruction(owner, projectA.id, 'Agent A authority');
    projects.updateInstruction(owner, projectB.id, 'Agent B authority');
    projects.moveSession(owner, { agentId: 'agent-a', sessionId: 'task-session', projectId: projectA.id });
    projects.moveSession(owner, { agentId: 'agent-b', sessionId: 'task-session', projectId: projectB.id });
    const snapshot = { type: 'session_list_updated', sessions: [{ id: 'task-session', task }, { id: 'no-project' }, { id: 'normal-session' }],
      projects: [{ id: 'legacy', name: 'Legacy', sessionIds: ['task-session', 'normal-session'] }] };
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', event: snapshot });
    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', { type: 'yeaft_project_context_sync', contexts: expect.arrayContaining([
      { sessionId: 'task-session', projectContext: projects.contextForSession(owner, 'agent-a', 'task-session') },
      { sessionId: 'no-project', projectContext: { projectId: null, projectName: null, projectInstruction: '', sessionIds: [] } },
      { sessionId: 'normal-session', projectContext: projects.contextForSession(owner, 'agent-a', 'normal-session') },
    ]) });
    expect(forwardToAgent.mock.calls[0][1].contexts).toHaveLength(3);
    expect(projects.contextForSession(owner, 'agent-a', 'normal-session').projectName).toBe('Legacy');
    expect(forwardToAgent.mock.calls[0][1].contexts.find(row => row.sessionId === 'task-session').projectContext.projectInstruction).toBe('Agent A authority');
    expect(projects.contextForSession(owner, 'agent-b', 'task-session').projectInstruction).toBe('Agent B authority');
    projects.updateInstruction(owner, projectA.id, 'Updated while Agent disconnected');
    await handleAgentOutput('agent-a', agent, snapshot); // Re-registration/top-level alias.
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
    expect(forwardToAgent.mock.calls.at(-1)[0]).toBe('agent-a');
    expect(forwardToAgent.mock.calls.at(-1)[1].contexts.find(row => row.sessionId === 'task-session').projectContext.projectInstruction).toBe('Updated while Agent disconnected');
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', event: {
      type: 'session_crud_result', op: 'create', ok: true, session: { id: 'new-task', task },
    } });
    expect(forwardToAgent).toHaveBeenCalledTimes(3);
    expect(forwardToAgent.mock.calls.at(-1)[1].contexts).toContainEqual({ sessionId: 'new-task', projectContext: {
      projectId: null, projectName: null, projectInstruction: '', sessionIds: [],
    } });
    expect(sendToWebClient).not.toHaveBeenCalled();
  });

  it('relays notifications only to authenticated owner tabs with source agent identity even in skip-auth mode', async () => {
    const { client, agent } = fixture();
    const sibling = { authenticated: true, userId: owner, sent: [] };
    const foreign = { authenticated: true, userId: foreignOwner, sent: [] };
    const anonymous = { authenticated: false, userId: owner, sent: [] };
    webClients.set('sibling', sibling); webClients.set('foreign', foreign); webClients.set('anonymous', anonymous);
    CONFIG.skipAuth = true;
    const event = { type: 'scheduled_task_notification', sessionId: 'task-session', runId: 'run-1', status: 'failed', taskName: 'Build', error: 'provider error' };
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', _requestClientId: 'foreign', agentId: 'forged-agent', event });
    expect(client.sent).toEqual([expect.objectContaining({ type: 'yeaft_output', agentId: 'agent-a', event })]);
    expect(sibling.sent).toHaveLength(1);
    expect(foreign.sent).toEqual([]); expect(anonymous.sent).toEqual([]);
  });
});
