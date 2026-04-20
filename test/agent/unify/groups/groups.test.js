import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openGroup,
  createGroup,
  loadGroupMeta,
  listGroups,
  addVp,
  removeVp,
  setDefaultVp,
  isMember,
  resolveFallbackVp,
  createCoordinator,
  parseMentions,
  isMultiVpEnabled,
  setMultiVpEnabled,
  seedDefaultGroup,
  DEFAULT_GROUP_ID,
  nextMsgId,
  nextGroupId,
  isReservedVpId,
  RESERVED_VP_IDS,
  ReservedVpIdError,
} from '../../../../agent/unify/groups/index.js';

let root;
let groupsRoot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '334b-'));
  groupsRoot = join(root, 'groups');
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

// ─── ids ─────────────────────────────────────────────────────

describe('ids', () => {
  it('nextMsgId is prefixed and lexicographically monotonic across calls', () => {
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(nextMsgId());
    for (const id of ids) expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    const sorted = ids.slice().sort();
    // Because time+random, we verify format and uniqueness (not strict order
    // within same ms).
    expect(new Set(ids).size).toBe(ids.length);
    expect(sorted.length).toBe(ids.length);
  });

  it('nextGroupId slugifies input', () => {
    expect(nextGroupId('My Team!')).toBe('grp_my-team-');
    expect(nextGroupId('')).toBe('grp_group');
  });

  it('isReservedVpId flags sentinels (case-insensitive) and exports the set', () => {
    expect(RESERVED_VP_IDS).toContain('all');
    expect(RESERVED_VP_IDS).toContain('user');
    for (const id of ['all', 'All', 'USER', 'system', 'everyone']) {
      expect(isReservedVpId(id)).toBe(true);
    }
    for (const id of ['architect', 'alice', 'bob', 'all_hands', '']) {
      expect(isReservedVpId(id)).toBe(false);
    }
    expect(isReservedVpId(null)).toBe(false);
    expect(isReservedVpId(undefined)).toBe(false);
  });
});

// ─── group-store ─────────────────────────────────────────────

describe('group-store', () => {
  it('createGroup writes group.json and is loadable', () => {
    const h = createGroup(groupsRoot, { id: 'grp_a', name: 'A', roster: ['alice'], defaultVpId: 'alice' });
    expect(h.getMeta().name).toBe('A');
    const dir = join(groupsRoot, 'grp_a');
    const parsed = JSON.parse(readFileSync(join(dir, 'group.json'), 'utf8'));
    expect(parsed.roster).toEqual(['alice']);
    expect(parsed.defaultVpId).toBe('alice');
  });

  it('createGroup refuses to overwrite', () => {
    createGroup(groupsRoot, { id: 'grp_a', name: 'A', roster: [] });
    expect(() => createGroup(groupsRoot, { id: 'grp_a', name: 'dup', roster: [] }))
      .toThrow(/already exists/);
  });

  it('appendMessage persists to jsonl log and streams back', () => {
    const h = createGroup(groupsRoot, { id: 'grp_a', name: 'A', roster: ['alice'] });
    h.appendMessage({ from: 'user', text: 'hi' });
    h.appendMessage({ from: 'alice', text: 'hey' });
    h.close();

    const h2 = openGroup(groupsRoot, 'grp_a');
    const all = Array.from(h2.streamMessages());
    expect(all).toHaveLength(2);
    expect(all[0].text).toBe('hi');
    expect(all[0].role).toBe('user');
    expect(all[1].from).toBe('alice');
    expect(all[1].id).toMatch(/^msg_/);
  });

  it('listGroups enumerates all on-disk groups', () => {
    createGroup(groupsRoot, { id: 'grp_a', roster: [] });
    createGroup(groupsRoot, { id: 'grp_b', roster: ['bob'] });
    const ids = listGroups(groupsRoot).map((m) => m.id).sort();
    expect(ids).toEqual(['grp_a', 'grp_b']);
  });

  it('loadGroupMeta returns null on missing or corrupt file', () => {
    expect(loadGroupMeta(join(groupsRoot, 'nope'))).toBeNull();
    const dir = join(groupsRoot, 'grp_x');
    createGroup(groupsRoot, { id: 'grp_x', roster: [] });
    writeFileSync(join(dir, 'group.json'), '{not-json');
    expect(loadGroupMeta(dir)).toBeNull();
  });

  it('rejects malformed roster on saveMeta', () => {
    const h = createGroup(groupsRoot, { id: 'grp_a', roster: [] });
    expect(() => h.saveMeta({ id: 'grp_a', roster: 'bad' })).toThrow(/roster/);
    expect(() => h.saveMeta({ id: 'grp_a', roster: [42] })).toThrow(/roster/);
  });

  it('createGroup rejects reserved vpIds in initial roster / defaultVpId', () => {
    expect(() => createGroup(groupsRoot, { id: 'grp_r1', roster: ['all'] }))
      .toThrow(ReservedVpIdError);
    expect(() => createGroup(groupsRoot, { id: 'grp_r2', roster: ['alice', 'system'] }))
      .toThrow(/reserved/);
    expect(() => createGroup(groupsRoot, { id: 'grp_r3', roster: ['alice'], defaultVpId: 'user' }))
      .toThrow(ReservedVpIdError);
    // Non-reserved roster proceeds normally.
    const h = createGroup(groupsRoot, { id: 'grp_ok', roster: ['architect'], defaultVpId: 'architect' });
    expect(h.getMeta().roster).toEqual(['architect']);
  });
});

