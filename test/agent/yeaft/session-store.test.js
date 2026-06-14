import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSession,
  LEGACY_GROUP_META_FILE,
  listSessions,
  loadSessionMeta,
  openSession,
  SESSION_META_FILE,
} from '../../../agent/yeaft/sessions/session-store.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-session-store-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session-store metadata files', () => {
  it('writes new session metadata to session.json, not group.json', () => {
    const root = tempRoot();
    createSession(root, {
      id: 'session_one',
      name: 'One',
      roster: ['vp-linus'],
      defaultVpId: 'vp-linus',
    });

    const dir = join(root, 'session_one');
    expect(existsSync(join(dir, SESSION_META_FILE))).toBe(true);
    expect(existsSync(join(dir, LEGACY_GROUP_META_FILE))).toBe(false);
    expect(loadSessionMeta(dir)).toMatchObject({
      id: 'session_one',
      roster: ['vp-linus'],
      defaultVpId: 'vp-linus',
    });
  });

  it('reads legacy group.json and saves later updates to session.json', () => {
    const root = tempRoot();
    const dir = join(root, 'session_legacy');
    mkdirSync(dir, { recursive: true });
    const legacyMeta = {
      id: 'session_legacy',
      name: 'Legacy',
      roster: ['vp-omni'],
      defaultVpId: 'vp-omni',
      createdAt: '2026-06-12T00:00:00.000Z',
    };
    writeFileSync(join(dir, LEGACY_GROUP_META_FILE), JSON.stringify(legacyMeta, null, 2), { flag: 'wx' });

    expect(loadSessionMeta(dir)).toMatchObject({
      id: 'session_legacy',
      roster: ['vp-omni'],
      announcement: '',
      workDir: '',
    });
    expect(listSessions(root).map(s => s.id)).toEqual(['session_legacy']);

    const handle = openSession(root, 'session_legacy');
    const next = handle.getMeta();
    next.roster.push('vp-linus');
    handle.saveMeta(next);
    handle.close();

    expect(existsSync(join(dir, SESSION_META_FILE))).toBe(true);
    expect(existsSync(join(dir, LEGACY_GROUP_META_FILE))).toBe(true);
    expect(loadSessionMeta(dir)).toMatchObject({
      id: 'session_legacy',
      roster: ['vp-omni', 'vp-linus'],
    });
  });

  it('reads broken migration meta.json as a rescue alias', () => {
    const root = tempRoot();
    const dir = join(root, 'session_meta');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      id: 'session_meta',
      displayName: 'Migrated with wrong schema',
      vpIds: ['omni', 'linus'],
      defaultVpId: 'linus',
      workDir: '/tmp/project',
      createdAt: '2026-06-12T00:00:00.000Z',
    }, null, 2), { flag: 'wx' });

    expect(loadSessionMeta(dir)).toMatchObject({
      id: 'session_meta',
      name: 'Migrated with wrong schema',
      roster: ['omni', 'linus'],
      defaultVpId: 'linus',
      workDir: '/tmp/project',
    });
    expect(listSessions(root).map(s => s.id)).toEqual(['session_meta']);

    const handle = openSession(root, 'session_meta');
    handle.saveMeta(handle.getMeta());
    handle.close();

    expect(existsSync(join(dir, SESSION_META_FILE))).toBe(true);
  });
});
