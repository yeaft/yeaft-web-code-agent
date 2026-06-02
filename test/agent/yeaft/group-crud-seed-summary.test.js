/**
 * group-crud-seed-summary.test.js — Pin the contract that `createGroupFromSpec`
 * also seeds `<root>/memory/group/<id>/summary.md` so the FIRST session
 * has a non-empty memory section. Same Bug-2 reasoning as
 * `vp-crud-seed-summary.test.js`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createGroupFromSpec,
  buildGroupSeedSummary,
  groupsRoot,
  readWorkDirRegistry,
  requireGroup,
  resolveGroupYeaftDir,
  snapshotGroups,
  updateGroupAnnouncement,
  yeaftDirForWorkDir,
} from '../../../agent/yeaft/groups/group-crud.js';
import { loadGroupMeta } from '../../../agent/yeaft/groups/group-store.js';

let yeaftDir;
beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'group-seed-'));
  yeaftDir = tmp;
  mkdirSync(join(yeaftDir, 'groups'), { recursive: true });
});

afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

describe('createGroupFromSpec seeds summary.md', () => {
  it('writes a non-empty summary.md for a newly created group', () => {
    const meta = createGroupFromSpec(yeaftDir, {
      name: `TestGrp_${Date.now()}`,
      roster: ['alice', 'bob'],
      defaultVpId: 'alice',
    });
    const summaryPath = join(yeaftDir, 'memory', 'group', meta.id, 'summary.md');
    try {
      expect(existsSync(summaryPath)).toBe(true);
      const body = readFileSync(summaryPath, 'utf-8');
      expect(body).toContain(meta.name);
      expect(body).toContain('alice');
      expect(body).toContain('bob');
    } finally {
      if (existsSync(summaryPath)) {
        rmSync(join(yeaftDir, 'memory', 'group', meta.id), { recursive: true, force: true });
      }
    }
  });


  it('creates workDir-backed group state under <workDir>/.yeaft and keeps it discoverable', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'group-workdir-'));
    const meta = createGroupFromSpec(yeaftDir, {
      name: `WorkdirGrp_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
      workDir,
    });

    const groupYeaftDir = yeaftDirForWorkDir(workDir);
    const groupDir = join(groupYeaftDir, 'groups', meta.id);
    expect(existsSync(groupDir)).toBe(true);
    expect(existsSync(join(yeaftDir, 'groups', meta.id))).toBe(false);

    const stored = loadGroupMeta(groupDir);
    expect(stored.workDir).toBe(workDir);
    expect(resolveGroupYeaftDir(yeaftDir, meta.id)).toBe(groupYeaftDir);
    expect(readWorkDirRegistry(yeaftDir)[meta.id]).toBe(workDir);

    const groups = snapshotGroups(yeaftDir);
    expect(groups.some((g) => g.id === meta.id && g.workDir === workDir)).toBe(true);

    const handle = requireGroup(yeaftDir, meta.id);
    expect(handle.getMeta().workDir).toBe(workDir);
    handle.close();

    const updated = updateGroupAnnouncement(yeaftDir, meta.id, 'Stored in project workdir');
    expect(updated.announcement).toBe('Stored in project workdir');
    expect(loadGroupMeta(groupDir).announcement).toBe('Stored in project workdir');

    const summaryPath = join(groupYeaftDir, 'memory', 'group', meta.id, 'summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    expect(readFileSync(summaryPath, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('keeps legacy groups without workDir under the default yeaftDir', () => {
    const meta = createGroupFromSpec(yeaftDir, {
      name: `LegacyGrp_${Date.now()}`,
      roster: ['alice'],
      defaultVpId: 'alice',
    });

    expect(resolveGroupYeaftDir(yeaftDir, meta.id)).toBe(yeaftDir);
    expect(existsSync(join(groupsRoot(yeaftDir), meta.id))).toBe(true);
    expect(readWorkDirRegistry(yeaftDir)[meta.id]).toBeUndefined();
  });
});

describe('buildGroupSeedSummary', () => {
  it('includes name, member count and roster', () => {
    const out = buildGroupSeedSummary({ name: 'X', roster: ['a', 'b', 'c'] });
    expect(out).toContain('# X');
    expect(out).toContain('3 members');
    expect(out).toContain('a, b, c');
  });
  it('handles empty roster', () => {
    const out = buildGroupSeedSummary({ name: 'Empty', roster: [] });
    expect(out).toContain('0 members');
  });
});
