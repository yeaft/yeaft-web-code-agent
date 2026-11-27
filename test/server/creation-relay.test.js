import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  agents: new Map(), webClients: new Map(), pendingFiles: new Map(), previewFiles: new Map(),
  users: new Map(), trackMessageBytesSent: () => {},
}));
vi.mock('../../server/context.js', () => state);
vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: false, jwtSecret: 'creation-relay-test-secret', jwtExpiresIn: '5m', browserRuntime: {}, fileCleanupInterval: 600_000 },
  getUserByUsername: username => state.users.get(username),
}));
vi.mock('../../server/auth.js', () => ({}));
vi.mock('../../server/database.js', () => ({ userDb: {
  isActive: id => [...state.users.values()].some(user => user.id === id && user.deletion_state === 'active'),
  getByUsername: username => state.users.get(username),
  updateLogin: () => {},
}, scheduledTaskReceiptDb: { getByUser: () => [] } }));
vi.mock('../../server/yeaft-asset-store.js', () => ({ yeaftAssetStore: {} }));
vi.mock('../../server/workbench-preview.js', () => ({}));

import { CONFIG } from '../../server/config.js';
import { activeSessions, revokedTokens } from '../../server/auth/session-store.js';
import { issueSessionToken, logout } from '../../server/auth/token.js';
import { handleWebConnection } from '../../server/ws-client.js';
import { createCreationRelay } from '../../server/handlers/client-creation.js';
import { handleAgentCreation } from '../../server/handlers/agent-creation.js';
import { validateCreationAttachments, MAX_CREATION_ATTACHMENT_BYTES } from '../../server/creation-attachment-policy.js';
import { closeCreationMediaReads, CREATION_MEDIA_CHUNK_BYTES, readCreationMediaChunk } from '../../server/creation-media-relay.js';
import { registerUploadRoutes } from '../../server/routes/upload-routes.js';

const agentId = 'user-a:agent-a';
const owner = { username: 'alice', role: 'pro' };
const source = { agentId, creationId: 'creation-a', mediaKind: 'asset', mediaId: 'media-a' };
const url = `/api/yeaft/creations/${agentId}/creation-a/media/asset/media-a`;
const msg = (extra = {}) => ({ type: 'creation_request', requestId: 'browser-1', agentId, op: 'get_creation', ...extra });
const socket = () => Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() });
const browser = userId => ({ authenticated: true, userId, username: userId === 'user-a' ? 'alice' : 'bob', role: 'pro', encryptOutbound: false, ws: socket() });
const app = express();
registerUploadRoutes(app, {
  requireAuth: (_req, res) => res.sendStatus(500),
  requireSessionAuth: (req, res, next) => {
    const username = req.get('test-user');
    if (!username) return res.sendStatus(401);
    req.user = { username, role: 'pro' };
    next();
  },
});

let relay, agent, client, peer, other;
beforeEach(() => {
  state.agents.clear();
  state.webClients.clear();
  state.pendingFiles.clear();
  state.users.clear();
  state.users.set('alice', { id: 'user-a', deletion_state: 'active' });
  state.users.set('bob', { id: 'user-b', deletion_state: 'active' });
  agent = { ownerId: 'user-a', capabilities: ['creations'], encryptOutbound: false, ws: socket() };
  state.agents.set(agentId, agent);
  client = browser('user-a');
  peer = browser('user-a');
  other = browser('user-b');
  state.webClients.set('client', client).set('peer', peer).set('other', other);
  relay = createCreationRelay();
});
afterEach(() => {
  relay.close();
  closeCreationMediaReads(agentId, agent);
  activeSessions.clear();
  revokedTokens.clear();
  vi.useRealTimers();
});
const frame = connection => JSON.parse(connection.ws.send.mock.lastCall[0]);

function serveMedia(bytes, mimeType = 'audio/mpeg', filename = 'media.mp3') {
  agent.ws.send.mockImplementation(wire => {
    const pull = JSON.parse(wire);
    const end = Math.min(bytes.length - 1, pull.end);
    void handleAgentCreation(agentId, agent, {
      ...pull, type: 'creation_media_chunk', mimeType, filename, totalSize: bytes.length, end,
      data: bytes.subarray(pull.start, end + 1).toString('base64'),
    });
  });
}
const binaryParser = (res, callback) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('error', callback);
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const get = (path = url, username = 'alice') => request(app).get(path).set('test-user', username).buffer(true).parse(binaryParser);

