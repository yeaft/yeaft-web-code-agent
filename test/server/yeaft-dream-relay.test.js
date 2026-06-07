/**
 * Server relay passthrough for `yeaft_dream_status` and `yeaft_dream_result`
 * (v0.1.758).
 *
 * The bug this guards against:
 *   The Yeaft Yeaft "Dream" feature has two manual trigger points in the UI
 *   (group conversation header + group settings modal). Both reach the
 *   agent's `handleYeaftDreamTrigger`, which emits two BARE top-level
 *   WebSocket messages: `yeaft_dream_status` (status: 'running') at the
 *   start of the run, and `yeaft_dream_result` (success/entriesCreated/
 *   lastDreamAt/groups/targets/error/skipped) at the end.
 *
 *   Before this fix, `server/handlers/agent-output.js` had cases for
 *   `yeaft_output` and `yeaft_history_chunk` but NO case for either dream
 *   message. The switch fell through to `default: return false`, and the
 *   subsequent agent-side handlers (conversation/crew/file-terminal/sync)
 *   also had no match. The messages were silently dropped at the server.
 *
 *   User-visible symptom: clicking the dream button left the UI stuck on
 *   "Running…" forever because `yeaft_dream_result` never arrived, even
 *   though the dream pass had actually completed on the agent.
 *
 * Strategy mirrors `yeaft-output-envelope.test.js`: mock the heavy deps,
 * import the real `handleAgentOutput`, exercise both message types, and
 * assert the relay actually pushes them to authenticated web clients.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _sent = [];
const _webClients = new Map();

function _reset() {
  _sent.length = 0;
  _webClients.clear();
}

vi.mock('../../server/database.js', () => ({
  messageDb: {
    add: vi.fn(() => 'mock-db-id'),
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
  CONFIG: { skipAuth: true },
}));

const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

function addClient(id, { authenticated = true, userId = 'u1' } = {}) {
  const c = { __id: id, authenticated, userId };
  _webClients.set(id, c);
  return c;
}

const baseAgent = { ownerId: 'u1', conversations: new Map() };

beforeEach(_reset);

describe('agent-output.js — yeaft_dream_status relay', () => {
  it('forwards a vpId-scoped running status to the web client', async () => {
    addClient('c1');
    const ok = await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_status',
      vpId: 'vp_alice',
      status: 'running',
    });
    expect(ok).toBe(true);
    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_dream_status',
      vpId: 'vp_alice',
      status: 'running',
    });
  });

  it('forwards a sessionId-scoped running status to the web client', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_status',
      sessionId: 'grp_team',
      status: 'running',
    });
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_dream_status',
      sessionId: 'grp_team',
      status: 'running',
    });
  });
});

describe('agent-output.js — yeaft_dream_result relay', () => {
  it('forwards a successful vpId-scoped result with derived fields', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_result',
      vpId: 'vp_alice',
      success: true,
      entriesCreated: 3,
      lastDreamAt: '2026-05-13T05:00:00Z',
      groups: [{ scope: 'vp/alice', mergedCount: 3 }],
      targets: [
        { scope: 'vp/alice', status: 'done' },
        { scope: 'vp/alice', status: 'done' },
        { scope: 'vp/alice', status: 'done' },
      ],
      startedAt: '2026-05-13T05:00:00Z',
    });
    const env = _sent[0].envelope;
    expect(env).toMatchObject({
      type: 'yeaft_dream_result',
      vpId: 'vp_alice',
      success: true,
      entriesCreated: 3,
      lastDreamAt: '2026-05-13T05:00:00Z',
    });
    expect(env.targets).toHaveLength(3);
    expect(env.groups).toHaveLength(1);
  });

  it('forwards a sessionId-scoped result', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_result',
      sessionId: 'grp_team',
      success: true,
      entriesCreated: 1,
      lastDreamAt: '2026-05-13T05:01:00Z',
    });
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_dream_result',
      sessionId: 'grp_team',
      success: true,
      entriesCreated: 1,
    });
  });

  it('forwards an error envelope verbatim (scheduler not ready)', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_result',
      vpId: 'vp_alice',
      success: false,
      error: 'Dream scheduler not initialized — session not loaded.',
    });
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_dream_result',
      vpId: 'vp_alice',
      success: false,
      error: 'Dream scheduler not initialized — session not loaded.',
    });
  });

  it('forwards a skipped-result (no new messages) verbatim', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_result',
      sessionId: 'grp_team',
      success: false,
      skipped: true,
      entriesCreated: 0,
      lastDreamAt: '2026-05-13T05:02:00Z',
    });
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_dream_result',
      sessionId: 'grp_team',
      skipped: true,
      success: false,
    });
  });
});

describe('agent-output.js — dream relay broadcast semantics', () => {
  it('delivers to every authenticated client of the agent owner', async () => {
    addClient('c1');
    addClient('c2');
    _webClients.set('c3', { __id: 'c3', authenticated: false, userId: 'u1' });
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_status',
      sessionId: 'grp_team',
      status: 'running',
    });
    const ids = _sent.map(s => s.clientId).sort();
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('does not deliver to an unauthenticated client', async () => {
    addClient('c1', { authenticated: false });
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_dream_status',
      vpId: 'vp_alice',
      status: 'running',
    });
    expect(_sent).toHaveLength(0);
  });
});
