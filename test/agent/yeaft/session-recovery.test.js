import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, afterEach } from 'vitest';
import { openSession } from '../../../agent/yeaft/sessions/session-store.js';
import { repairSessionStore } from '../../../agent/yeaft/sessions/recovery.js';
import { snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-session-recovery-'));
  roots.push(root);
  return root;
}

function writeMd(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Session disk recovery', () => {
  it('rebuilds missing metadata from markdown-only session dirs without creating audit transcripts', () => {
    const root = tempRoot();
    const sessionId = 'session_orphan_ABC12345';
    const dir = join(root, 'sessions', sessionId);
    mkdirSync(join(dir, 'conversation', 'messages'), { recursive: true });
    writeMd(join(dir, 'conversation', 'messages', 'm0001.md'), `---
id: m0001
role: user
time: 2026-06-01T00:00:00.000Z
sessionId: ${sessionId}
clientMessageId: u_local_1
tokens_est: 1
---

hello`);
    writeMd(join(dir, 'conversation', 'messages', 'm0002.md'), `---
id: m0002
role: assistant
time: 2026-06-01T00:00:01.000Z
sessionId: ${sessionId}
speakerVpId: linus
tokens_est: 1
---

world`);

    const result = repairSessionStore(root, { defaultRoster: ['linus'], defaultVpId: 'linus' });

    expect(result.repaired).toBe(1);
    expect(existsSync(join(dir, 'session.json'))).toBe(true);
    expect(existsSync(join(dir, 'messages', '000001.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'messages', 'index.json'))).toBe(false);
    const meta = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    expect(meta).toMatchObject({
      id: sessionId,
      name: 'Orphan',
      roster: ['linus'],
      defaultVpId: 'linus',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('makes snapshotSessions include orphan session dirs after metadata self-repair', () => {
    const root = tempRoot();
    const sessionId = 'session_orphan_DEF67890';
    const dir = join(root, 'sessions', sessionId);
    mkdirSync(join(dir, 'conversation', 'messages'), { recursive: true });
    writeMd(join(dir, 'conversation', 'messages', 'm0007.md'), `---
id: m0007
role: user
time: 2026-06-02T00:00:00.000Z
sessionId: ${sessionId}
tokens_est: 1
---

restore me`);

    const rows = snapshotSessions(root);

    expect(rows.map(row => row.id)).toContain(sessionId);
    expect(rows.find(row => row.id === sessionId)).toMatchObject({ name: 'Orphan', defaultVpId: 'omni' });
    expect(existsSync(join(dir, 'messages', '000001.jsonl'))).toBe(false);
  });

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

  it('does not rewrite a healthy existing session', () => {
    const root = tempRoot();
    const sessionId = 'session_healthy_JKL12345';
    const dir = join(root, 'sessions', sessionId);
    mkdirSync(join(dir, 'messages'), { recursive: true });
    writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ id: sessionId, name: 'Healthy', roster: ['omni'], defaultVpId: 'omni' }, null, 2)}\n`);
    writeFileSync(join(dir, 'messages', '000001.jsonl'), `${JSON.stringify({ id: 'msg_audit_1', ts: '2026-06-03T00:00:00.000Z', from: 'user', role: 'user', text: 'already here', taskId: null, mentions: [], meta: {} })}\n`);
    const handle = openSession(join(root, 'sessions'), sessionId);
    handle.close();
    const before = readFileSync(join(dir, 'messages', 'index.json'), 'utf8');

    const result = repairSessionStore(root);

    expect(result.repaired).toBe(0);
    expect(readFileSync(join(dir, 'messages', 'index.json'), 'utf8')).toBe(before);
  });
});
