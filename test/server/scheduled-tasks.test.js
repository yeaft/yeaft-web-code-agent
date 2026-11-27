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
const { default: db, closeDb, userDb, yeaftProjectDb: projects, yeaftSessionDb: sessions, scheduledTaskReceiptDb: receipts } = await import('../../server/database.js');
const { CONFIG } = await import('../../server/config.js');
const { agents, webClients } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const { projectSessionCatalog } = await import('../../server/session-catalog.js');
const { handleWebConnection } = await import('../../server/ws-client.js');
const { completeLogin } = await import('../../server/auth/login.js');
const { generateSessionKey } = await import('../../server/encryption.js');
const { activeSessions } = await import('../../server/auth/session-store.js');
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

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  webClients.clear();
  sendToWebClient.mockClear();
  forwardToAgent.mockReset();
  forwardToAgent.mockResolvedValue(true);
  broadcastSessionCatalog.mockClear();
  allow.mockClear();
  db.prepare('DELETE FROM scheduled_task_receipts WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM scheduled_task_notification_runs WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM yeaft_sessions WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM yeaft_projects WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
  db.prepare('DELETE FROM yeaft_project_imports WHERE user_id = ? OR user_id = ?').run(owner, foreignOwner);
});
afterAll(() => { closeDb(); rmSync(testDbDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function receipt(overrides = {}) {
  return { agentId: 'agent-a', sessionId: 'task-session', runId: 'run-1', ...overrides };
}
function readRequest(batch = [receipt()], overrides = {}) {
  return { type: 'scheduled_task_notifications_read', receipts: batch, requestId: 'read-1', ...overrides };
}

describe('Account-wide scheduled Task read receipts', () => {
  it('acknowledges a deleted Session notice only with exact Server-owned run proof and still rejects forged runs or owners', async () => {
    const { client, agent } = fixture();
    const sibling = { authenticated: true, userId: owner, sent: [] };
    webClients.set('sibling', sibling);
    const event = { type: 'scheduled_task_notification', sessionId: 'task-session', runId: 'deleted-run', status: 'completed' };
    await handleAgentOutput('agent-a', agent, { type: 'yeaft_output', event });
    sessions.deleteForAgent(owner, 'agent-a', 'task-session');
    client.sent = []; sibling.sent = [];
    await handleClientConversation('client-a', client, readRequest([receipt({ runId: 'deleted-run' })]), allow);
    expect(client.sent.at(-1)).toMatchObject({ type: 'scheduled_task_notifications_read', receipts: [receipt({ runId: 'deleted-run' })] });
    expect(sibling.sent).toEqual(client.sent);
    const count = client.sent.length;
    for (const request of [readRequest([receipt({ runId: 'forged' })]),
      readRequest([], { sessionRead: true, sessions: [{ agentId: 'agent-a', sessionId: 'task-session' }] })]) {
      await handleClientConversation('client-a', client, request, allow);
      expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: 'session_access_denied' });
    }
    expect(sibling.sent).toHaveLength(count);
    expect(receipts.has(owner, 'agent-a', 'task-session', 'forged')).toBe(false);
    expect(() => receipts.markRead(foreignOwner, [receipt({ runId: 'deleted-run' })])).toThrow('Session not found');
  });

  it('rejects malformed or mixed-ownership batches atomically, without broadcasting or accepting an unauthenticated owner', async () => {
    const { client } = fixture();
    sessions.upsertFromSnapshot(foreignOwner, 'foreign-agent', { id: 'foreign-session', task });
    const malformed = [null, {}, [], Array(101).fill(receipt()), [receipt(), null],
      [receipt(), receipt({ runId: '' })], [receipt(), receipt({ sessionId: ' task-session' })],
      [receipt(), receipt({ agentId: 123 })], [receipt(), receipt({ runId: 'x'.repeat(257) })],
      [receipt(), receipt({ runId: 'run\n1' })], [receipt(), receipt({ runId: 'run 1' })],
      [receipt(), receipt({ agentId: 'foreign-agent', sessionId: 'foreign-session' })],
      [receipt(), receipt({ sessionId: 'missing' })]];
    receipts.recordNotificationRun(owner, 'agent-a', {
      type: 'scheduled_task_notification', sessionId: 'task-session', runId: 'older-run', status: 'completed',
    });
    for (const batch of malformed) {
      for (const sessionRead of [false, true]) {
        await handleClientConversation('client-a', client, readRequest(batch, { sessionRead }), allow);
        expect(client.sent.at(-1)).toMatchObject({ type: 'error', requestId: 'read-1' });
        expect(receipts.getByUser(owner)).toEqual([]);
      }
    }
    for (const overrides of [{ requestId: 42 }, { sessionRead: null }, { sessionRead: 'true' }, { sessionRead: 1 },
      { sessionRead: true, sessions: [{ agentId: 'agent-a', sessionId: 'foreign-session' }] },
      { sessionRead: true, sessions: [null] }, { sessionRead: true, sessions: {} },
      { sessionRead: false, sessions: [{ agentId: 'agent-a', sessionId: 'task-session' }] }]) {
      await handleClientConversation('client-a', client, readRequest([receipt()], overrides), allow);
      expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: overrides.sessions?.[0]?.sessionId === 'foreign-session'
        ? 'session_access_denied' : 'invalid_scheduled_task_receipts' });
      expect(receipts.getByUser(owner)).toEqual([]);
    }
    for (const identity of [{ authenticated: false, userId: owner }, { authenticated: true, userId: null },
      { authenticated: true, userId: 'missing-user' }]) {
      await handleClientConversation('client-a', { ...client, ...identity }, readRequest(), allow);
      expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: 'authentication_required' });
    }
    expect(receipts.getByUser(owner)).toEqual([]);
    expect(client.sent.every(msg => msg.type === 'error')).toBe(true);
    // Simulate a storage failure halfway through an otherwise valid batch.
    db.exec(`CREATE TEMP TRIGGER fail_second_receipt BEFORE INSERT ON scheduled_task_receipts
      WHEN NEW.run_id = 'fail-run' BEGIN SELECT RAISE(ABORT, 'storage failure'); END;`);
    try {
      expect(() => receipts.markRead(owner, [receipt(), receipt({ runId: 'fail-run' })])).toThrow('storage failure');
      expect(receipts.getByUser(owner)).toEqual([]);
      receipts.recordNotificationRun(owner, 'agent-a', {
        type: 'scheduled_task_notification', sessionId: 'task-session', runId: 'fail-run', status: 'failed',
      });
      expect(() => receipts.markRead(owner, [receipt()], { sessionRead: true })).toThrow('storage failure');
      expect(receipts.getByUser(owner)).toEqual([]);
    } finally { db.exec('DROP TRIGGER fail_second_receipt'); }
  });

});

