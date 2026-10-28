import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const testDbDir = mkdtempSync(join(tmpdir(), 'yeaft-fork-handler-'));
vi.stubEnv('SERVER_DATA_DIR', undefined);
vi.stubEnv('TEST_DB_PATH', undefined);
vi.stubEnv('TEST_DB_DIR', testDbDir);

const sendToWebClient = vi.fn(async (client, msg) => { client.sent.push(msg); });
const forwardToAgent = vi.fn(async () => true);
const broadcastAgentList = vi.fn(async () => {});
const forwardToClients = vi.fn();
const getByUser = vi.fn(() => []);

vi.mock('../../server/ws-utils.js', async (importOriginal) => ({
  resolveAgentAccessError: (await importOriginal()).resolveAgentAccessError,
  sendToWebClient,
  forwardToAgent,
  forwardToClients,
  sendToAgent: vi.fn(),
  broadcastAgentList,
  broadcastSessionCatalog: vi.fn(),
  buildSessionCatalog: vi.fn(() => []),
  buildHiddenSessionCatalog: vi.fn(() => []),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, yeaftSessionDb: { ...actual.yeaftSessionDb, getByUser } };
});

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { yeaftProjectDb: projects, yeaftSessionDb: sessions, userDb, closeDb, default: db } = await import('../../server/database.js');
const { CONFIG } = await import('../../server/config.js');
const { agents, pendingFiles, pendingYeaftDebugRequests, webClients } = await import('../../server/context.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterAll(() => {
  closeDb();
  rmSync(testDbDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  pendingFiles.clear();
  webClients.clear();
  pendingYeaftDebugRequests.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  sendToWebClient.mockClear();
  forwardToAgent.mockClear();
  forwardToClients.mockClear();
  broadcastAgentList.mockClear();
});

