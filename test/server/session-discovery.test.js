import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents } from '../../server/context.js';
import { userDb, yeaftSessionDb, sessionUiMetadataDb } from '../../server/database.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { clearSessionDiscoveryRequests, handleAgentSessionDiscovery, handleClientSessionDiscovery } from '../../server/handlers/session-discovery.js';
import { createMockAgent, createMockWebClient } from '../helpers/mockWs.js';
import { handleSessionDiscovery } from '../../agent/yeaft/session-discovery/bridge.js';
import { runDailySessionIndex } from '../../agent/yeaft/session-discovery/indexer.js';
import { DAY_MS } from '../../agent/yeaft/session-discovery/store.js';
import { ConversationStore } from '../../agent/yeaft/conversation/persist.js';
import { commitSessionTurnDeletion } from '../../agent/yeaft/conversation/turn-deletion-journal.js';
import { addOrUpdateManifestSession } from '../../agent/yeaft/sessions/session-manifest.js';
import { createSession } from '../../agent/yeaft/sessions/session-store.js';

it('serves daily FTS results and durable Share entries through owner-scoped Server/Agent relays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-discovery-'));
  const savedSkipAuth = CONFIG.skipAuth;
  CONFIG.skipAuth = false;
  // An ownerless Agent can have multiple admins; the Session/Share owner
  // boundary still applies among them and cannot be supplied by the browser.
  const agentId = 'shared-machine';
  const agent = createMockAgent({ ownerId: null, capabilities: ['session_discovery'], encryptOutbound: false });
  const alice = createMockWebClient({ userId: 'alice', role: 'admin', encryptOutbound: false });
  const bob = createMockWebClient({ userId: 'bob', role: 'admin', encryptOutbound: false });
  agents.set(agentId, agent);
  vi.spyOn(userDb, 'isActive').mockReturnValue(true);
  const now = Date.now();
  const store = new ConversationStore(root);
  const metadata = [];
  const create = (id, userId, count, time, agent = agentId) => {
    const handle = createSession(join(root, 'sessions'), { id, name: `Session ${id}` });
    const meta = handle.getMeta();
    addOrUpdateManifestSession(root, meta, handle.dir);
    handle.close();
    metadata.push({ ...meta, userId, agentId: agent, isArchived: false });
    const rows = store.appendBatch(Array.from({ length: count }, (_, i) => ({
      sessionId: id, role: i % 2 ? 'assistant' : 'user',
      content: [
        '已达成共识：所有面向客户的变更通知都先写结论。',
        '已决定：助手的推测不能变成共识。',
        '已决定：修改 src/main.js。',
        'FTS login settings 索引检索功能已确认。',
      ][i],
      time: new Date(time + i).toISOString(),
    })));
    // Ensure actual message time, not directory mtime, determines age.
    const index = join(handle.dir, 'conversation', 'index.json');
    utimesSync(index, new Date(now), new Date(now));
    return rows;
  };
  const visible = create('visible', 'alice', 4, now - 60_000);
  create('short', 'alice', 3, now - 30_000);
  create('old', 'alice', 4, now - 5 * DAY_MS - 60_000);
  create('other-owner', 'bob', 4, now - 30_000);
  create('hidden', 'alice', 4, now - 15_000);
  create('other-agent', 'alice', 4, now - 15_000, 'different-machine');
  let hidden = ['hidden'];
  const hiddenRows = () => hidden.map(id => ({ catalogKey: `yeaft:${agentId}:${id}`, hidden: true }));
  vi.spyOn(yeaftSessionDb, 'getByUser').mockImplementation(userId => metadata.filter(row => row.userId === userId));
  vi.spyOn(yeaftSessionDb, 'getByAgent').mockImplementation(id => metadata.filter(row => row.agentId === id));
  vi.spyOn(yeaftSessionDb, 'getForAgent').mockImplementation((userId, id, sessionId) => metadata.find(row => row.userId === userId && row.agentId === id && row.id === sessionId));
  vi.spyOn(sessionUiMetadataDb, 'getByUser').mockImplementation(userId => userId === 'alice' ? hiddenRows() : []);
  let nextRequest = 0;
  async function send(client, op, payload = {}, beforeReply = async () => {}) {
    const requestId = `browser_${++nextRequest}`;
    await handleClientSessionDiscovery(client, {
      type: 'session_discovery_request', requestId, op, agentId, payload, ownerId: 'bob', allowedIds: ['other-owner'],
    });
    const outgoing = agent.ws.getLastMessage();
    expect(outgoing.requestId).not.toBe(requestId);
    expect(outgoing.ownerId).toBe(client.userId);
    await handleSessionDiscovery(outgoing, root, async response => {
      await beforeReply(response);
      await handleAgentSessionDiscovery(agentId, agent, response);
    });
    const reply = client.ws.getLastMessage();
    expect(reply).toMatchObject({ type: 'session_discovery_response', agentId, op, requestId, ok: true });
    return reply.data;
  }
  try {
    expect(runDailySessionIndex(root, now)).toBe(true);
    expect(runDailySessionIndex(root, now + 30_000)).toBe(false);
    const result = await send(alice, 'search', { query: '检索 login' }, async response => {
      await handleAgentSessionDiscovery(agentId, { ...agent }, response);
      expect(alice.ws.getLastMessage()).toBe(null);
      expect(response.data.results.map(row => row.sessionId)).toEqual(['visible']);
    });
    expect(result).toMatchObject({ indexedAt: now, results: [{ sessionId: 'visible', snippet: expect.stringContaining('索引检索功能') }] });
    expect((await send(bob, 'search', { query: '检索' })).results.map(row => row.sessionId)).toEqual(['other-owner']);
    expect((await send(alice, 'search', { query: '检索' }, () => { hidden.push('visible'); })).results).toEqual([]);
    hidden.pop();
    const { items: [candidate, ...rest] } = await send(alice, 'share_list');
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ status: 'candidate', kind: 'consensus', sourceSessionId: 'visible', body: '所有面向客户的变更通知都先写结论。' });
    const { item } = await send(alice, 'share_save', { id: candidate.id, expectedUpdatedAt: candidate.updatedAt, kind: 'consensus', title: '通知', body: '变更通知先写结论。' });
    expect(item).toMatchObject({ id: candidate.id, status: 'published' });
    const createOutput = { createId: '4eee0399-f9a2-4e31-b69f-984a7777ec31', kind: 'output', title: '调研', body: '用户访谈报告' };
    const output = (await send(alice, 'share_save', createOutput)).item;
    expect(output.kind).toBe('output');
    expect((await send(alice, 'share_save', createOutput)).item).toEqual(output);
    expect((await send(bob, 'share_list')).items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    commitSessionTurnDeletion(root, 'visible', [], {
      version: 1, deletionId: 'test-delete', sessionId: 'visible', turnId: 'test-turn', messageIds: [visible[3].id],
      anchorMessageIds: [], clientMessageIds: [], executionIds: [], referenceIds: [],
    });
    expect((await send(alice, 'search', { query: '检索' })).results).toEqual([]);
    expect((await send(alice, 'share_list')).items.some(row => row.id === item.id && row.status === 'published')).toBe(true);
    await send(alice, 'share_delete', { id: item.id, expectedUpdatedAt: item.updatedAt });
    await send(alice, 'share_delete', { id: item.id, expectedUpdatedAt: item.updatedAt });
    expect(runDailySessionIndex(root, now + DAY_MS)).toBe(true);
    expect((await send(alice, 'share_list')).items.map(row => row.kind)).toEqual(['output']);

    const forward = id => handleClientConversation('alice-client', alice, {
      type: 'yeaft_session_send', agentId, sessionId: id, message: 'look at history', _agentSessionIds: ['other-owner', 'other-agent'],
    }, vi.fn(async () => true));
    await forward('visible');
    expect(agent.ws.getLastMessage()._agentSessionIds).toEqual(expect.arrayContaining(['visible', 'old', 'short']));
    expect(agent.ws.getLastMessage()._agentSessionIds).not.toContain('other-owner');
    expect(agent.ws.getLastMessage()._agentSessionIds).not.toContain('other-agent');
    await forward('other-owner');
    expect(agent.ws.getLastMessage()._agentSessionIds).toBeUndefined();
    store.clear();
    expect((await send(bob, 'search', { query: '检索' })).results).toEqual([]);
  } finally {
    clearSessionDiscoveryRequests(alice);
    clearSessionDiscoveryRequests(bob);
    agents.delete(agentId);
    CONFIG.skipAuth = savedSkipAuth;
    vi.restoreAllMocks();
    rmSync(root, { force: true, recursive: true });
  }
});