it('blocks new scheduled execution on an Agent with legacy Work Center but still allows a pause', async () => {
  const { agent, client } = fixture();
  agent.capabilities.push('work_center');
  const base = { agentId: 'agent-a', sessionId: 'task-session', requestId: 'schedule-change' };
  const create = { ...base, type: 'yeaft_create_session', payload: { name: 'Build', task } };
  const update = { ...base, type: 'yeaft_scheduled_task', op: 'update', expectedRevision: task.revision };
  for (const request of [
    create,
    { ...update, task: { enabled: true } },
    { ...update, task: { trigger: task.trigger } },
    { ...update, op: 'run' },
  ]) {
    await handleClientConversation('client-a', client, request, allow);
    expect(client.sent.at(-1)?.event).toMatchObject({ requestId: base.requestId, ok: false, error: { code: 'legacy_work_center_active' } });
  }
  expect(forwardToAgent).not.toHaveBeenCalled();

  const pause = { ...update, task: { enabled: false } };
  await handleClientConversation('client-a', client, pause, allow);
  expect(forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({ op: 'update', task: { enabled: false } }));
  const manual = { ...update, task: { enabled: true, trigger: { type: 'manual' } } };
  await handleClientConversation('client-a', client, manual, allow);
  expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', expect.objectContaining({ op: 'update', task: manual.task }));
  agent.capabilities = ['scheduled_tasks'];
  await handleClientConversation('client-a', client, create, allow);
  expect(forwardToAgent).toHaveBeenLastCalledWith('agent-a', expect.objectContaining({ type: 'yeaft_create_session', payload: expect.objectContaining({ task: expect.objectContaining({ enabled: true }) }) }));
});
