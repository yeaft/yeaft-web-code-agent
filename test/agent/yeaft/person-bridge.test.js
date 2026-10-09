import { describe, expect, it, vi } from 'vitest';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';

const request = (extra = {}) => ({ type: 'person_request', requestId: 'r1', ownerId: 'u1', op: 'status', payload: {}, ...extra });
function fixture(env = { YEAFT_PERSON_MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=test' }) {
  const service = { request: vi.fn(async () => ({ configured: true })), close: vi.fn(async () => {}) };
  const createService = vi.fn(async () => service);
  const send = vi.fn(async () => {});
  const context = { agentId: 'a1', CONFIG: { serverUrl: 'https://server', yeaftDir: '/isolated/person', workDir: '/work' } };
  return { service, createService, send, context, bridge: createPersonBridge({ context, env, send, createService }) };
}

describe('Person bridge is independent of Session and Work Center', () => {
  it('lazily selects instance-local storage without Mongo configuration', async () => {
    const f = fixture({});
    expect(f.createService).not.toHaveBeenCalled();
    await f.bridge.request(request());
    expect(f.createService).toHaveBeenCalledWith(expect.objectContaining({
      uri: undefined, storage: undefined, yeaftDir: '/isolated/person',
      embedding: { enabled: true, allowDownload: true },
    }));
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { configured: true } }));
    await f.bridge.close();
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  it('passes only deployment embedding and backend controls', async () => {
    const f = fixture({ YEAFT_PERSON_STORAGE: 'sqlite', YEAFT_PERSON_EMBEDDING: 'off', YEAFT_PERSON_EMBEDDING_DOWNLOAD: '0' });
    await f.bridge.request(request({ payload: { storage: 'mongodb', embedding: { allowDownload: true } } }));
    expect(f.createService).toHaveBeenCalledWith(expect.objectContaining({ storage: 'sqlite', embedding: { enabled: false, allowDownload: false } }));
    await f.bridge.close();
  });

  it('binds local database configuration and authenticated owner without accepting browser config', async () => {
    const f = fixture();
    await f.bridge.request(request({ op: 'open', payload: { uri: 'mongodb://evil', ownerId: 'victim' } }));
    expect(f.createService).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'mongodb://localhost:27017/?replicaSet=test', dbName: 'yeaft_person', yeaftDir: '/isolated/person', namespace: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(f.service.request).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', op: 'open' }));
    await f.bridge.request(request());
    expect(f.createService).toHaveBeenCalledTimes(1);
    await f.bridge.close();
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  it('does not return database or provider secrets on failures; failed init can be retried', async () => {
    const f = fixture();
    f.createService.mockRejectedValueOnce(new Error('mongodb://admin:password@example credentials'));
    await f.bridge.request(request());
    expect(f.send.mock.lastCall[0]).toMatchObject({ ok: false, requestId: 'r1', errorCode: 'outcome_unknown' });
    expect(JSON.stringify(f.send.mock.lastCall)).not.toContain('password');
    await f.bridge.request(request());
    expect(f.send.mock.lastCall[0].ok).toBe(true);
    await f.bridge.close();
  });

  it.each(['settings', 'send'])('uses safe operation-appropriate validation errors for %s', async op => {
    const f = fixture();
    f.service.request.mockRejectedValue(Object.assign(new Error('mongodb://admin:password@example'), { code: 'INVALID_REQUEST' }));
    await f.bridge.request(request({ op, payload: op === 'settings' ? { name: ' ' } : {} }));
    const response = f.send.mock.lastCall[0];
    expect(response).toMatchObject({ ok: false, op, requestId: 'r1', errorCode: 'invalid_request' });
    expect(response.error).not.toContain('8192');
    expect(response.error).not.toContain('password');
    if (op === 'settings') expect(response.error).toContain('160 UTF-8 bytes');
    else expect(response.error).toBe('Invalid digital person request');
    await f.bridge.close();
  });

  it.each(['tasks', 'task_log', 'task_cancel', 'agent_close'])('routes %s task operations without losing authenticated identity', async op => {
    const f = fixture({});
    const payload = op === 'tasks' ? {} : op === 'agent_close' ? { agentId: 'agent-child' } : { taskId: 'task-one' };
    await f.bridge.request(request({ op, payload }));
    expect(f.service.request).toHaveBeenCalledWith({ ownerId: 'u1', op, payload });
    expect(f.send.mock.lastCall[0]).toMatchObject({ ok: true, requestId: 'r1', op });
    await f.bridge.close();
  });

  it.each(['NOT_FOUND', 'TASK_SCOPE_DENIED', 'TASK_CONTROL_UNAVAILABLE'])('returns safe %s task errors, never internal credential-bearing messages', async code => {
    const f = fixture({});
    f.service.request.mockRejectedValue(Object.assign(new Error('mongodb://admin:password@example /internal/path'), { code }));
    await f.bridge.request(request({ op: 'task_cancel', payload: { taskId: 'task-one' } }));
    expect(f.send.mock.lastCall[0]).toMatchObject({ ok: false, requestId: 'r1', op: 'task_cancel', errorCode: code.toLowerCase() });
    expect(JSON.stringify(f.send.mock.lastCall[0])).not.toContain('password');
    expect(JSON.stringify(f.send.mock.lastCall[0])).not.toContain('/internal/path');
    await f.bridge.close();
  });

  it('fences missing owner, closed transport and Agent identity changes', async () => {
    const f = fixture();
    await f.bridge.request(request({ ownerId: undefined }));
    expect(f.createService).not.toHaveBeenCalled();
    await f.bridge.request(request());
    const oldNamespace = f.createService.mock.lastCall[0].namespace;
    f.context.agentId = 'a2';
    await f.bridge.request(request());
    expect(f.service.close).toHaveBeenCalledTimes(1);
    expect(f.createService.mock.lastCall[0].namespace).not.toBe(oldNamespace);
    await f.bridge.close();
    await f.bridge.request(request());
    expect(f.send.mock.lastCall[0].ok).toBe(false);
    expect(await f.bridge.request({ type: 'other' })).toBe(false);
  });
});