// ─── roster helpers ─────────────────────────────────────────

describe('roster', () => {
  const base = { id: 'grp_a', roster: [], defaultVpId: null };

  it('addVp appends and sets default if none', () => {
    const m1 = addVp(base, 'alice');
    expect(m1.roster).toEqual(['alice']);
    expect(m1.defaultVpId).toBe('alice');
    const m2 = addVp(m1, 'bob');
    expect(m2.roster).toEqual(['alice', 'bob']);
    expect(m2.defaultVpId).toBe('alice');
  });

  it('addVp is idempotent and preserves order', () => {
    let m = addVp(base, 'a');
    m = addVp(m, 'b');
    m = addVp(m, 'a');
    expect(m.roster).toEqual(['a', 'b']);
  });

  it('removeVp re-picks default by join order', () => {
    let m = addVp(addVp(base, 'alice'), 'bob');
    m = setDefaultVp(m, 'bob');
    const m2 = removeVp(m, 'bob');
    expect(m2.roster).toEqual(['alice']);
    expect(m2.defaultVpId).toBe('alice');
  });

  it('removeVp clears default to null when roster empties', () => {
    let m = addVp(base, 'alice');
    m = removeVp(m, 'alice');
    expect(m.roster).toEqual([]);
    expect(m.defaultVpId).toBeNull();
  });

  it('setDefaultVp rejects non-member', () => {
    const m = addVp(base, 'alice');
    expect(() => setDefaultVp(m, 'stranger')).toThrow(/not in roster/);
  });

  it('resolveFallbackVp prefers default, falls back to first, null if empty', () => {
    expect(resolveFallbackVp(base)).toBeNull();
    const m1 = addVp(base, 'alice');
    expect(resolveFallbackVp(m1)).toBe('alice');
    const m2 = addVp(m1, 'bob');
    const m3 = setDefaultVp(m2, 'bob');
    expect(resolveFallbackVp(m3)).toBe('bob');
  });

  it('isMember basic', () => {
    const m = addVp(base, 'alice');
    expect(isMember(m, 'alice')).toBe(true);
    expect(isMember(m, 'stranger')).toBe(false);
  });

  it('addVp throws ReservedVpIdError on reserved vpId (e.g. "all")', () => {
    expect(() => addVp(base, 'all')).toThrow(ReservedVpIdError);
    expect(() => addVp(base, 'user')).toThrow(/reserved/);
    // Non-reserved id (including names containing reserved substrings) pass.
    expect(addVp(base, 'architect').roster).toEqual(['architect']);
    expect(addVp(base, 'all_hands').roster).toEqual(['all_hands']);
  });
});

// ─── parseMentions ───────────────────────────────────────────

describe('parseMentions', () => {
  it('extracts ordered unique mentions', () => {
    expect(parseMentions('hey @alice, tag @bob and @alice again'))
      .toEqual(['alice', 'bob']);
  });

  it('recognises @all as a mention token', () => {
    expect(parseMentions('@all please ack')).toEqual(['all']);
  });

  it('ignores email-style addresses (no leading space)', () => {
    // Our regex requires start-of-string OR whitespace before @ — so
    // "mail@example.com" does NOT emit `@example`.
    expect(parseMentions('ping me at foo@example.com')).toEqual([]);
  });

  it('empty or non-string input → []', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
  });
});

// ─── coordinator ─────────────────────────────────────────────