describe('Creation WebSocket relay', () => {
  it.each(['email_verify', 'totp_verify', 'temp', 'totp-setup'])('rejects a %s token before registering the socket', type => {
    const token = jwt.sign({ username: 'alice', type }, CONFIG.jwtSecret, { expiresIn: '5m' });
    const ws = socket();
    handleWebConnection(ws, new URL(`https://example.test/ws?token=${token}`));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication required');
    expect(frame({ ws })).toMatchObject({ type: 'auth_result', success: false });
    expect([...state.webClients.values()].some(c => c.ws === ws)).toBe(false);
    expect(ws.emit('message', Buffer.from(JSON.stringify(msg())))).toBe(false);
    expect(agent.ws.send).not.toHaveBeenCalled();
  });

  it('retains the full session token and rejects incoming frames after logout', async () => {
    vi.useFakeTimers();
    agent.conversations = new Map();
    const token = issueSessionToken('alice');
    const ws = socket();
    handleWebConnection(ws, new URL('https://example.test/ws'), { headers: { cookie: `yeaft_session=${token}` } });
    expect(frame({ ws })).toMatchObject({ type: 'auth_result', success: true });
    expect([...state.webClients.values()].find(c => c.ws === ws)?.authToken).toBe(token);
    logout(token);
    const [receive] = ws.listeners('message');
    await receive(Buffer.from(JSON.stringify(msg())));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Session no longer valid');
    expect(agent.ws.send).not.toHaveBeenCalled();
  });

  it.each(['request', 'response', 'event'])('closes a revoked session and blocks Creation %s delivery', async kind => {
    client.authToken = issueSessionToken('alice');
    if (kind === 'response') await relay.request(client, msg());
    logout(client.authToken);
    if (kind === 'request') {
      await relay.request(client, msg());
      expect(agent.ws.send).not.toHaveBeenCalled();
    } else if (kind === 'response') {
      await relay.response(agentId, agent, { type: 'creation_response', requestId: frame(agent).requestId, ok: true });
    } else {
      await handleAgentCreation(agentId, agent, { type: 'creation_event', event: { type: 'creation_updated' } });
      expect(frame(peer).type).toBe('creation_event');
    }
    expect(client.ws.close).toHaveBeenCalledWith(1008, 'Session no longer valid');
    expect(client.ws.send).not.toHaveBeenCalled();
  });

  it('authorizes the owner, replaces the correlation ID and does not trust browser identity', async () => {
    await relay.request(client, msg({ ownerId: 'spoofed', payload: { creationId: 'creation-a' } }));
    expect(frame(agent)).toEqual({ type: 'creation_request', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), op: 'get_creation', ownerId: 'alice', payload: { creationId: 'creation-a' } });
    expect(frame(agent).requestId).not.toBe('browser-1');
  });

  it.each([
    ['another user', 'forbidden', () => other],
    ['inactive owner', 'forbidden', () => { state.users.get('alice').deletion_state = 'pending'; return client; }],
    ['offline Agent', 'offline', () => { agent.ws.readyState = 3; return client; }],
    ['no capability', 'unsupported_capability', () => { agent.capabilities = []; return client; }],
    ['unknown op', 'invalid_request', () => client, { op: 'read_file' }],
    ['implicit Agent', 'invalid_request', () => client, { agentId: undefined }],
  ])('rejects %s', async (_label, errorCode, setup, extra) => {
    const requester = setup();
    await relay.request(requester, msg(extra));
    expect(frame(requester)).toMatchObject({ type: 'creation_response', ok: false, errorCode });
    if (errorCode === 'unsupported_capability') expect(frame(requester).error).toBe('Agent does not support Creations');
    expect(agent.ws.send).not.toHaveBeenCalled();
  });

  it('ignores wrong Agent IDs and socket objects, then delivers only once to the requesting browser', async () => {
    await relay.request(client, msg());
    const response = { type: 'creation_response', requestId: frame(agent).requestId, ok: true, data: { title: 'Private' }, agentId: 'spoofed', op: 'spoofed' };
    await relay.response('wrong-agent', agent, response);
    await relay.response(agentId, { ...agent }, response);
    expect(client.ws.send).not.toHaveBeenCalled();
    await relay.response(agentId, agent, response);
    await relay.response(agentId, agent, response);
    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(frame(client)).toEqual({ type: 'creation_response', agentId, requestId: 'browser-1', op: 'get_creation', ok: true, data: response.data });
    expect(peer.ws.send).not.toHaveBeenCalled();
    expect(other.ws.send).not.toHaveBeenCalled();
  });

  it.each(['revoked account', 'revoked ownership', 'replaced connection'])('drops responses after %s', async change => {
    await relay.request(client, msg());
    const response = { type: 'creation_response', requestId: frame(agent).requestId, ok: true };
    if (change === 'revoked account') state.users.get('alice').deletion_state = 'pending';
    if (change === 'revoked ownership') agent.ownerId = 'user-b';
    if (change === 'replaced connection') state.agents.set(agentId, { ...agent });
    await relay.response(agentId, agent, response);
    expect(client.ws.send).not.toHaveBeenCalled();
  });

  it('times out after exactly 45s and clears timers and correlations on browser disconnect', async () => {
    vi.useFakeTimers();
    await relay.request(client, msg());
    const expired = frame(agent).requestId;
    await relay.request(peer, msg());
    const disconnected = frame(agent).requestId;
    relay.clearClient(peer);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(client.ws.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(frame(client)).toMatchObject({ errorCode: 'timeout', requestId: 'browser-1' });
    for (const requestId of [expired, disconnected]) await relay.response(agentId, agent, { type: 'creation_response', requestId, ok: true });
    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(peer.ws.send).not.toHaveBeenCalled();
  });

  it.each(['offline', 'outcome_unknown'])('cleans up transport failure (%s)', async code => {
    vi.useFakeTimers();
    relay = createCreationRelay({ forward: async () => {
      if (code === 'outcome_unknown') throw new Error('Transport failure');
      return false;
    } });
    await relay.request(client, msg());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(frame(client)).toMatchObject({ errorCode: code });
  });

  it('broadcasts events with the server-derived ID only to authorized browsers', async () => {
    const event = { type: 'creation_updated', creationId: 'c1' };
    await handleAgentCreation(agentId, agent, { type: 'creation_event', agentId: 'spoofed', event, ownerId: 'user-b' });
    for (const receiver of [client, peer]) expect(frame(receiver)).toEqual({ type: 'creation_event', agentId, event });
    expect(other.ws.send).not.toHaveBeenCalled();
  });
});

