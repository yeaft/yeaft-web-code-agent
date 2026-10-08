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
  });

  it.each(['foreign', 'unowned', 'expired', 'malformed', 'missing', 'duplicate', 'count', 'file-size', 'total-size', 'data', 'paths', 'raw-files', 'access', 'auth'])('rejects %s before forwarding any subset', async mode => {
    let msg = request();
    if (mode === 'foreign') uploads.get('upload').userId = 'bob';
    if (mode === 'unowned') delete uploads.get('upload').userId;
    if (mode === 'expired') uploads.get('upload').uploadedAt -= 600000;
    if (mode === 'malformed') msg = request({ attachments: {} });
    if (mode === 'missing') msg.payload.attachments.push({ fileId: 'missing' });
    if (mode === 'duplicate') msg.payload.attachments.push({ fileId: 'upload' });
    if (mode === 'count') msg.payload.attachments = Array.from({ length: 5 }, (_, i) => ({ fileId: `f${i}` }));
    if (mode === 'file-size') uploads.get('upload').buffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    if (mode === 'total-size') {
      msg.payload.attachments = Array.from({ length: 3 }, (_, i) => ({ fileId: `f${i}` }));
      for (const { fileId } of msg.payload.attachments) uploads.set(fileId, { ...uploads.get('upload'), buffer: Buffer.alloc(4 * 1024 * 1024) });
    }
    if (mode === 'data') msg.payload.attachments[0].data = 'forged';
    if (mode === 'paths') msg.payload.attachments[0].path = '/etc/passwd';
    if (mode === 'raw-files') msg.payload.files = [{ data: 'forged' }];
    if (mode === 'access') accessError.mockReturnValue('No Agent access');
    if (mode === 'auth') client.authenticated = false;
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
      yield { type: 'text_delta', text: JSON.stringify(proposal) }; yield { type: 'stop', stopReason: 'end_turn' };
    } } });
    const state = personState(), envelopes = [];
    const chat = { authenticated: true, connectionState: 'connected', agents: [{ id: 'agent', online: true, capabilities: ['digital_person'] }],
      sendWsMessage(msg) { void relay.request(client, msg); return true; } };
    relay = createPersonRelay({ uploads, accessError, timeoutMs: 1000, agentMap: new Map([['agent', { capabilities: ['digital_person'] }]]),
      send: async (_client, msg) => acceptPersonResponse(chat, msg),
      forward: async (agentId, msg) => {
        const data = await service.request({ ownerId: msg.ownerId, op: msg.op, payload: msg.payload });
        if (msg.op === 'send') {
          envelopes.push(msg.payload);
          if (!lost) { lost = true; throw new Error('response lost after commit'); }
        }
        await relay.response(agentId, { requestId: msg.requestId, type: 'person_response', ok: true, data }); return true;
      } });
    const controller = createPersonController({ chat, state, scope: () => 'alice', timeoutMs: 2000, pollMs: 100000 });
    try {
      await controller.open('agent');
      // The backend contract starts with an already prepared/recoverable controller envelope.
      // UI composition/upload controls are covered in the independent frontend change.
      state.retryCommand = { op: 'send', payload: { text: '', clientMessageId: 'stable-controller', attachments: [{ fileId: 'upload' }] } };
      expect(await controller.command('send', '', true)).toBe(false);
      expect(state.error.code).toBe('outcome_unknown');
      expect(state.retryCommand.payload.attachments).toEqual([{ fileId: 'upload' }]);
      expect(await controller.command('send', '', true)).toBe(true);
      expect(envelopes[1]).toEqual(envelopes[0]);
      for (let i = 0; i < 100; i++) {
        if (!(await service.request({ ownerId: 'alice', op: 'snapshot', payload: {} })).busy) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const messages = await service.request({ ownerId: 'alice', op: 'messages', payload: {} });
      expect(messages.items.filter(m => m.role === 'user')).toHaveLength(1);
      expect(messages.items.find(m => m.role === 'user').attachments[0].name).toBe('notes.md');
      expect(calls).toBe(1); expect(uploads.has('upload')).toBe(true);
    } finally { controller.dispose(); await service.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('forwards modelCandidates settings without accepting forged owner or global provider config', async () => {
    await relay.request(client, request({ modelCandidates: ['native/first'], ownerId: 'bob', providers: [{ apiKey: 'secret' }] }, { op: 'settings' }));
    expect(forward.mock.lastCall[1]).toMatchObject({ ownerId: 'alice', payload: { modelCandidates: ['native/first'] } });
    expect(forward.mock.lastCall[1].payload).not.toHaveProperty('providers');
  });
});
