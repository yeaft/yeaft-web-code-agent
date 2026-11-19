import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';

const request = (extra = {}) => ({ type: 'person_request', requestId: 'r1', ownerId: 'u1', op: 'status', payload: {}, ...extra });

describe('Person bridge is independent of Session and Work Center', () => {
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

});
