/**
 * migrate-r6-to-v2.test.js — DESIGN-v2 §21 migration script.
 *
 * Verifies:
 *   M1. Empty root → no-op (no errors, no plan)
 *   M2. Dry-run reports plan but writes nothing
 *   M3. Apply migrates user/, vp/<id>, groups/<id> (→ group/<id>),
 *       features/<id> (→ feature/<id>) — concatenating shards + entries
 *       + summary into v2 memory.md + summary.md
 *   M4. Backup is created at backupRoot before mutation
 *   M5. Refuses to clobber an existing v2 memory.md / summary.md (skip)
 *   M6. Already-singular `vp/<id>` with v2 files only → skipped (idempotent)
 *   M7. R6 shard files / index.md / MEMORY.md / scopes.md / entries/ all
 *       removed after apply; old plural dirs (groups/, features/) emptied
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateR6toV2 } from '../../../agent/unify/memory/migrate-r6-to-v2.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mig-r6-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedR6Tree() {
  // user/
  mkdirSync(join(root, 'user'), { recursive: true });
  writeFileSync(join(root, 'user', 'summary.md'), 'User likes brevity.');
  writeFileSync(join(root, 'user', 'MEMORY.md'), '# User Profile\n- prefers TS\n');
  writeFileSync(join(root, 'user', 'memory-prefs.md'), '# Prefs shard\n- dark mode\n');
  writeFileSync(join(root, 'user', 'memory-facts.md'), '# Facts shard\n- lives in SF\n');
  writeFileSync(join(root, 'user', 'index.md'), '| path | title |\n| --- | --- |\n');
  mkdirSync(join(root, 'user', 'entries'), { recursive: true });
  writeFileSync(join(root, 'user', 'entries', '2026-04-01-foo.md'), 'entry foo body');

  // vp/zhang-san/   (already singular)
  mkdirSync(join(root, 'vp', 'zhang-san'), { recursive: true });
  writeFileSync(join(root, 'vp', 'zhang-san', 'summary.md'), 'Zhang has a PM style.');
  writeFileSync(join(root, 'vp', 'zhang-san', 'memory-style.md'), '## style\nADR-driven');

  // groups/g-eng/  (R6 plural)
  mkdirSync(join(root, 'groups', 'g-eng'), { recursive: true });
  writeFileSync(join(root, 'groups', 'g-eng', 'summary.md'), 'Eng group ships weekly.');
  writeFileSync(join(root, 'groups', 'g-eng', 'memory-norms.md'), '## norms\nweekly demo');
  mkdirSync(join(root, 'groups', 'g-eng', 'entries'), { recursive: true });
  writeFileSync(join(root, 'groups', 'g-eng', 'entries', '2026-04-02-bar.md'), 'entry bar body');

  // features/f-1/  (R6 plural)
  mkdirSync(join(root, 'features', 'f-1'), { recursive: true });
  writeFileSync(join(root, 'features', 'f-1', 'summary.md'), 'Feature 1 in progress.');
  writeFileSync(join(root, 'features', 'f-1', 'memory-decisions.md'), '## decisions\nuse v2');
}

describe('M1. empty root', () => {
  it('no-op when root absent', async () => {
    const fakeRoot = join(root, 'does-not-exist');
    const res = await migrateR6toV2({ root: fakeRoot, apply: true });
    expect(res.plan).toEqual([]);
    expect(res.migratedScopes).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('no-op when root has no scopes', async () => {
    const res = await migrateR6toV2({ root, apply: true });
    expect(res.plan).toEqual([]);
    expect(res.migratedScopes).toBe(0);
  });
});

describe('M2. dry-run', () => {
  it('reports plan but writes nothing', async () => {
    seedR6Tree();
    const res = await migrateR6toV2({ root, apply: false });
    expect(res.plan.length).toBe(4);                 // user, vp/zhang-san, groups/g-eng, features/f-1
    expect(res.migratedScopes).toBe(0);
    expect(res.backedUpTo).toBe(null);
    // R6 files untouched
    expect(existsSync(join(root, 'user', 'memory-prefs.md'))).toBe(true);
    expect(existsSync(join(root, 'group', 'g-eng', 'memory.md'))).toBe(false);
  });
});

describe('M3. apply migrates concatenating R6 surfaces', () => {
  it('produces v2 memory.md + summary.md per scope', async () => {
    seedR6Tree();
    const res = await migrateR6toV2({ root, apply: true });
    expect(res.errors).toEqual([]);
    expect(res.migratedScopes).toBe(4);

    // user
    const userMem = readFileSync(join(root, 'user', 'memory.md'), 'utf8');
    expect(userMem).toContain('Legacy MEMORY.md (R5 user profile)');
    expect(userMem).toContain('# User Profile');
    expect(userMem).toContain('R6 shards');
    expect(userMem).toContain('# Prefs shard');
    expect(userMem).toContain('# Facts shard');
    expect(userMem).toContain('R6 entries');
    expect(userMem).toContain('entry foo body');
    expect(userMem).toContain('<!-- dream-state -->');
    expect(readFileSync(join(root, 'user', 'summary.md'), 'utf8').trim())
      .toBe('User likes brevity.');

    // vp/zhang-san (already singular)
    const vpMem = readFileSync(join(root, 'vp', 'zhang-san', 'memory.md'), 'utf8');
    expect(vpMem).toContain('## style');
    expect(readFileSync(join(root, 'vp', 'zhang-san', 'summary.md'), 'utf8').trim())
      .toBe('Zhang has a PM style.');

    // groups → group (singular)
    const grpMem = readFileSync(join(root, 'group', 'g-eng', 'memory.md'), 'utf8');
    expect(grpMem).toContain('## norms');
    expect(grpMem).toContain('entry bar body');
    expect(readFileSync(join(root, 'group', 'g-eng', 'summary.md'), 'utf8').trim())
      .toBe('Eng group ships weekly.');

    // features → feature (singular)
    const feaMem = readFileSync(join(root, 'feature', 'f-1', 'memory.md'), 'utf8');
    expect(feaMem).toContain('## decisions');
    expect(readFileSync(join(root, 'feature', 'f-1', 'summary.md'), 'utf8').trim())
      .toBe('Feature 1 in progress.');
  });
});

describe('M4. backup', () => {
  it('takes a snapshot under backupRoot before mutating', async () => {
    seedR6Tree();
    const res = await migrateR6toV2({ root, apply: true });
    expect(res.backedUpTo).toBeTruthy();
    expect(existsSync(join(res.backedUpTo, 'user', 'memory-prefs.md'))).toBe(true);
    expect(existsSync(join(res.backedUpTo, 'groups', 'g-eng', 'memory-norms.md'))).toBe(true);
  });
});

describe('M5. refuse to clobber existing v2 destination', () => {
  it('skips when destination already has v2 memory.md', async () => {
    // Pre-existing v2 group/g-eng with files
    mkdirSync(join(root, 'group', 'g-eng'), { recursive: true });
    writeFileSync(join(root, 'group', 'g-eng', 'memory.md'), 'PRESERVE ME');
    writeFileSync(join(root, 'group', 'g-eng', 'summary.md'), 'preserve');
    // R6 plural source with shards
    mkdirSync(join(root, 'groups', 'g-eng'), { recursive: true });
    writeFileSync(join(root, 'groups', 'g-eng', 'memory-x.md'), 'shard');
    const res = await migrateR6toV2({ root, apply: true });
    const skip = res.plan.find(a => a.kind === 'skip' && a.srcRelPath === 'groups/g-eng');
    expect(skip).toBeTruthy();
    expect(skip.reason).toMatch(/already has v2/);
    // existing file untouched
    expect(readFileSync(join(root, 'group', 'g-eng', 'memory.md'), 'utf8')).toBe('PRESERVE ME');
  });
});

describe('M6. idempotent on already-v2 layout', () => {
  it('skips a singular vp scope that only has v2 files', async () => {
    mkdirSync(join(root, 'vp', 'a'), { recursive: true });
    writeFileSync(join(root, 'vp', 'a', 'memory.md'), '# vp/a\n');
    writeFileSync(join(root, 'vp', 'a', 'summary.md'), 'a-summary\n');
    const res = await migrateR6toV2({ root, apply: true });
    expect(res.migratedScopes).toBe(0);
    expect(res.plan.find(a => a.srcRelPath === 'vp/a')?.reason).toMatch(/already v2/);
  });
});

describe('M7. R6 leftovers are purged after apply', () => {
  it('removes shards / entries / index.md / MEMORY.md / scopes.md', async () => {
    seedR6Tree();
    await migrateR6toV2({ root, apply: true });

    expect(existsSync(join(root, 'user', 'memory-prefs.md'))).toBe(false);
    expect(existsSync(join(root, 'user', 'memory-facts.md'))).toBe(false);
    expect(existsSync(join(root, 'user', 'MEMORY.md'))).toBe(false);
    expect(existsSync(join(root, 'user', 'index.md'))).toBe(false);
    expect(existsSync(join(root, 'user', 'entries'))).toBe(false);

    expect(existsSync(join(root, 'vp', 'zhang-san', 'memory-style.md'))).toBe(false);

    // groups/<id> entire dir cleaned and removed
    expect(existsSync(join(root, 'groups', 'g-eng'))).toBe(false);
    // features/<id> entire dir cleaned and removed
    expect(existsSync(join(root, 'features', 'f-1'))).toBe(false);

    // v2 destinations exist
    expect(existsSync(join(root, 'group', 'g-eng', 'memory.md'))).toBe(true);
    expect(existsSync(join(root, 'feature', 'f-1', 'memory.md'))).toBe(true);
  });
});
