import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, afterEach } from 'vitest';
import { openSession } from '../../../agent/yeaft/sessions/session-store.js';
import { repairSessionStore } from '../../../agent/yeaft/sessions/recovery.js';
import { createSessionFromSpec, migrateRegisteredWorkDirSessions, registerSessionWorkDir, scanWorkdirSessions, updateSessionWorkDir } from '../../../agent/yeaft/sessions/session-crud.js';

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
  it('updates workDir in Session metadata and the canonical manifest without moving history', () => {
    const root = tempRoot();
    const firstWorkDir = join(root, 'workspace-before');
    const nextWorkDir = join(root, 'workspace-after');
    mkdirSync(firstWorkDir, { recursive: true });
    mkdirSync(nextWorkDir, { recursive: true });
    const created = createSessionFromSpec(root, {
      name: 'Movable', workDir: firstWorkDir, roster: [],
    }, { libDir: join(root, 'empty-vps') });
    const sessionDir = join(root, 'sessions', created.id);

    const updated = updateSessionWorkDir(root, created.id, nextWorkDir);

    expect(updated).toMatchObject({ id: created.id, workDir: nextWorkDir, workspaceKey: nextWorkDir });
    expect(existsSync(sessionDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8')))
      .toMatchObject({ workDir: nextWorkDir, workspaceKey: nextWorkDir });
    const manifest = JSON.parse(readFileSync(join(root, 'sessions-manifest.json'), 'utf8'));
    expect(manifest.sessions.find(row => row.id === created.id))
      .toMatchObject({ path: sessionDir, workDir: nextWorkDir, workspaceKey: nextWorkDir });
    expect(scanWorkdirSessions(firstWorkDir, root)).toEqual([]);
    expect(scanWorkdirSessions(nextWorkDir, root)).toEqual([
      expect.objectContaining({ id: created.id, workDir: nextWorkDir }),
    ]);

    const cleared = updateSessionWorkDir(root, created.id, '');
    expect(cleared).toMatchObject({ workDir: '', workspaceKey: '' });
  });

  it('bootstraps registered Session transcripts without copying archived Dream scopes', () => {
    const root = tempRoot();
    const workDir = join(root, 'workspace');
    const sessionId = 'session_legacy_bootstrap';
    const sourceSession = join(workDir, '.yeaft', 'sessions', sessionId);
    const sourceMemory = join(workDir, '.yeaft', 'memory', 'group', sessionId);
    mkdirSync(join(sourceSession, 'conversation', 'segments'), { recursive: true });
    mkdirSync(sourceMemory, { recursive: true });
    writeFileSync(join(sourceSession, 'session.json'), `${JSON.stringify({ id: sessionId, name: 'Legacy', workDir, roster: [] })}\n`);
    writeFileSync(join(sourceSession, 'conversation', 'segments', '000001.jsonl'), '{"role":"user","text":"preserve me"}\n');
    writeFileSync(join(sourceMemory, 'memory.md'), 'ARCHIVED_DREAM');
    registerSessionWorkDir(root, sessionId, workDir);

    const result = migrateRegisteredWorkDirSessions(root);

    expect(result.migrated).toEqual([sessionId]);
    expect(readFileSync(join(root, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl'), 'utf8'))
      .toContain('preserve me');
    expect(readFileSync(join(sourceMemory, 'memory.md'), 'utf8')).toBe('ARCHIVED_DREAM');
    expect(existsSync(join(root, 'memory', 'group', sessionId))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(root, 'sessions-manifest.json'), 'utf8'));
    expect(manifest.sessions.find(row => row.id === sessionId)?.path)
      .toBe(join(root, 'sessions', sessionId));
  });

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
