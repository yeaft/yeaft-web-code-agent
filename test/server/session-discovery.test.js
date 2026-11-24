import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents } from '../../server/context.js';
import { userDb, yeaftSessionDb, sessionUiMetadataDb } from '../../server/database.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { clearSessionDiscoveryRequests, handleAgentSessionDiscovery, handleClientSessionDiscovery } from '../../server/handlers/session-discovery.js';
import { createMockAgent, createMockWebClient } from '../helpers/mockWs.js';
import { handleSessionDiscovery } from '../../agent/yeaft/session-discovery/bridge.js';
import { MAX_MESSAGE_INDEX_CHARS, runDailySessionIndex } from '../../agent/yeaft/session-discovery/indexer.js';
import { DAY_MS, listActiveSessionCards, openDiscoveryStore, searchDiscovery } from '../../agent/yeaft/session-discovery/store.js';
import { ConversationStore } from '../../agent/yeaft/conversation/persist.js';
import { commitSessionTurnDeletion } from '../../agent/yeaft/conversation/turn-deletion-journal.js';
import { addOrUpdateManifestSession } from '../../agent/yeaft/sessions/session-manifest.js';
import { createSession } from '../../agent/yeaft/sessions/session-store.js';

it('serves full incremental FTS results, 5-day active cards and durable Share entries through owner-scoped relays', async () => {
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
  async function send(client, op, payload = {}, beforeReply = async () => {}, ok = true) {
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
    expect(reply).toMatchObject({ type: 'session_discovery_response', agentId, op, requestId, ok });
    return reply.data;
  }
  try {
    // Seed a legacy v1 discovery.db with a saved Share item that must survive migration.
    const discoveryDir = join(root, 'session-discovery');
    mkdirSync(discoveryDir, { recursive: true });
    const legacyDb = new DatabaseSync(join(discoveryDir, 'discovery.db'));
    legacyDb.exec(`
      CREATE TABLE index_state (id INTEGER PRIMARY KEY CHECK(id = 1), indexed_at INTEGER NOT NULL);
      CREATE TABLE session_cards (
        session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, work_dir TEXT NOT NULL,
        passages TEXT NOT NULL, active_at INTEGER NOT NULL, deletion_generation TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE session_fts USING fts5(title, work_dir, requests, replies);
      CREATE TABLE share_items (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('consensus', 'output')),
        title TEXT NOT NULL, body TEXT NOT NULL, source_session_id TEXT, source_message_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id, id)
      );
      INSERT INTO index_state VALUES (1, ${now - 1000});
      INSERT INTO share_items VALUES ('alice', 'legacy-saved', 'output', '迁移前成果', '升级后保留', NULL, NULL, ${now - 2000}, ${now - 2000});
    `);
    legacyDb.close();

    // Verify full user prompts, final-only assistant responses, image/tool/progress exclusion, and oversized cap.
    const richHandle = createSession(join(root, 'sessions'), { id: 'rich', name: '架构评审', workDir: '/repo/core' });
    const richMeta = richHandle.getMeta();
    addOrUpdateManifestSession(root, richMeta, richHandle.dir);
    richHandle.close();
    metadata.push({ ...richMeta, userId: 'alice', agentId, isArchived: false });
    const longUserTail = 'USER_FULL_TAIL_MARKER';
    const longResultTail = 'ASSISTANT_FINAL_TAIL_MARKER';
    const oversizedUser = `OVERSIZED_PREFIX_TOKEN ${'A'.repeat(MAX_MESSAGE_INDEX_CHARS + 1000)} OVERSIZED_BEYOND_CAP`;
    store.appendBatch([
      {
        sessionId: 'rich', role: 'user',
        content: [
          { type: 'text', text: `${'排查上下文 '.repeat(350)}${longUserTail}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SECRET_IMG_BASE64_TOKEN' } },
        ],
        attachments: [{ name: 'secret-screenshot.png', path: '/tmp/secret-screenshot.png' }],
        time: new Date(now - 50_000).toISOString(),
      },
      {
        sessionId: 'rich', role: 'assistant', turnId: 'r-t1', responseKind: 'progress',
        content: '中间进度_PROGRESS_ONLY_TOKEN',
        toolCalls: [{ id: 'tc-1', name: 'Bash', input: { command: 'echo TOOL_INPUT_SECRET' } }],
        time: new Date(now - 49_000).toISOString(),
      },
      { sessionId: 'rich', role: 'tool', toolCallId: 'tc-1', content: 'TOOL_OUTPUT_SECRET', time: new Date(now - 48_500).toISOString() },
      {
        sessionId: 'rich', role: 'assistant', turnId: 'r-t1', responseKind: 'result', stopReason: 'end_turn',
        content: `${'最终分析结论 '.repeat(350)}${longResultTail}`,
        time: new Date(now - 48_000).toISOString(),
      },
      {
        sessionId: 'rich', role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGE_ONLY_BASE64_TOKEN' } }],
        time: new Date(now - 47_000).toISOString(),
      },
      {
        sessionId: 'rich', role: 'assistant', turnId: 'r-t2', responseKind: 'result', stopReason: 'end_turn',
        content: '纯图消息的最终分析：峰值在第 3 步。',
        time: new Date(now - 46_000).toISOString(),
      },
      { sessionId: 'rich', role: 'user', content: oversizedUser, time: new Date(now - 45_000).toISOString() },
      { sessionId: 'rich', role: 'assistant', turnId: 'r-t3', responseKind: 'result', content: '超长日志已归档。', time: new Date(now - 44_000).toISOString() },
    ]);

    // Schema migration resets index_state so the first run indexes immediately.
    expect(runDailySessionIndex(root, now)).toBe(true);
    expect(runDailySessionIndex(root, now + 30_000)).toBe(false);

    // Check full user/final-result indexing and exclusions directly against discovery.db.
    let db = openDiscoveryStore(root);
    let oldRowIdsBefore;
    try {
      oldRowIdsBefore = db.prepare('SELECT rowid, seq FROM session_messages WHERE session_id = ? ORDER BY seq ASC').all('old');
      expect(oldRowIdsBefore).toHaveLength(4);
      expect(searchDiscovery(db, root, ['rich'], longUserTail, now).results).toHaveLength(1);
      expect(searchDiscovery(db, root, ['rich'], longResultTail, now).results).toHaveLength(1);
      expect(searchDiscovery(db, root, ['rich'], '架构评审 峰值在第', now).results).toHaveLength(1);
      expect(searchDiscovery(db, root, ['rich'], 'OVERSIZED_PREFIX_TOKEN', now).results).toHaveLength(1);
      for (const excluded of [
        'PROGRESS_ONLY_TOKEN', 'TOOL_INPUT_SECRET', 'TOOL_OUTPUT_SECRET',
        'SECRET_IMG_BASE64_TOKEN', 'secret-screenshot', 'IMAGE_ONLY_BASE64_TOKEN', 'OVERSIZED_BEYOND_CAP',
      ]) {
        expect(searchDiscovery(db, root, ['rich'], excluded, now).results).toEqual([]);
      }
      expect(listActiveSessionCards(db, root, ['old', 'visible'], now, { activeWindowDays: 5 }).cards.map(c => c.sessionId))
        .toEqual(['visible']);
    } finally { db.close(); }

    const result = await send(alice, 'search', { query: '检索 login' }, async response => {
      await handleAgentSessionDiscovery(agentId, { ...agent }, response);
      expect(alice.ws.getLastMessage()).toBe(null);
      expect(response.data.results.map(row => row.sessionId)).toEqual(['visible', 'old']);
    });
    expect(result).toMatchObject({
      indexedAt: now,
      results: [
        { sessionId: 'visible', snippet: expect.stringContaining('索引检索功能') },
        { sessionId: 'old', snippet: expect.stringContaining('索引检索功能') },
      ],
    });
    // Windowed search (5-day active window) and active_sessions enforce 5-day + owner scope.
    expect((await send(alice, 'search', { query: '检索 login', activeWindowDays: 5 })).results.map(row => row.sessionId))
      .toEqual(['visible']);
    const activeAlice = await send(alice, 'active_sessions', { activeWindowDays: 5 });
    expect(activeAlice.cards.map(card => card.sessionId).sort()).toEqual(['rich', 'visible']);
    expect((await send(bob, 'active_sessions', { activeWindowDays: 5 })).cards.map(card => card.sessionId))
      .toEqual(['other-owner']);

    const searchFrame = { type: 'session_discovery_request', op: 'search', agentId, payload: { query: '检索' } };
    for (let i = 0; i < 8; i++) await handleClientSessionDiscovery(alice, { ...searchFrame, requestId: `superseded_${i}` });
    const lastSuperseded = agent.ws.getLastMessage();
    const cancel = { type: 'session_discovery_cancel', requestId: 'superseded_7', agentId };
    await handleClientSessionDiscovery(bob, cancel);
    await handleClientSessionDiscovery(alice, { ...searchFrame, requestId: 'still_full' });
    expect(alice.ws.getLastMessage()).toMatchObject({ requestId: 'still_full', ok: false });
    await handleClientSessionDiscovery(alice, cancel);
    await handleSessionDiscovery(lastSuperseded, root, response => handleAgentSessionDiscovery(agentId, agent, response));
    expect(alice.ws.getLastMessage().requestId).toBe('still_full');
    expect((await send(alice, 'search', { query: '检索' })).results).toHaveLength(2);
    clearSessionDiscoveryRequests(alice);
    expect((await send(bob, 'search', { query: '检索' })).results.map(row => row.sessionId)).toEqual(['other-owner']);
    expect((await send(alice, 'search', { query: '检索', activeWindowDays: 5 }, () => { hidden.push('visible'); })).results).toEqual([]);
    hidden.pop();
    const shareList = await send(alice, 'share_list');
    expect(shareList.items.some(row => row.id === 'legacy-saved' && row.status === 'published')).toBe(true);
    const candidate = shareList.items.find(row => row.status === 'candidate');
    expect(candidate).toMatchObject({ status: 'candidate', kind: 'consensus', sourceSessionId: 'visible', body: '所有面向客户的变更通知都先写结论。' });
    const { item } = await send(alice, 'share_save', { id: candidate.id, expectedUpdatedAt: candidate.updatedAt, kind: 'consensus', title: '通知', body: '变更通知先写结论。' });
    expect(item).toMatchObject({ id: candidate.id, status: 'published' });
    const createOutput = { createId: '4eee0399-f9a2-4e31-b69f-984a7777ec31', kind: 'output', title: '调研', body: '用户访谈报告' };
    const output = (await send(alice, 'share_save', createOutput)).item;
    expect(output.kind).toBe('output');
    expect((await send(alice, 'share_save', createOutput)).item).toEqual(output);
    await send(alice, 'share_save', { ...createOutput, body: '另一个版本' }, undefined, false);
    expect((await send(alice, 'share_list')).items.find(row => row.id === output.id)).toEqual(output);
    expect((await send(bob, 'share_list')).items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    commitSessionTurnDeletion(root, 'visible', [], {
      version: 1, deletionId: 'test-delete', sessionId: 'visible', turnId: 'test-turn', messageIds: [visible[3].id],
      anchorMessageIds: [], clientMessageIds: [], executionIds: [], referenceIds: [],
    });
    expect((await send(alice, 'search', { query: '检索', activeWindowDays: 5 })).results).toEqual([]);
    expect((await send(alice, 'search', { query: '检索' })).results.map(row => row.sessionId)).toEqual(['old']);
    expect((await send(alice, 'share_list')).items.some(row => row.id === item.id && row.status === 'published')).toBe(true);
    await send(alice, 'share_delete', { id: item.id, expectedUpdatedAt: item.updatedAt });
    await send(alice, 'share_delete', { id: item.id, expectedUpdatedAt: item.updatedAt });

    // Append a new turn to `rich` on the next day and verify true incremental append while `old` stays untouched.
    const nextDay = now + DAY_MS + 1_000;
    store.appendBatch([
      { sessionId: 'rich', role: 'user', content: '增量追加问题 INCREMENTAL_USER_TOKEN', time: new Date(nextDay - 2000).toISOString() },
      { sessionId: 'rich', role: 'assistant', turnId: 'r-t4', responseKind: 'progress', content: '增量进度 INCREMENTAL_PROGRESS_SKIPPED', time: new Date(nextDay - 1500).toISOString() },
      { sessionId: 'rich', role: 'assistant', turnId: 'r-t4', responseKind: 'result', content: '增量最终回复 INCREMENTAL_RESULT_TOKEN', time: new Date(nextDay - 1000).toISOString() },
    ]);
    expect(runDailySessionIndex(root, nextDay)).toBe(true);
    db = openDiscoveryStore(root);
    try {
      expect(db.prepare('SELECT rowid, seq FROM session_messages WHERE session_id = ? ORDER BY seq ASC').all('old'))
        .toEqual(oldRowIdsBefore);
      expect(searchDiscovery(db, root, ['rich'], 'INCREMENTAL_USER_TOKEN', nextDay).results).toHaveLength(1);
      expect(searchDiscovery(db, root, ['rich'], 'INCREMENTAL_RESULT_TOKEN', nextDay).results).toHaveLength(1);
      expect(searchDiscovery(db, root, ['rich'], 'INCREMENTAL_PROGRESS_SKIPPED', nextDay).results).toEqual([]);
      expect(searchDiscovery(db, root, ['rich'], longUserTail, nextDay).results).toHaveLength(1);
    } finally { db.close(); }

    expect((await send(alice, 'share_list')).items.map(row => row.kind)).toEqual(['output', 'output']);

    const forward = id => handleClientConversation('alice-client', alice, {
      type: 'yeaft_session_send', agentId, sessionId: id, message: 'look at history', _shareOwnerId: 'bob', _agentSessionIds: ['other-owner', 'other-agent'],
    }, vi.fn(async () => true));
    await forward('visible');
    expect(agent.ws.getLastMessage()._agentSessionIds).toEqual(expect.arrayContaining(['visible', 'old', 'short', 'rich']));
    expect(agent.ws.getLastMessage()._agentSessionIds).not.toContain('other-owner');
    expect(agent.ws.getLastMessage()._agentSessionIds).not.toContain('other-agent');
    expect(agent.ws.getLastMessage()._shareOwnerId).toBe('alice');
    await forward('other-owner');
    expect(agent.ws.getLastMessage()._agentSessionIds).toBeUndefined();
    expect(agent.ws.getLastMessage()._shareOwnerId).toBeUndefined();
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
