import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateProjectSessionsToUser } from '../../../agent/yeaft/migrate/project-sessions-to-user.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { registerSessionWorkDir, sessionsRoot, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';

const roots = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeProjectSession(projectDir, sessionId, name = 'Project Session') {
  const projectYeaftDir = join(projectDir, '.yeaft');
  createSession(sessionsRoot(projectYeaftDir), {
    id: sessionId,
    name,
    roster: ['omni'],
    defaultVpId: 'omni',
    workDir: projectDir,
  }).close();
  return join(projectYeaftDir, 'sessions', sessionId);
}

function writeFileWithDirs(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migrateProjectSessionsToUser', () => {
  it('copies project-backed sessions into the user Yeaft sessions root and unregisters the workDir', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_migrate';
    const sourceDir = makeProjectSession(projectDir, sessionId, 'Moved Session');
    writeFileSync(join(sourceDir, 'config.json'), `${JSON.stringify({ model: 'project/gpt-5' }, null, 2)}\n`);
    registerSessionWorkDir(userYeaftDir, sessionId, projectDir);

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir);

    expect(result.scanned).toBe(1);
    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);
    const destDir = join(userYeaftDir, 'sessions', sessionId);
    expect(existsSync(join(destDir, 'session.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(destDir, 'config.json'), 'utf8'))).toEqual({ model: 'project/gpt-5' });
    expect(existsSync(join(destDir, '.migrations', 'project-sessions-to-user.json'))).toBe(true);
    expect(readFileSync(join(userYeaftDir, 'group-workdirs.json'), 'utf8')).not.toContain(sessionId);
    const row = snapshotSessions(userYeaftDir).find(s => s.id === sessionId);
    expect(row?.name).toBe('Moved Session');
  });

  it('skips existing destination sessions unless overwrite is requested', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_conflict';
    makeProjectSession(projectDir, sessionId, 'Project Copy');
    createSession(sessionsRoot(userYeaftDir), {
      id: sessionId,
      name: 'User Copy',
      roster: [],
      defaultVpId: null,
    }).close();

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.sessions[0].reason).toBe('destination_exists');
    const row = snapshotSessions(userYeaftDir).find(s => s.id === sessionId);
    expect(row?.name).toBe('User Copy');
  });

  it('overwrites existing destination sessions when requested', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_overwrite';
    makeProjectSession(projectDir, sessionId, 'Project Copy');
    createSession(sessionsRoot(userYeaftDir), {
      id: sessionId,
      name: 'User Copy',
      roster: [],
      defaultVpId: null,
    }).close();

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir, { overwrite: true });

    expect(result.copied).toBe(1);
    expect(result.overwritten).toBe(1);
    const row = snapshotSessions(userYeaftDir).find(s => s.id === sessionId);
    expect(row?.name).toBe('Project Copy');
  });

  it('copies legacy group memory and nested scope directories', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_group_memory';
    makeProjectSession(projectDir, sessionId, 'Group Memory Session');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'group', sessionId, 'memory.md'), 'legacy group summary');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'group', sessionId, 'user', 'summary.md'), 'nested user memory');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'group', sessionId, 'vp', 'omni', 'summary.md'), 'nested vp memory');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'group', sessionId, 'topic', 'planning', 'summary.md'), 'nested topic memory');

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir);

    expect(result.copied).toBe(1);
    expect(readFileSync(join(userYeaftDir, 'memory', 'group', sessionId, 'memory.md'), 'utf8')).toBe('legacy group summary');
    expect(readFileSync(join(userYeaftDir, 'memory', 'group', sessionId, 'user', 'summary.md'), 'utf8')).toBe('nested user memory');
    expect(readFileSync(join(userYeaftDir, 'memory', 'group', sessionId, 'vp', 'omni', 'summary.md'), 'utf8')).toBe('nested vp memory');
    expect(readFileSync(join(userYeaftDir, 'memory', 'group', sessionId, 'topic', 'planning', 'summary.md'), 'utf8')).toBe('nested topic memory');
  });

  it('delete-source removes only source memory directories that were copied', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_delete_source_memory';
    makeProjectSession(projectDir, sessionId, 'Delete Source Memory Session');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'group', sessionId, 'memory.md'), 'legacy group summary');
    writeFileWithDirs(join(userYeaftDir, 'memory', 'session', sessionId, 'summary.md'), 'existing session memory');
    writeFileWithDirs(join(projectDir, '.yeaft', 'memory', 'session', sessionId, 'summary.md'), 'project session memory');

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir, { deleteSource: true });

    expect(result.copied).toBe(1);
    expect(existsSync(join(projectDir, '.yeaft', 'sessions', sessionId))).toBe(false);
    expect(existsSync(join(projectDir, '.yeaft', 'memory', 'group', sessionId))).toBe(false);
    expect(existsSync(join(projectDir, '.yeaft', 'memory', 'session', sessionId))).toBe(true);
    expect(readFileSync(join(userYeaftDir, 'memory', 'session', sessionId, 'summary.md'), 'utf8')).toBe('existing session memory');
    expect(readFileSync(join(userYeaftDir, 'memory', 'group', sessionId, 'memory.md'), 'utf8')).toBe('legacy group summary');
  });

  it('dry-runs without writing destination files', () => {
    const userYeaftDir = tempRoot('yeaft-user-');
    const projectDir = tempRoot('yeaft-project-');
    const sessionId = 'session_project_dry_run';
    makeProjectSession(projectDir, sessionId, 'Dry Run');

    const result = migrateProjectSessionsToUser(projectDir, userYeaftDir, { dryRun: true });

    expect(result.copied).toBe(1);
    expect(result.sessions[0].status).toBe('would_copy');
    expect(existsSync(join(userYeaftDir, 'sessions', sessionId))).toBe(false);
  });
});