describe('Yeaft Plugin Skill detail relay', () => {
  it('preserves skillName and client correlation, whitelists detail fields and isolates owner/auth boundaries', async () => {
    CONFIG.skipAuth = false;
    const agent = { ws: { readyState: 1 }, ownerId: 'owner-1', capabilities: ['yeaft_plugins'], capabilityMetadataProvided: true };
    agents.set('plugin-agent', agent);
    const client = { authenticated: true, userId: 'owner-1', sent: [] };
    const sibling = { authenticated: true, userId: 'owner-1', sent: [] };
    const foreign = { authenticated: true, userId: 'owner-2', sent: [] };
    const anonymous = { authenticated: false, userId: 'owner-1', sent: [] };
    webClients.set('plugin-client', client);
    webClients.set('sibling', sibling);
    webClients.set('foreign', foreign);
    webClients.set('anonymous', anonymous);
    await handleClientConversation('plugin-client', client, {
      type: 'yeaft_plugin_catalog', agentId: 'plugin-agent', requestId: 'skill-detail',
      skillName: 'inspect', workDir: '/requested/project', _requestClientId: 'foreign',
    }, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('plugin-agent', {
      type: 'yeaft_plugin_catalog', requestId: 'skill-detail', skillName: 'inspect',
      workDir: '/requested/project', _requestClientId: 'plugin-client',
    });
    const skillDetail = {
      name: 'inspect', description: 'Inspect code', trigger: 'inspect', keywords: ['code'],
      category: 'development', tier: 'project', content: 'Bounded body',
      references: ['guide.md'], templates: ['form.md'], contentTruncated: true,
    };
    const result = {
      type: 'yeaft_plugin_catalog_result', requestId: 'skill-detail',
      catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] },
      skillDetail: { ...skillDetail, _path: '/private/root', internal: 'SECRET', linkedContent: 'SECRET',
        keywords: ['code', { secret: 'SECRET' }], references: ['guide.md', { _path: 'SECRET' }] },
      _requestClientId: 'plugin-client', ownerId: 'owner-2', internal: 'SECRET',
    };
    await handleAgentOutput('plugin-agent', agent, result);
    expect(client.sent).toEqual([{
      type: 'yeaft_plugin_catalog_result', agentId: 'plugin-agent', requestId: 'skill-detail',
      catalog: result.catalog, skillDetail, error: null,
    }]);
    expect(JSON.stringify(client.sent)).not.toContain('SECRET');
    expect(sibling.sent).toEqual([]);
    for (const _requestClientId of ['foreign', 'anonymous', 'missing', undefined]) {
      await handleAgentOutput('plugin-agent', agent, { ...result, _requestClientId });
    }
    expect(client.sent).toHaveLength(1);
    expect(sibling.sent).toEqual([]);
    expect(foreign.sent).toEqual([]);
    expect(anonymous.sent).toEqual([]);

    const { skillDetail: _discard, ...legacy } = result;
    await handleAgentOutput('plugin-agent', agent, legacy);
    expect(client.sent.at(-1)).not.toHaveProperty('skillDetail');
    for (const detail of [null, 'invalid', []]) {
      await handleAgentOutput('plugin-agent', agent, { ...result, skillDetail: detail, error: 'Skill unavailable' });
      expect(client.sent.at(-1)).toMatchObject({ skillDetail: null, error: 'Skill unavailable' });
    }
    // Existing capability negotiation is unchanged; no detail capability is required.
    forwardToAgent.mockClear();
    agent.capabilities = [];
    await handleClientConversation('plugin-client', client, {
      type: 'yeaft_plugin_catalog', agentId: 'plugin-agent', requestId: 'unsupported', skillName: 'inspect',
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(client.sent.at(-1)).toMatchObject({ requestId: 'unsupported', error: expect.stringContaining('does not support Plugins') });
  });
});

describe('Yeaft Session online Agent filtering', () => {
  const sendIdentity = {
    id: 'user-message-original', requestId: 'send-request-original',
    sessionId: 'session-original', conversationId: 'conversation-original',
  };
  const uploadedImage = (overrides = {}) => ({
    name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('image-bytes'),
    uploadedAt: Date.now(), userId: 'user-1', ...overrides,
  });
  const expectSendFailure = (client, agentId, code) => {
    expect(client.sent).toEqual([{
      type: 'error', agentId, ...sendIdentity,
      clientMessageId: sendIdentity.id, code, message: expect.any(String),
    }]);
    expect(client.sent[0].message.length).toBeGreaterThan(0);
    expect(sendToWebClient).toHaveBeenLastCalledWith(client, client.sent[0]);
  };

  it('rejects a foreign Session attachment atomically without consuming valid uploads', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-online', { ws: { readyState: 1 }, ownerId: 'user-1' });
    const client = { userId: 'user-1', sent: [] };
    const valid = uploadedImage();
    const foreign = uploadedImage({ userId: 'other-owner' });
    pendingFiles.set('valid', valid);
    pendingFiles.set('foreign', foreign);
    await handleClientConversation('client-send', client, {
      type: 'yeaft_session_send', agentId: 'agent-online', ...sendIdentity,
      text: 'Inspect this image', attachments: [{ fileId: 'valid' }, { fileId: 'foreign' }],
    }, allow);
    expectSendFailure(client, 'agent-online', 'invalid_attachment');
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect([...pendingFiles]).toEqual([['valid', valid], ['foreign', foreign]]);
  });

  it('keeps Session uploads retryable on relay failure and reports the original send identity', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-send', { ws: { readyState: 1 }, ownerId: 'user-1' });
    const image = uploadedImage();
    pendingFiles.set('image', image);
    const client = { userId: 'user-1', sent: [] };
    const msg = {
      type: 'yeaft_session_send', agentId: 'agent-send', ...sendIdentity,
      text: '(attached files)', attachments: [{ fileId: 'image', isImage: true }],
    };
    forwardToAgent.mockResolvedValueOnce(false);
    await handleClientConversation('client-send', client, msg, allow);
    expectSendFailure(client, 'agent-send', 'agent_unavailable');
    expect(pendingFiles.get('image')).toBe(image);
    client.sent = [];
    await handleClientConversation('client-send', client, msg, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('agent-send', expect.objectContaining({
      ...sendIdentity, files: [{ name: image.name, mimeType: image.mimeType,
        data: image.buffer.toString('base64'), isImage: true }],
    }));
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
    expect(pendingFiles.has('image')).toBe(false);
    expect(client.sent).toEqual([]);
  });

  it('persists fork Project inheritance before replying, rolls back failures and fences owner/Agent scopes and replays', async () => {
    CONFIG.skipAuth = false;
    const owner = userDb.getOrCreate('fork-db-owner');
    const other = userDb.getOrCreate('fork-db-other');
    const ownerTab = { authenticated: true, userId: owner.id, sent: [] };
    const otherTab = { authenticated: true, userId: other.id, sent: [] };
    webClients.set('owner-tab', ownerTab);
    webClients.set('other-tab', otherTab);
    const agent = { ownerId: owner.id, conversations: new Map() };
    const otherAgent = { ownerId: other.id, conversations: new Map() };
    const forkResult = (sourceSessionId = 'source', targetId = 'target') => ({
      type: 'session_crud_result', op: 'copy', ok: true, requestId: `fork-${targetId}`,
      sourceSessionId, sessionId: targetId, session: { id: targetId, name: 'Fork' },
    });
    // A second connection sees only committed SQLite state, including at send time.
    const observer = new DatabaseSync(join(testDbDir, 'webchat.db'), { readOnly: true });
    const persistedSession = observer.prepare(`
      SELECT s.id, p.id AS projectId, p.instruction AS projectInstruction
      FROM yeaft_sessions s
      LEFT JOIN yeaft_project_sessions m
        ON m.user_id = s.user_id AND m.agent_id = s.agent_id AND m.session_id = s.id
      LEFT JOIN yeaft_projects p ON p.user_id = m.user_id AND p.id = m.project_id
      WHERE s.user_id = ? AND s.agent_id = ? AND s.id = ?
    `);
    try {
      const project = projects.create(owner.id, 'Fork Project');
      projects.updateInstruction(owner.id, project.id, 'Keep instruction');
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'source', projectId: project.id });
      sendToWebClient.mockImplementationOnce(async (client, reply) => {
        expect(client).toBe(ownerTab);
        expect(reply).toMatchObject({ ...forkResult(), agentId: 'agent-a', projectsAuthoritative: true });
        expect(persistedSession.get(owner.id, 'agent-a', 'target')).toEqual({
          id: 'target', projectId: project.id, projectInstruction: 'Keep instruction',
        });
        expect(reply.projects).toContainEqual(expect.objectContaining({
          id: project.id, instruction: 'Keep instruction', sessionIds: ['source', 'target'],
        }));
        client.sent.push(reply);
      });
      await handleAgentOutput('agent-a', agent, forkResult());
      expect(ownerTab.sent).toHaveLength(1);
      expect(otherTab.sent).toEqual([]);
      expect(sessions.getForAgent(owner.id, 'agent-a', 'target')).toMatchObject({ name: 'Fork' });

      // Identical Session ids must neither inherit foreign membership nor hit its replay fence.
      await handleAgentOutput('agent-b', agent, forkResult());
      await handleAgentOutput('agent-a', otherAgent, forkResult());
      await handleAgentOutput('agent-a', agent, forkResult('standalone', 'standalone-target'));
      for (const [userId, agentId, sessionId] of [
        [owner.id, 'agent-b', 'target'], [other.id, 'agent-a', 'target'],
        [owner.id, 'agent-a', 'standalone-target'],
      ]) {
        expect(persistedSession.get(userId, agentId, sessionId)).toEqual({
          id: sessionId, projectId: null, projectInstruction: null,
        });
        expect(projects.contextForSession(userId, agentId, sessionId)).toBeNull();
      }
      expect(ownerTab.sent).toHaveLength(3);
      expect(otherTab.sent).toEqual([expect.objectContaining({
        ...forkResult(), agentId: 'agent-a', projects: [], projectsAuthoritative: true,
      })]);

      const movedProject = projects.create(owner.id, 'User destination');
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'target', projectId: movedProject.id });
      await handleAgentOutput('agent-a', agent, forkResult());
      await handleAgentOutput('agent-a', agent, {
        type: 'yeaft_output', conversationId: 'yeaft-agent-a', event: forkResult(),
      });
      expect(ownerTab.sent.at(-1)).toMatchObject({ type: 'yeaft_output', event: { ok: true } });
      expect(persistedSession.get(owner.id, 'agent-a', 'target').projectId).toBe(movedProject.id);

      // Fail inside the real inheritance INSERT, after the handler registered the target.
      db.exec(`CREATE TRIGGER fail_fork_inheritance AFTER INSERT ON yeaft_project_sessions
        WHEN NEW.session_id = 'partial'
        BEGIN SELECT RAISE(ABORT, 'forced inheritance failure'); END`);
      sendToWebClient.mockImplementationOnce(async (client, reply) => {
        expect(client).toBe(ownerTab);
        expect(reply).toMatchObject({
          ...forkResult('source', 'partial'), ok: false, agentId: 'agent-a',
          error: { code: 'project_inheritance_failed', message: expect.any(String) },
        });
        expect(persistedSession.get(owner.id, 'agent-a', 'partial')).toBeUndefined();
        expect(projects.contextForSession(owner.id, 'agent-a', 'partial')).toBeNull();
        client.sent.push(reply);
      });
      await handleAgentOutput('agent-a', agent, forkResult('source', 'partial'));
      expect(ownerTab.sent).toHaveLength(6);
      expect(ownerTab.sent.at(-1)).toMatchObject({ ok: false, error: { code: 'project_inheritance_failed' } });
      expect(sessions.getForAgent(owner.id, 'agent-a', 'partial')).toBeUndefined();
      expect(projects.contextForSession(owner.id, 'agent-a', 'source').projectId).toBe(project.id);
      expect(persistedSession.get(owner.id, 'agent-a', 'target').projectId).toBe(movedProject.id);
      expect(otherTab.sent).toHaveLength(1);

      // Merge inherits only the initiator's authoritative Project and cannot
      // reuse either source identity. The two sources keep their membership.
      const mergeProject = projects.create(owner.id, 'Other branch Project');
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'other-source', projectId: mergeProject.id });
      const mergeResult = { ...forkResult('source', 'merged'), op: 'merge', otherSessionId: 'other-source' };
      await handleAgentOutput('agent-a', agent, mergeResult);
      expect(ownerTab.sent.at(-1)).toMatchObject({ ...mergeResult, agentId: 'agent-a', projectsAuthoritative: true });
      expect(persistedSession.get(owner.id, 'agent-a', 'merged').projectId).toBe(project.id);
      expect(projects.contextForSession(owner.id, 'agent-a', 'source').projectId).toBe(project.id);
      expect(projects.contextForSession(owner.id, 'agent-a', 'other-source').projectId).toBe(mergeProject.id);
      for (const target of ['source', 'other-source']) {
        await handleAgentOutput('agent-a', agent, { ...mergeResult, sessionId: target, session: { id: target, name: 'Invalid' } });
        expect(ownerTab.sent.at(-1)).toMatchObject({ ok: false, error: { code: 'project_inheritance_failed' } });
      }
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'merged', projectId: movedProject.id });
      await handleAgentOutput('agent-a', agent, mergeResult);
      expect(persistedSession.get(owner.id, 'agent-a', 'merged').projectId).toBe(movedProject.id);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_fork_inheritance');
      observer.close();
      sendToWebClient.mockImplementation(async (client, msg) => { client.sent.push(msg); });
    }
  });
  it('scopes both merge inputs to the requested owner and Agent, never currentAgent or browser Project metadata', async () => {
    CONFIG.skipAuth = false;
    const owner = userDb.getOrCreate('merge-route-owner');
    const otherOwner = userDb.getOrCreate('merge-route-other');
    const client = { userId: owner.id, currentAgent: 'wrong-agent', sent: [] };
    agents.set('merge-agent', { ownerId: owner.id, ws: { readyState: 1 }, capabilities: ['session_merge'] });
    sessions.upsertFromSnapshot(owner.id, 'merge-agent', { id: 'merge-source' });
    sessions.upsertFromSnapshot(owner.id, 'merge-agent', { id: 'merge-other' });
    sessions.upsertFromSnapshot(owner.id, 'other-agent', { id: 'different-agent-only' });
    sessions.upsertFromSnapshot(otherOwner.id, 'merge-agent', { id: 'foreign-owner-only' });
    const request = {
      type: 'yeaft_merge_sessions', agentId: 'merge-agent', requestId: 'merge-route',
      sessionId: 'merge-source', otherSessionId: 'merge-other', name: 'Merged',
    };
    const check = vi.fn(async () => { throw new Error('Uncorrelated access checker must not run'); });
    expect(await handleClientConversation('merge-client', client, {
      ...request, projectId: 'forged-project', otherAgentId: 'other-agent', ownerId: otherOwner.id,
    }, check)).toBe(true);
    expect(forwardToAgent).toHaveBeenCalledExactlyOnceWith('merge-agent', {
      type: request.type, requestId: request.requestId, sessionId: request.sessionId,
      otherSessionId: request.otherSessionId, name: request.name,
    });
    expect(client.sent).toEqual([]);
    forwardToAgent.mockClear();
    for (const field of ['sessionId', 'otherSessionId']) {
      const denied = { ...request, [field]: field === 'sessionId' ? 'foreign-owner-only' : 'different-agent-only' };
      await handleClientConversation('merge-client', client, denied, check);
      expect(client.sent.at(-1)).toMatchObject({
        type: 'session_crud_result', op: 'merge', requestId: request.requestId,
        agentId: request.agentId, sourceSessionId: denied.sessionId, otherSessionId: denied.otherSessionId,
        ok: false, error: { code: 'agent_access_denied' },
      });
    }
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(client.sent).toHaveLength(2);
    for (const otherSessionId of ['', null, request.sessionId]) {
      await handleClientConversation('merge-client', client, { ...request, otherSessionId }, check);
      expect(client.sent.at(-1)).toMatchObject({
        requestId: request.requestId, sourceSessionId: request.sessionId, otherSessionId,
        ok: false, error: { code: 'invalid_merge_source' },
      });
    }
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('correlates merge failures when no Agent is selected, missing, or offline', async () => {
    CONFIG.skipAuth = false;
    agents.set('merge-offline', { ownerId: 'user-1', ws: { readyState: 3 }, capabilities: ['session_merge'] });
    const client = { userId: 'user-1', sent: [] };
    for (const agentId of [null, 'missing-agent', 'merge-offline']) {
      client.sent = [];
      await handleClientConversation('merge-client', client, {
        type: 'yeaft_merge_sessions', agentId, requestId: 'merge-unavailable',
        sessionId: 'source', otherSessionId: 'other',
      }, allow);
      expect(client.sent).toEqual([{
        type: 'session_crud_result', op: 'merge', ok: false, requestId: 'merge-unavailable',
        agentId, sourceSessionId: 'source', otherSessionId: 'other',
        error: { code: 'agent_unavailable', message: expect.any(String) },
      }]);
    }
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('rejects foreign-Agent merges with one correlated result instead of the generic ACL error', async () => {
    CONFIG.skipAuth = false;
    agents.set('foreign-merge-agent', { ownerId: 'user-2', ws: { readyState: 1 }, capabilities: ['session_merge'] });
    const client = { userId: 'user-1', sent: [] };
    const check = vi.fn(async () => false);
    await handleClientConversation('merge-client', client, {
      type: 'yeaft_merge_sessions', agentId: 'foreign-merge-agent', requestId: 'merge-denied',
      sessionId: 'source', otherSessionId: 'other',
    }, check);
    expect(client.sent).toEqual([{
      type: 'session_crud_result', op: 'merge', ok: false, requestId: 'merge-denied',
      agentId: 'foreign-merge-agent', sourceSessionId: 'source', otherSessionId: 'other',
      error: { code: 'agent_access_denied', message: expect.any(String) },
    }]);
    expect(check).not.toHaveBeenCalled();
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('rejects merge on an older Agent with the original request and both Session identities', async () => {
    CONFIG.skipAuth = false;
    agents.set('old-merge-agent', { ownerId: 'user-1', ws: { readyState: 1 } });
    const client = { userId: 'user-1', currentAgent: 'old-merge-agent', sent: [] };
    await handleClientConversation('merge-client', client, {
      type: 'unify_merge_sessions', requestId: 'merge-unsupported', sessionId: 'source', otherSessionId: 'other',
    }, allow);
    expect(client.sent).toEqual([{
      type: 'session_crud_result', op: 'merge', ok: false, requestId: 'merge-unsupported',
      agentId: 'old-merge-agent', sourceSessionId: 'source', otherSessionId: 'other',
      error: { code: 'session_merge_unsupported', message: expect.any(String) },
    }]);
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('reports unsuccessful and thrown merge dispatches without leaving the request pending', async () => {
    CONFIG.skipAuth = false;
    const owner = userDb.getOrCreate('merge-dispatch-owner');
    agents.set('merge-agent', { ownerId: owner.id, ws: { readyState: 1 }, capabilities: ['session_merge'] });
    sessions.upsertFromSnapshot(owner.id, 'merge-agent', { id: 'dispatch-source' });
    sessions.upsertFromSnapshot(owner.id, 'merge-agent', { id: 'dispatch-other' });
    const client = { userId: owner.id, currentAgent: 'merge-agent', sent: [] };
    forwardToAgent.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('socket closed'));
    for (const requestId of ['merge-false', 'merge-throw']) {
      await handleClientConversation('merge-client', client, {
        type: 'yeaft_merge_sessions', requestId, sessionId: 'dispatch-source', otherSessionId: 'dispatch-other',
      }, allow);
      expect(client.sent.at(-1)).toEqual({
        type: 'session_crud_result', op: 'merge', ok: false, requestId,
        agentId: 'merge-agent', sourceSessionId: 'dispatch-source', otherSessionId: 'dispatch-other',
        error: { code: 'agent_unavailable', message: expect.any(String) },
      });
    }
    expect(client.sent).toHaveLength(2);
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
  });

  it('keeps the fork-from-turn capability guard without blocking whole-Session copies', async () => {
    CONFIG.skipAuth = false;
    const agent = { ownerId: 'user-1', ws: { readyState: 1 }, capabilities: ['session_merge'] };
    agents.set('fork-agent', agent);
    const client = { userId: 'user-1', currentAgent: 'fork-agent', sent: [] };
    const copy = { type: 'yeaft_copy_session', requestId: 'fork-turn', sessionId: 'source' };
    // Presence matters: even malformed/empty boundaries must never become full copies on old Agents.
    await handleClientConversation('fork-client', client, { ...copy, throughTurnId: '' }, allow);
    expect(client.sent).toEqual([{
      type: 'session_crud_result', op: 'copy', requestId: copy.requestId, agentId: 'fork-agent', ok: false,
      error: { code: 'session_fork_from_turn_unsupported', message: expect.any(String) },
    }]);
    expect(forwardToAgent).not.toHaveBeenCalled();
    await handleClientConversation('fork-client', client, copy, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('fork-agent', copy);
    agent.capabilities.push('session_fork_from_turn');
    await handleClientConversation('fork-client', client, { ...copy, throughTurnId: 'turn-1' }, allow);
    expect(forwardToAgent).toHaveBeenLastCalledWith('fork-agent', { ...copy, throughTurnId: 'turn-1' });
    expect(forwardToAgent).toHaveBeenCalledTimes(2);
    expect(client.sent).toHaveLength(1);
  });

  it('hydrates owner inventory as separate Agent slices and excludes disconnected Agents', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-a', { ws: { readyState: 1 }, ownerId: 'user-1', conversations: new Map() });
    agents.set('agent-b', { ws: { readyState: 1 }, ownerId: 'user-1', conversations: new Map() });
    agents.set('agent-closed', { ws: { readyState: 3 }, ownerId: 'user-1' });
    agents.set('agent-foreign', { ws: { readyState: 1 }, ownerId: 'user-2' });
    const a = { id: 'same-id', agentId: 'agent-a', name: 'A' };
    const b = { id: 'same-id', agentId: 'agent-b', name: 'B' };
    getByUser.mockReturnValue([a, b, { id: 'closed', agentId: 'agent-closed' }]);
    const client = { userId: 'user-1', sent: [] };
    await handleClientConversation('inventory-client', client, { type: 'get_agents', requestId: 'inventory' }, allow);
    expect(getByUser).toHaveBeenCalledWith('user-1');
    expect(client.sent).toEqual([
      { type: 'yeaft_session_hydrate', requestId: 'inventory', agentId: 'agent-a', sessions: [a], fromDb: true },
      { type: 'yeaft_session_hydrate', requestId: 'inventory', agentId: 'agent-b', sessions: [b], fromDb: true },
      { type: 'yeaft_session_hydrate_complete', requestId: 'inventory', ok: true },
    ]);
    expect(sendToWebClient.mock.invocationCallOrder[1]).toBeLessThan(broadcastAgentList.mock.invocationCallOrder[0]);
    expect(broadcastAgentList.mock.invocationCallOrder[0]).toBeLessThan(sendToWebClient.mock.invocationCallOrder[2]);
  });

  it('drops private history for a disconnected requester instead of broadcasting to sibling tabs', async () => {
    CONFIG.skipAuth = false;
    const ownerTab = { authenticated: true, userId: 'user-1', sent: [], ws: { readyState: 1 } };
    const foreignTab = { authenticated: true, userId: 'user-2', sent: [], ws: { readyState: 1 } };
    webClients.set('owner-tab', ownerTab);
    webClients.set('foreign-tab', foreignTab);
    const agent = { ownerId: 'user-1', conversations: new Map(), ws: { readyState: 1, send() {} } };
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_history_chunk', conversationId: 'yeaft-agent-a', sessionId: 'same-id',
      requestId: 'history-gone', _requestClientId: 'closed-tab', messages: [{ role: 'user', content: 'private history' }],
    });
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output', conversationId: 'yeaft-agent-a', sessionId: 'same-id',
      requestId: 'history-gone', _requestClientId: 'closed-tab',
      event: { type: 'history_loaded', sessionId: 'same-id', requestId: 'history-gone' },
    });
    expect(ownerTab.sent).toEqual([]);
    expect(foreignTab.sent).toEqual([]);
    expect(forwardToClients).not.toHaveBeenCalled();
  });
});
