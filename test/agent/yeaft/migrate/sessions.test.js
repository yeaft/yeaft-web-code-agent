/**
 * sessions.test.js — migration test: groups/ + chats/ → sessions/, plus
 * backup snapshot + per-message frontmatter rewrite (groupId: → sessionId:).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateSessions } from '../../../../agent/yeaft/migrate/sessions.js';

function seedDir(tmp) {
  // Seed a group
  const gDir = join(tmp, 'groups', 'grp_alpha');
  mkdirSync(gDir, { recursive: true });
  writeFileSync(join(gDir, 'group.json'), JSON.stringify({
    id: 'grp_alpha',
    name: 'Alpha',
    roster: ['omni', 'linus'],
    defaultVpId: 'omni',
    workDir: '/tmp/alpha',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  mkdirSync(join(gDir, 'messages'));

  // Seed a chat
  const cDir = join(tmp, 'chats', 'chat_beta');
  mkdirSync(cDir, { recursive: true });
  writeFileSync(join(cDir, 'chat.json'), JSON.stringify({
    id: 'chat_beta',
    vpId: 'omni',
    displayName: 'Beta',
    workDir: '',
    createdAt: '2026-01-02T00:00:00.000Z',
    lastTurnAt: null,
  }));

  // Seed memory dirs with segment files
  const memG = join(tmp, 'memory', 'group', 'grp_alpha', 'segments');
  mkdirSync(memG, { recursive: true });
  writeFileSync(join(memG, 'seg1.md'), `---\nid: seg_aaaaaaaa\nscope: group/grp_alpha\nkind: fact\n---\nBody A\n`);
  const memC = join(tmp, 'memory', 'chat', 'chat_beta', 'segments');
  mkdirSync(memC, { recursive: true });
  writeFileSync(join(memC, 'seg1.md'), `---\nid: seg_bbbbbbbb\nscope: chat/chat_beta\nkind: fact\n---\nBody B\n`);

  // Seed AMS files
  const amsG = join(tmp, 'memory', 'groups', 'grp_alpha');
  mkdirSync(amsG, { recursive: true });
  writeFileSync(join(amsG, 'ams.json'), JSON.stringify({ version: 1, recentIds: [] }));
  const amsC = join(tmp, 'memory', 'chats', 'chat_beta');
  mkdirSync(amsC, { recursive: true });
  writeFileSync(join(amsC, 'ams.json'), JSON.stringify({ version: 1, recentIds: [] }));
}

/**
 * Seed a legacy per-message frontmatter file containing `groupId:` (and no
 * `sessionId:`) at `<dir>/<name>`. Mirrors what real on-disk files look like
 * before the rename PR landed.
 */
function seedLegacyMessage(dir, name, { id, groupId = null, sessionId = null, extra = '' } = {}) {
  mkdirSync(dir, { recursive: true });
  const idLine = id ? `id: ${id}\n` : '';
  const groupIdLine = groupId ? `groupId: ${groupId}\n` : '';
  const sessionIdLine = sessionId ? `sessionId: ${sessionId}\n` : '';
  const fm = `---\n${idLine}${groupIdLine}${sessionIdLine}role: user\ntimestamp: 2026-05-01T00:00:00.000Z\n${extra}---\n\nhello body\n`;
  writeFileSync(join(dir, name), fm, 'utf8');
}

