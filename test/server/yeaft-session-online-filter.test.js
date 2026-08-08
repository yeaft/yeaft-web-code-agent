import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectSessionCatalog, yeaftCatalogKey } from '../../server/session-catalog.js';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const forwardToAgent = vi.fn(async () => {});
const broadcastAgentList = vi.fn(async () => {});
const broadcastSessionCatalog = vi.fn(async () => {});
const buildSessionCatalog = vi.fn(() => []);
const buildHiddenSessionCatalog = vi.fn(() => []);
const getByUser = vi.fn(() => []);
const getByAgent = vi.fn(() => []);
const getActiveChatSessions = vi.fn(() => []);
const getSessionUiMetadataByUser = vi.fn(() => []);
const listProjects = vi.fn(() => []);
const listProjectsForAgent = vi.fn(() => listProjects());
const importLegacyProjects = vi.fn(() => false);
const reconcileProjectSessions = vi.fn(() => 0);
const removeProjectSession = vi.fn(() => false);
const createProject = vi.fn(() => ({ id: 'project-created', name: 'Created', members: [] }));
const renameProject = vi.fn();
const updateProjectInstruction = vi.fn();
const deleteProject = vi.fn();
const reorderProjects = vi.fn();
const moveProjectSession = vi.fn();
const contextForSession = vi.fn(() => null);
const getForAgent = vi.fn(() => null);
const deleteYeaftSessionForAgent = vi.fn();
const getSessionUiMetadata = vi.fn(() => null);
const reconcileFromSnapshot = vi.fn();
const upsertFromSnapshot = vi.fn();
const getChatSession = vi.fn(() => null);
const updateChatSession = vi.fn();
const applySessionUiMetadataBatch = vi.fn(() => true);
const deleteSessionUiMetadataForRoute = vi.fn(() => true);
const verifyConversationOwnership = vi.fn(() => true);
const verifyAgentOwnership = vi.fn(() => true);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent,
  broadcastAgentList,
  broadcastSessionCatalog,
  buildSessionCatalog,
  buildHiddenSessionCatalog,
  verifyConversationOwnership,
  verifyAgentOwnership,
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {
    getActiveByUser: getActiveChatSessions,
    getByUser: vi.fn(() => []),
    get: getChatSession,
    update: updateChatSession,
    setActive: vi.fn(),
  },
  messageDb: {},
  userDb: {},
  yeaftProjectDb: {
    list: listProjects,
    listForAgent: listProjectsForAgent,
    importLegacyProjects,
    reconcileAgentSessions: reconcileProjectSessions,
    removeSession: removeProjectSession,
    create: createProject,
    rename: renameProject,
    updateInstruction: updateProjectInstruction,
    delete: deleteProject,
    reorder: reorderProjects,
    moveSession: moveProjectSession,
    contextForSession,
  },
  yeaftSessionDb: {
    getByUser,
    getByAgent,
    getForAgent,
    reconcileFromSnapshot,
    upsertFromSnapshot,
    deleteForAgent: deleteYeaftSessionForAgent,
    setOrderForUser: vi.fn(() => true),
  },
  sessionUiMetadataDb: {
    get: getSessionUiMetadata,
    getByUser: getSessionUiMetadataByUser,
    applyBatch: applySessionUiMetadataBatch,
    deleteForRoute: deleteSessionUiMetadataForRoute,
  },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { CONFIG } = await import('../../server/config.js');
const { agents, pendingYeaftDebugRequests, webClients } = await import('../../server/context.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const {
  groupOnlineYeaftSessions,
  handleClientConversation,
} = await import('../../server/handlers/client-conversation.js');

const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  webClients.clear();
  pendingYeaftDebugRequests.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  getByAgent.mockReset();
  getByAgent.mockReturnValue([]);
  getActiveChatSessions.mockReset();
  getActiveChatSessions.mockReturnValue([]);
  getSessionUiMetadataByUser.mockReset();
  getSessionUiMetadataByUser.mockReturnValue([]);
  listProjects.mockReset();
  listProjects.mockReturnValue([]);
  listProjectsForAgent.mockClear();
  importLegacyProjects.mockClear();
  reconcileProjectSessions.mockClear();
  removeProjectSession.mockClear();
  createProject.mockClear();
  renameProject.mockClear();
  updateProjectInstruction.mockClear();
  deleteProject.mockClear();
  reorderProjects.mockClear();
  moveProjectSession.mockClear();
  contextForSession.mockReset();
  contextForSession.mockReturnValue(null);
  reconcileFromSnapshot.mockClear();
  upsertFromSnapshot.mockClear();
  sendToWebClient.mockClear();
  forwardToAgent.mockClear();
  broadcastAgentList.mockClear();
  broadcastSessionCatalog.mockClear();
  buildSessionCatalog.mockReset();
  buildSessionCatalog.mockReturnValue([]);
  buildHiddenSessionCatalog.mockReset();
  buildHiddenSessionCatalog.mockReturnValue([]);
  getForAgent.mockReset();
  deleteYeaftSessionForAgent.mockClear();
  getSessionUiMetadata.mockReset();
  getSessionUiMetadata.mockReturnValue(null);
  getChatSession.mockReset();
  updateChatSession.mockClear();
  applySessionUiMetadataBatch.mockClear();
  deleteSessionUiMetadataForRoute.mockClear();
  verifyConversationOwnership.mockReset();
  verifyConversationOwnership.mockReturnValue(true);
  verifyAgentOwnership.mockReset();
  verifyAgentOwnership.mockReturnValue(true);
});

