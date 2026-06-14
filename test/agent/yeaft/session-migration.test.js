import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { migrateSessions } from '../../../agent/yeaft/migrate/sessions.js';
import { initYeaftDir } from '../../../agent/yeaft/init.js';
import { openSegmentIndex } from '../../../agent/yeaft/memory/index-db.js';
import { parseSegments } from '../../../agent/yeaft/memory/segment.js';
import { buildRelevantScopes } from '../../../agent/yeaft/sessions/pre-flow.js';

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
  it('recalls migrated and runtime session memory scope spellings', () => {
    expect(buildRelevantScopes({ sessionId: 'session_scope', vpId: 'omni' })).toEqual(expect.arrayContaining([
      'session/session_scope',
      'session/session_scope/user',
      'session/session_scope/vp/omni',
      'sessions/session_scope',
      'sessions/session_scope/user',
      'sessions/session_scope/vp/omni',
      'group/session_scope',
      'group/session_scope/user',
      'group/session_scope/vp/omni',
    ]));
  });

  it('accepts migrated singular session memory subscopes', () => {
    for (const scope of [
      'session/session_scope',
      'session/session_scope/user',
      'session/session_scope/vp/omni',
      'session/session_scope/feature/auth',
      'session/session_scope/topic/api',
      'session/session_scope/topic/api/routes',
      'sessions/session_scope',
      'sessions/session_scope/user',
      'sessions/session_scope/vp/omni',
      'sessions/session_scope/feature/auth',
      'sessions/session_scope/topic/api',
      'sessions/session_scope/topic/api/routes',
    ]) {
      const parsed = parseSegments([
        '---',
        'id: seg',
        `scope: ${scope}`,
        'kind: fact',
        '---',
        'memory',
        '',
      ].join('\n'));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].scope).toBe(scope);
    }
  });

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

  it('migrates registered workdir session roots during init', () => {
    const root = tempRoot();
    const workDir = tempRoot();
    const workYeaftDir = join(workDir, '.yeaft');
    const legacyDir = join(workYeaftDir, 'groups', 'session_workdir');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(root, 'group-workdirs.json'), JSON.stringify({
      session_workdir: workDir,
    }, null, 2));
    writeFileSync(join(legacyDir, 'group.json'), JSON.stringify({
      id: 'session_workdir',
      name: 'Workdir Session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir,
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    initYeaftDir(root);

    expect(existsSync(join(workYeaftDir, 'sessions', 'session_workdir', 'session.json'))).toBe(true);
    expect(existsSync(join(workYeaftDir, 'groups', 'session_workdir'))).toBe(false);
    expect(readJson(join(workYeaftDir, 'sessions', 'session_workdir', 'session.json'))).toMatchObject({
      id: 'session_workdir',
      name: 'Workdir Session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir,
    });
  });

  it('preserves empty legacy group rosters', () => {
    const root = tempRoot();
    const legacyDir = join(root, 'groups', 'session_empty_legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'group.json'), JSON.stringify({
      id: 'session_empty_legacy',
      name: 'Empty Legacy Session',
      roster: [],
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);
    const sessionDir = join(root, 'sessions', 'session_empty_legacy');

    expect(result.migrated).toBe(true);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_empty_legacy',
      name: 'Empty Legacy Session',
      roster: [],
      defaultVpId: null,
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

  it('keeps valid empty-roster canonical metadata instead of overwriting from stale rescue files', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'session_empty');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'session_empty',
      name: 'Empty Session',
      roster: [],
      defaultVpId: null,
      announcement: '',
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'session_empty',
      displayName: 'Stale Rescue',
      vpIds: ['omni'],
      createdAt: '2026-06-11T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_empty',
      name: 'Empty Session',
      roster: [],
      defaultVpId: null,
      workDir: '/tmp/project',
    });
  });

  it('rebuilds canonical metadata that runtime validation would reject', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'session_invalid_roster');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'session_invalid_roster',
      name: 'Invalid Canonical',
      roster: ['omni', 42],
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'session_invalid_roster',
      displayName: 'Valid Rescue',
      vpIds: ['omni'],
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(false);
    expect(readJson(join(sessionDir, 'session.json'))).toMatchObject({
      id: 'session_invalid_roster',
      name: 'Valid Rescue',
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
      'chatId: chat_history',
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
    expect(migratedMessage).not.toContain('chatId: chat_history');
  });

  it('does not rewrite flat live chatId frontmatter to sessionId', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const flatChatDir = join(root, 'chat', 'messages');
    mkdirSync(flatChatDir, { recursive: true });
    writeFileSync(join(flatChatDir, 'turn.md'), [
      '---',
      'id: msg_1',
      'chatId: chat_flat',
      'role: user',
      '---',
      'hello',
      '',
    ].join('\n'));

    const result = migrateSessions(root);
    const message = readFileSync(join(flatChatDir, 'turn.md'), 'utf8');

    expect(result.migrated).toBe(true);
    expect(message).toContain('chatId: chat_flat');
    expect(message).not.toContain('sessionId: chat_flat');
  });

  it('does not migrate current chat-mode history dirs without legacy chat.json metadata', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const chatMessagesDir = join(root, 'chats', 'chat_live', 'conversation', 'messages');
    mkdirSync(chatMessagesDir, { recursive: true });
    writeFileSync(join(chatMessagesDir, 'turn.md'), [
      '---',
      'id: msg_1',
      'chatId: chat_live',
      'role: user',
      '---',
      'hello',
      '',
    ].join('\n'));

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(root, 'chats', 'chat_live', 'conversation', 'messages', 'turn.md'))).toBe(true);
    expect(existsSync(join(root, 'sessions', 'chat_live'))).toBe(false);
    expect(readFileSync(join(chatMessagesDir, 'turn.md'), 'utf8')).toContain('chatId: chat_live');
  });

  it('restores live chat-mode history dirs that v3 moved under sessions', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const movedMessagesDir = join(root, 'sessions', 'chat_v3_live', 'conversation', 'messages');
    mkdirSync(movedMessagesDir, { recursive: true });
    mkdirSync(join(root, 'memory', 'session', 'chat_v3_live'), { recursive: true });
    mkdirSync(join(root, 'memory', 'sessions', 'chat_v3_live'), { recursive: true });
    writeFileSync(join(movedMessagesDir, 'turn.md'), [
      '---',
      'id: msg_1',
      'chatId: chat_v3_live',
      'role: user',
      '---',
      'hello',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'memory', 'session', 'chat_v3_live', 'memory.md'), [
      '---',
      'id: mem_1',
      'scope: session/chat_v3_live',
      '---',
      'memory',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'memory', 'sessions', 'chat_v3_live', 'summary.md'), 'chat summary');
    const idx = openSegmentIndex(join(root, 'memory', 'index.db'));
    idx.upsert({
      id: 'mem_1',
      scope: 'session/chat_v3_live',
      kind: 'fact',
      tags: [],
      body: 'memory',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.close();

    const result = migrateSessions(root);
    const after = openSegmentIndex(join(root, 'memory', 'index.db'));

    expect(result.migrated).toBe(true);
    expect(existsSync(join(root, 'sessions', 'chat_v3_live'))).toBe(false);
    expect(readFileSync(join(root, 'chats', 'chat_v3_live', 'conversation', 'messages', 'turn.md'), 'utf8'))
      .toContain('chatId: chat_v3_live');
    expect(readFileSync(join(root, 'memory', 'chat', 'chat_v3_live', 'memory.md'), 'utf8'))
      .toContain('scope: chat/chat_v3_live');
    expect(readFileSync(join(root, 'memory', 'chat', 'chat_v3_live', 'summary.md'), 'utf8')).toBe('chat summary');
    expect(after.get('mem_1').scope).toBe('chat/chat_v3_live');
    after.close();
  });

  it('does not migrate current chat-mode memory scopes without legacy chat.json metadata', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const legacyChatDir = join(root, 'chats', 'chat_legacy_memory');
    mkdirSync(legacyChatDir, { recursive: true });
    writeFileSync(join(legacyChatDir, 'chat.json'), JSON.stringify({
      id: 'chat_legacy_memory',
      displayName: 'Legacy Memory Chat',
      vpId: 'omni',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));
    mkdirSync(join(root, 'memory', 'chat', 'chat_live_memory', 'segments'), { recursive: true });
    mkdirSync(join(root, 'memory', 'chat', 'chatXlegacy_memory', 'segments'), { recursive: true });
    mkdirSync(join(root, 'memory', 'chat', 'chat_legacy_memory', 'segments'), { recursive: true });

    const idx = openSegmentIndex(join(root, 'memory', 'index.db'));
    idx.upsert({
      id: 'live',
      scope: 'chat/chat_live_memory',
      kind: 'note',
      tags: [],
      body: 'live',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.upsert({
      id: 'live-wildcard-neighbor',
      scope: 'chat/chatXlegacy_memory',
      kind: 'note',
      tags: [],
      body: 'live wildcard neighbor',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.upsert({
      id: 'legacy',
      scope: 'chat/chat_legacy_memory',
      kind: 'note',
      tags: [],
      body: 'legacy',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.close();

    const result = migrateSessions(root);
    const after = openSegmentIndex(join(root, 'memory', 'index.db'));

    expect(result.migrated).toBe(true);
    expect(existsSync(join(root, 'memory', 'chat', 'chat_live_memory'))).toBe(true);
    expect(existsSync(join(root, 'memory', 'chat', 'chatXlegacy_memory'))).toBe(true);
    expect(existsSync(join(root, 'memory', 'session', 'chat_legacy_memory'))).toBe(true);
    expect(after.get('live').scope).toBe('chat/chat_live_memory');
    expect(after.get('live-wildcard-neighbor').scope).toBe('chat/chatXlegacy_memory');
    expect(after.get('legacy').scope).toBe('session/chat_legacy_memory');
    after.close();
  });

  it('keeps singular v3 segment memory while moving Layer-A summary to plural sessions scope', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const segDir = join(root, 'memory', 'session', 'session_memory', 'segments');
    mkdirSync(segDir, { recursive: true });
    mkdirSync(join(root, 'memory', 'session', 'session_memory', 'vp', 'omni'), { recursive: true });
    writeFileSync(join(root, 'memory', 'session', 'session_memory', 'summary.md'), 'summary');
    writeFileSync(join(root, 'memory', 'session', 'session_memory', 'summary.zh.md'), '摘要');
    writeFileSync(join(root, 'memory', 'session', 'session_memory', 'memory.md'), [
      '---',
      'id: resident',
      'scope: group/session_memory',
      '---',
      'resident',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'memory', 'session', 'session_memory', 'vp', 'omni', 'summary.zh.md'), 'vp 摘要');
    writeFileSync(join(segDir, 'seg.md'), [
      '---',
      'id: seg',
      'scope: session/session_memory',
      '---',
      'memory',
      '',
    ].join('\n'));
    const idx = openSegmentIndex(join(root, 'memory', 'index.db'));
    idx.upsert({
      id: 'seg',
      scope: 'session/session_memory',
      kind: 'note',
      tags: [],
      body: 'memory',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.close();

    const result = migrateSessions(root);
    const after = openSegmentIndex(join(root, 'memory', 'index.db'));

    expect(result.migrated).toBe(true);
    expect(readFileSync(join(root, 'memory', 'session', 'session_memory', 'segments', 'seg.md'), 'utf8'))
      .toContain('scope: session/session_memory');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_memory', 'summary.md'), 'utf8')).toBe('summary');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_memory', 'summary.zh.md'), 'utf8')).toBe('摘要');
    expect(readFileSync(join(root, 'memory', 'session', 'session_memory', 'memory.md'), 'utf8'))
      .toContain('scope: session/session_memory');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_memory', 'vp', 'omni', 'summary.zh.md'), 'utf8')).toBe('vp 摘要');
    expect(after.get('seg').scope).toBe('session/session_memory');
    after.close();
  });

  it('merges legacy group memory into existing session memory without orphaning summary or AMS', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const existingSegDir = join(root, 'memory', 'session', 'session_merge', 'segments');
    const legacySegDir = join(root, 'memory', 'group', 'session_merge', 'segments');
    mkdirSync(existingSegDir, { recursive: true });
    mkdirSync(legacySegDir, { recursive: true });
    mkdirSync(join(root, 'memory', 'group', 'session_merge', 'vp', 'omni'), { recursive: true });
    mkdirSync(join(root, 'memory', 'groups', 'session_merge'), { recursive: true });
    writeFileSync(join(existingSegDir, 'existing.md'), [
      '---',
      'id: existing',
      'scope: session/session_merge',
      '---',
      'existing',
      '',
    ].join('\n'));
    writeFileSync(join(legacySegDir, 'legacy.md'), [
      '---',
      'id: legacy',
      'scope: group/session_merge',
      '---',
      'legacy',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'memory', 'group', 'session_merge', 'summary.md'), 'summary');
    writeFileSync(join(root, 'memory', 'group', 'session_merge', 'summary.zh.md'), '摘要');
    writeFileSync(join(root, 'memory', 'group', 'session_merge', 'memory.md'), [
      '---',
      'id: resident',
      'scope: group/session_merge',
      '---',
      'resident',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'memory', 'group', 'session_merge', 'vp', 'omni', 'summary.md'), 'vp summary');
    writeFileSync(join(root, 'memory', 'groups', 'session_merge', 'ams.json'), '{"layers":[]}');

    const result = migrateSessions(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(root, 'memory', 'session', 'session_merge', 'segments', 'existing.md'))).toBe(true);
    expect(readFileSync(join(root, 'memory', 'session', 'session_merge', 'segments', 'legacy.md'), 'utf8'))
      .toContain('scope: session/session_merge');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_merge', 'summary.md'), 'utf8')).toBe('summary');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_merge', 'summary.zh.md'), 'utf8')).toBe('摘要');
    expect(readFileSync(join(root, 'memory', 'session', 'session_merge', 'memory.md'), 'utf8'))
      .toContain('scope: session/session_merge');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_merge', 'vp', 'omni', 'summary.md'), 'utf8')).toBe('vp summary');
    expect(readFileSync(join(root, 'memory', 'sessions', 'session_merge', 'ams.json'), 'utf8')).toBe('{"layers":[]}');
  });

  it('repairs stale chat scopes after chat metadata was already moved to sessions', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.yeaft-migration.done'), JSON.stringify({ version: 3 }, null, 2));
    const sessionDir = join(root, 'sessions', 'chat_partial_memory');
    const segDir = join(root, 'memory', 'session', 'chat_partial_memory', 'segments');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(segDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'chat_partial_memory',
      name: 'Partial Chat',
      roster: ['omni'],
      defaultVpId: 'omni',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2));
    writeFileSync(join(segDir, 'seg.md'), [
      '---',
      'id: seg',
      'scope: chat/chat_partial_memory',
      '---',
      'memory',
      '',
    ].join('\n'));
    const idx = openSegmentIndex(join(root, 'memory', 'index.db'));
    idx.upsert({
      id: 'seg',
      scope: 'chat/chat_partial_memory',
      kind: 'note',
      tags: [],
      body: 'memory',
      sourceMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    idx.close();

    const result = migrateSessions(root);
    const after = openSegmentIndex(join(root, 'memory', 'index.db'));

    expect(result.migrated).toBe(true);
    expect(readFileSync(join(segDir, 'seg.md'), 'utf8')).toContain('scope: session/chat_partial_memory');
    expect(after.get('seg').scope).toBe('session/chat_partial_memory');
    after.close();
  });
});
