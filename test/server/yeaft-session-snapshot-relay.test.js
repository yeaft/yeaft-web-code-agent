/**
 * yeaft-session-snapshot-relay.test.js — regression guard for the
 * "yeaft session list wipes itself after create" bug (fixed in v0.1.907).
 *
 * Root cause: server/handlers/agent-output.js used `agent.id` (which is
 * undefined — the agents Map in server/ws-agent.js stores agents keyed
 * by id but never copies the id INTO the value object). This had two
 * symptom paths:
 *
 *   1. `yeaftSessionDb.reconcileFromSnapshot(ownerId, undefined, rows)`
 *      → node:sqlite throws on `undefined` parameter bind → caught by
 *      the surrounding try/catch → silent warn → DB never persists
 *      yeaft_sessions rows. Page reload reads `getByUser(userId)` and
 *      sees nothing.
 *   2. Forwarded envelopes to web carry `agentId: undefined` → JSON
 *      drops the field → web `applySnapshot(rows, null)` falls through
 *      to the legacy whole-replace path, which mishandles cross-agent
 *      rows.
 *
 * Fix: pass the `agentId` function-parameter (already destructured from
 * the call site in server/ws-agent.js → handleAgentOutput) everywhere
 * the handler previously read `agent.id`.
 *
 * This test mounts the real `handleAgentOutput` with light mocks (mirrors
 * yeaft-output-envelope.test.js) and asserts both symptoms are gone:
 *   - reconcileFromSnapshot is called with the right agentId
 *   - the forwarded envelope to webClients carries `agentId` set to the
 *     function-parameter value (not undefined)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory state shared across mocks + tests ──
const _sent = [];
const _webClients = new Map();
const _reconcileCalls = [];
const _upsertCalls = [];
const _deleteCalls = [];

function _reset() {
  _sent.length = 0;
  _webClients.clear();
  _reconcileCalls.length = 0;
  _upsertCalls.length = 0;
  _deleteCalls.length = 0;
}

// ── Mocks (hoisted before import below) ──
vi.mock('../../server/database.js', () => ({
  messageDb: { add: vi.fn(() => 'mock-db-id') },
  yeaftSessionDb: {
    reconcileFromSnapshot: vi.fn((userId, agentId, rows) => {
      _reconcileCalls.push({ userId, agentId, rows });
    }),
    upsertFromSnapshot: vi.fn((userId, agentId, row) => {
      _upsertCalls.push({ userId, agentId, row });
    }),
    get: vi.fn(() => null),
    delete: vi.fn((id) => { _deleteCalls.push(id); }),
  },
}));

vi.mock('../../server/ws-utils.js', () => ({
  broadcastAgentList: vi.fn(),
  forwardToClients: vi.fn(),
  sendToWebClient: vi.fn(async (client, envelope) => {
    _sent.push({ clientId: client.__id, envelope });
  }),
}));

vi.mock('../../server/context.js', () => ({
  webClients: _webClients,
  previewFiles: new Map(),
  trackMessage: vi.fn(),
}));

vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: false },
}));

const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

function addClient(id, userId) {
  const c = { __id: id, authenticated: true, userId };
  _webClients.set(id, c);
  return c;
}

// Critical: the agent object stored in server/ws-agent.js NEVER copies
// the agent id into the value. So tests must mirror that — no `id`
// field on the agent. If a future refactor adds `id`, the bug would
// still be present (handler should not depend on agent.id existing).
const baseAgent = {
  ownerId: 'u1',
  conversations: new Map(),
  // intentionally no `id`
};

beforeEach(_reset);

describe('agent-output.js — session_list_updated persistence (regression)', () => {
  it('passes the agentId function-parameter (not agent.id) to reconcileFromSnapshot', async () => {
    addClient('c1', 'u1');
    const sessions = [
      { id: 'grp_test_abc123', name: 'Test', roster: ['vp_alice'], defaultVpId: 'vp_alice' },
    ];
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_list_updated',
      sessions,
    });

    expect(_reconcileCalls).toHaveLength(1);
    expect(_reconcileCalls[0].userId).toBe('u1');
    expect(_reconcileCalls[0].agentId).toBe('agent_xyz');
    expect(_reconcileCalls[0].agentId).not.toBeUndefined();
    expect(_reconcileCalls[0].rows).toEqual(sessions);
  });

  it('forwards session_list_updated to web with agentId stamped from the parameter', async () => {
    addClient('c1', 'u1');
    const sessions = [{ id: 'grp_a', name: 'A' }];
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_list_updated',
      sessions,
    });

    expect(_sent).toHaveLength(1);
    const env = _sent[0].envelope;
    expect(env.type).toBe('session_list_updated');
    expect(env.agentId).toBe('agent_xyz');
    expect(env.agentId).not.toBeUndefined();
    expect(env.sessions).toEqual(sessions);
  });

  it('reconcile failure is swallowed but the broadcast still goes out (per-handler isolation)', async () => {
    // If reconcileFromSnapshot throws (e.g. transient DB lock), the
    // forwarded envelope must still reach the web client — sidebar
    // should never stall waiting for the DB.
    const { yeaftSessionDb } = await import('../../server/database.js');
    yeaftSessionDb.reconcileFromSnapshot.mockImplementationOnce(() => {
      throw new Error('simulated DB failure');
    });
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_list_updated',
      sessions: [{ id: 'g' }],
    });
    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope.agentId).toBe('agent_xyz');
  });

  it('skips DB persist when agent has no ownerId (anonymous agent)', async () => {
    addClient('c1', 'u1');
    const anonAgent = { ownerId: null, conversations: new Map() };
    await handleAgentOutput('agent_xyz', anonAgent, {
      type: 'session_list_updated',
      sessions: [{ id: 'g' }],
    });
    expect(_reconcileCalls).toHaveLength(0);
    // No web client gets it either — c1's userId is u1 but agent.ownerId
    // is null; CONFIG.skipAuth=false, so the ownership predicate
    // filters everyone out.
    expect(_sent).toHaveLength(0);
  });

  it('only forwards to webClients owned by the agent owner', async () => {
    addClient('mine', 'u1');
    addClient('theirs', 'u2');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_list_updated',
      sessions: [{ id: 'g' }],
    });
    expect(_sent.map(s => s.clientId)).toEqual(['mine']);
  });
});

describe('agent-output.js — session_roster_changed persistence (regression)', () => {
  it('passes the agentId parameter to upsertFromSnapshot', async () => {
    const { yeaftSessionDb } = await import('../../server/database.js');
    // Pre-seed the DB-mock so the "skip when unknown" guard passes:
    yeaftSessionDb.get.mockReturnValueOnce({
      id: 'grp_team',
      name: 'Team',
      roster: ['vp_a'],
      defaultVpId: 'vp_a',
      workDir: '/tmp',
      config: {},
      announcement: '',
      createdAt: 100,
    });
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_roster_changed',
      sessionId: 'grp_team',
      roster: ['vp_a', 'vp_b'],
      defaultVpId: 'vp_a',
      name: 'Team',
    });

    expect(_upsertCalls).toHaveLength(1);
    expect(_upsertCalls[0].userId).toBe('u1');
    expect(_upsertCalls[0].agentId).toBe('agent_xyz');
    expect(_upsertCalls[0].agentId).not.toBeUndefined();
  });

  it('forwards roster delta to web with agentId from the parameter', async () => {
    const { yeaftSessionDb } = await import('../../server/database.js');
    yeaftSessionDb.get.mockReturnValueOnce({
      id: 'grp_team',
      name: 'Team',
      roster: ['vp_a'],
      defaultVpId: 'vp_a',
      workDir: '/tmp',
      config: {},
      announcement: '',
      createdAt: 100,
    });
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_roster_changed',
      sessionId: 'grp_team',
      roster: ['vp_a', 'vp_b'],
      defaultVpId: 'vp_a',
      name: 'Team',
    });

    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope.agentId).toBe('agent_xyz');
    expect(_sent[0].envelope.sessionId).toBe('grp_team');
  });

  it('skips persist when the session is not already in the DB (cache-only delta)', async () => {
    const { yeaftSessionDb } = await import('../../server/database.js');
    yeaftSessionDb.get.mockReturnValueOnce(null);
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_roster_changed',
      sessionId: 'never_seen',
      roster: [],
    });
    expect(_upsertCalls).toHaveLength(0);
  });
});

describe('agent-output.js — session_crud_result relay (regression)', () => {
  it('forwards crud results with agentId from the parameter', async () => {
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_crud_result',
      op: 'create',
      ok: true,
      requestId: 'req_1',
      session: { id: 'grp_new', name: 'New' },
    });

    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope.agentId).toBe('agent_xyz');
    expect(_sent[0].envelope.type).toBe('session_crud_result');
  });

  it('deletes the row on a successful delete result', async () => {
    addClient('c1', 'u1');
    await handleAgentOutput('agent_xyz', baseAgent, {
      type: 'session_crud_result',
      op: 'delete',
      ok: true,
      sessionId: 'grp_gone',
    });
    expect(_deleteCalls).toEqual(['grp_gone']);
  });
});
