/**
 * task-334m — group-crud.js unit tests.
 *
 * Covers the high-level CRUD API + D1 seed. Uses a fresh tmp yeaftDir per
 * test so no cross-test leakage. Where the behavior depends on VP library,
 * we point `libDir` at a tmp dir with hand-crafted role.md files so we
 * don't touch the real ~/.yeaft.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GroupCrudError,
  makeGroupId,
  ensureDefaultGroupIfEmpty,
  createGroupFromSpec,
  renameGroup,
  archiveGroup,
  addMember,
  removeMember,
  setGroupDefaultVp,
  snapshotGroups,
} from '../../../../agent/unify/groups/group-crud.js';
import { listGroups } from '../../../../agent/unify/groups/group-store.js';

let yeaftDir;
let libDir;

function writeVp(id, name = id) {
  const dir = join(libDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'role.md'),
    `---\nid: ${id}\nname: ${name}\nrole: tester\n---\n${name} persona body.\n`,
  );
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), '334m-crud-'));
  yeaftDir = join(root, 'yeaft');
  libDir = join(root, 'lib');
  mkdirSync(yeaftDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(yeaftDir, { recursive: true, force: true }); } catch {}
  try { rmSync(libDir, { recursive: true, force: true }); } catch {}
});

// ─── makeGroupId ─────────────────────────────────────────────

describe('makeGroupId', () => {
  it('slugifies + adds ulid-lite suffix', () => {
    const id = makeGroupId('My Group!!!');
    expect(id).toMatch(/^grp_my-group/);
  });
  it('falls back to grp_group for empty / punctuation-only names', () => {
    const id = makeGroupId('...');
    expect(id).toMatch(/^grp_group/);
  });
});

// ─── createGroupFromSpec ────────────────────────────────────

describe('createGroupFromSpec', () => {
  it('creates a group with the supplied roster; defaultVpId defaults to roster[0]', () => {
    writeVp('alice'); writeVp('bob');
    const meta = createGroupFromSpec(yeaftDir, {
      name: 'Team A',
      roster: ['alice', 'bob'],
    });
    expect(meta.name).toBe('Team A');
    expect(meta.roster).toEqual(['alice', 'bob']);
    expect(meta.defaultVpId).toBe('alice');
  });

  it('honors explicit defaultVpId when in roster', () => {
    const meta = createGroupFromSpec(yeaftDir, {
      name: 'Team B',
      roster: ['alice', 'bob'],
      defaultVpId: 'bob',
    });
    expect(meta.defaultVpId).toBe('bob');
  });

  it('rejects empty name', () => {
    expect(() => createGroupFromSpec(yeaftDir, { name: '  ' }))
      .toThrow(GroupCrudError);
    try { createGroupFromSpec(yeaftDir, { name: '  ' }); }
    catch (e) { expect(e.code).toBe('invalid_name'); }
  });

  it('rejects reserved vpId', () => {
    try { createGroupFromSpec(yeaftDir, { name: 'X', roster: ['user'] }); expect.fail(); }
    catch (e) { expect(e.code).toBe('reserved'); }
  });

  it('rejects defaultVpId not in roster', () => {
    try {
      createGroupFromSpec(yeaftDir, { name: 'X', roster: ['alice'], defaultVpId: 'bob' });
      expect.fail();
    } catch (e) { expect(e.code).toBe('default_not_in_roster'); }
  });

  it('permits empty roster (no_default_vp state — UI nudges on first send)', () => {
    const meta = createGroupFromSpec(yeaftDir, { name: 'Empty' });
    expect(meta.roster).toEqual([]);
    expect(meta.defaultVpId).toBeNull();
  });
});

// ─── renameGroup / archiveGroup ─────────────────────────────

describe('renameGroup + archiveGroup', () => {
  it('renameGroup updates the display name only', () => {
    const created = createGroupFromSpec(yeaftDir, { name: 'Old', roster: ['alice'] });
    const next = renameGroup(yeaftDir, created.id, 'New');
    expect(next.id).toBe(created.id);
    expect(next.name).toBe('New');
    expect(next.roster).toEqual(['alice']);
  });

  it('renameGroup rejects blank name', () => {
    const created = createGroupFromSpec(yeaftDir, { name: 'x', roster: [] });
    try { renameGroup(yeaftDir, created.id, ''); expect.fail(); }
    catch (e) { expect(e.code).toBe('invalid_name'); }
  });

  it('archiveGroup renames dir with .archived- prefix and hex suffix', () => {
    const created = createGroupFromSpec(yeaftDir, { name: 'A', roster: [] });
    const before = listGroups(join(yeaftDir, 'groups')).map(g => g.id);
    expect(before).toContain(created.id);

    const res = archiveGroup(yeaftDir, created.id);
    expect(res.groupId).toBe(created.id);
    // Dir prefix + 4-hex collision guard
    const dirs = readdirSync(join(yeaftDir, 'groups'));
    const archived = dirs.find(n => n.startsWith('.archived-'));
    expect(archived).toBeTruthy();
    expect(archived).toMatch(/-[0-9a-f]{4}-/);
    // Live dir for the original id is gone.
    expect(dirs).not.toContain(created.id);
  });

  it('archiveGroup throws not_found on missing id', () => {
    try { archiveGroup(yeaftDir, 'grp_missing'); expect.fail(); }
    catch (e) { expect(e.code).toBe('not_found'); }
  });
});

// ─── addMember / removeMember / setGroupDefaultVp ───────────

describe('roster ops', () => {
  it('addMember is idempotent', () => {
    const g = createGroupFromSpec(yeaftDir, { name: 'A', roster: [] });
    const m1 = addMember(yeaftDir, g.id, 'alice');
    const m2 = addMember(yeaftDir, g.id, 'alice');
    expect(m1.roster).toEqual(['alice']);
    expect(m2.roster).toEqual(['alice']);
    expect(m2.defaultVpId).toBe('alice'); // first add sets default
  });

  it('removeMember no-ops on non-member', () => {
    const g = createGroupFromSpec(yeaftDir, { name: 'A', roster: ['alice'] });
    const after = removeMember(yeaftDir, g.id, 'nobody');
    expect(after.roster).toEqual(['alice']);
  });

  it('removeMember rotates defaultVpId when default is removed', () => {
    const g = createGroupFromSpec(yeaftDir, { name: 'A', roster: ['alice', 'bob'], defaultVpId: 'alice' });
    const after = removeMember(yeaftDir, g.id, 'alice');
    expect(after.roster).toEqual(['bob']);
    expect(after.defaultVpId).toBe('bob');
  });

  it('setGroupDefaultVp updates only when vpId is a member', () => {
    const g = createGroupFromSpec(yeaftDir, { name: 'A', roster: ['alice', 'bob'] });
    const next = setGroupDefaultVp(yeaftDir, g.id, 'bob');
    expect(next.defaultVpId).toBe('bob');
  });
});

// ─── D1 seed: ensureDefaultGroupIfEmpty ────────────────────

describe('ensureDefaultGroupIfEmpty (D1 seed)', () => {
  it('seeds grp_default with sorted roster from VP library', () => {
    writeVp('zane'); writeVp('alice'); writeVp('mary');
    const res = ensureDefaultGroupIfEmpty(yeaftDir, { libDir });
    expect(res.seeded).toBe(true);
    expect(res.rosterSize).toBe(3);
    expect(res.defaultVpId).toBe('alice'); // alphabetically first
    const groups = listGroups(join(yeaftDir, 'groups'));
    expect(groups.length).toBe(1);
    expect(groups[0].roster).toEqual(['alice', 'mary', 'zane']);
  });

  it('is idempotent (no-op when ≥1 group already exists)', () => {
    writeVp('alice');
    ensureDefaultGroupIfEmpty(yeaftDir, { libDir });
    const after1 = listGroups(join(yeaftDir, 'groups')).length;

    const res2 = ensureDefaultGroupIfEmpty(yeaftDir, { libDir });
    expect(res2.seeded).toBe(false);
    expect(listGroups(join(yeaftDir, 'groups')).length).toBe(after1);
  });

  it('seeds an empty-roster group when VP library is empty', () => {
    const res = ensureDefaultGroupIfEmpty(yeaftDir, { libDir });
    expect(res.seeded).toBe(true);
    expect(res.rosterSize).toBe(0);
    expect(res.defaultVpId).toBeNull();
    const groups = listGroups(join(yeaftDir, 'groups'));
    expect(groups.length).toBe(1);
    expect(groups[0].roster).toEqual([]);
    expect(groups[0].defaultVpId).toBeNull();
  });
});

// ─── snapshotGroups passthrough ────────────────────────────

describe('snapshotGroups', () => {
  it('returns the live (non-archived) group after archiving another', () => {
    const g1 = createGroupFromSpec(yeaftDir, { name: 'A', roster: [] });
    const g2 = createGroupFromSpec(yeaftDir, { name: 'B', roster: [] });
    archiveGroup(yeaftDir, g2.id);
    const snap = snapshotGroups(yeaftDir);
    // At minimum the live group is present with its original name.
    const liveNames = snap.map(g => g.name);
    expect(liveNames).toContain('A');
  });
});
