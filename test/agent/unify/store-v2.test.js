/**
 * store-v2.test.js/§5/§9 store API.
 *
 * Verifies:
 *   A.  scopeDir for all 5 scope kinds + topic 1/2-level
 *   B.  scopeDir rejects: missing id, missing topic.path, > 2 levels,
 *       path-traversal segments, separator-in-segment
 *   C.  read/write/append memory.md round-trip + atomic write semantics
 *       (.tmp.* files vanish, target updates atomically)
 *   D.  read/write summary.md round-trip + trim-on-read
 *   E.  ACL: vp/<other> blocked when currentVpId set; same vp permitted;
 *       non-vp paths permitted regardless
 *   F.  listScopes enumerates user, vp/*, group/*, feature/*, topic/<l1>,
 *       topic/<l1>/<l2>; ignores non-directories and stray files
 *   G.  isValidTopic: positive + negative cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scopeDir,
  isValidTopic,
  isVpForeign,
  readMemory,
  writeMemory,
  appendMemory,
  readSummary,
  writeSummary,
  ensureScope,
  listScopes,
  SCOPE_KINDS,
} from '../../../agent/unify/memory/store-v2.js';

describe('store-v2: SCOPE_KINDS contract', () => {
  it('exposes the 5 v2 scope kinds, frozen', () => {
    expect(SCOPE_KINDS).toEqual(['user', 'vp', 'group', 'feature', 'topic']);
    expect(Object.isFrozen(SCOPE_KINDS)).toBe(true);
  });
});

describe('A. scopeDir', () => {
  it('user → "user"', () => {
    expect(scopeDir({ kind: 'user' })).toBe('user');
  });
  it('vp → "vp/<id>"', () => {
    expect(scopeDir({ kind: 'vp', id: 'zhang-san' })).toBe('vp/zhang-san');
  });
  it('group → "group/<id>"', () => {
    expect(scopeDir({ kind: 'group', id: 'g-eng' })).toBe('group/g-eng');
  });
  it('feature → "feature/<id>"', () => {
    expect(scopeDir({ kind: 'feature', id: 'abc-123' })).toBe('feature/abc-123');
  });
  it('topic 1-level → "topic/<l1>"', () => {
    expect(scopeDir({ kind: 'topic', path: ['work'] })).toBe('topic/work');
  });
  it('topic 2-level → "topic/<l1>/<l2>"', () => {
    expect(scopeDir({ kind: 'topic', path: ['science', 'physics'] }))
      .toBe('topic/science/physics');
  });
  it('topic CJK in path is allowed', () => {
    expect(scopeDir({ kind: 'topic', path: ['科学', '物理'] }))
      .toBe('topic/科学/物理');
  });
});

describe('B. scopeDir rejection paths', () => {
  it('throws on missing scope', () => {
    expect(() => scopeDir(null)).toThrow();
  });
  it('throws when vp/group/feature lack id', () => {
    expect(() => scopeDir({ kind: 'vp' })).toThrow();
    expect(() => scopeDir({ kind: 'group' })).toThrow();
    expect(() => scopeDir({ kind: 'feature' })).toThrow();
  });
  it('throws on topic with no path', () => {
    expect(() => scopeDir({ kind: 'topic' })).toThrow();
  });
  it('throws on topic path exceeding 2 levels', () => {
    expect(() => scopeDir({ kind: 'topic', path: ['a', 'b', 'c'] })).toThrow(/1 or 2 segments/);
  });
  it('throws on path-traversal segments', () => {
    expect(() => scopeDir({ kind: 'vp', id: '..' })).toThrow();
    expect(() => scopeDir({ kind: 'topic', path: ['..', 'foo'] })).toThrow();
  });
  it('throws on separator in segment', () => {
    expect(() => scopeDir({ kind: 'vp', id: 'a/b' })).toThrow();
    expect(() => scopeDir({ kind: 'topic', path: ['a/b'] })).toThrow();
  });
  it('throws on unknown kind', () => {
    expect(() => scopeDir({ kind: 'mystery' })).toThrow(/unknown kind/);
  });
});

describe('C. memory.md read/write/append', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mem-v2-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('missing memory.md reads as empty string', async () => {
    const txt = await readMemory({ kind: 'user' }, { root });
    expect(txt).toBe('');
  });

  it('write then read round-trip', async () => {
    const scope = { kind: 'topic', path: ['life', 'parenting'] };
    await writeMemory(scope, '# parenting\n\n- tip\n', { root });
    const txt = await readMemory(scope, { root });
    expect(txt).toBe('# parenting\n\n- tip\n');
  });

  it('write is atomic — no .tmp.* leftover', async () => {
    const scope = { kind: 'group', id: 'g-eng' };
    await writeMemory(scope, 'hello', { root });
    const dir = join(root, 'group', 'g-eng');
    const files = readdirSync(dir);
    expect(files).toContain('memory.md');
    for (const f of files) {
      expect(f.startsWith('.tmp.')).toBe(false);
      expect(f.includes('.tmp.')).toBe(false);
    }
  });

  it('append concatenates without overwriting prior content', async () => {
    const scope = { kind: 'feature', id: 'f-1' };
    await writeMemory(scope, 'L1\n', { root });
    await appendMemory(scope, 'L2\n', { root });
    await appendMemory(scope, 'L3\n', { root });
    expect(await readMemory(scope, { root })).toBe('L1\nL2\nL3\n');
  });

  it('append on missing file creates the file', async () => {
    const scope = { kind: 'feature', id: 'f-fresh' };
    await appendMemory(scope, 'first\n', { root });
    expect(await readMemory(scope, { root })).toBe('first\n');
  });

  it('append empty string is a no-op', async () => {
    const scope = { kind: 'feature', id: 'f-empty' };
    await writeMemory(scope, 'x', { root });
    await appendMemory(scope, '', { root });
    expect(await readMemory(scope, { root })).toBe('x');
  });
});

describe('D. summary.md read/write', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mem-v2-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('missing summary.md reads as empty string', async () => {
    expect(await readSummary({ kind: 'user' }, { root })).toBe('');
  });
  it('write then read round-trip with trim', async () => {
    const scope = { kind: 'vp', id: 'zhang-san' };
    await writeSummary(scope, '   one-liner.   \n', { root });
    expect(await readSummary(scope, { root })).toBe('one-liner.');
    // The persisted body always ends with one newline
    const onDisk = readFileSync(join(root, 'vp', 'zhang-san', 'summary.md'), 'utf8');
    expect(onDisk).toBe('one-liner.\n');
  });
  it('writeSummary("") writes "\\n"', async () => {
    const scope = { kind: 'vp', id: 'li-si' };
    await writeSummary(scope, '', { root });
    const onDisk = readFileSync(join(root, 'vp', 'li-si', 'summary.md'), 'utf8');
    expect(onDisk).toBe('\n');
    expect(await readSummary(scope, { root })).toBe('');
  });
});

describe('E. VP ACL', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mem-v2-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('isVpForeign matches vp/<other> only', () => {
    expect(isVpForeign('vp/A/memory.md', 'A')).toBe(false);
    expect(isVpForeign('vp/B/memory.md', 'A')).toBe(true);
    expect(isVpForeign('user/memory.md', 'A')).toBe(false);
    expect(isVpForeign('group/g/memory.md', 'A')).toBe(false);
    expect(isVpForeign('feature/f/memory.md', 'A')).toBe(false);
    expect(isVpForeign('vp/A', 'A')).toBe(false); // no trailing slash, exact match
  });

  it('readMemory of vp/<other> with currentVpId throws acl_blocked', async () => {
    const scope = { kind: 'vp', id: 'B' };
    await writeMemory(scope, 'secret', { root });
    await expect(readMemory(scope, { root, currentVpId: 'A' }))
      .rejects.toMatchObject({ code: 'acl_blocked' });
  });

  it('writeMemory of vp/<other> with currentVpId throws acl_blocked', async () => {
    await expect(
      writeMemory({ kind: 'vp', id: 'B' }, 'x', { root, currentVpId: 'A' })
    ).rejects.toMatchObject({ code: 'acl_blocked' });
  });

  it('same vp passes', async () => {
    const scope = { kind: 'vp', id: 'A' };
    await writeMemory(scope, 'self', { root, currentVpId: 'A' });
    expect(await readMemory(scope, { root, currentVpId: 'A' })).toBe('self');
  });

  it('non-vp scopes ignore currentVpId', async () => {
    const scope = { kind: 'group', id: 'g-eng' };
    await writeMemory(scope, 'shared', { root, currentVpId: 'A' });
    expect(await readMemory(scope, { root, currentVpId: 'A' })).toBe('shared');
  });
});

describe('F. listScopes', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mem-v2-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('empty root → empty list', async () => {
    expect(await listScopes({ root })).toEqual([]);
  });

  it('enumerates all 5 scope kinds with topic 1+2-level', async () => {
    await ensureScope({ kind: 'user' }, { root });
    await ensureScope({ kind: 'vp', id: 'zhang-san' }, { root });
    await ensureScope({ kind: 'vp', id: 'li-si' }, { root });
    await ensureScope({ kind: 'group', id: 'g-eng' }, { root });
    await ensureScope({ kind: 'feature', id: 'f-1' }, { root });
    await ensureScope({ kind: 'topic', path: ['science', 'physics'] }, { root });
    await ensureScope({ kind: 'topic', path: ['life', 'parenting'] }, { root });
    // 1-level topic: marked by the presence of memory.md
    await writeMemory({ kind: 'topic', path: ['work'] }, '', { root });

    const scopes = await listScopes({ root });
    const sorted = scopes.map(s => JSON.stringify(s)).sort();
    expect(sorted).toEqual([
      JSON.stringify({ kind: 'user' }),
      JSON.stringify({ kind: 'vp', id: 'li-si' }),
      JSON.stringify({ kind: 'vp', id: 'zhang-san' }),
      JSON.stringify({ kind: 'group', id: 'g-eng' }),
      JSON.stringify({ kind: 'feature', id: 'f-1' }),
      JSON.stringify({ kind: 'topic', path: ['life', 'parenting'] }),
      JSON.stringify({ kind: 'topic', path: ['science', 'physics'] }),
      JSON.stringify({ kind: 'topic', path: ['work'] }),
    ].sort());
  });

  it('ignores non-directory entries and unsafe segment names', async () => {
    mkdirSync(join(root, 'vp'), { recursive: true });
    writeFileSync(join(root, 'vp', 'stray.md'), 'x');
    // Names containing a path separator can't actually be created via
    // mkdirSync in one segment — but `@`, spaces, and other chars not in
    // [A-Za-z0-9_\-.<CJK>] are rejected by the segment validator.
    mkdirSync(join(root, 'vp', 'has space'), { recursive: true });
    mkdirSync(join(root, 'vp', 'with@symbol'), { recursive: true });
    mkdirSync(join(root, 'vp', 'ok'), { recursive: true });
    const scopes = await listScopes({ root });
    expect(scopes).toEqual([{ kind: 'vp', id: 'ok' }]);
  });

  it('1-level topic without memory.md/summary.md is hidden', async () => {
    // bare topic/<l1> dir with no files → invisible
    mkdirSync(join(root, 'topic', 'empty-l1'), { recursive: true });
    const scopes = await listScopes({ root });
    expect(scopes).toEqual([]);
  });
});

describe('G. isValidTopic', () => {
  it('accepts 1-level and 2-level topics', () => {
    expect(isValidTopic({ kind: 'topic', path: ['x'] })).toBe(true);
    expect(isValidTopic({ kind: 'topic', path: ['x', 'y'] })).toBe(true);
  });
  it('rejects non-topic kinds', () => {
    expect(isValidTopic({ kind: 'user' })).toBe(false);
    expect(isValidTopic({ kind: 'vp', id: 'a' })).toBe(false);
  });
  it('rejects empty / overlong paths', () => {
    expect(isValidTopic({ kind: 'topic', path: [] })).toBe(false);
    expect(isValidTopic({ kind: 'topic', path: ['a', 'b', 'c'] })).toBe(false);
  });
  it('rejects unsafe segments', () => {
    expect(isValidTopic({ kind: 'topic', path: ['..'] })).toBe(false);
    expect(isValidTopic({ kind: 'topic', path: ['a/b'] })).toBe(false);
    expect(isValidTopic({ kind: 'topic', path: [''] })).toBe(false);
    expect(isValidTopic({ kind: 'topic', path: ['ok', '..'] })).toBe(false);
  });
});
