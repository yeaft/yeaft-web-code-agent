import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSessionFromSpec,
  ensureDefaultSessionIfEmpty,
  readWorkDirRegistry,
  resolveSessionYeaftDir,
  snapshotSessions,
} from '../../../agent/yeaft/sessions/session-crud.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { loadSessionsManifest, sessionManifestPath } from '../../../agent/yeaft/sessions/session-manifest.js';

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeVp(libDir, id, name = id) {
  const dir = join(libDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.md'), `---\nid: ${id}\nname: ${name}\nrole: Test VP\n---\n\n${name} persona\n`);
}

function writeFileWithDirs(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session CRUD default VP selection', () => {
  it('defaults a new empty-roster session to omni when the VP library has omni', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const libDir = tempRoot('yeaft-vp-lib-');
    writeVp(libDir, 'alpha', 'Alpha');
    writeVp(libDir, 'omni', 'Omni Assistant');
    writeVp(libDir, 'zebra', 'Zebra');

    const session = createSessionFromSpec(
      yeaftDir,
      { name: 'IFTyeaft session', roster: [] },
      { libDir },
    );

    expect(session.roster).toEqual(['omni']);
    expect(session.defaultVpId).toBe('omni');
  });

  it('preserves an explicit non-empty roster instead of forcing omni', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const libDir = tempRoot('yeaft-vp-lib-');
    writeVp(libDir, 'linus', 'Linus');
    writeVp(libDir, 'omni', 'Omni Assistant');

    const session = createSessionFromSpec(
      yeaftDir,
      { name: 'Kernel review', roster: ['linus'] },
      { libDir },
    );

    expect(session.roster).toEqual(['linus']);
    expect(session.defaultVpId).toBe('linus');
  });

  it('keeps an empty roster when the VP library is empty', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const libDir = tempRoot('yeaft-vp-lib-empty-');

    const session = createSessionFromSpec(
      yeaftDir,
      { name: 'Empty library session', roster: [] },
      { libDir },
    );

    expect(session.roster).toEqual([]);
    expect(session.defaultVpId).toBe(null);
  });

  it('stores workDir-associated sessions under the user root and indexes them in the manifest', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const workDir = tempRoot('yeaft-session-workdir-');
    const libDir = tempRoot('yeaft-vp-lib-');
    writeVp(libDir, 'alpha', 'Alpha');
    writeVp(libDir, 'omni', 'Omni Assistant');

    const session = createSessionFromSpec(
      yeaftDir,
      { name: 'Workdir session', roster: [], workDir },
      { libDir },
    );

    expect(session.roster).toEqual(['omni']);
    expect(session.defaultVpId).toBe('omni');
    expect(session.workDir).toBe(workDir);
    const sessionFile = join(yeaftDir, 'sessions', session.id, 'session.json');
    expect(existsSync(sessionFile)).toBe(true);
    expect(existsSync(join(workDir, '.yeaft', 'sessions', session.id, 'session.json'))).toBe(false);
    const persisted = JSON.parse(readFileSync(sessionFile, 'utf8'));
    expect(persisted).toMatchObject({ roster: ['omni'], defaultVpId: 'omni', workDir });
    expect(readWorkDirRegistry(yeaftDir)[session.id]).toBeUndefined();
    expect(loadSessionsManifest(yeaftDir).sessions.find(row => row.id === session.id)?.path)
      .toBe(join(yeaftDir, 'sessions', session.id));
  });

  it('prefers omni as the default VP when seeding the first default session', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const libDir = tempRoot('yeaft-vp-lib-');
    writeVp(libDir, 'alpha', 'Alpha');
    writeVp(libDir, 'omni', 'Omni Assistant');
    writeVp(libDir, 'zebra', 'Zebra');

    const seeded = ensureDefaultSessionIfEmpty(yeaftDir, { libDir });

    expect(seeded.seeded).toBe(true);
    expect(seeded.defaultVpId).toBe('omni');
    expect(seeded.rosterSize).toBe(3);
    expect(loadSessionsManifest(yeaftDir).sessions.map(row => row.id)).toEqual(['session_default']);
  });

  it('bootstraps a missing manifest by moving registered project sessions into the user sessions root', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const workDir = tempRoot('yeaft-session-workdir-');
    const sessionId = 'session_manifest_bootstrap';
    createSession(join(workDir, '.yeaft', 'sessions'), {
      id: sessionId,
      name: 'Project old layout',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir,
    }).close();
    writeFileSync(join(yeaftDir, 'group-workdirs.json'), `${JSON.stringify({ [sessionId]: workDir }, null, 2)}\n`);
    writeFileWithDirs(join(workDir, '.yeaft', 'memory', 'group', sessionId, 'vp', 'omni', 'summary.md'), 'legacy vp memory');

    const sessions = snapshotSessions(yeaftDir);

    expect(sessions.map(s => s.id)).toEqual([sessionId]);
    expect(existsSync(sessionManifestPath(yeaftDir))).toBe(true);
    expect(existsSync(join(yeaftDir, 'sessions', sessionId, 'session.json'))).toBe(true);
    expect(readFileSync(join(yeaftDir, 'memory', 'group', sessionId, 'vp', 'omni', 'summary.md'), 'utf8')).toBe('legacy vp memory');
    expect(readWorkDirRegistry(yeaftDir)[sessionId]).toBeUndefined();
    expect(resolveSessionYeaftDir(yeaftDir, sessionId)).toBe(yeaftDir);
    expect(loadSessionsManifest(yeaftDir).sessions.find(row => row.id === sessionId)?.path)
      .toBe(join(yeaftDir, 'sessions', sessionId));
  });

  it('uses an existing manifest without scanning the legacy workDir registry again', () => {
    const yeaftDir = tempRoot('yeaft-session-crud-');
    const workDir = tempRoot('yeaft-session-workdir-');
    const localId = 'session_manifest_local';
    const hiddenId = 'session_manifest_hidden_workdir';
    createSession(join(yeaftDir, 'sessions'), {
      id: localId,
      name: 'Manifest local',
      roster: [],
      defaultVpId: null,
    }).close();
    snapshotSessions(yeaftDir); // creates manifest from local sessions.
    createSession(join(workDir, '.yeaft', 'sessions'), {
      id: hiddenId,
      name: 'Should not load',
      roster: [],
      defaultVpId: null,
      workDir,
    }).close();
    writeFileSync(join(yeaftDir, 'group-workdirs.json'), `${JSON.stringify({ [hiddenId]: workDir }, null, 2)}\n`);

    const sessions = snapshotSessions(yeaftDir);

    expect(sessions.map(s => s.id)).toEqual([localId]);
    expect(existsSync(join(yeaftDir, 'sessions', hiddenId))).toBe(false);
    expect(resolveSessionYeaftDir(yeaftDir, hiddenId)).toBe(yeaftDir);
    expect(readWorkDirRegistry(yeaftDir)[hiddenId]).toBe(workDir);
  });
});
