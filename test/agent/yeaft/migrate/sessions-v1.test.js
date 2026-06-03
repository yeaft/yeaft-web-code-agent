/**
 * sessions-v1.test.js — migration test: groups/ + chats/ → sessions/
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateSessionsV1 } from '../../../../agent/yeaft/migrate/sessions-v1.js';

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

describe('sessions-v1 migration', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'yeaft-mig-'));
    seedDir(tmp);
  });

  it('moves group + chat to sessions with normalized meta', () => {
    const r = migrateSessionsV1(tmp);
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
    migrateSessionsV1(tmp);
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
    migrateSessionsV1(tmp);
    expect(existsSync(join(tmp, 'memory', 'sessions', 'grp_alpha', 'ams.json'))).toBe(true);
    expect(existsSync(join(tmp, 'memory', 'sessions', 'chat_beta', 'ams.json'))).toBe(true);
  });

  it('writes sentinel + is idempotent on second run', () => {
    migrateSessionsV1(tmp);
    expect(existsSync(join(tmp, '.session-migration-v1.done'))).toBe(true);
    const r2 = migrateSessionsV1(tmp);
    expect(r2.migrated).toBe(false);
    expect(r2.moved).toBe(0);
  });

  it('preserves defaultVpId from group.json into session meta', () => {
    migrateSessionsV1(tmp);
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

    const r = migrateSessionsV1(tmp);
    expect(r.migrated).toBe(true);
    // meta.json was repaired from the leftover group.json
    expect(existsSync(join(sessDir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(sessDir, 'meta.json'), 'utf8'));
    expect(meta.id).toBe('grp_alpha');
    expect(meta.vpIds).toEqual(['omni']);
  });
});