describe('sessions migration', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'yeaft-mig-'));
    seedDir(tmp);
  });

  it('moves group + chat to sessions with normalized meta', () => {
    const r = migrateSessions(tmp);
    expect(r.migrated).toBe(true);
    expect(r.moved).toBe(2);

    const gMeta = JSON.parse(readFileSync(join(tmp, 'sessions', 'grp_alpha', 'meta.json'), 'utf8'));
    expect(gMeta.id).toBe('grp_alpha');
    expect(gMeta.vpIds).toEqual(['omni', 'linus']);
    expect(gMeta.displayName).toBe('Alpha');
    expect(gMeta.workDir).toBe('/tmp/alpha');

    const cMeta = JSON.parse(readFileSync(join(tmp, 'sessions', 'chat_beta', 'meta.json'), 'utf8'));
    expect(cMeta.id).toBe('chat_beta');
    expect(cMeta.vpIds).toEqual(['omni']);
    expect(cMeta.displayName).toBe('Beta');

    // group.json and chat.json should be removed
    expect(existsSync(join(tmp, 'sessions', 'grp_alpha', 'group.json'))).toBe(false);
    expect(existsSync(join(tmp, 'sessions', 'chat_beta', 'chat.json'))).toBe(false);
  });

  it('moves memory dirs and rewrites segment scope', () => {
    migrateSessions(tmp);
    const segG = readFileSync(join(tmp, 'memory', 'session', 'grp_alpha', 'segments', 'seg1.md'), 'utf8');
    expect(segG).toContain('scope: session/grp_alpha');
    expect(segG).not.toContain('scope: group/');
    const segC = readFileSync(join(tmp, 'memory', 'session', 'chat_beta', 'segments', 'seg1.md'), 'utf8');
    expect(segC).toContain('scope: session/chat_beta');

    // old memory dirs gone
    expect(existsSync(join(tmp, 'memory', 'group', 'grp_alpha'))).toBe(false);
    expect(existsSync(join(tmp, 'memory', 'chat', 'chat_beta'))).toBe(false);
  });

  it('moves AMS files into memory/sessions/<id>/', () => {
    migrateSessions(tmp);
    expect(existsSync(join(tmp, 'memory', 'sessions', 'grp_alpha', 'ams.json'))).toBe(true);
    expect(existsSync(join(tmp, 'memory', 'sessions', 'chat_beta', 'ams.json'))).toBe(true);
  });

  it('writes new sentinel + is idempotent on second run', () => {
    migrateSessions(tmp);
    expect(existsSync(join(tmp, '.yeaft-migration.done'))).toBe(true);
    const sentinel = JSON.parse(readFileSync(join(tmp, '.yeaft-migration.done'), 'utf8'));
    expect(sentinel.version).toBe(2);

    const r2 = migrateSessions(tmp);
    expect(r2.migrated).toBe(false);
    expect(r2.moved).toBe(0);
    expect(r2.frontmatterRewrites).toBe(0);
  });

  it('preserves defaultVpId from group.json into session meta', () => {
    migrateSessions(tmp);
    const meta = JSON.parse(readFileSync(join(tmp, 'sessions', 'grp_alpha', 'meta.json'), 'utf8'));
    expect(meta.defaultVpId).toBe('omni');
  });

  it('reconciles a partially migrated session (dir renamed, meta not written yet)', () => {
    // Simulate a prior crash: sessions/grp_alpha/ exists with the leftover
    // group.json (renameSync done, rewrite skipped). No sentinel.
    const sessDir = join(tmp, 'sessions', 'grp_alpha');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'group.json'), JSON.stringify({
      id: 'grp_alpha',
      name: 'Alpha',
      roster: ['omni'],
    }));
    // groups/grp_alpha/ also still seeded by beforeEach; remove it so the
    // collision check sees only the dst side.
    rmSync(join(tmp, 'groups', 'grp_alpha'), { recursive: true, force: true });

    const r = migrateSessions(tmp);
    expect(r.migrated).toBe(true);
    // meta.json was repaired from the leftover group.json
    expect(existsSync(join(sessDir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(sessDir, 'meta.json'), 'utf8'));
    expect(meta.id).toBe('grp_alpha');
    expect(meta.vpIds).toEqual(['omni']);
  });

  it('rewrites SQLite FTS scope rows from group/<id> → session/<id>', async () => {
    // Seed an FTS index with a row pointing at the legacy scope.
    const { openSegmentIndex } = await import('../../../../agent/yeaft/memory/index-db.js');
    const dbPath = join(tmp, 'memory', 'index.db');
    const idx = openSegmentIndex(dbPath);
    idx.upsert({
      id: 'seg_aaaaaaaa', scope: 'group/grp_alpha', kind: 'fact',
      tags: '', body: 'Body A', sourceMsgs: '',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    idx.close();

    migrateSessions(tmp);

    const idx2 = openSegmentIndex(dbPath);
    const rows = idx2.listByScope('session/grp_alpha');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('seg_aaaaaaaa');
    const legacy = idx2.listByScope('group/grp_alpha');
    expect(legacy.length).toBe(0);
    idx2.close();
  });

  // ─── New: backup snapshot ──────────────────────────────────────────────

  it('snapshots conversation trees into .legacy-backup-<YYYYMMDD>/ before mutating', () => {
    // Seed legacy conversation files under BOTH flat layout and per-session
    // layout. The backup must capture them verbatim.
    seedLegacyMessage(join(tmp, 'conversation', 'messages'), 'm-old-flat.md', {
      id: 'm-old-flat',
      groupId: 'grp_alpha',
    });
    seedLegacyMessage(join(tmp, 'sessions', 'grp_alpha', 'conversation', 'messages'), 'm-old-session.md', {
      id: 'm-old-session',
      groupId: 'grp_alpha',
    });

    migrateSessions(tmp);

    // Backup root exists with YYYYMMDD date.
    const backups = readdirSync(tmp).filter((n) => n.startsWith('.legacy-backup-'));
    expect(backups.length).toBe(1);
    const backupRoot = join(tmp, backups[0]);

    // Original flat-layout file copied verbatim (still contains groupId:).
    const flatBackup = readFileSync(join(backupRoot, 'conversation', 'messages', 'm-old-flat.md'), 'utf8');
    expect(flatBackup).toContain('groupId: grp_alpha');
    expect(flatBackup).not.toContain('sessionId:');

    // Per-session file backed up before step-1's directory move ran.
    // Note: backup happens BEFORE the rename, so the file lives at the
    // sessions/<id>/ path within the backup (matching the source layout at
    // the moment of snapshot).
    const sessionBackup = readFileSync(
      join(backupRoot, 'sessions', 'grp_alpha', 'conversation', 'messages', 'm-old-session.md'),
      'utf8',
    );
    expect(sessionBackup).toContain('groupId: grp_alpha');
  });

  // ─── New: per-message frontmatter rewrite ───────────────────────────────

  it('rewrites groupId: → sessionId: in flat-layout conversation messages', () => {
    const flatDir = join(tmp, 'conversation', 'messages');
    seedLegacyMessage(flatDir, 'm-1.md', { id: 'm-1', groupId: 'grp_alpha' });
    seedLegacyMessage(flatDir, 'm-2.md', { id: 'm-2', groupId: 'grp_alpha' });

    const r = migrateSessions(tmp);
    expect(r.frontmatterRewrites).toBeGreaterThanOrEqual(2);

    for (const name of ['m-1.md', 'm-2.md']) {
      const body = readFileSync(join(flatDir, name), 'utf8');
      expect(body).toContain('sessionId: grp_alpha');
      expect(body).not.toMatch(/^groupId:/m);
    }
  });

  it('rewrites groupId: → sessionId: in per-session conversation messages', () => {
    // Note: groups/<id>/ is moved to sessions/<id>/ in step 1 BEFORE step 7
    // scans sessions/<id>/conversation/messages/. Seed the legacy file at the
    // post-rename path (sessions/<id>/) so the scan picks it up. Step-0 backup
    // is what protects originals that exist in the pre-rename path.
    const dir = join(tmp, 'sessions', 'grp_alpha', 'conversation', 'messages');
    seedLegacyMessage(dir, 'm-old.md', {
      id: 'm-old',
      groupId: 'grp_alpha',
    });

    migrateSessions(tmp);

    const body = readFileSync(join(dir, 'm-old.md'), 'utf8');
    expect(body).toContain('sessionId: grp_alpha');
    expect(body).not.toMatch(/^groupId:/m);
  });

  it('drops redundant groupId: line when sessionId: is already present', () => {
    const flatDir = join(tmp, 'conversation', 'messages');
    seedLegacyMessage(flatDir, 'm-redundant.md', {
      id: 'm-redundant',
      // Both keys present — sessionId wins, groupId line dropped.
      groupId: 'grp_alpha',
      sessionId: 'grp_alpha',
    });

    migrateSessions(tmp);

    const body = readFileSync(join(flatDir, 'm-redundant.md'), 'utf8');
    expect(body).toContain('sessionId: grp_alpha');
    expect(body).not.toMatch(/^groupId:/m);
  });

  it('frontmatter rewrite is idempotent — second run reports 0 rewrites', () => {
    seedLegacyMessage(join(tmp, 'conversation', 'messages'), 'm-once.md', {
      id: 'm-once',
      groupId: 'grp_alpha',
    });

    const r1 = migrateSessions(tmp);
    expect(r1.frontmatterRewrites).toBeGreaterThanOrEqual(1);

    // Sentinel blocks the second run entirely — but the idempotency claim
    // we care about is "a re-run on a pre-rewritten tree finds nothing to
    // do." Delete the sentinel and re-run to exercise the rewrite path
    // against already-rewritten files.
    rmSync(join(tmp, '.yeaft-migration.done'));
    const r2 = migrateSessions(tmp);
    expect(r2.migrated).toBe(true);
    expect(r2.frontmatterRewrites).toBe(0);

    // The file should still be in the post-rewrite shape.
    const body = readFileSync(join(tmp, 'conversation', 'messages', 'm-once.md'), 'utf8');
    expect(body).toContain('sessionId: grp_alpha');
    expect(body).not.toMatch(/^groupId:/m);
  });
});