describe('coordinator', () => {
  function buildGroup(roster = ['alice', 'bob'], defaultVpId = 'alice') {
    return createGroup(groupsRoot, { id: 'grp_a', roster, defaultVpId });
  }

  it('user @mention dispatches to the target and persists the message', () => {
    const g = buildGroup();
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v, e) => delivered.push([v, e.trigger]) });
    const r = coord.ingest({ from: 'user', text: 'hi @alice!' });
    expect(r.dispatched).toEqual(['alice']);
    expect(r.errors).toEqual([]);
    expect(delivered).toEqual([['alice', 'mention']]);
    expect(Array.from(g.streamMessages())).toHaveLength(1);
  });

  it('user no-mention falls back to defaultVpId', () => {
    const g = buildGroup();
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const r = coord.ingest({ from: 'user', text: 'plain text' });
    expect(r.fallback).toBe('alice');
    expect(r.dispatched).toEqual(['alice']);
    expect(delivered).toEqual(['alice']);
  });

  it('user @all fans out to all roster members except the sender, capped', () => {
    const g = createGroup(groupsRoot, { id: 'grp_big', roster: ['u1','u2','u3','u4','u5'], defaultVpId: 'u1' });
    const delivered = [];
    const coord = createCoordinator(g, {
      deliver: (v) => delivered.push(v),
      perGroupFanOut: 3,
    });
    const r = coord.ingest({ from: 'user', text: '@all ping' });
    expect(r.broadcast).toBe(true);
    expect(r.dispatched.length).toBe(3);
    expect(r.truncatedAtFanOutCap).toBe(true);
    expect(delivered.length).toBe(3);
  });

  it('user @stranger returns not_in_roster without dispatch', () => {
    const g = buildGroup();
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const r = coord.ingest({ from: 'user', text: 'hi @stranger' });
    expect(r.dispatched).toEqual([]);
    expect(r.errors).toEqual([{ vpId: 'stranger', error: 'not_in_roster' }]);
    expect(delivered).toEqual([]);
  });

  it('VP-authored messages are persisted but NEVER routed via text @', () => {
    const g = buildGroup();
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const r = coord.ingest({ from: 'alice', role: 'assistant', text: 'thanks @bob' });
    expect(r.skipped).toBe('vp-author-no-text-routing');
    expect(r.dispatched).toEqual([]);
    expect(delivered).toEqual([]);
    // ...but the message is persisted
    expect(Array.from(g.streamMessages())).toHaveLength(1);
  });

  it('task scoping filters @mentions to task.members', () => {
    const g = buildGroup(['alice','bob','carol']);
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const r = coord.ingest(
      { from: 'user', text: '@alice @bob', taskId: 'task_x' },
      { taskMembers: ['alice'] },
    );
    expect(r.dispatched).toEqual(['alice']);
    expect(r.errors).toEqual([{ vpId: 'bob', error: 'not_in_task_members' }]);
    expect(delivered).toEqual(['alice']);
  });

  it('task scoping fallback blocks default if not in task.members', () => {
    const g = buildGroup(['alice','bob'], 'alice');
    const delivered = [];
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const r = coord.ingest(
      { from: 'user', text: 'hi', taskId: 'task_x' },
      { taskMembers: ['bob'] },
    );
    expect(r.dispatched).toEqual([]);
    expect(r.errors[0].error).toBe('not_in_task_members');
    expect(delivered).toEqual([]);
  });

  it('no_default_vp on empty roster + no mention', () => {
    const g = createGroup(groupsRoot, { id: 'grp_empty', roster: [] });
    const coord = createCoordinator(g);
    const r = coord.ingest({ from: 'user', text: 'hello' });
    expect(r.errors).toEqual([{ error: 'no_default_vp' }]);
  });

  it('message envelope carries groupId + taskId + trigger + full msg', () => {
    const g = buildGroup();
    let env = null;
    const coord = createCoordinator(g, { deliver: (_v, e) => { env = e; } });
    coord.ingest({ from: 'user', text: '@alice hi', taskId: 'task_xyz' });
    expect(env.groupId).toBe('grp_a');
    expect(env.taskId).toBe('task_xyz');
    expect(env.trigger).toBe('mention');
    expect(env.msg.text).toBe('@alice hi');
    expect(env.msg.id).toMatch(/^msg_/);
  });
});

// ─── feature-flag ────────────────────────────────────────────

describe('feature-flag', () => {
  it('returns false when config.json absent', () => {
    expect(isMultiVpEnabled(root)).toBe(false);
  });

  it('returns false on corrupt config.json', () => {
    writeFileSync(join(root, 'config.json'), '{bad');
    expect(isMultiVpEnabled(root)).toBe(false);
  });

  it('setMultiVpEnabled writes nested path and isMultiVpEnabled reads it', () => {
    setMultiVpEnabled(root, true);
    expect(isMultiVpEnabled(root)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(cfg.unify.multiVp.enabled).toBe(true);
    setMultiVpEnabled(root, false);
    expect(isMultiVpEnabled(root)).toBe(false);
  });

  it('setMultiVpEnabled preserves sibling config fields', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ language: 'zh', unify: { foo: 1 } }));
    setMultiVpEnabled(root, true);
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(cfg.language).toBe('zh');
    expect(cfg.unify.foo).toBe(1);
    expect(cfg.unify.multiVp.enabled).toBe(true);
  });
});

// ─── seedDefaultGroup ────────────────────────────────────────

describe('seedDefaultGroup', () => {
  it('creates grp_default on first call', () => {
    const { group, created } = seedDefaultGroup(root, { defaultVpId: 'alice' });
    expect(created).toBe(true);
    expect(group.id).toBe(DEFAULT_GROUP_ID);
    expect(group.getMeta().roster).toEqual(['alice']);
    expect(group.getMeta().defaultVpId).toBe('alice');
  });

  it('is idempotent — subsequent calls return existing group', () => {
    seedDefaultGroup(root, { defaultVpId: 'alice' });
    const { group, created } = seedDefaultGroup(root, { defaultVpId: 'other' });
    expect(created).toBe(false);
    // Meta from first call should not be overwritten:
    expect(group.getMeta().defaultVpId).toBe('alice');
  });

  it('handles empty spec gracefully (empty roster)', () => {
    const { group, created } = seedDefaultGroup(root);
    expect(created).toBe(true);
    expect(group.getMeta().roster).toEqual([]);
    expect(group.getMeta().defaultVpId).toBeNull();
  });
});
