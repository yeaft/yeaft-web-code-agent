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

  it('persists fork Project inheritance before replying, rolls back failures, fences owner/Agent scopes and replays, and keeps nested folder context', async () => {
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

      // Nested folders: a fork joins its source's own folder, and the Agent
      // context carries the folder path, every instruction on it (outermost
      // first) and recall across the whole top-level folder.
      const outer = projects.create(owner.id, 'Outer');
      projects.updateInstruction(owner.id, outer.id, 'Outer rule');
      projects.move(owner.id, project.id, { parentId: outer.id });
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'outer-sibling', projectId: outer.id });
      await handleAgentOutput('agent-a', agent, forkResult('source', 'nested-fork'));
      expect(persistedSession.get(owner.id, 'agent-a', 'nested-fork').projectId).toBe(project.id);
      const nested = projects.contextForSession(owner.id, 'agent-a', 'nested-fork');
      expect({ ...nested, sessionIds: [...nested.sessionIds].sort() }).toEqual({
        projectId: project.id,
        projectName: 'Outer / Fork Project',
        projectInstruction: '[Outer]\nOuter rule\n\n[Outer / Fork Project]\nKeep instruction',
        sessionIds: ['outer-sibling', 'source'],
      });
      // A single instruction on the path still reaches the Agent verbatim.
      expect(projects.contextForSession(owner.id, 'agent-a', 'outer-sibling').projectInstruction).toBe('Outer rule');
      // Cycles and trees deeper than five levels are refused before any write.
      expect(() => projects.move(owner.id, outer.id, { parentId: project.id }))
        .toThrow(expect.objectContaining({ code: 'project_cycle' }));
      let deepest = project;
      for (const name of ['Level 3', 'Level 4', 'Level 5']) deepest = projects.create(owner.id, name, deepest.id);
      expect(() => projects.create(owner.id, 'Level 6', deepest.id))
        .toThrow(expect.objectContaining({ code: 'project_depth_exceeded' }));
      expect(() => projects.move(owner.id, movedProject.id, { parentId: deepest.id }))
        .toThrow(expect.objectContaining({ code: 'project_depth_exceeded' }));
      expect(projects.list(owner.id).find(row => row.id === movedProject.id).parentId).toBeNull();
      // Deleting a folder removes its subfolders; its Sessions move up a level.
      projects.moveSession(owner.id, { agentId: 'agent-a', sessionId: 'deep', projectId: deepest.id });
      expect(projects.delete(owner.id, project.id)).toMatchObject({ parentId: outer.id });
      expect(projects.list(owner.id).map(row => row.name)).not.toEqual(expect.arrayContaining(['Fork Project']));
      expect(projects.list(owner.id).map(row => row.name)).not.toEqual(expect.arrayContaining(['Level 3']));
      for (const sessionId of ['source', 'nested-fork', 'deep']) {
        expect(projects.contextForSession(owner.id, 'agent-a', sessionId)).toMatchObject({
          projectId: outer.id, projectName: 'Outer', projectInstruction: 'Outer rule',
        });
      }
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

});
