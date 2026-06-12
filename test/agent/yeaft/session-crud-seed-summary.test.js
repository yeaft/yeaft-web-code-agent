/**
 * group-crud-seed-summary.test.js — Pin the contract that `createSessionFromSpec`
 * also seeds `<root>/memory/sessions/<id>/summary.md` so the FIRST session
 * has a non-empty memory section. Same Bug-2 reasoning as
 * `vp-crud-seed-summary.test.js`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSessionFromSpec,
  buildSessionSeedSummary,
  sessionsRoot,
  readWorkDirRegistry,
  requireSession,
  resolveSessionYeaftDir,
  snapshotSessions,
  updateSessionAnnouncement,
  yeaftDirForWorkDir,
} from '../../../agent/yeaft/sessions/session-crud.js';
import { loadSessionMeta } from '../../../agent/yeaft/sessions/session-store.js';

let yeaftDir;
beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'group-seed-'));
  yeaftDir = tmp;
  mkdirSync(join(yeaftDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

describe('createSessionFromSpec seeds summary.md', () => {
  it('writes a non-empty summary.md for a newly created session', () => {
    const meta = createSessionFromSpec(yeaftDir, {
      name: `TestGrp_${Date.now()}`,
      roster: ['alice', 'bob'],
      defaultVpId: 'alice',
    });
    const summaryPath = join(yeaftDir, 'memory', 'sessions', meta.id, 'summary.md');
    try {
      expect(existsSync(summaryPath)).toBe(true);
      const body = readFileSync(summaryPath, 'utf-8');
      expect(body).toContain(meta.name);
      expect(body).toContain('alice');
      expect(body).toContain('bob');
    } finally {
      if (existsSync(summaryPath)) {
        rmSync(join(yeaftDir, 'memory', 'sessions', meta.id), { recursive: true, force: true });
      }
    }
  });


  it('creates workDir-backed session state under <workDir>/.yeaft and keeps it discoverable', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'group-workdir-'));
    const meta = createSessionFromSpec(yeaftDir, {
      name: `WorkdirGrp_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
      workDir,
    });

    const groupYeaftDir = yeaftDirForWorkDir(workDir);
    const sessionDir = join(groupYeaftDir, 'sessions', meta.id);
    expect(existsSync(sessionDir)).toBe(true);
    expect(existsSync(join(yeaftDir, 'sessions', meta.id))).toBe(false);

    const stored = loadSessionMeta(sessionDir);
    expect(stored.workDir).toBe(workDir);
    expect(resolveSessionYeaftDir(yeaftDir, meta.id)).toBe(groupYeaftDir);
    expect(readWorkDirRegistry(yeaftDir)[meta.id]).toBe(workDir);

    const groups = snapshotSessions(yeaftDir);
    expect(groups.some((g) => g.id === meta.id && g.workDir === workDir)).toBe(true);

    const handle = requireSession(yeaftDir, meta.id);
    expect(handle.getMeta().workDir).toBe(workDir);
    handle.close();

    const updated = updateSessionAnnouncement(yeaftDir, meta.id, 'Stored in project workdir');
    expect(updated.announcement).toBe('Stored in project workdir');
    expect(loadSessionMeta(sessionDir).announcement).toBe('Stored in project workdir');

    const summaryPath = join(groupYeaftDir, 'memory', 'sessions', meta.id, 'summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('keeps legacy sessions without workDir under the default yeaftDir', () => {
    const meta = createSessionFromSpec(yeaftDir, {
      name: `LegacyGrp_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
    });

    expect(resolveSessionYeaftDir(yeaftDir, meta.id)).toBe(yeaftDir);
    expect(existsSync(join(sessionsRoot(yeaftDir), meta.id))).toBe(true);
    expect(readWorkDirRegistry(yeaftDir)[meta.id]).toBeUndefined();
  });
});

describe('buildSessionSeedSummary', () => {
  it('includes name, member count and roster', () => {
    const out = buildSessionSeedSummary({ name: 'X', roster: ['a', 'b', 'c'] });
    expect(out).toContain('# X');
    expect(out).toContain('3 members');
    expect(out).toContain('a, b, c');
  });
  it('handles empty roster', () => {
    const out = buildSessionSeedSummary({ name: 'Empty', roster: [] });
    expect(out).toContain('0 members');
  });
});
