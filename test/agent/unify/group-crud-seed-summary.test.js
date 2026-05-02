/**
 * group-crud-seed-summary.test.js — Pin the contract that `createGroupFromSpec`
 * also seeds `<root>/memory/group/<id>/summary.md` so the FIRST session
 * has a non-empty memory section. Same Bug-2 reasoning as
 * `vp-crud-seed-summary.test.js`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  createGroupFromSpec,
  buildGroupSeedSummary,
} from '../../../agent/unify/groups/group-crud.js';

let yeaftDir;
let realHome;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'group-seed-'));
  yeaftDir = tmp;
  mkdirSync(join(yeaftDir, 'groups'), { recursive: true });
  realHome = homedir();
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
    const summaryPath = join(realHome, '.yeaft', 'memory', 'group', meta.id, 'summary.md');
    try {
      expect(existsSync(summaryPath)).toBe(true);
      const body = readFileSync(summaryPath, 'utf-8');
      expect(body).toContain(meta.name);
      expect(body).toContain('alice');
      expect(body).toContain('bob');
    } finally {
      if (existsSync(summaryPath)) {
        rmSync(join(realHome, '.yeaft', 'memory', 'group', meta.id), { recursive: true, force: true });
      }
    }
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
