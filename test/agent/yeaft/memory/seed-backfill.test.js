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
  migrateLegacyVpSummaries,
  isVpSeedBackfillStub,
  VP_STUB_MARKER,
} from '../../../../agent/yeaft/memory/seed-backfill.js';

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

function writeGroupMeta(sessionId, meta) {
  const dir = join(yeaftDir, 'sessions', sessionId);
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
    // Stamp lets `engine.#prepareAms` detect the stub and skip the
    // own-VP Resident push (the redundant-label follow-up to PR #722).
    expect(out).toContain(VP_STUB_MARKER);
    expect(isVpSeedBackfillStub(out)).toBe(true);
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
    expect(r.migrate.migrated).toBe(0);
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
    expect(r2.migrate.migrated).toBe(0);
  });

  it('migrates legacy persona-body summaries on first run, then is a no-op', () => {
    writeRoleMd('legacy', '---\nid: legacy\nname: Legacy\nrole: Engineer\n---\nLegacy persona body.');
    // Pre-stamp summary written by the old stub: contains **Persona:**
    // and a body excerpt, no marker.
    mkdirSync(join(memoryRoot, 'vp', 'legacy'), { recursive: true });
    writeFileSync(
      join(memoryRoot, 'vp', 'legacy', 'summary.md'),
      '# Legacy\n\n**Role:** Engineer\n\n**Persona:**\n\nLegacy persona body.\n',
      'utf-8'
    );
    const r1 = runSummaryBackfill({ yeaftDir, libDir, root: memoryRoot });
    expect(r1.migrate.migrated).toBe(1);
    expect(r1.vp.seeded).toBe(0);  // file exists post-migration → not re-seeded
    const out = readFileSync(join(memoryRoot, 'vp', 'legacy', 'summary.md'), 'utf-8');
    expect(out).toContain(VP_STUB_MARKER);
    expect(out).not.toContain('**Persona:**');
    expect(out).not.toContain('Legacy persona body');
    const r2 = runSummaryBackfill({ yeaftDir, libDir, root: memoryRoot });
    expect(r2.migrate.migrated).toBe(0);
  });
});

describe('isVpSeedBackfillStub', () => {
  it('returns true for a freshly-stamped stub', () => {
    writeRoleMd('alice', '---\nid: alice\nname: Alice\nrole: PM\n---\nbody');
    backfillVpSummaries({ libDir, root: memoryRoot });
    const out = readFileSync(join(memoryRoot, 'vp', 'alice', 'summary.md'), 'utf-8');
    expect(isVpSeedBackfillStub(out)).toBe(true);
  });

  it('returns false for a Dream-v2-shaped summary (no marker)', () => {
    const dreamLike = '# Alice\n\nWorked on AMS resident dedup last week. Prefers single-PR fixes.';
    expect(isVpSeedBackfillStub(dreamLike)).toBe(false);
  });

  it('returns false for legacy pre-stamp persona-body summaries', () => {
    const legacy = '# Alice\n\n**Role:** PM\n\n**Persona:**\n\nAlice is the product lead.';
    expect(isVpSeedBackfillStub(legacy)).toBe(false);
  });

  it('returns false for empty / non-string input', () => {
    expect(isVpSeedBackfillStub('')).toBe(false);
    expect(isVpSeedBackfillStub(null)).toBe(false);
    expect(isVpSeedBackfillStub(undefined)).toBe(false);
    expect(isVpSeedBackfillStub(42)).toBe(false);
  });
});

describe('migrateLegacyVpSummaries', () => {
  it('rewrites a legacy persona-body summary into a stamped stub', () => {
    writeRoleMd('legacy', '---\nid: legacy\nname: Legacy\nrole: Engineer\n---\nbody');
    mkdirSync(join(memoryRoot, 'vp', 'legacy'), { recursive: true });
    writeFileSync(
      join(memoryRoot, 'vp', 'legacy', 'summary.md'),
      '# Legacy\n\n**Role:** Engineer\n\n**Persona:**\n\nLong body excerpt up to 800 chars…\n',
      'utf-8'
    );
    const r = migrateLegacyVpSummaries({ libDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(1);
    const out = readFileSync(join(memoryRoot, 'vp', 'legacy', 'summary.md'), 'utf-8');
    expect(out).toContain(VP_STUB_MARKER);
    expect(out).toContain('Legacy');
    expect(out).toContain('Engineer');
    expect(out).not.toContain('**Persona:**');
    expect(out).not.toContain('Long body excerpt');
  });

  it('leaves stamped stubs alone', () => {
    writeRoleMd('alice', '---\nid: alice\nname: Alice\nrole: PM\n---\nbody');
    backfillVpSummaries({ libDir, root: memoryRoot });
    const before = readFileSync(join(memoryRoot, 'vp', 'alice', 'summary.md'), 'utf-8');
    const r = migrateLegacyVpSummaries({ libDir, root: memoryRoot });
    expect(r.migrated).toBe(0);
    const after = readFileSync(join(memoryRoot, 'vp', 'alice', 'summary.md'), 'utf-8');
    expect(after).toBe(before);
  });

  it('leaves Dream-v2-shaped summaries alone (no persona marker, no stamp)', () => {
    writeRoleMd('drm', '---\nid: drm\nname: Drm\nrole: Eng\n---\nbody');
    mkdirSync(join(memoryRoot, 'vp', 'drm'), { recursive: true });
    const dreamLike = '# Drm\n\nReal summary written by Dream-v2 — no marker, no Persona block.\n';
    writeFileSync(join(memoryRoot, 'vp', 'drm', 'summary.md'), dreamLike, 'utf-8');
    const r = migrateLegacyVpSummaries({ libDir, root: memoryRoot });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(0);
    expect(readFileSync(join(memoryRoot, 'vp', 'drm', 'summary.md'), 'utf-8')).toBe(dreamLike);
  });

  it('skips VPs whose role.md is missing (cannot rebuild stub)', () => {
    // No writeRoleMd — the on-disk role.md is absent.
    mkdirSync(join(memoryRoot, 'vp', 'orphan'), { recursive: true });
    const legacy = '# Orphan\n\n**Persona:**\n\nbody.\n';
    writeFileSync(join(memoryRoot, 'vp', 'orphan', 'summary.md'), legacy, 'utf-8');
    const r = migrateLegacyVpSummaries({ libDir, root: memoryRoot });
    expect(r.migrated).toBe(0);
    // Legacy file is preserved, not blanked.
    expect(readFileSync(join(memoryRoot, 'vp', 'orphan', 'summary.md'), 'utf-8')).toBe(legacy);
  });

  it('handles a missing memoryRoot/vp dir without throwing', () => {
    const r = migrateLegacyVpSummaries({ libDir, root: join(tmpRoot, 'no-such-root') });
    expect(r.scanned).toBe(0);
    expect(r.migrated).toBe(0);
  });
});
