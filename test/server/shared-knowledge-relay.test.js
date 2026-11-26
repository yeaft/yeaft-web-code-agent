import { afterEach, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents } from '../../server/context.js';
import { sessionUiMetadataDb, yeaftProjectDb, yeaftSessionDb } from '../../server/database.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { createMockAgent, createMockWebClient } from '../helpers/mockWs.js';

const agentId = 'knowledge-fixture-agent';
const capability = 'session_shared_knowledge';
const savedSkipAuth = CONFIG.skipAuth;
afterEach(() => {
  agents.delete(agentId);
  CONFIG.skipAuth = savedSkipAuth;
  vi.restoreAllMocks();
});

it('stamps only same-owner native source IDs for Cosmos delivery, independently of route candidates and Share', async () => {
  CONFIG.skipAuth = false;
  const client = createMockWebClient({ userId: 'alice', encryptOutbound: false });
  const agent = createMockAgent({ ownerId: 'alice', capabilities: [capability, 'session_auto_route'], encryptOutbound: false });
  agents.set(agentId, agent);
  const session = (id, userId, overrides = {}) => ({ id, userId, agentId, name: id, isArchived: false, ...overrides });
  const rows = [session('own', 'alice'), session('hidden-prior', 'alice'), session('foreign', 'bob'),
    session('archived', 'alice', { isArchived: true }), session('other-agent', 'alice', { agentId: 'elsewhere' })];
  vi.spyOn(yeaftSessionDb, 'getByAgent').mockImplementation(id => rows.filter(row => row.agentId === id && !row.isArchived));
  vi.spyOn(yeaftSessionDb, 'getByUser').mockImplementation(id => rows.filter(row => row.userId === id && !row.isArchived));
  vi.spyOn(yeaftSessionDb, 'getForAgent').mockImplementation((user, agent, id) => rows.find(row => row.userId === user && row.agentId === agent && row.id === id));
  vi.spyOn(yeaftProjectDb, 'contextForSession').mockReturnValue(null);
  vi.spyOn(sessionUiMetadataDb, 'getByUser').mockReturnValue([{ catalogKey: `yeaft:${agentId}:hidden-prior`, hidden: true }]);

  let seq = 0;
  const send = async (overrides = {}) => {
    agent.ws.clearMessages();
    await handleClientConversation('alice-client', client, {
      type: 'yeaft_session_send', id: `msg-${++seq}`, agentId, sessionId: 'own', text: 'fixture',
      cosmosDelivery: true, _knowledgeSessionIds: ['foreign', 'other-agent'], ...overrides,
    }, async () => true);
    return agent.ws.getLastMessage();
  };

  const direct = await send();
  expect(direct._knowledgeSessionIds).toEqual(['own', 'hidden-prior']);
  expect(direct).not.toHaveProperty('cosmosDelivery');
  expect(direct).not.toHaveProperty('_shareOwnerId');
  expect(direct).not.toHaveProperty('_agentSessionIds');
  expect(await send({ sessionId: 'foreign' })).not.toHaveProperty('_knowledgeSessionIds');
  expect(await send({ sessionId: 'archived' })).not.toHaveProperty('_knowledgeSessionIds');
  expect(await send({ cosmosDelivery: undefined })).not.toHaveProperty('_knowledgeSessionIds');
  expect(await send({ cosmosDelivery: 'true' })).not.toHaveProperty('_knowledgeSessionIds');
  expect(await send({ type: 'yeaft_set_mode' })).not.toHaveProperty('_knowledgeSessionIds');

  const quick = await send({ type: 'yeaft_auto_route_send', sessionId: undefined });
  expect(quick._knowledgeSessionIds).toEqual(direct._knowledgeSessionIds);
  expect(quick._allowedSessionIds).toEqual(['own']);
  expect(quick).not.toHaveProperty('cosmosDelivery');
  expect(await send({ type: 'yeaft_auto_route_send', cosmosDelivery: undefined })).not.toHaveProperty('_knowledgeSessionIds');
  agent.capabilities = ['session_auto_route', 'session_discovery'];
  const oldAgent = await send();
  expect(oldAgent._shareOwnerId).toBe('alice');
  expect(oldAgent).not.toHaveProperty('_knowledgeSessionIds');
});
