/**
 * Server relay envelope passthrough for `yeaft_output`.
 *
 * The bug this guards against (fixed in v0.1.756):
 *   Agent sends `{type:'yeaft_output', conversationId, sessionId, vpId, turnId, data}`
 *   Server forwarded only `{conversationId, sessionId, data, event}` to web clients,
 *   silently DROPPING `vpId` and `turnId`. The frontend reads
 *   `msg.vpId / msg.turnId` in `handleYeaftOutput` to stamp routing context
 *   that drives `speakerVpId` on streaming assistant deltas. Missing fields
 *   meant MessageList fell through from VpTurnBlock (with avatar) to a plain
 *   AssistantTurn (no avatar) — exactly the visual bug users reported after
 *   v0.1.755 ("AI 的 response icon 不见了").
 *
 * Strategy: mock the heavy deps (database, context, ws-utils, config) so we
 * can import the real `handleAgentOutput` and exercise the `yeaft_output`
 * branch end-to-end. The fake `sendToWebClient` records every envelope it
 * receives; assertions inspect those envelopes verbatim.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory state shared across mocks + tests ────────────────────────────
const _sent = [];
const _webClients = new Map();
const _previewFiles = new Map();

function _reset() {
  _sent.length = 0;
  _webClients.clear();
  _previewFiles.clear();
}

// ── Mocks (must be hoisted before the import below) ───────────────────────
vi.mock('../../server/database.js', () => ({
  messageDb: {
    add: vi.fn(() => 'mock-db-id'),
  },
}));

vi.mock('../../server/ws-utils.js', () => ({
  broadcastAgentList: vi.fn(),
  forwardToClients: vi.fn(),
  // The relay we care about. Record verbatim envelope per call.
  sendToWebClient: vi.fn(async (client, envelope) => {
    _sent.push({ clientId: client.__id, envelope });
  }),
}));

vi.mock('../../server/context.js', () => ({
  webClients: _webClients,
  previewFiles: _previewFiles,
  trackMessage: vi.fn(),
}));

vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: true },
}));

const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

function addClient(id) {
  const c = { __id: id, authenticated: true, userId: 'u1' };
  _webClients.set(id, c);
  return c;
}

const baseAgent = { ownerId: 'u1', conversations: new Map() };

beforeEach(_reset);

describe('agent-output.js — yeaft_output envelope passthrough', () => {
  it('forwards vpId on data envelopes', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      vpId: 'vp_alice',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope.vpId).toBe('vp_alice');
  });

  it('forwards turnId on data envelopes', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      turnId: 'd123:vp_alice',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    expect(_sent[0].envelope.turnId).toBe('d123:vp_alice');
  });

  it('forwards sessionId on data envelopes (already worked, regression guard)', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      sessionId: 'grp_team',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    expect(_sent[0].envelope.sessionId).toBe('grp_team');
  });

  it('forwards ALL envelope fields together on a typical streaming delta', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      sessionId: 'grp_team',
      vpId: 'vp_alice',
      turnId: 'd123:vp_alice',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    const env = _sent[0].envelope;
    expect(env).toMatchObject({
      type: 'yeaft_output',
      conversationId: 'conv1',
      sessionId: 'grp_team',
      vpId: 'vp_alice',
      turnId: 'd123:vp_alice',
    });
    expect(env.data).toEqual({ type: 'assistant', message: { content: 'hi' } });
  });

  it('forwards vpId/turnId on event envelopes (vp_typing_start, vp_turn_start, etc.)', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      vpId: 'vp_alice',
      turnId: 'd123:vp_alice',
      event: { type: 'vp_typing_start', vpId: 'vp_alice' },
    });
    expect(_sent[0].envelope.vpId).toBe('vp_alice');
    expect(_sent[0].envelope.turnId).toBe('d123:vp_alice');
    expect(_sent[0].envelope.event).toEqual({ type: 'vp_typing_start', vpId: 'vp_alice' });
  });

  it('omits absent envelope fields (no `undefined` leaks)', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      data: { type: 'assistant', message: { content: 'hi' } },
      // No sessionId / vpId / turnId
    });
    const env = _sent[0].envelope;
    expect('sessionId' in env).toBe(false);
    expect('vpId' in env).toBe(false);
    expect('turnId' in env).toBe(false);
  });

  it('forwards empty-string ids verbatim (`!= null`, not truthy)', async () => {
    // A relay shouldn't silently eat legitimate values. IDs are non-empty
    // in practice, but if one ever arrives as '' or 0, we want the relay
    // to pass it through visibly rather than drop it. Documents the
    // `!= null` semantics chosen in agent-output.js.
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      sessionId: '',
      vpId: '',
      turnId: '',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    const env = _sent[0].envelope;
    expect(env.sessionId).toBe('');
    expect(env.vpId).toBe('');
    expect(env.turnId).toBe('');
  });

  it('hydrates previewData into preview URLs on yeaft_output user attachments', async () => {
    addClient('c1');
    const data = Buffer.from('image-bytes').toString('base64');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      sessionId: 'grp_img',
      data: {
        type: 'user',
        message: {
          content: 'see image',
          attachments: [{
            name: 'pic.png',
            mimeType: 'image/png',
            isImage: true,
            previewData: { data, mimeType: 'image/png', filename: 'pic.png' },
          }],
        },
      },
    });

    const att = _sent[0].envelope.data.message.attachments[0];
    expect(att.preview).toMatch(/^\/api\/preview\/[^?]+\?token=/);
    expect(att).not.toHaveProperty('previewData');
    expect(_previewFiles.size).toBe(1);
    expect(Array.from(_previewFiles.values())[0]).toEqual(expect.objectContaining({
      buffer: Buffer.from('image-bytes'),
      mimeType: 'image/png',
      filename: 'pic.png',
    }));
  });

  it('hydrates previewData into preview URLs on history chunks', async () => {
    addClient('c1');
    const data = Buffer.from('older-image').toString('base64');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_history_chunk',
      conversationId: 'conv1',
      sessionId: 'grp_img',
      messages: [{
        role: 'user',
        content: 'old image',
        attachments: [{ name: 'old.png', mimeType: 'image/png', isImage: true, previewData: { data } }],
      }],
      oldestSeq: 5,
      hasMore: false,
    });

    const att = _sent[0].envelope.messages[0].attachments[0];
    expect(att.preview).toMatch(/^\/api\/preview\/[^?]+\?token=/);
    expect(att).not.toHaveProperty('previewData');
    expect(_previewFiles.size).toBe(1);
  });

  it('forwards sessionId on history chunks using the same `!= null` semantics', async () => {
    addClient('c1');
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_history_chunk',
      conversationId: 'conv1',
      sessionId: '',
      messages: [],
      oldestSeq: 5,
      hasMore: false,
    });

    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_history_chunk',
      conversationId: 'conv1',
      sessionId: '',
      messages: [],
      oldestSeq: 5,
      hasMore: false,
    });
  });

  it('broadcasts to every authenticated client of the agent owner', async () => {
    addClient('c1');
    addClient('c2');
    // Unauthenticated client should NOT receive
    _webClients.set('c3', { __id: 'c3', authenticated: false, userId: 'u1' });
    await handleAgentOutput('a1', baseAgent, {
      type: 'yeaft_output',
      conversationId: 'conv1',
      vpId: 'vp_alice',
      data: { type: 'assistant', message: { content: 'hi' } },
    });
    // skipAuth: true bypasses the ownerId check; both c1 and c2 are
    // authenticated so both receive. c3 is filtered out by the
    // `c.authenticated` predicate.
    const ids = _sent.map(s => s.clientId).sort();
    expect(ids).toEqual(['c1', 'c2']);
    for (const s of _sent) expect(s.envelope.vpId).toBe('vp_alice');
  });
});