describe('Creation upload attachment policy', () => {
  const ref = { fileId: 'upload-id' };
  const payload = { attachments: [ref] };
  let entry;
  beforeEach(() => {
    entry = { userId: 'user-a', name: 'notes.md', mimeType: 'text/markdown', uploadedAt: Date.now(), buffer: Buffer.from('notes') };
    state.pendingFiles.set(ref.fileId, entry);
  });

  it.each(['create_creation', 'add_sources', 'send_message'])('uses server upload bytes for %s and rejects raw files', async op => {
    await relay.request(client, msg({ op, payload: { attachments: [{ ...ref, name: 'fake.md' }] } }));
    expect(frame(agent).payload).toEqual({ files: [{ name: 'notes.md', mimeType: 'text/markdown', data: 'bm90ZXM=', size: 5 }] });
    expect(state.pendingFiles.get(ref.fileId)).toBe(entry);
    await relay.request(client, msg({ op, payload: { ...payload, files: [] } }));
    expect(frame(client)).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(agent.ws.send).toHaveBeenCalledTimes(1);
  });

  it('requires the session middleware for POST uploads', async () => {
    await request(app).post('/api/upload').attach('files', Buffer.from('notes'), 'notes.txt').expect(401);
    await request(app).post('/api/upload').set('test-user', 'alice').expect(400);
  });

  it.each(['response', 'timeout', 'browser disconnect', 'Agent disconnect', 'transport error', 'offline'])('releases the shared per-user upload budget after %s', async exit => {
    vi.useFakeTimers();
    entry.buffer = Buffer.alloc(MAX_CREATION_ATTACHMENT_BYTES);
    const encode = vi.spyOn(entry.buffer, 'toString').mockReturnValue('encoded');
    const large = msg({ op: 'add_sources', payload: { attachments: [ref, { fileId: 'upload-two' }] } });
    state.pendingFiles.set('upload-two', entry);
    const forward = vi.fn(async () => {
      if (exit === 'transport error') throw new Error('Transport failure');
      return exit !== 'offline';
    });
    relay = createCreationRelay({ forward });
    await relay.request(client, large);
    if (!['transport error', 'offline'].includes(exit)) {
      await relay.request(peer, msg({ op: 'add_sources', payload }));
      expect(frame(peer)).toMatchObject({ ok: false, errorCode: 'busy' });
      expect(forward).toHaveBeenCalledTimes(1);
      expect(encode).toHaveBeenCalledTimes(2);
      if (exit === 'response') await relay.response(agentId, agent, {
        type: 'creation_response', requestId: forward.mock.calls[0][1].requestId, ok: true,
      });
      if (exit === 'timeout') await vi.advanceTimersByTimeAsync(45_000);
      if (exit === 'browser disconnect') relay.clearClient(client);
      if (exit === 'Agent disconnect') relay.clearAgent(agentId, agent);
    }
    await relay.request(peer, large);
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('enforces the global upload budget across users', async () => {
    const bytes = Buffer.alloc(MAX_CREATION_ATTACHMENT_BYTES);
    vi.spyOn(bytes, 'toString').mockReturnValue('encoded');
    const forward = vi.fn(async () => true);
    const adminAgent = { ...agent, ownerId: null };
    state.agents.set(agentId, adminAgent);
    state.users.set('carol', { id: 'user-c', deletion_state: 'active' });
    relay = createCreationRelay({ forward });
    const upload = async userId => {
      const requester = { ...browser(userId), role: 'admin' };
      const attachments = [0, 1].map(index => {
        const fileId = `${userId}-${index}`;
        state.pendingFiles.set(fileId, { ...entry, userId, buffer: bytes });
        return { fileId };
      });
      await relay.request(requester, msg({ op: 'add_sources', payload: { attachments } }));
      return requester;
    };
    const first = await upload('user-a');
    await upload('user-b');
    expect(frame(await upload('user-c'))).toMatchObject({ ok: false, errorCode: 'busy' });
    expect(forward).toHaveBeenCalledTimes(2);
    relay.clearClient(first);
    await upload('user-c');
    expect(forward).toHaveBeenCalledTimes(3);
  });

  it('rejects forwarding above 16 MiB of Agent socket backpressure', async () => {
    agent.ws.bufferedAmount = 16 * 1024 * 1024 + 1;
    const upload = msg({ op: 'add_sources', payload });
    await relay.request(client, upload);
    expect(frame(client)).toMatchObject({ ok: false, errorCode: 'busy' });
    expect(agent.ws.send).not.toHaveBeenCalled();
    agent.ws.bufferedAmount--;
    await relay.request(client, upload);
    expect(agent.ws.send).toHaveBeenCalledTimes(1);
  });

  it('requires upload ownership and checks the original TTL, including the exact expiry boundary', () => {
    expect(validateCreationAttachments(other, payload)).toMatchObject({ ok: false, errorCode: 'forbidden' });
    expect(validateCreationAttachments(other, payload, { skipAuth: true }).ok).toBe(true);
    expect(validateCreationAttachments(client, payload, { now: () => entry.uploadedAt + 600_000 })).toMatchObject({ ok: false, errorCode: 'attachment_expired' });
    expect(validateCreationAttachments(client, payload, { now: () => entry.uploadedAt - 1 })).toMatchObject({ ok: false, errorCode: 'attachment_expired' });
  });

  it('rejects too many attachments, oversized files, and oversized totals before forwarding', () => {
    const limited = { ok: false, files: [], errorCode: 'attachment_limit' };
    expect(validateCreationAttachments(client, { attachments: Array(11).fill(ref) })).toMatchObject(limited);
    entry.buffer = Buffer.alloc(MAX_CREATION_ATTACHMENT_BYTES + 1);
    expect(validateCreationAttachments(client, payload)).toMatchObject(limited);
    entry.buffer = entry.buffer.subarray(1);
    state.pendingFiles.set('upload-two', entry).set('upload-three', { ...entry, buffer: Buffer.alloc(1) });
    expect(validateCreationAttachments(client, { attachments: [ref, { fileId: 'upload-two' }, { fileId: 'upload-three' }] })).toMatchObject(limited);
  });
});

describe('Creation media HTTP streaming', () => {
  const bytes = Buffer.from('0123456789');
  it('streams a full body in bounded chunks with authenticated, no-transform headers', async () => {
    const big = Buffer.alloc(CREATION_MEDIA_CHUNK_BYTES + 7, 'a');
    big.write('ID3');
    serveMedia(big);
    const response = await get().expect(200).expect('Content-Length', String(big.length))
      .expect('Accept-Ranges', 'bytes').expect('X-Content-Type-Options', 'nosniff')
      .expect('Cache-Control', 'private, no-store, no-transform').expect('Content-Disposition', /^inline;/);
    expect(response.body.equals(big)).toBe(true);
    expect(agent.ws.send.mock.calls.map(([wire]) => { const { start, end } = JSON.parse(wire); return [start, end]; }))
      .toEqual([[0, CREATION_MEDIA_CHUNK_BYTES - 1], [CREATION_MEDIA_CHUNK_BYTES, big.length - 1]]);
  });

  it.each([['bytes=2-4', '234', '2-4'], ['bytes=-3', '789', '7-9'], ['bytes=8-', '89', '8-9'], ['bytes=8-999', '89', '8-9']])('supports %s', async (range, body, actual) => {
    serveMedia(bytes);
    const response = await get().set('Range', range).expect(206).expect('Content-Range', `bytes ${actual}/10`).expect('Content-Length', String(body.length));
    expect(response.body.toString()).toBe(body);
  });

  it('supports HEAD without pulling a full body', async () => {
    serveMedia(bytes);
    const response = await request(app).head(url).set('test-user', 'alice').set('Range', 'bytes=-3')
      .expect(206).expect('Content-Range', 'bytes 7-9/10').expect('Content-Length', '3');
    expect(response.text).toBeUndefined();
    expect(agent.ws.send).toHaveBeenCalledTimes(1);
    expect(frame(agent)).toMatchObject({ start: 0, end: 4095 });
  });

  it.each(['bytes=10-', 'bytes=4-2', 'bytes=0-1,3-4', 'items=0-1'])('rejects unsatisfiable or malformed range %s', async range => {
    serveMedia(bytes);
    await get().set('Range', range).expect(416).expect('Content-Range', 'bytes */10').expect('Content-Length', '0');
  });

  it('applies strong If-Range comparison and serves the complete representation for a mismatch', async () => {
    const fullBytes = Buffer.alloc(CREATION_MEDIA_CHUNK_BYTES + 7, 'x');
    fullBytes.write('ID3');
    serveMedia(fullBytes);
    const { headers: { etag } } = await request(app).head(url).set('test-user', 'alice').expect(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const partial = await get().set('Range', 'bytes=2-4').set('If-Range', etag).expect(206).expect('ETag', etag);
    expect(partial.body.equals(fullBytes.subarray(2, 5))).toBe(true);
    for (const validator of ['"different"', `W/${etag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const full = await get().set('Range', 'bytes=2-4').set('If-Range', validator).expect(200).expect('ETag', etag);
      expect(full.headers['content-range']).toBeUndefined();
      expect(full.body.equals(fullBytes)).toBe(true);
    }
  });

  it('checks the representation prefix on GET, ranged GET and HEAD before serving an inline MIME type', async () => {
    const spoof = Buffer.concat([Buffer.from('<script>/*'), Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('*/</script>')]);
    serveMedia(spoof, 'image/png', 'image.png');
    for (const [response, code] of [[get(), 200], [get().set('Range', 'bytes=10-17'), 206], [request(app).head(url).set('test-user', 'alice'), 200]]) {
      await response.expect(code).expect('Content-Type', 'application/octet-stream').expect('Content-Disposition', /^attachment;/);
    }
    serveMedia(Buffer.from('89504e470d0a1a0a0000', 'hex'), 'image/png', 'image.png');
    await get().set('Range', 'bytes=9-').expect(206).expect('Content-Type', 'image/png').expect('Content-Disposition', /^inline;/);
  });

  it('handles zero-byte files', async () => {
    serveMedia(Buffer.alloc(0));
    await get().expect(200).expect('Content-Length', '0');
    await get().set('Range', 'bytes=0-').expect(416).expect('Content-Range', 'bytes */0');
  });

  it('requires a session, denies other users and hides missing media', async () => {
    await request(app).get(url).expect(401);
    await request(app).head(url).expect(401);
    await get(url, 'bob').expect(403);
    await get(url.replace('media-a', '%2e%2e%2fother')).expect(404);
    expect(agent.ws.send).not.toHaveBeenCalled();
    agent.ws.send.mockImplementation(wire => {
      const { requestId } = JSON.parse(wire);
      void handleAgentCreation(agentId, agent, { type: 'creation_media_chunk', requestId, errorCode: 'NOT_FOUND' });
    });
    await get().expect(404);
  });

  it('sandboxes inline SVG assets only, forces downloads and never serves active HTML inline', async () => {
    serveMedia(Buffer.from('<svg/>'), 'image/svg+xml', '../pictué.svg');
    await get().expect(200).expect('Content-Type', 'image/svg+xml')
      .expect('Content-Disposition', "inline; filename*=UTF-8''pictu%C3%A9.svg")
      .expect('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    for (const path of [url.replace('/asset/', '/source/'), `${url}?download=1`]) {
      const response = await get(path).expect(200).expect('Content-Disposition', /^attachment;/);
      expect(response.headers['content-security-policy']).toBeUndefined();
    }
    serveMedia(Buffer.from('<h1>active</h1>'), 'text/html');
    await get().expect(200).expect('Content-Disposition', /^attachment;/).expect('Content-Type', 'application/octet-stream');
  });
});

describe('Creation media chunk correlation and limits', () => {
  const read = signal => readCreationMediaChunk(owner, { ...source, start: 0, end: 9 }, signal);
  const reply = data => ({ ...frame(agent), type: 'creation_media_chunk', start: 0, end: 0, totalSize: 1, filename: 'a', mimeType: 'image/png', data });

  it('ignores spoofed socket and agent ID, and validates canonical base64', async () => {
    const pending = read();
    expect(frame(agent)).toMatchObject({ type: 'creation_media_read', ownerId: 'alice' });
    const response = reply('YQ==');
    await handleAgentCreation(agentId, { ...agent }, response);
    await handleAgentCreation('other-id', agent, response);
    await handleAgentCreation(agentId, agent, { ...response, data: 'YR==' });
    await expect(pending).rejects.toMatchObject({ status: 502 });
  });

  it('releases pending reads on timeout, disconnect and abort', async () => {
    vi.useFakeTimers();
    const timed = expect(read()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15_000);
    await timed;
    const disconnected = expect(read()).rejects.toMatchObject({ status: 503 });
    closeCreationMediaReads(agentId, { ...agent });
    closeCreationMediaReads(agentId, agent);
    await disconnected;
    const controller = new AbortController();
    const aborted = expect(read(controller.signal)).rejects.toMatchObject({ status: 499 });
    controller.abort();
    await aborted;
    serveMedia(Buffer.from('ok'));
    await expect(read()).resolves.toMatchObject({ totalSize: 2, buffer: Buffer.from('ok') });
  });

  it('bounds pulls and enforces the per-user transfer limit until slots are released', async () => {
    await expect(readCreationMediaChunk(owner, { ...source, start: 0, end: CREATION_MEDIA_CHUNK_BYTES })).rejects.toMatchObject({ status: 416 });
    expect(agent.ws.send).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = Array.from({ length: 16 }, () => expect(read(controller.signal)).rejects.toMatchObject({ status: 499 }));
    await expect(read()).rejects.toMatchObject({ status: 503 });
    controller.abort();
    await Promise.all(pending);
    serveMedia(Buffer.from('ok'));
    await expect(read()).resolves.toMatchObject({ totalSize: 2 });
  });
});
