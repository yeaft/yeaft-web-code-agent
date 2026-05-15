import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGroup,
  openGroup,
  loadGroupMeta,
} from '../../../../agent/unify/groups/group-store.js';
import {
  updateGroupAnnouncement,
  GroupCrudError,
} from '../../../../agent/unify/groups/group-crud.js';

describe('group.json announcement field', () => {
  let groupsDir;
  beforeEach(() => {
    groupsDir = mkdtempSync(join(tmpdir(), 'group-ann-store-'));
  });

  it('createGroup defaults announcement to empty string', () => {
    const h = createGroup(groupsDir, { id: 'g1', name: 'G1', roster: ['vp_a'] });
    const meta = h.getMeta();
    h.close();
    expect(meta.announcement).toBe('');
  });

  it('saveMeta + loadGroupMeta roundtrips announcement', () => {
    const h = createGroup(groupsDir, { id: 'g2', name: 'G2', roster: [] });
    h.saveMeta({ ...h.getMeta(), announcement: 'Be kind. Cite sources.' });
    h.close();
    const reloaded = loadGroupMeta(join(groupsDir, 'g2'));
    expect(reloaded.announcement).toBe('Be kind. Cite sources.');
  });

  it('rejects non-string announcement', () => {
    const h = createGroup(groupsDir, { id: 'g3', name: 'G3', roster: [] });
    expect(() => h.saveMeta({ ...h.getMeta(), announcement: 42 }))
      .toThrow(/announcement.*string/);
    h.close();
  });


  it('createGroup persists workDir and legacy groups load with empty workDir', () => {
    const h = createGroup(groupsDir, {
      id: 'workdir',
      name: 'Workdir',
      roster: [],
      workDir: '/tmp/project-a',
    });
    const meta = h.getMeta();
    h.close();
    expect(meta.workDir).toBe('/tmp/project-a');

    const legacy = createGroup(groupsDir, { id: 'legacy-workdir', name: 'Legacy Workdir', roster: [] });
    legacy.saveMeta({ id: 'legacy-workdir', name: 'Legacy Workdir', roster: [], defaultVpId: null });
    legacy.close();
    const reloaded = loadGroupMeta(join(groupsDir, 'legacy-workdir'));
    expect(reloaded.workDir).toBe('');
  });
  it('legacy group without announcement loads with empty string', () => {
    // Simulate pre-migration meta (no announcement field) by writing through
    // a saveMeta call, which runs validateMeta — so a meta without
    // announcement must still be accepted.
    const h = openGroup(groupsDir, 'legacy');
    h.saveMeta({ id: 'legacy', name: 'Legacy', roster: [], defaultVpId: null });
    h.close();
    const meta = loadGroupMeta(join(groupsDir, 'legacy'));
    expect(meta.announcement).toBe('');
  });
});

describe('updateGroupAnnouncement', () => {
  let yeaftDir;
  beforeEach(() => {
    yeaftDir = mkdtempSync(join(tmpdir(), 'group-ann-crud-'));
  });

  it('persists announcement (trimmed) and returns updated meta', () => {
    const groupsDir = join(yeaftDir, 'groups');
    createGroup(groupsDir, { id: 'g1', name: 'G1', roster: [] }).close();
    const meta = updateGroupAnnouncement(yeaftDir, 'g1', '  Hello team.  ');
    expect(meta.announcement).toBe('Hello team.');
    const reloaded = loadGroupMeta(join(groupsDir, 'g1'));
    expect(reloaded.announcement).toBe('Hello team.');
  });

  it('accepts empty string (clears announcement)', () => {
    const groupsDir = join(yeaftDir, 'groups');
    const h = createGroup(groupsDir, { id: 'g2', name: 'G2', roster: [] });
    h.saveMeta({ ...h.getMeta(), announcement: 'old' });
    h.close();
    const meta = updateGroupAnnouncement(yeaftDir, 'g2', '');
    expect(meta.announcement).toBe('');
  });

  it('throws not_found for unknown group', () => {
    let err;
    try { updateGroupAnnouncement(yeaftDir, 'ghost', 'x'); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(GroupCrudError);
    expect(err.code).toBe('not_found');
  });

  it('rejects non-string text with invalid_announcement', () => {
    const groupsDir = join(yeaftDir, 'groups');
    createGroup(groupsDir, { id: 'g3', name: 'G3', roster: [] }).close();
    let err;
    try { updateGroupAnnouncement(yeaftDir, 'g3', 42); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(GroupCrudError);
    expect(err.code).toBe('invalid_announcement');
  });
});
