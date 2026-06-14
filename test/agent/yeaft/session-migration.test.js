import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { migrateSessions } from '../../../agent/yeaft/migrate/sessions.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-session-migration-'));
  roots.push(root);
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session storage migration', () => {
  it('migrates legacy group.json metadata to canonical session.json', () => {
    const root = tempRoot();
    const legacyDir = join(root, 'groups', 'session_legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'group.json'), JSON.stringify({
      id: 'session_legacy',
      name: 'Legacy Session',
      roster: ['omni', 'linus'],
      defaultVpId: 'linus',
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);
    const sessionDir = join(root, 'sessions', 'session_legacy');

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'session.json'))).toBe(true);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_legacy',
      name: 'Legacy Session',
      roster: ['omni', 'linus'],
      defaultVpId: 'linus',
      workDir: '/tmp/project',
    });
  });

  it('repairs v3 meta.json output into canonical session.json', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'session_meta');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'session_meta',
      displayName: 'Wrong Schema',
      vpIds: ['omni'],
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'session.json'))).toBe(true);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_meta',
      name: 'Wrong Schema',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/project',
    });
  });

  it('rebuilds corrupt canonical metadata from v3 meta.json instead of deleting the rescue file', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'session_partial');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{"id":');
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'session_partial',
      displayName: 'Partial Rewrite',
      vpIds: ['omni'],
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_partial',
      name: 'Partial Rewrite',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/project',
    });
  });

  it('converts legacy chat metadata merged during cleanup into session.json', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'chat_legacy');
    const legacyDir = join(root, 'chats', 'chat_legacy');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'chat.json'), JSON.stringify({
      id: 'chat_legacy',
      displayName: 'Legacy Chat',
      vpId: 'omni',
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'session.json'))).toBe(true);
    expect(existsSync(join(sessionDir, 'chat.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'chat_legacy',
      name: 'Legacy Chat',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/project',
    });
  });

  it('falls back to chat.json when meta.json is corrupt', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'chat_corrupt_meta');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'meta.json'), '{"id":');
    writeFileSync(join(sessionDir, 'chat.json'), JSON.stringify({
      id: 'chat_corrupt_meta',
      displayName: 'Fallback Chat',
      vpId: 'omni',
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'chat_corrupt_meta',
      name: 'Fallback Chat',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/project',
    });
  });

  it('rewrites frontmatter for legacy conversation files merged during cleanup', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'chat_history');
    const legacyMessagesDir = join(root, 'chats', 'chat_history', 'conversation', 'messages');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(legacyMessagesDir, { recursive: true });
    writeFileSync(join(root, 'chats', 'chat_history', 'chat.json'), JSON.stringify({
      id: 'chat_history',
      displayName: 'History Chat',
      vpId: 'omni',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));
    writeFileSync(join(legacyMessagesDir, 'turn.md'), [
      '---',
      'id: msg_1',
      'groupId: chat_history',
      'role: user',
      '---',
      'hello',
      '',
    ].join('\n'));

    const result = migrateSessions(root);
    const migratedMessage = readFileSync(
      join(sessionDir, 'conversation', 'messages', 'turn.md'),
      'utf8'
    );

    expect(result.migrated).toBe(true);
    expect(result.frontmatterRewrites).toBe(1);
    expect(migratedMessage).toContain('sessionId: chat_history');
    expect(migratedMessage).not.toContain('groupId: chat_history');
  });
});
