/**
 * memory/seed-backfill.test.js — Pin the contract that fresh sessions get
 * a non-empty Layer-A resident summary even before Dream-v2 has run.
 *
 * Bug being guarded against:
 *   `engine.#prepareAms` reads `<root>/<scope>/summary.md` for user, vp,
 *   group scopes. Before this fix, NONE of these files existed on disk
 *   until Dream-v2 ran (which itself requires several turns of segment
 *   accumulation). Fresh sessions therefore rendered an empty memory
 *   section in the system prompt — the user-visible Bug #2.
 *
 *   This module backfills `summary.md` for every existing VP / group
 *   so the FIRST turn already has SOMETHING to inject. It's also a
 *   migration helper for users with pre-fix installations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  backfillVpSummaries,
  backfillGroupSummaries,
  runSummaryBackfill,
} from '../../../../agent/unify/memory/seed-backfill.js';

let tmpRoot;
let yeaftDir;
let memoryRoot;
let libDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'seed-backfill-'));
  yeaftDir = join(tmpRoot, 'yeaft');
  memoryRoot = join(yeaftDir, 'memory');
  libDir = join(yeaftDir, 'virtual-persons');
  mkdirSync(yeaftDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRoleMd(vpId, body) {
  mkdirSync(join(libDir, vpId), { recursive: true });
  writeFileSync(join(libDir, vpId, 'role.md'), body, 'utf-8');
}

function writeGroupMeta(groupId, meta) {
  const dir = join(yeaftDir, 'groups', groupId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'group.json'), JSON.stringify(meta), 'utf-8');
}

describe('backfillVpSummaries', () => {
  it('seeds summary.md for VPs missing one (stub: name + role only, no persona body)', () => {
    writeRoleMd('alice', '---\nid: alice\nname: Alice\nrole: PM\n---\nAlice is the product lead.');
    const r = backfillVpSummaries({ libDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.seeded).toBe(1);
    const out = readFileSync(join(memoryRoot, 'vp', 'alice', 'summary.md'), 'utf-8');
    expect(out).toContain('Alice');
    expect(out).toContain('PM');
    // Persona body MUST NOT be copied here — it is already rendered as
    // Section 1 of the system prompt by `renderVpPersona`. Duplicating it
    // into Layer-A `vp/<id>` resident produced the visible "persona defined
    // twice" bug.
    expect(out).not.toContain('product lead');
    expect(out).not.toContain('**Persona:**');
  });

  it('does NOT overwrite an existing non-empty summary.md', () => {
    writeRoleMd('bob', '---\nid: bob\nname: Bob\n---\nNew persona body.');
    mkdirSync(join(memoryRoot, 'vp', 'bob'), { recursive: true });
    writeFileSync(
      join(memoryRoot, 'vp', 'bob', 'summary.md'),
      'PRESERVE THIS\n',
      'utf-8'
    );
    const r = backfillVpSummaries({ libDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.seeded).toBe(0);
    const out = readFileSync(join(memoryRoot, 'vp', 'bob', 'summary.md'), 'utf-8');
    expect(out.trim()).toBe('PRESERVE THIS');
  });

  it('skips VPs without a role.md', () => {
    mkdirSync(join(libDir, 'orphan'), { recursive: true });
    const r = backfillVpSummaries({ libDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.seeded).toBe(0);
    expect(existsSync(join(memoryRoot, 'vp', 'orphan', 'summary.md'))).toBe(false);
  });

  it('handles a missing libDir without throwing', () => {
    const r = backfillVpSummaries({ libDir: join(tmpRoot, 'does-not-exist'), root: memoryRoot });
    expect(r.scanned).toBe(0);
    expect(r.seeded).toBe(0);
  });
});

describe('backfillGroupSummaries', () => {
  it('seeds summary.md for groups missing one', () => {
    writeGroupMeta('grp_test', {
      id: 'grp_test',
      name: 'Test Group',
      roster: ['alice', 'bob'],
      defaultVpId: 'alice',
    });
    const r = backfillGroupSummaries({ yeaftDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.seeded).toBe(1);
    const out = readFileSync(join(memoryRoot, 'group', 'grp_test', 'summary.md'), 'utf-8');
    expect(out).toContain('Test Group');
    expect(out).toContain('alice');
    expect(out).toContain('bob');
  });

  it('does NOT overwrite an existing summary.md', () => {
    writeGroupMeta('grp_test', { id: 'grp_test', name: 'Test', roster: [], defaultVpId: null });
    mkdirSync(join(memoryRoot, 'group', 'grp_test'), { recursive: true });
    writeFileSync(
      join(memoryRoot, 'group', 'grp_test', 'summary.md'),
      'KEEP ME\n',
      'utf-8'
    );
    const r = backfillGroupSummaries({ yeaftDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.seeded).toBe(0);
    expect(readFileSync(join(memoryRoot, 'group', 'grp_test', 'summary.md'), 'utf-8').trim())
      .toBe('KEEP ME');
  });

  it('ignores soft-archived `.archived-*` directories', () => {
    writeGroupMeta('.archived-2026-01-01-grp_old', { id: 'old', name: 'Old', roster: [] });
    const r = backfillGroupSummaries({ yeaftDir, root: memoryRoot });
    expect(r.scanned).toBe(0);
  });
});

describe('runSummaryBackfill — end-to-end', () => {
  it('seeds both VP and group summaries in one call', () => {
    writeRoleMd('steve', '---\nid: steve\nname: Steve\nrole: PM\n---\nSteve is a product manager.');
    writeGroupMeta('grp_claude', {
      id: 'grp_claude',
      name: 'Claude Group',
      roster: ['steve'],
      defaultVpId: 'steve',
    });
    const r = runSummaryBackfill({ yeaftDir, libDir, root: memoryRoot });
    expect(r.vp.seeded).toBe(1);
    expect(r.group.seeded).toBe(1);
    expect(existsSync(join(memoryRoot, 'vp', 'steve', 'summary.md'))).toBe(true);
    expect(existsSync(join(memoryRoot, 'group', 'grp_claude', 'summary.md'))).toBe(true);
  });

  it('is idempotent — running twice produces the same files', () => {
    writeRoleMd('idem', '---\nid: idem\nname: Idem\n---\nbody');
    writeGroupMeta('grp_idem', { id: 'grp_idem', name: 'I', roster: ['idem'] });
    const r1 = runSummaryBackfill({ yeaftDir, libDir, root: memoryRoot });
    const r2 = runSummaryBackfill({ yeaftDir, libDir, root: memoryRoot });
    expect(r1.vp.seeded).toBe(1);
    expect(r1.group.seeded).toBe(1);
    expect(r2.vp.seeded).toBe(0);
    expect(r2.group.seeded).toBe(0);
  });
});