describe('Yeaft Session online Agent filtering', () => {
  const verifyCatalogProjection = () => {
    const registry = new Map([
      ['agent-online', { ws: { readyState: 1 } }],
      ['agent-closed', { ws: { readyState: 3 } }],
    ]);

    expect(groupOnlineYeaftSessions([
      { id: 'online-pinned', agentId: 'agent-online', pinned: true },
      { id: 'online-free', agentId: 'agent-online', pinned: false },
      { id: 'closed-pinned', agentId: 'agent-closed', pinned: true },
      { id: 'missing-free', agentId: 'agent-missing', pinned: false },
    ], registry)).toEqual({
      'agent-online': [
        { id: 'online-pinned', agentId: 'agent-online', pinned: true },
        { id: 'online-free', agentId: 'agent-online', pinned: false },
      ],
    });

    const catalog = projectSessionCatalog({
      chatSessions: [
        { id: 'same-id', agent_id: 'chat-agent', title: 'Chat', created_at: 10, updated_at: 50, is_active: 1 },
        { id: 'inactive', agent_id: 'chat-agent', is_active: 0 },
      ],
      yeaftSessions: [
        { id: 'same-id', agentId: 'agent-online', name: 'Online', createdAt: 20, updatedAt: 20 },
        { id: 'same-id', agentId: 'agent-closed', name: 'Closed', createdAt: 30, updatedAt: 30 },
      ],
      metadata: [{ catalogKey: yeaftCatalogKey('agent-online', 'same-id'), pinned: true, sortRank: 1 }],
      onlineAgentIds: new Set(['agent-online']),
    });
    expect(catalog.map(row => row.catalogKey)).toEqual([
      'yeaft:agent-online:same-id',
      'yeaft:agent-closed:same-id',
      'chat:same-id',
    ]);
    const creationOrdered = projectSessionCatalog({
      chatSessions: [
        { id: 'chat-new', agent_id: 'chat-agent', created_at: Date.parse('2026-07-29T12:00:00.000Z'), updated_at: 1, is_active: 1 },
        { id: 'chat-old', agent_id: 'chat-agent', created_at: Date.parse('2026-07-29T10:00:00.000Z'), updated_at: 999, is_active: 1 },
      ],
      yeaftSessions: [
        { id: 'yeaft-middle-new', agentId: 'agent-online', createdAt: '2026-07-29T11:30:00.000Z', updatedAt: '2026-07-29T20:00:00.000Z' },
        { id: 'yeaft-middle-old', agentId: 'agent-online', createdAt: '2026-07-29T11:00:00.000Z', updatedAt: '2026-07-29T21:00:00.000Z' },
      ],
      onlineAgentIds: new Set(['agent-online', 'chat-agent']),
    });
    const reversedAfterActivity = projectSessionCatalog({
      chatSessions: [
        { id: 'chat-old', agent_id: 'chat-agent', created_at: Date.parse('2026-07-29T10:00:00.000Z'), updated_at: 5000, is_active: 1 },
        { id: 'chat-new', agent_id: 'chat-agent', created_at: Date.parse('2026-07-29T12:00:00.000Z'), updated_at: 2, is_active: 1 },
      ],
      yeaftSessions: [
        { id: 'yeaft-middle-new', agentId: 'agent-online', createdAt: '2026-07-29T11:30:00.000Z', updatedAt: '2026-07-30T20:00:00.000Z' },
        { id: 'yeaft-middle-old', agentId: 'agent-online', createdAt: '2026-07-29T11:00:00.000Z', updatedAt: '2026-07-30T21:00:00.000Z' },
      ].reverse(),
      onlineAgentIds: new Set(['agent-online', 'chat-agent']),
    });
    const stableCreationOrder = [
      'chat:chat-new',
      'yeaft:agent-online:yeaft-middle-new',
      'yeaft:agent-online:yeaft-middle-old',
      'chat:chat-old',
    ];
    expect(creationOrdered.map(row => row.catalogKey)).toEqual(stableCreationOrder);
    expect(reversedAfterActivity.map(row => row.catalogKey)).toEqual(stableCreationOrder);
    const manuallyOrdered = projectSessionCatalog({
      chatSessions: [
        { id: 'manual-a', agent_id: 'chat-agent', created_at: 4000, metadata_updated_at: 4000, is_active: 1 },
        { id: 'manual-b', agent_id: 'chat-agent', created_at: 3000, metadata_updated_at: 3000, is_active: 1 },
      ],
      yeaftSessions: [
        { id: 'manual-c', agentId: 'agent-online', createdAt: 2000, metadataUpdatedAt: 2000 },
      ],
      metadata: [
        { catalogKey: 'chat:manual-a', sortRank: 2 },
        { catalogKey: 'chat:manual-b', sortRank: 0 },
        { catalogKey: 'yeaft:agent-online:manual-c', sortRank: 1 },
      ],
      onlineAgentIds: new Set(['agent-online', 'chat-agent']),
    });
    expect(manuallyOrdered.map(row => row.catalogKey)).toEqual([
      'chat:manual-b',
      'yeaft:agent-online:manual-c',
      'chat:manual-a',
    ]);
    const partiallyRanked = projectSessionCatalog({
      chatSessions: [
        { id: 'ranked', agent_id: 'chat-agent', created_at: 1000, is_active: 1 },
        { id: 'new-unranked', agent_id: 'chat-agent', created_at: 3000, is_active: 1 },
        { id: 'old-unranked', agent_id: 'chat-agent', created_at: 2000, is_active: 1 },
      ],
      metadata: [{ catalogKey: 'chat:ranked', sortRank: 4 }],
      onlineAgentIds: new Set(['chat-agent']),
    });
    expect(partiallyRanked.map(row => row.catalogKey)).toEqual([
      'chat:new-unranked',
      'chat:old-unranked',
      'chat:ranked',
    ]);
    const duplicateRanks = projectSessionCatalog({
      chatSessions: [
        { id: 'duplicate-new', agent_id: 'chat-agent', created_at: 3000, metadata_updated_at: 3000, is_active: 1 },
        { id: 'duplicate-middle', agent_id: 'chat-agent', created_at: 2000, metadata_updated_at: 2000, is_active: 1 },
        { id: 'duplicate-old', agent_id: 'chat-agent', created_at: 1000, metadata_updated_at: 1000, is_active: 1 },
      ],
      metadata: [
        { catalogKey: 'chat:duplicate-new', sortRank: 1 },
        { catalogKey: 'chat:duplicate-middle', sortRank: 0 },
        { catalogKey: 'chat:duplicate-old', sortRank: 0 },
      ],
      onlineAgentIds: new Set(['chat-agent']),
    });
    expect(duplicateRanks.map(row => row.catalogKey)).toEqual([
      'chat:duplicate-new',
      'chat:duplicate-middle',
      'chat:duplicate-old',
    ]);
    const legacyAgentRanks = projectSessionCatalog({
      chatSessions: [
        { id: 'chat-newest', agent_id: 'chat-agent', provider: 'copilot', created_at: 4000, metadata_updated_at: 4000, is_active: 1 },
        { id: 'chat-oldest', agent_id: 'chat-agent', created_at: 1000, metadata_updated_at: 1000, is_active: 1 },
      ],
      yeaftSessions: [
        { id: 'agent-a-new', agentId: 'agent-a', sortOrder: 0, createdAt: 3000, metadataUpdatedAt: 3000 },
        { id: 'agent-a-old', agentId: 'agent-a', sortOrder: 1, createdAt: 500, metadataUpdatedAt: 500 },
        { id: 'agent-b-middle', agentId: 'agent-b', sortOrder: 0, createdAt: 2000, metadataUpdatedAt: 2000 },
      ],
      onlineAgentIds: new Set(['agent-a', 'agent-b', 'chat-agent']),
    });
    expect(legacyAgentRanks.map(row => row.catalogKey)).toEqual([
      'chat:chat-newest',
      'yeaft:agent-a:agent-a-new',
      'yeaft:agent-b:agent-b-middle',
      'chat:chat-oldest',
      'yeaft:agent-a:agent-a-old',
    ]);
    expect(legacyAgentRanks.every(row => row.sortRank === null)).toBe(true);
    const reorderedAfterSettings = projectSessionCatalog({
      chatSessions: [
        { id: 'chat-new', agent_id: 'chat-agent', created_at: 4000, updated_at: 9000, metadata_updated_at: 4000, is_active: 1 },
        { id: 'chat-old', agent_id: 'chat-agent', created_at: 1000, updated_at: 1000, metadata_updated_at: 6000, is_active: 1 },
      ],
      yeaftSessions: [
        { id: 'yeaft-new', agentId: 'agent-online', createdAt: 3000, updatedAt: 8000, metadataUpdatedAt: 3000 },
        { id: 'yeaft-old', agentId: 'agent-online', createdAt: 2000, updatedAt: 2000, metadataUpdatedAt: 5000 },
      ],
      onlineAgentIds: new Set(['agent-online', 'chat-agent']),
    });
    expect(reorderedAfterSettings.map(row => row.catalogKey)).toEqual([
      'chat:chat-old',
      'yeaft:agent-online:yeaft-old',
      'chat:chat-new',
      'yeaft:agent-online:yeaft-new',
    ]);
    expect(catalog.map(row => row.availability)).toEqual(['online', 'offline', 'offline']);
    expect(catalog.some(row => row.catalogKey === 'chat:inactive')).toBe(false);
    const hiddenRows = projectSessionCatalog({
      yeaftSessions: [{ id: 'hidden', agentId: 'agent-online', name: 'Hidden', createdAt: 10 }],
      metadata: [{ catalogKey: yeaftCatalogKey('agent-online', 'hidden'), hidden: true }],
      onlineAgentIds: new Set(['agent-online']),
    });
    expect(hiddenRows).toEqual([]);
    expect(projectSessionCatalog({
      yeaftSessions: [{ id: 'hidden', agentId: 'agent-online', name: 'Hidden', createdAt: 10 }],
      metadata: [{ catalogKey: yeaftCatalogKey('agent-online', 'hidden'), hidden: true }],
      onlineAgentIds: new Set(['agent-online']),
      includeHidden: true,
    })).toEqual([
      expect.objectContaining({
        catalogKey: 'yeaft:agent-online:hidden',
        hidden: true,
      }),
    ]);
    expect(() => projectSessionCatalog({
      chatSessions: [{ id: 'bad', agent_id: 'a', provider: 'mystery', is_active: 1 }],
    })).toThrow(/Unknown Chat runtime provider/);
  };

  it('projects canonical availability and handles catalog lifecycle updates', async () => {
    verifyCatalogProjection();
    CONFIG.skipAuth = false;
    agents.set('agent-online', {
      ws: { readyState: 1 },
      ownerId: 'user-1',
      conversations: new Map(),
    });
    agents.set('agent-closed', {
      ws: { readyState: 3 },
      ownerId: 'user-1',
      conversations: new Map(),
    });
    getByUser.mockReturnValue([
      { id: 'online-pinned', agentId: 'agent-online', pinned: true },
      { id: 'online-free', agentId: 'agent-online', pinned: false },
      { id: 'closed-pinned', agentId: 'agent-closed', pinned: true },
      { id: 'missing-free', agentId: 'agent-missing', pinned: false },
    ]);
    const client = {
      userId: 'user-1',
      username: 'user',
      sent: [],
    };

    await handleClientConversation('client-1', client, { type: 'get_agents' }, allow);

    expect(broadcastAgentList).toHaveBeenCalledOnce();
    expect(sendToWebClient.mock.invocationCallOrder[0])
      .toBeLessThan(broadcastAgentList.mock.invocationCallOrder[0]);
    expect(broadcastAgentList.mock.invocationCallOrder[0])
      .toBeLessThan(sendToWebClient.mock.invocationCallOrder.at(-1));
    expect(client.sent).toEqual([
      {
        type: 'yeaft_session_hydrate',
        agentId: 'agent-online',
        sessions: [
          { id: 'online-pinned', agentId: 'agent-online', pinned: true },
          { id: 'online-free', agentId: 'agent-online', pinned: false },
        ],
        fromDb: true,
      },
      { type: 'yeaft_session_hydrate_complete', ok: true },
    ]);

    getByUser.mockReturnValue([]);
    agents.clear();
    client.sent = [];
    sendToWebClient.mockClear();
    broadcastAgentList.mockClear();
    await handleClientConversation('client-1', client, { type: 'get_agents' }, allow);
    expect(client.sent).toEqual([
      { type: 'yeaft_session_hydrate', agentId: null, sessions: [], fromDb: true },
      { type: 'yeaft_session_hydrate_complete', ok: true },
    ]);
    expect(sendToWebClient.mock.invocationCallOrder[0])
      .toBeLessThan(broadcastAgentList.mock.invocationCallOrder[0]);
    expect(broadcastAgentList.mock.invocationCallOrder[0])
      .toBeLessThan(sendToWebClient.mock.invocationCallOrder.at(-1));

    agents.set('agent-online', {
      ws: { readyState: 1 }, ownerId: 'user-1', conversations: new Map(),
    });

    const vpClient = { userId: 'user-1', sent: [] };
    await handleClientConversation('client-vp', vpClient, {
      type: 'yeaft_vp_subscribe', agentId: 'missing-agent', requestId: 'vp-offline',
    }, allow);
    expect(vpClient.sent).toEqual([{
      type: 'yeaft_output',
      agentId: 'missing-agent',
      requestId: 'vp-offline',
      event: {
        type: 'vp_snapshot_error',
        error: 'The selected Agent is offline.',
      },
    }]);
    expect(forwardToAgent).not.toHaveBeenCalledWith('missing-agent', expect.anything());

    client.sent = [];
    await handleClientConversation('client-1', client, {
      type: 'select_agent', agentId: 'agent-online', requestId: 'agent-select-1',
    }, allow);
    expect(client.sent.at(-1)).toMatchObject({
      type: 'agent_selected', agentId: 'agent-online', requestId: 'agent-select-1',
    });

    agents.set('agent-a', {
      ws: { readyState: 1 }, ownerId: 'user-1', name: 'Agent A', conversations: new Map(),
    });
    agents.set('agent-b', {
      ws: { readyState: 1 }, ownerId: 'user-1', name: 'Agent B', conversations: new Map(),
    });
    const raceClient = { userId: 'user-1', sent: [] };
    let releaseAgentA;
    let markAgentAStarted;
    const agentAStarted = new Promise(resolve => { markAgentAStarted = resolve; });
    const agentAGate = new Promise(resolve => { releaseAgentA = resolve; });
    const checkRaceAccess = async (agentId) => {
      if (agentId === 'agent-a') {
        markAgentAStarted();
        await agentAGate;
      }
      return true;
    };
    const slowA = handleClientConversation('client-race', raceClient, {
      type: 'select_agent', agentId: 'agent-a', requestId: 'select-a',
    }, checkRaceAccess);
    await agentAStarted;
    await handleClientConversation('client-race', raceClient, {
      type: 'select_agent', agentId: 'agent-b', requestId: 'select-b',
    }, checkRaceAccess);
    releaseAgentA();
    await slowA;
    expect(raceClient.currentAgent).toBe('agent-b');
    expect(raceClient.sent).toEqual([
      expect.objectContaining({ type: 'agent_selected', agentId: 'agent-b', requestId: 'select-b' }),
    ]);

    const restoreRaceClient = { userId: 'user-1', currentAgent: 'agent-b', sent: [] };
    let releaseExplicitA;
    let markExplicitAStarted;
    const explicitAStarted = new Promise(resolve => { markExplicitAStarted = resolve; });
    const explicitAGate = new Promise(resolve => { releaseExplicitA = resolve; });
    const checkExplicitRaceAccess = async (agentId) => {
      if (agentId === 'agent-a') {
        markExplicitAStarted();
        await explicitAGate;
      }
      return true;
    };
    const explicitA = handleClientConversation('client-restore-race', restoreRaceClient, {
      type: 'select_agent', agentId: 'agent-a', requestId: 'explicit-a',
    }, checkExplicitRaceAccess);
    await explicitAStarted;
    await handleClientConversation('client-restore-race', restoreRaceClient, {
      type: 'select_agent', agentId: 'agent-b', silent: true,
    }, checkExplicitRaceAccess);
    expect(restoreRaceClient.currentAgent).toBe('agent-b');
    expect(restoreRaceClient.sent).toEqual([]);
    releaseExplicitA();
    await explicitA;
    expect(restoreRaceClient.currentAgent).toBe('agent-a');
    expect(restoreRaceClient.pendingAgentSelectionGeneration).toBeNull();
    expect(restoreRaceClient.sent).toEqual([
      expect.objectContaining({ type: 'agent_selected', agentId: 'agent-a', requestId: 'explicit-a' }),
    ]);

    const staleRestoreClient = { userId: 'user-1', currentAgent: 'agent-b', sent: [] };
    let releaseSilentB;
    let markSilentBStarted;
    const silentBStarted = new Promise(resolve => { markSilentBStarted = resolve; });
    const silentBGate = new Promise(resolve => { releaseSilentB = resolve; });
    const checkStaleRestoreAccess = async (agentId) => {
      if (agentId === 'agent-b') {
        markSilentBStarted();
        await silentBGate;
      }
      return true;
    };
    const silentB = handleClientConversation('client-stale-restore', staleRestoreClient, {
      type: 'select_agent', agentId: 'agent-b', silent: true,
    }, checkStaleRestoreAccess);
    await silentBStarted;
    await handleClientConversation('client-stale-restore', staleRestoreClient, {
      type: 'select_agent', agentId: 'agent-a', requestId: 'explicit-after-restore',
    }, checkStaleRestoreAccess);
    releaseSilentB();
    await silentB;
    expect(staleRestoreClient.currentAgent).toBe('agent-a');
    expect(staleRestoreClient.sent).toEqual([
      expect.objectContaining({
        type: 'agent_selected', agentId: 'agent-a', requestId: 'explicit-after-restore',
      }),
    ]);

    await handleClientConversation('client-1', client, {
      type: 'reorder_yeaft_sessions',
      sessions: [{ agentId: 'agent-online', sessionId: 'online-free' }],
      requestId: 'reorder-1',
    }, allow);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');
    expect(client.sent.at(-1)).toMatchObject({
      type: 'session_crud_result',
      op: 'reorder',
      requestId: 'reorder-1',
      ok: true,
    });

    // Unified ordering validates the complete canonical identity batch before
    // committing any metadata writes.
    CONFIG.skipAuth = true;
    getForAgent.mockImplementation((_userId, agentId, sessionId) => (
      sessionId === 'same-id' ? { id: sessionId, agentId } : null
    ));
    getChatSession.mockReturnValue({ id: 'chat-1', agent_id: 'agent-a', provider: 'copilot' });
    const catalogClient = { userId: 'user-1', role: 'user', sent: [] };
    const sessions = [
      {
        catalogKey: 'yeaft:agent-a:same-id',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
        pinned: true,
      },
      {
        catalogKey: 'yeaft:agent-b:same-id',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'same-id' },
        pinned: false,
      },
      {
        catalogKey: 'chat:chat-1',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'chat-1' },
        pinned: false,
      },
    ];
    buildSessionCatalog.mockReturnValue(sessions.map(row => ({
      ...row,
      pinned: row.pinned === true,
    })));

    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      sessions,
    }, allow);

    expect(applySessionUiMetadataBatch).toHaveBeenCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'yeaft:agent-a:same-id', sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'yeaft:agent-b:same-id', sortRank: 1 }),
      expect.objectContaining({ catalogKey: 'chat:chat-1', sortRank: 2 }),
    ]);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_catalog_reorder_result',
      ok: true,
    });

    // Offline catalog rows are authorized by their persisted composite route;
    // the online Agent registry is irrelevant to metadata durability.
    CONFIG.skipAuth = false;
    verifyAgentOwnership.mockReturnValue(false);
    verifyConversationOwnership.mockReturnValue(true);
    getForAgent.mockReturnValue({ id: 'offline-yeaft', agentId: 'agent-offline' });
    getChatSession.mockReturnValue({ id: 'offline-chat', user_id: 'user-1', agent_id: 'agent-offline', provider: 'copilot' });
    const offlineSessions = [
        {
          catalogKey: 'yeaft:agent-offline:offline-yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-offline', sessionId: 'offline-yeaft' },
          pinned: true,
        },
        {
          catalogKey: 'chat:offline-chat',
          routeRef: { runtimeProvider: 'copilot', agentId: 'agent-offline', sessionId: 'offline-chat' },
          pinned: false,
        },
      ];
    buildSessionCatalog.mockReturnValue(offlineSessions);
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      requestId: 'offline-order',
      sessions: offlineSessions,
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'yeaft:agent-offline:offline-yeaft', sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'chat:offline-chat', sortRank: 1 }),
    ]);
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_catalog_reorder_result',
      requestId: 'offline-order',
      ok: true,
    });

    // A drag payload contains only visible rows. The server appends hidden
    // rows to the same transaction so a later restore cannot duplicate a
    // visible rank.
    CONFIG.skipAuth = true;
    const visibleRows = [
      {
        catalogKey: 'chat:visible-c',
        routeRef: { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: 'visible-c' },
        pinned: false,
      },
      {
        catalogKey: 'chat:visible-a',
        routeRef: { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: 'visible-a' },
        pinned: false,
      },
    ];
    const hiddenRow = {
      catalogKey: 'chat:hidden-b',
      routeRef: { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: 'hidden-b' },
      pinned: false,
      hidden: true,
    };
    buildSessionCatalog.mockReturnValue(visibleRows);
    buildHiddenSessionCatalog.mockReturnValue([hiddenRow]);
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      requestId: 'visible-only-order',
      sessions: visibleRows,
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'chat:visible-c', sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'chat:visible-a', sortRank: 1 }),
      expect.objectContaining({ catalogKey: 'chat:hidden-b', hidden: true, sortRank: 2 }),
    ]);

    // Restore re-normalizes the full catalog atomically. Its result has one
    // rank per row even after a prior visible-only reorder.
    getChatSession.mockReturnValue({ id: 'hidden-b', user_id: 'user-1', agent_id: 'agent-a', provider: null, is_pinned: 0 });
    getSessionUiMetadata.mockReturnValue({ pinned: false, hidden: true, sortRank: 2 });
    buildSessionCatalog.mockReturnValue(visibleRows);
    buildHiddenSessionCatalog.mockReturnValue([hiddenRow]);
    catalogClient.sent = [];
    await handleClientConversation('client-1', catalogClient, {
      type: 'set_session_ui_metadata',
      requestId: 'restore-after-visible-order',
      catalogKey: 'chat:hidden-b',
      routeRef: { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: 'hidden-b' },
      hidden: false,
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'chat:visible-c', hidden: false, sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'chat:visible-a', hidden: false, sortRank: 1 }),
      expect.objectContaining({ catalogKey: 'chat:hidden-b', hidden: false, sortRank: 2 }),
    ]);
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_ui_metadata_updated',
      requestId: 'restore-after-visible-order',
      ok: true,
      hidden: false,
    });

    // Sidebar removal is a user-scoped metadata mutation. It must preserve
    // the Agent Session and message storage by never forwarding an archive
    // command; the catalog broadcaster alone removes the row from view.
    getForAgent.mockReturnValue({ id: 'same-id', agentId: 'agent-a', isArchived: false, pinned: true });
    getSessionUiMetadata.mockReturnValue({ pinned: true, hidden: false, sortRank: 3 });
    buildSessionCatalog.mockReturnValue([{
      catalogKey: 'yeaft:agent-a:same-id',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
      pinned: true,
      hidden: false,
    }]);
    buildHiddenSessionCatalog.mockReturnValue([]);
    catalogClient.sent = [];
    await handleClientConversation('client-1', catalogClient, {
      type: 'set_session_ui_metadata',
      requestId: 'hide-yeaft-row',
      catalogKey: 'yeaft:agent-a:same-id',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
      hidden: true,
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({
        catalogKey: 'yeaft:agent-a:same-id',
        pinned: true,
        hidden: true,
        sortRank: 0,
      }),
    ]);
    expect(forwardToAgent).not.toHaveBeenCalledWith('agent-a', expect.objectContaining({
      type: 'yeaft_archive_session',
    }));
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_ui_metadata_updated',
      requestId: 'hide-yeaft-row',
      ok: true,
      hidden: true,
      pinned: true,
      sortRank: 3,
    });

    getSessionUiMetadata.mockReturnValue({ pinned: true, hidden: true, sortRank: 3 });
    buildSessionCatalog.mockReturnValue([]);
    buildHiddenSessionCatalog.mockReturnValue([{
      catalogKey: 'yeaft:agent-a:same-id',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
      pinned: true,
      hidden: true,
    }]);
    catalogClient.sent = [];
    await handleClientConversation('client-1', catalogClient, {
      type: 'set_session_ui_metadata',
      requestId: 'restore-yeaft-row',
      catalogKey: 'yeaft:agent-a:same-id',
      routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
      hidden: false,
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({
        catalogKey: 'yeaft:agent-a:same-id',
        pinned: true,
        hidden: false,
      }),
    ]);
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_ui_metadata_updated',
      requestId: 'restore-yeaft-row',
      ok: true,
      hidden: false,
    });

    applySessionUiMetadataBatch.mockClear();
    broadcastSessionCatalog.mockClear();
    CONFIG.skipAuth = true;
    verifyAgentOwnership.mockReturnValue(true);
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      sessions: [...sessions, { ...sessions[0], catalogKey: 'yeaft:agent-x:wrong' }],
    }, allow);
    expect(applySessionUiMetadataBatch).not.toHaveBeenCalled();
    expect(broadcastSessionCatalog).not.toHaveBeenCalled();

    CONFIG.skipAuth = false;
    agents.set('agent-a', {
      ws: { readyState: 1 },
      ownerId: 'user-1',
      conversations: new Map([['chat-1', { id: 'chat-1', title: 'Old' }]]),
    });
    const routedClient = { userId: 'user-1', role: 'user', currentAgent: 'agent-b', sent: [] };
    getChatSession.mockReturnValue({ id: 'chat-1', user_id: 'user-1', agent_id: 'agent-a', provider: 'copilot' });
    await handleClientConversation('client-1', routedClient, {
      type: 'update_conversation_settings',
      conversationId: 'chat-1',
      agentId: 'agent-a',
      title: 'Renamed',
    }, allow);
    expect(agents.get('agent-a').conversations.get('chat-1')).toMatchObject({
      title: 'Renamed',
      customTitle: true,
    });
    expect(updateChatSession).toHaveBeenCalledWith('chat-1', {
      title: 'Renamed',
      isCustomTitle: 1,
      metadataChanged: true,
    });

    await handleClientConversation('client-1', routedClient, {
      type: 'delete_conversation',
      conversationId: 'chat-1',
      agentId: 'agent-a',
      requestId: 'delete-1',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-a', {
      type: 'delete_conversation',
      conversationId: 'chat-1',
    });
    expect(deleteSessionUiMetadataForRoute).toHaveBeenCalledWith('user-1', {
      runtimeProvider: 'copilot',
      agentId: 'agent-a',
      sessionId: 'chat-1',
    });
    expect(routedClient.sent.at(-1)).toMatchObject({
      type: 'conversation_delete_result',
      requestId: 'delete-1',
      agentId: 'agent-a',
      ok: true,
    });

    CONFIG.skipAuth = true;
    listProjectsForAgent.mockReturnValueOnce([{
      id: 'project-created',
      name: 'Created',
      members: [],
      sessionIds: [],
    }]);
    forwardToAgent.mockClear();
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-create-1',
      op: 'create',
      name: 'Created',
    }, allow);
    expect(createProject).toHaveBeenCalledWith('user-1', 'Created');
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(routedClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      event: {
        type: 'project_mutation_result',
        requestId: 'project-create-1',
        projectsAuthoritative: true,
        ok: true,
        projects: [{ id: 'project-created', sessionIds: [] }],
      },
    });

    reorderProjects.mockReturnValueOnce([
      { id: 'project-b', name: 'B', sortOrder: 0 },
      { id: 'project-a', name: 'A', sortOrder: 1 },
    ]);
    listProjectsForAgent.mockReturnValueOnce([
      { id: 'project-b', name: 'B', sortOrder: 0, sessionIds: [] },
      { id: 'project-a', name: 'A', sortOrder: 1, sessionIds: [] },
    ]);
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-reorder-1',
      op: 'reorder',
      projectIds: ['project-b', 'project-a'],
    }, allow);
    expect(reorderProjects).toHaveBeenCalledWith('user-1', ['project-b', 'project-a']);
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(routedClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      event: {
        type: 'project_mutation_result',
        requestId: 'project-reorder-1',
        projectsAuthoritative: true,
        ok: true,
        projects: [
          { id: 'project-b', sortOrder: 0 },
          { id: 'project-a', sortOrder: 1 },
        ],
      },
    });

    getByUser.mockReturnValue([{ id: 'same-id', agentId: 'agent-a' }]);
    contextForSession.mockReturnValue({
      projectId: 'project-created',
      projectName: 'Created',
      projectInstruction: 'Use the Project release checklist.',
      sessionIds: [],
    });
    updateProjectInstruction.mockReturnValue({
      id: 'project-created',
      name: 'Created',
      instruction: 'Use the Project release checklist.',
      members: [{ agentId: 'agent-a', sessionId: 'same-id' }],
    });
    listProjectsForAgent.mockReturnValueOnce([{
      id: 'project-created',
      name: 'Created',
      instruction: 'Use the Project release checklist.',
      members: [{ agentId: 'agent-a', sessionId: 'same-id' }],
      sessionIds: ['same-id'],
    }]);
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-instruction-1',
      op: 'update_instruction',
      projectId: 'project-created',
      instruction: 'Use the Project release checklist.',
    }, allow);
    expect(updateProjectInstruction).toHaveBeenCalledWith(
      'user-1',
      'project-created',
      'Use the Project release checklist.',
    );
    expect(forwardToAgent).toHaveBeenCalledWith('agent-a', {
      type: 'yeaft_project_context_sync',
      contexts: [{
        sessionId: 'same-id',
        projectContext: {
          projectId: 'project-created',
          projectName: 'Created',
          projectInstruction: 'Use the Project release checklist.',
          sessionIds: [],
        },
      }],
    });
    getByUser.mockImplementationOnce(() => {
      throw new Error('forced Project context sync failure');
    });
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-instruction-sync-failure',
      op: 'update_instruction',
      projectId: 'project-created',
      instruction: 'Use the Project release checklist.',
    }, allow);
    expect(routedClient.sent).toHaveLength(1);
    expect(routedClient.sent[0]).toMatchObject({
      event: {
        type: 'project_mutation_result',
        requestId: 'project-instruction-sync-failure',
        ok: true,
      },
    });
    getByUser.mockReturnValue([]);
    contextForSession.mockReturnValue(null);

    moveProjectSession.mockClear();
    getForAgent.mockReturnValue({ id: 'same-id', agentId: 'agent-a', isArchived: false });
    buildSessionCatalog.mockReturnValue(sessions);
    buildHiddenSessionCatalog.mockReturnValue([]);
    listProjectsForAgent.mockReturnValueOnce([{
      id: 'project-created',
      name: 'Created',
      members: [{ agentId: 'agent-a', sessionId: 'same-id' }],
      sessionIds: ['same-id'],
    }]);
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-move-atomic',
      op: 'move_session',
      targetAgentId: 'agent-a',
      sessionId: 'same-id',
      projectId: 'project-created',
      catalogOrder: sessions,
    }, allow);
    expect(moveProjectSession).toHaveBeenCalledWith('user-1', {
      agentId: 'agent-a',
      sessionId: 'same-id',
      projectId: 'project-created',
      catalogUpdates: [
        expect.objectContaining({ catalogKey: 'yeaft:agent-a:same-id', sortRank: 0 }),
        expect.objectContaining({ catalogKey: 'yeaft:agent-b:same-id', sortRank: 1 }),
        expect.objectContaining({ catalogKey: 'chat:chat-1', sortRank: 2 }),
      ],
    });
    expect(routedClient.sent.at(-1)).toMatchObject({
      event: {
        type: 'project_mutation_result',
        requestId: 'project-move-atomic',
        ok: true,
      },
    });

    moveProjectSession.mockClear();
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-move-stale-order',
      op: 'move_session',
      targetAgentId: 'agent-a',
      sessionId: 'same-id',
      projectId: 'project-created',
      catalogOrder: sessions.slice(1),
    }, allow);
    expect(moveProjectSession).not.toHaveBeenCalled();
    expect(routedClient.sent.at(-1)).toMatchObject({
      event: {
        type: 'project_mutation_result',
        requestId: 'project-move-stale-order',
        ok: false,
        error: { code: 'invalid_catalog_order' },
      },
    });

    getForAgent.mockReturnValue({ id: 'archived-session', agentId: 'agent-a', isArchived: true });
    routedClient.sent = [];
    await handleClientConversation('client-1', routedClient, {
      type: 'yeaft_project_mutation',
      requestId: 'project-move-archived',
      op: 'move_session',
      targetAgentId: 'agent-a',
      sessionId: 'archived-session',
      projectId: 'project-created',
    }, allow);
    expect(moveProjectSession).not.toHaveBeenCalled();
    expect(routedClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      agentId: 'agent-a',
      event: {
        type: 'project_mutation_result',
        requestId: 'project-move-archived',
        ok: false,
        error: { code: 'session_archived' },
      },
    });
    getForAgent.mockReturnValue(null);
    broadcastSessionCatalog.mockClear();

    const ownerClient = { authenticated: true, userId: 'user-1', sent: [], ws: { readyState: 1 } };
    webClients.set('owner-client', ownerClient);
    const agent = { ownerId: 'user-1', conversations: new Map(), ws: { readyState: 1 } };
    broadcastSessionCatalog.mockClear();
    await handleAgentOutput('agent-a', agent, {
      type: 'session_crud_result', op: 'rename', ok: true, sessionId: 'same-id', requestId: 'rename-1',
    });
    expect(broadcastSessionCatalog).not.toHaveBeenCalled();
    expect(ownerClient.sent.at(-1)).toMatchObject({ type: 'session_crud_result', requestId: 'rename-1' });
    ownerClient.sent = [];
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output',
      event: {
        type: 'project_mutation_result',
        requestId: 'project-rename-1',
        ok: true,
        projects: [{ id: 'legacy-project', name: 'Legacy project', sessionIds: ['same-id'] }],
      },
    });
    expect(ownerClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      agentId: 'agent-a',
      event: { type: 'project_mutation_result', requestId: 'project-rename-1' },
    });

    listProjects.mockReturnValue([{
      id: 'server-project',
      name: 'Server project',
      members: [{ agentId: 'agent-a', sessionId: 'same-id' }],
    }]);
    ownerClient.sent = [];
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output',
      event: {
        type: 'session_list_updated',
        sessions: [{ id: 'same-id', name: 'Session' }],
        projects: [{ id: 'legacy-project', name: 'Legacy project', sessionIds: ['same-id'] }],
      },
    });
    expect(agent.yeaftSessions).toBeInstanceOf(Map);
    expect(agent.yeaftSessions.get('same-id')).toMatchObject({ id: 'same-id', name: 'Session' });
    expect(reconcileProjectSessions).toHaveBeenCalledWith('user-1', 'agent-a', ['same-id']);
    expect(importLegacyProjects).toHaveBeenCalledWith(
      'user-1',
      'agent-a',
      [{ id: 'legacy-project', name: 'Legacy project', sessionIds: ['same-id'] }],
      expect.any(Function),
    );
    expect(ownerClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      event: {
        type: 'session_list_updated',
        projectsAuthoritative: true,
        projects: [{ id: 'server-project', name: 'Server project' }],
      },
    });
    // The canonical sidebar reads the server-owned catalog, not this live
    // envelope. A nested agent snapshot must therefore publish the catalog
    // after its DB reconciliation, exactly like a top-level snapshot does.
    expect(broadcastSessionCatalog).toHaveBeenCalledTimes(1);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');

    const otherTab = { authenticated: true, userId: 'user-1', sent: [], ws: { readyState: 1 } };
    webClients.set('other-tab', otherTab);
    ownerClient.sent = [];
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_history_chunk',
      conversationId: 'yeaft-agent-a',
      sessionId: 'same-id',
      requestId: 'history-gone',
      _requestClientId: 'closed-tab',
      messages: [{ role: 'user', content: 'private history' }],
    });
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output',
      conversationId: 'yeaft-agent-a',
      sessionId: 'same-id',
      requestId: 'history-gone',
      _requestClientId: 'closed-tab',
      event: { type: 'history_loaded', sessionId: 'same-id', requestId: 'history-gone' },
    });
    expect(ownerClient.sent).toEqual([]);
    expect(otherTab.sent).toEqual([]);

    ownerClient.sent = [];
    otherTab.sent = [];
    CONFIG.skipAuth = false;
    getForAgent.mockReturnValue({ id: 'same-id', agentId: 'agent-a', userId: 'user-1' });
    const debugRelayClient = {
      authenticated: true,
      userId: 'user-1',
      currentAgent: 'agent-a',
      sent: ownerClient.sent,
    };
    await handleClientConversation('owner-client', debugRelayClient, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-a',
      sessionId: 'same-id',
      requestId: 'debug-owner-only',
      requestKind: 'detail',
      detailTurnId: 'turn-owner-only',
    }, allow);
    expect(pendingYeaftDebugRequests.size).toBe(1);
    // Simulate the rolling topology: an old Agent echoes requestId/sessionId
    // but drops the newly introduced private browser client field.
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_debug_history',
      requestId: 'debug-owner-only',
      requestKind: 'detail',
      detailTurnId: 'turn-owner-only',
      sessionId: 'same-id',
      turns: [{ turnId: 'turn-owner-only' }],
      loops: [{ turnId: 'turn-owner-only', loopNumber: 1 }],
      dreamEvents: [],
      projection: { truncated: true, reason: 'debug_detail_wire_budget' },
    });
    expect(ownerClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_debug_history',
      agentId: 'agent-a',
      requestId: 'debug-owner-only',
      detailTurnId: 'turn-owner-only',
      projection: { truncated: true, reason: 'debug_detail_wire_budget' },
    });
    expect(otherTab.sent).toEqual([]);
    expect(pendingYeaftDebugRequests.size).toBe(0);

    ownerClient.sent = [];
    otherTab.sent = [];
    CONFIG.skipAuth = true;
    await handleClientConversation('owner-client', debugRelayClient, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-a',
      sessionId: 'same-id',
      requestId: 'debug-skip-auth-ownerless',
      requestKind: 'detail',
      detailTurnId: 'turn-skip-auth-ownerless',
    }, allow);
    await handleAgentOutput('agent-a', { ...agent, ownerId: null }, {
      type: 'yeaft_debug_history',
      requestId: 'debug-skip-auth-ownerless',
      requestKind: 'detail',
      detailTurnId: 'turn-skip-auth-ownerless',
      sessionId: 'same-id',
      turns: [{ turnId: 'turn-skip-auth-ownerless' }],
      loops: [{ turnId: 'turn-skip-auth-ownerless', loopNumber: 1 }],
      dreamEvents: [],
    });
    expect(ownerClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_debug_history',
      agentId: 'agent-a',
      requestId: 'debug-skip-auth-ownerless',
      detailTurnId: 'turn-skip-auth-ownerless',
    });
    expect(otherTab.sent).toEqual([]);
    expect(pendingYeaftDebugRequests.size).toBe(0);

    ownerClient.sent = [];
    otherTab.sent = [];
    CONFIG.skipAuth = false;
    await handleClientConversation('owner-client', debugRelayClient, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-a',
      sessionId: 'same-id',
      requestId: 'debug-owner-mismatch',
      detailTurnId: 'turn-owner-mismatch',
    }, allow);
    await handleAgentOutput('agent-a', { ...agent, ownerId: 'other-user' }, {
      type: 'yeaft_debug_history',
      requestId: 'debug-owner-mismatch',
      sessionId: 'same-id',
      turns: [{ turnId: 'turn-owner-mismatch' }],
      loops: [],
      dreamEvents: [],
    });
    expect(ownerClient.sent).toEqual([]);
    expect(otherTab.sent).toEqual([]);
    expect(pendingYeaftDebugRequests.size).toBe(0);

    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_debug_history',
      requestId: 'unregistered-debug',
      sessionId: 'same-id',
      turns: [{ turnId: 'must-not-broadcast' }],
      loops: [],
      dreamEvents: [],
    });
    expect(ownerClient.sent).toEqual([]);
    expect(otherTab.sent).toEqual([]);

    await handleClientConversation('owner-client', debugRelayClient, {
      type: 'yeaft_fetch_debug_history',
      agentId: 'agent-a',
      sessionId: 'same-id',
      requestId: 'expired-debug',
      detailTurnId: 'expired-turn',
    }, allow);
    const expiredPending = [...pendingYeaftDebugRequests.values()].find(item => item.requestId === 'expired-debug');
    expiredPending.expiresAt = Date.now() - 1;
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_debug_history',
      requestId: 'expired-debug',
      sessionId: 'same-id',
      turns: [{ turnId: 'expired-turn' }],
      loops: [],
      dreamEvents: [],
    });
    expect(ownerClient.sent).toEqual([]);
    expect(otherTab.sent).toEqual([]);
    expect(pendingYeaftDebugRequests.size).toBe(0);

    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_history_chunk',
      conversationId: 'yeaft-agent-a',
      sessionId: 'same-id',
      messages: [{ role: 'user', content: 'legacy history' }],
      pageKind: 'gap',
      gapStopAtSeq: 501,
      cacheEpoch: 7,
    });
    expect(ownerClient.sent.at(-1)).toMatchObject({
      type: 'yeaft_history_chunk', sessionId: 'same-id',
      pageKind: 'gap', gapStopAtSeq: 501, cacheEpoch: 7,
    });
    expect(otherTab.sent.at(-1)).toMatchObject({
      type: 'yeaft_history_chunk', sessionId: 'same-id',
      pageKind: 'gap', gapStopAtSeq: 501, cacheEpoch: 7,
    });

    ownerClient.sent = [];
    broadcastSessionCatalog.mockClear();
    await handleAgentOutput('agent-a', agent, {
      type: 'session_list_updated',
      sessions: [{ id: 'same-id', name: 'Renamed' }],
    });
    expect(reconcileFromSnapshot).toHaveBeenCalledWith('user-1', 'agent-a', [
      { id: 'same-id', name: 'Renamed' },
    ]);
    expect(broadcastSessionCatalog).toHaveBeenCalledTimes(1);

    deleteSessionUiMetadataForRoute.mockClear();
    deleteYeaftSessionForAgent.mockClear();
    await handleAgentOutput('agent-a', agent, {
      type: 'session_crud_result',
      op: 'delete',
      ok: true,
      sessionId: 'same-id',
      requestId: 'delete-yeaft-row',
    });
    expect(deleteYeaftSessionForAgent).toHaveBeenCalledWith('user-1', 'agent-a', 'same-id');
    expect(deleteSessionUiMetadataForRoute).toHaveBeenCalledWith('user-1', {
      runtimeProvider: 'yeaft',
      agentId: 'agent-a',
      sessionId: 'same-id',
    });

    getForAgent.mockReturnValue({
      id: 'same-id',
      name: 'Before',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/repo',
      config: {},
      announcement: '',
      createdAt: '2026-07-29T10:00:00.000Z',
      metadataUpdatedAt: '2026-07-29T10:00:00.000Z',
    });
    broadcastSessionCatalog.mockClear();
    await handleAgentOutput('agent-a', agent, {
      type: 'yeaft_output',
      conversationId: 'yeaft-agent-a',
      event: {
        type: 'session_roster_changed',
        sessionId: 'same-id',
        name: 'After',
        roster: ['omni', 'reviewer'],
        defaultVpId: 'reviewer',
        metadataUpdatedAt: '2026-07-29T11:00:00.000Z',
      },
    });
    expect(upsertFromSnapshot).toHaveBeenCalledWith('user-1', 'agent-a', expect.objectContaining({
      id: 'same-id',
      roster: ['omni', 'reviewer'],
      defaultVpId: 'reviewer',
      metadataUpdatedAt: '2026-07-29T11:00:00.000Z',
    }));
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');
  });
});
