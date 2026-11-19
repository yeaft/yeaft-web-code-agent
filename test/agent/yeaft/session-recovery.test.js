import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, afterEach } from 'vitest';
import { openSession } from '../../../agent/yeaft/sessions/session-store.js';
import { repairSessionStore } from '../../../agent/yeaft/sessions/recovery.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-session-recovery-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Session disk recovery', () => {
  it('rebuilds a stale coordinator audit index without duplicating or inventing rows', () => {
    const root = tempRoot();
    const sessionId = 'session_existing_GHI12345';
    const dir = join(root, 'sessions', sessionId);
    mkdirSync(join(dir, 'messages'), { recursive: true });
    writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ id: sessionId, name: 'Existing', roster: ['omni'], defaultVpId: 'omni' }, null, 2)}\n`);
    writeFileSync(join(dir, 'messages', '000001.jsonl'), `${JSON.stringify({ id: 'msg_audit_1', ts: '2026-06-03T00:00:00.000Z', from: 'user', role: 'user', text: 'already here', taskId: null, mentions: [], meta: {} })}\n`);
    writeFileSync(join(dir, 'messages', 'index.json'), `${JSON.stringify({ version: 1, nextId: null, segments: [{ file: '000001.jsonl', firstId: null, lastId: null, firstTs: null, lastTs: null, count: 0, bytes: 0 }] }, null, 2)}\n`);

    repairSessionStore(root);

    const handle = openSession(join(root, 'sessions'), sessionId);
    const auditRows = Array.from(handle.streamMessages());
    handle.close();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ id: 'msg_audit_1', role: 'user', text: 'already here' });
    const index = JSON.parse(readFileSync(join(dir, 'messages', 'index.json'), 'utf8'));
    expect(index.segments).toHaveLength(1);
    expect(index.segments[0].count).toBe(1);
  });
});
