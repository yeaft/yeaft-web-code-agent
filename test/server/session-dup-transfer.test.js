/**
 * fix-session-dup regression tests.
 *
 * The bug: a single conversation could appear as TWO rows in the sidebar,
 * each tagged with a different agent badge. Root cause is on the server:
 *
 *   1. User creates conv `c1` on agent `A`. `sessionDb.agent_id = A`,
 *      `A.conversations` contains `c1`.
 *   2. Agent `A` goes offline. User later resumes `c1` against agent `B`.
 *      Before this fix, server only inserted `c1` into `B.conversations`
 *      and updated `claudeSessionId` — but the DB row still said `A`, and
 *      when `A` came back online, the `get_agents` restore re-seated `c1`
 *      into `A.conversations` from the DB.
 *   3. The next `broadcastAgentList` now exposes `c1` under BOTH `A` and
 *      `B`. `handleAgentSelected` on the web side merged them by agentId
 *      partition, producing the visible duplicate.
 *
 * The fix has two parts, both tested below:
 *   (a) Resume must transfer agent_id in the DB
 *       (`sessionDb.setAgent`) AND drop the conv from the previous
 *       agent's in-memory Map.
 *   (b) `conversation_list` must drop any incoming conv whose DB owner
 *       has moved away — without (b), a slow agent restart can still
 *       re-claim a conv that was transferred while it was offline.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, cleanupTestDb, createDbOperations } from '../helpers/testDb.js';

let db, sessionDb;

beforeEach(() => {
  if (db) { try { db.close(); } catch (e) {} }
  const result = createTestDb();
  db = result.db;
  const ops = createDbOperations(db);
  sessionDb = ops.sessionDb;
});

afterAll(() => { cleanupTestDb(); });

describe('sessionDb.setAgent — transfer a conv to a new owning agent', () => {
  it('re-points agent_id + agent_name', () => {
    sessionDb.create('c1', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    const before = sessionDb.get('c1');
    expect(before.agent_id).toBe('agentA');
    expect(before.agent_name).toBe('AgentA');

    sessionDb.setAgent('c1', 'agentB', 'AgentB');

    const after = sessionDb.get('c1');
    expect(after.agent_id).toBe('agentB');
    expect(after.agent_name).toBe('AgentB');
  });

  it('updates updated_at so subsequent sorts reflect the transfer', async () => {
    sessionDb.create('c2', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    const before = sessionDb.get('c2');
    await new Promise(r => setTimeout(r, 5));
    sessionDb.setAgent('c2', 'agentB', 'AgentB');
    const after = sessionDb.get('c2');
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
  });

  it('handles null agentName gracefully', () => {
    sessionDb.create('c3', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    sessionDb.setAgent('c3', 'agentB', null);
    const after = sessionDb.get('c3');
    expect(after.agent_id).toBe('agentB');
    expect(after.agent_name).toBe(null);
  });

  it('flips getByAgent membership: source loses it, destination gains it', () => {
    sessionDb.create('c4', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    expect(sessionDb.getByAgent('agentA').map(s => s.id)).toContain('c4');
    expect(sessionDb.getByAgent('agentB').map(s => s.id)).not.toContain('c4');

    sessionDb.setAgent('c4', 'agentB', 'AgentB');

    expect(sessionDb.getByAgent('agentA').map(s => s.id)).not.toContain('c4');
    expect(sessionDb.getByAgent('agentB').map(s => s.id)).toContain('c4');
  });
});

describe('conversation_list guard — stale agent must not re-claim a transferred conv', () => {
  // Model of the production guard at
  // server/handlers/agent-conversation.js#conversation_list:
  //
  //   const dbForConv = sessionDb.get(conv.id);
  //   if (dbForConv && dbForConv.agent_id && dbForConv.agent_id !== agentId) {
  //     agent.conversations.delete(conv.id);
  //     continue;
  //   }
  function applyConversationListGuard(agentId, agentConvs, incomingList) {
    for (const conv of incomingList) {
      const dbForConv = sessionDb.get(conv.id);
      if (dbForConv && dbForConv.agent_id && dbForConv.agent_id !== agentId) {
        agentConvs.delete(conv.id);
        continue;
      }
      if (!agentConvs.has(conv.id)) {
        agentConvs.set(conv.id, { id: conv.id, ...conv });
      }
    }
  }

  it('drops a conv whose DB owner has moved away', () => {
    sessionDb.create('c10', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    sessionDb.setAgent('c10', 'agentB', 'AgentB');

    const agentAConvs = new Map([['c10', { id: 'c10', stale: true }]]);
    applyConversationListGuard('agentA', agentAConvs, [{ id: 'c10' }]);

    expect(agentAConvs.has('c10')).toBe(false);
  });

  it('keeps a conv whose DB owner matches the reporting agent', () => {
    sessionDb.create('c11', 'agentB', 'AgentB', '/w', null, 't', 'u1');

    const agentBConvs = new Map();
    applyConversationListGuard('agentB', agentBConvs, [{ id: 'c11' }]);

    expect(agentBConvs.has('c11')).toBe(true);
  });

  it('end-to-end: original agent restart cannot resurrect a transferred conv', () => {
    // Step 1: conv created on agent A, A has it in-memory.
    sessionDb.create('c20', 'agentA', 'AgentA', '/w', null, 't', 'u1');
    const agentAConvs = new Map([['c20', { id: 'c20', workDir: '/w' }]]);
    const agentBConvs = new Map();

    // Step 2: user resumes on agent B — simulated transfer.
    agentAConvs.delete('c20');
    agentBConvs.set('c20', { id: 'c20', workDir: '/w' });
    sessionDb.setAgent('c20', 'agentB', 'AgentB');

    // Step 3: agent A reconnects and broadcasts its (stale) list.
    applyConversationListGuard('agentA', agentAConvs, [{ id: 'c20' }]);

    // The guard refuses to re-seat c20 on A — no duplicate possible.
    expect(agentAConvs.has('c20')).toBe(false);
    expect(agentBConvs.has('c20')).toBe(true);
  });

  it('does not drop convs not present in DB (e.g. fresh creates)', () => {
    // A conv the agent owns but the DB has not yet persisted (race
    // window during initial create) should NOT be dropped — that
    // would lose ongoing user work.
    const agentAConvs = new Map();
    applyConversationListGuard('agentA', agentAConvs, [{ id: 'fresh-conv' }]);
    expect(agentAConvs.has('fresh-conv')).toBe(true);
  });
});

describe('frontend dedup model — agent_selected must merge by id, not by agentId', () => {
  // Mirror of web/stores/helpers/handlers/agentHandler.js#handleAgentSelected:
  //
  //   const incomingIds = new Set(activeConvs.map(c => c.id));
  //   const otherAgentConvs = store.conversations.filter(c => !incomingIds.has(c.id));
  //   store.conversations = [...otherAgentConvs, ...activeConvs];
  function mergeAgentSelected(storeConvs, incomingConvs, msgAgentId) {
    const seenIds = new Set();
    const activeConvs = incomingConvs.filter(c => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    }).map(c => ({ ...c, agentId: msgAgentId }));

    const incomingIds = new Set(activeConvs.map(c => c.id));
    const otherAgentConvs = storeConvs.filter(c => !incomingIds.has(c.id));
    return [...otherAgentConvs, ...activeConvs];
  }

  it('collapses two-agent-row duplicate into one when agent_selected arrives', () => {
    // Stale state before the fix: same conv listed twice with different
    // agentIds. The new merge collapses by id; whichever copy is in the
    // incoming `activeConvs` wins outright.
    const stale = [
      { id: 'c30', agentId: 'agentA', agentName: 'AgentA' },
      { id: 'c30', agentId: 'agentB', agentName: 'AgentB' }, // stale duplicate
    ];
    const incoming = [{ id: 'c30' }];
    const merged = mergeAgentSelected(stale, incoming, 'agentB');

    const c30Rows = merged.filter(c => c.id === 'c30');
    expect(c30Rows.length).toBe(1);
    expect(c30Rows[0].agentId).toBe('agentB');
  });

  it('keeps other agents\' convs untouched', () => {
    const stale = [
      { id: 'c40', agentId: 'agentA' },
      { id: 'c41', agentId: 'agentC' },
    ];
    const merged = mergeAgentSelected(stale, [{ id: 'c42' }], 'agentB');
    const ids = merged.map(c => c.id).sort();
    expect(ids).toEqual(['c40', 'c41', 'c42']);
  });

  it('dedupes a server-side duplicate within the same agent_selected payload', () => {
    // If somehow the server emits the same id twice in `msg.conversations`
    // (e.g. a brief sync race during reconnect), the dedup gate at the
    // top of the merger collapses them to one.
    const incoming = [
      { id: 'c50', claudeSessionId: 'cs-old' },
      { id: 'c50', claudeSessionId: 'cs-new' },
    ];
    const merged = mergeAgentSelected([], incoming, 'agentB');
    expect(merged.filter(c => c.id === 'c50').length).toBe(1);
    // First-seen wins (matches the production filter)
    expect(merged.find(c => c.id === 'c50').claudeSessionId).toBe('cs-old');
  });
});
