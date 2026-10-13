import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';

const request = (extra = {}) => ({ type: 'person_request', requestId: 'r1', ownerId: 'u1', op: 'status', payload: {}, ...extra });
function fixture(env = {}) {
  const service = { request: vi.fn(async () => ({ configured: true })), close: vi.fn(async () => {}) };
  const createService = vi.fn(async () => service);
  const send = vi.fn(async () => {});
  const context = { agentId: 'a1', CONFIG: { serverUrl: 'https://server', yeaftDir: '/isolated/person', workDir: '/work' } };
  return { service, createService, send, context, bridge: createPersonBridge({ context, env, send, createService }) };
}

describe('Person bridge is independent of Session and Work Center', () => {
  it('lazily creates the instance-local service with only supported options', async () => {
    const f = fixture({});
    expect(f.createService).not.toHaveBeenCalled();
    await f.bridge.request(request());
    expect(f.createService).toHaveBeenCalledWith({
      namespace: expect.stringMatching(/^[a-f0-9]{64}$/), yeaftDir: '/isolated/person', workDir: '/work',
      embedding: { enabled: true, allowDownload: true },
    });
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { configured: true } }));
    await f.bridge.close();
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  it('does not return database or provider secrets on failures; failed init can be retried', async () => {
    const f = fixture();
    f.createService.mockRejectedValueOnce(new Error('https://admin:password@example credentials'));
    await f.bridge.request(request());
    expect(f.send.mock.lastCall[0]).toMatchObject({ ok: false, requestId: 'r1', errorCode: 'outcome_unknown' });
    expect(JSON.stringify(f.send.mock.lastCall)).not.toContain('password');
    await f.bridge.request(request());
    expect(f.send.mock.lastCall[0].ok).toBe(true);
    await f.bridge.close();
  });

  it('routes output reads with authenticated ownership and original correlation', async () => {
    const f = fixture(), op = 'output_read';
    const payload = { outputId: '550e8400-e29b-41d4-a716-446655440000', offset: 64, maxBytes: 65536 };
    await f.bridge.request(request({ op, payload }));
    expect(f.service.request).toHaveBeenCalledWith({ ownerId: 'u1', op, payload });
    expect(f.send.mock.lastCall[0]).toMatchObject({ ok: true, requestId: 'r1', op });
    await f.bridge.close();
  });

  it('uses the real SQLite service across restart with authenticated owner and Agent namespace isolation', async () => {
    const yeaftDir = await mkdtemp(join(tmpdir(), 'person-bridge-'));
    const send = vi.fn(async () => {});
    const context = { agentId: 'a1', CONFIG: { serverUrl: 'https://server', yeaftDir, workDir: yeaftDir } };
    const options = { context, send, env: { YEAFT_PERSON_EMBEDDING: 'off', YEAFT_PERSON_EMBEDDING_DOWNLOAD: '0' } };
    let bridge = createPersonBridge(options);
    try {
      await bridge.request(request({ op: 'open', payload: { name: 'Alice' } }));
      const opened = send.mock.lastCall[0];
      expect(opened).toMatchObject({ ok: true, requestId: 'r1', op: 'open', data: { person: { name: 'Alice' } } });
      const alice = opened.data.person.id;
      await bridge.close(); bridge = createPersonBridge(options);
      await bridge.request(request({ op: 'open' }));
      expect(send.mock.lastCall[0].data.person).toMatchObject({ id: alice, name: 'Alice' });
      await bridge.request(request({ op: 'open', ownerId: 'u2', payload: { name: 'Bob' } }));
      expect(send.mock.lastCall[0]).toMatchObject({ ok: true, data: { person: { name: 'Bob' } } });
      expect(send.mock.lastCall[0].data.person.id).not.toBe(alice);
      await bridge.request(request({ op: 'open', payload: { ownerId: 'u2', yeaftDir: '/browser/override' } }));
      expect(send.mock.lastCall[0]).toMatchObject({ ok: false, errorCode: 'invalid_request' });
      context.agentId = 'a2';
      await bridge.request(request({ op: 'open' }));
      expect(send.mock.lastCall[0]).toMatchObject({ ok: true, data: { person: { name: 'Digital Person' } } });
      expect(send.mock.lastCall[0].data.person.id).not.toBe(alice);
      expect(await readdir(yeaftDir)).toEqual(['person']);
    } finally { await bridge.close(); await rm(yeaftDir, { recursive: true, force: true }); }
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
