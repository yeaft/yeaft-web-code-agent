import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false, fileCleanupInterval: 600000 } }));
vi.mock('../../server/context.js', () => ({ agents: new Map(), pendingFiles: new Map() }));
vi.mock('../../server/ws-utils.js', () => ({ forwardToAgent: vi.fn(), sendToWebClient: vi.fn(), resolveAgentAccessError: vi.fn() }));
import { createPersonRelay } from '../../server/handlers/client-person.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../agent/yeaft/person/service.js';
import { acceptPersonResponse, createPersonController, personState } from '../../web/stores/helpers/digital-person.js';
import { config, finalProposal } from '../agent/yeaft/person/fixtures.js';

let relay, uploads, forward, send, client, accessError;
const request = (payload = {}, extra = {}) => ({ type: 'person_request', op: 'send', requestId: 'browser', agentId: 'agent', payload: { text: '', clientMessageId: 'stable', attachments: [{ fileId: 'upload' }], ...payload }, ...extra });
beforeEach(() => {
  vi.useFakeTimers();
  client = { authenticated: true, userId: 'alice' };
  uploads = new Map([['upload', { userId: 'alice', name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('private notes'), uploadedAt: Date.now() }]]);
  send = vi.fn(async () => true); forward = vi.fn(async () => true); accessError = vi.fn(() => null);
  relay = createPersonRelay({ uploads, send, forward, accessError, agentMap: new Map([['agent', { capabilities: ['digital_person'] }]]) });
});
afterEach(() => { relay.close(); vi.useRealTimers(); });

describe('Person uploaded reference relay', () => {
  it('forwards canonical files only and retains identical refs across timeout, disconnect and lost response retries', async () => {
    await relay.request(client, request());
    const original = forward.mock.calls[0][1];
    expect(original.payload).toEqual({ text: '', clientMessageId: 'stable', files: [{ name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('private notes').toString('base64') }] });
    expect(uploads.has('upload')).toBe(true);
    await vi.advanceTimersByTimeAsync(30001);
    expect(send.mock.lastCall[1].errorCode).toBe('timeout');
    await relay.request(client, request({}, { requestId: 'retry' }));
    expect(forward.mock.lastCall[1].payload).toEqual(original.payload);
    relay.clearClient(client);
    await relay.request(client, request({}, { requestId: 'reconnect' }));
    const latest = forward.mock.lastCall[1];
    await relay.response('agent', { type: 'person_response', requestId: latest.requestId, ok: true, data: { episodeId: 'accepted-once', duplicate: true } });
    expect(uploads.has('upload')).toBe(true);
    expect(send.mock.lastCall[1].data.duplicate).toBe(true);
    await relay.request(client, request({}, { requestId: 'expired-response' }));
    await relay.response('agent', { type: 'person_response', requestId: forward.mock.lastCall[1].requestId, ok: false, errorCode: 'attachment_expired', error: 'Attachment expired' });
    expect(send.mock.lastCall[1]).toMatchObject({ ok: false, errorCode: 'attachment_expired' });
  });

  it.each(['foreign', 'paths'])('rejects %s before forwarding any subset', async mode => {
    const msg = request();
    if (mode === 'foreign') uploads.get('upload').userId = 'bob';
    if (mode === 'paths') msg.payload.attachments[0].path = '/etc/passwd';
    await relay.request(client, msg);
    expect(forward).not.toHaveBeenCalled();
    expect(send.mock.lastCall[1].ok).toBe(false);
    expect(uploads.has('upload')).toBe(true);
  });

  it('replays an attachment envelope from the controller after a real SQLite admission loses its response', async () => {
    vi.useRealTimers(); relay.close();
    const dir = await mkdtemp(join(tmpdir(), 'person-relay-files-'));
    let calls = 0, lost = false;
    const service = createPersonService({ yeaftDir: dir, config, embedding: { enabled: false }, adapter: { async *stream(params) {
      calls++;
      const context = JSON.parse(params.messages[0].content), proposal = finalProposal(context.state.version);
      proposal.concepts = []; proposal.state.focusConceptIds = [];
      yield { type: 'text_delta', text: params.tools.length ? proposal.reply : JSON.stringify(proposal) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } } });
    const state = personState(), envelopes = [];
    const chat = { authenticated: true, connectionState: 'connected', digitalPersonUiEnabledByAgent: { agent: true }, agents: [{ id: 'agent', online: true, capabilities: ['digital_person'] }],
      sendWsMessage(msg) { void relay.request(client, msg); return true; } };
    // This case tests a thrown/lost ACK, not the independent relay timeout path.
    // Allow cold SQLite/catalog initialization on slower CI workers to finish.
    relay = createPersonRelay({ uploads, accessError, timeoutMs: 10000, agentMap: new Map([['agent', { capabilities: ['digital_person'] }]]),
      send: async (_client, msg) => acceptPersonResponse(chat, msg),
      forward: async (agentId, msg) => {
        const data = await service.request({ ownerId: msg.ownerId, op: msg.op, payload: msg.payload });
        if (msg.op === 'send') {
          envelopes.push(msg.payload);
          if (!lost) { lost = true; throw new Error('response lost after commit'); }
        }
        await relay.response(agentId, { requestId: msg.requestId, type: 'person_response', ok: true, data }); return true;
      } });
    const controller = createPersonController({ chat, state, scope: () => 'alice', timeoutMs: 15000, pollMs: 100000 });
    try {
      await controller.open('agent');
      // The backend contract starts with an already prepared/recoverable controller envelope.
      // UI composition/upload controls are covered in the independent frontend change.
      state.retryCommand = { op: 'send', payload: { text: '', clientMessageId: 'stable-controller', attachments: [{ fileId: 'upload' }] } };
      expect(await controller.command('send', '', true)).toBe(false);
      expect(state.error.code).toBe('outcome_unknown');
      expect(state.retryCommand.payload.attachments).toEqual([{ fileId: 'upload' }]);
      expect(await controller.command('send', '', true)).toBe(true);
      // The original admission exists: reconcile its receipt instead of sending it again.
      expect(envelopes).toHaveLength(1);
      expect(state.retryCommand).toBeNull();
      for (let i = 0; i < 100; i++) {
        if (!(await service.request({ ownerId: 'alice', op: 'snapshot', payload: {} })).busy) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const messages = await service.request({ ownerId: 'alice', op: 'messages', payload: {} });
      expect(messages.items.filter(m => m.role === 'user')).toHaveLength(1);
      expect(messages.items.find(m => m.role === 'user').attachments[0].name).toBe('notes.md');
      expect(calls).toBe(2); // One execution end_turn plus one final cognition, no replay.
      expect(uploads.has('upload')).toBe(true);
    } finally { controller.dispose(); await service.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
