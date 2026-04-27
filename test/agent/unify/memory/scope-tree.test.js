/**
 * Phase 2 — scoped memory tree primitives. Pins the on-disk shape from
 * DESIGN.md §2 (path-keyed entries, atomic writes, ACL on vp-foreign).
 *
 * Tests run inside a per-test temp dir so we never touch the user's real
 * `~/.yeaft/memory`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  scopeDir,
  slugify,
  isoDate,
  entryPathFor,
  createEntry,
  readEntry,
  isVpForeign,
  renderIndex,
  parseIndex,
  readIndex,
  writeIndex,
  upsertIndexRow,
  capIndexRows,
  readSummary,
  writeSummary,
  ensureScopeSync,
  parseEntry,
} from '../../../../agent/unify/memory/scope-tree.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scope-tree-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scopeDir', () => {
  it('maps the four scope kinds to their canonical directories', () => {
    expect(scopeDir({ kind: 'user' })).toBe('user');
    expect(scopeDir({ kind: 'group', id: 'eng' })).toBe('groups/eng');
    expect(scopeDir({ kind: 'vp', id: 'linus' })).toBe('vp/linus');
    expect(scopeDir({ kind: 'task', id: 't_42' })).toBe('tasks/t_42');
  });

  it('throws on unknown kind or missing id', () => {
    expect(() => scopeDir({ kind: 'bogus' })).toThrow();
    expect(() => scopeDir({ kind: 'group' })).toThrow(/requires id/);
  });
});

describe('slugify', () => {
  it('lowercases and dasherises', () => {
    expect(slugify('Deploy Rollback Risk')).toBe('deploy-rollback-risk');
  });
  it('coalesces runs of separators and trims', () => {
    expect(slugify('  --foo___bar.. ')).toBe('foo-bar');
  });
  it('falls back to `entry` for pathological input', () => {
    expect(slugify('')).toBe('entry');
    expect(slugify('!!!')).toBe('entry');
  });
  it('caps at 60 chars', () => {
    const long = 'x'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe('entryPathFor', () => {
  it('builds a date-prefixed slug under entries/', () => {
    const fixedDate = new Date('2026-04-21T12:00:00Z');
    expect(entryPathFor({ kind: 'group', id: 'eng' }, 'Deploy Note', fixedDate))
      .toBe('groups/eng/entries/2026-04-21-deploy-note.md');
  });
});

describe('isoDate', () => {
  it('formats UTC YYYY-MM-DD', () => {
    expect(isoDate(new Date('2026-04-27T22:30:00Z'))).toBe('2026-04-27');
  });
});

describe('createEntry / readEntry', () => {
  it('writes frontmatter + body and reads back identically', async () => {
    const r = await createEntry({
      root,
      scope: { kind: 'group', id: 'eng' },
      title: 'Release Tag Trigger',
      body: 'releases use the release-v0.1.X tag.',
      kind: 'fact',
      tags: ['ops', 'release'],
      date: new Date('2026-04-18T00:00:00Z'),
    });
    expect(r.path).toBe('groups/eng/entries/2026-04-18-release-tag-trigger.md');
    const back = await readEntry(r.path, { root });
    expect(back.frontmatter.title).toBe('Release Tag Trigger');
    expect(back.frontmatter.kind).toBe('fact');
    expect(back.frontmatter.tags).toEqual(['ops', 'release']);
    expect(back.frontmatter.createdAt).toBe('2026-04-18');
    expect(back.body).toBe('releases use the release-v0.1.X tag.');
  });

  it('refuses to overwrite an existing slug (slug_exists)', async () => {
    const args = {
      root,
      scope: { kind: 'user' },
      title: 'preference',
      body: 'first',
      date: new Date('2026-04-21T00:00:00Z'),
    };
    await createEntry(args);
    await expect(createEntry({ ...args, body: 'second' })).rejects.toMatchObject({
      code: 'slug_exists',
    });
  });

  it('readEntry returns null for missing files', async () => {
    const out = await readEntry('groups/eng/entries/missing.md', { root });
    expect(out).toBeNull();
  });
});

describe('isVpForeign / ACL', () => {
  it('flags vp/<other>/ as foreign', () => {
    expect(isVpForeign('vp/linus/entries/foo.md', 'grace')).toBe(true);
  });
  it('does not flag own vp paths', () => {
    expect(isVpForeign('vp/linus/entries/foo.md', 'linus')).toBe(false);
  });
  it('does not flag non-vp paths', () => {
    expect(isVpForeign('groups/eng/entries/foo.md', 'grace')).toBe(false);
    expect(isVpForeign('user/entries/foo.md', 'grace')).toBe(false);
  });
  it('readEntry throws acl_blocked when accessing vp/<other>/', async () => {
    await createEntry({
      root,
      scope: { kind: 'vp', id: 'linus' },
      title: 'private',
      body: 'kernel notes',
      date: new Date('2026-04-25T00:00:00Z'),
    });
    await expect(
      readEntry('vp/linus/entries/2026-04-25-private.md', { root, currentVpId: 'grace' }),
    ).rejects.toMatchObject({ code: 'acl_blocked' });
  });
});

describe('index.md render / parse / round-trip', () => {
  const rows = [
    { path: 'groups/eng/entries/2026-04-18-release-tag-trigger.md', title: 'Release Tag Trigger', tags: ['ops', 'release'], kind: 'fact', updated: '2026-04-18' },
    { path: 'groups/eng/entries/2026-04-25-disagrees-router-design.md', title: 'Linus disagrees with router design', tags: ['opinion'], kind: 'lesson', updated: '2026-04-25' },
    { path: 'groups/eng/entries/2026-04-21-prefers-concise.md', title: 'user prefers concise replies', tags: 'preference,tone', kind: 'preference', updated: '2026-04-21' },
  ];

  it('renders a markdown table with newest first', () => {
    const out = renderIndex({ kind: 'group', id: 'eng' }, rows);
    expect(out).toMatch(/# index — groups\/eng/);
    const newestFirst = out.indexOf('disagrees-router-design');
    const middle = out.indexOf('prefers-concise');
    const oldest = out.indexOf('release-tag-trigger');
    expect(newestFirst).toBeGreaterThan(0);
    expect(newestFirst).toBeLessThan(middle);
    expect(middle).toBeLessThan(oldest);
  });

  it('parses back into rows', () => {
    const text = renderIndex({ kind: 'group', id: 'eng' }, rows);
    const parsed = parseIndex(text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].path).toBe('groups/eng/entries/2026-04-25-disagrees-router-design.md');
    expect(parsed[0].tags).toEqual(['opinion']);
    expect(parsed[2].kind).toBe('fact');
  });

  it('parseIndex skips header / separator / empty rows', () => {
    const out = parseIndex(`# index\n\n| path | title | tags | kind | updated |\n| ---- | ----- | ---- | ---- | ------- |\n| a/b.md | T | t1 | fact | 2026-01-01 |\n`);
    expect(out).toEqual([{ path: 'a/b.md', title: 'T', tags: ['t1'], kind: 'fact', updated: '2026-01-01' }]);
  });
});

describe('writeIndex / readIndex / atomic rewrite', () => {
  it('round-trips through disk', async () => {
    const scope = { kind: 'group', id: 'eng' };
    const rows = [
      { path: 'groups/eng/entries/2026-04-21-a.md', title: 'A', kind: 'fact', updated: '2026-04-21' },
    ];
    await writeIndex(scope, rows, { root });
    const back = await readIndex(scope, { root });
    expect(back).toEqual([{ path: 'groups/eng/entries/2026-04-21-a.md', title: 'A', tags: [], kind: 'fact', updated: '2026-04-21' }]);
  });

  it('readIndex returns [] for cold-start scope', async () => {
    expect(await readIndex({ kind: 'user' }, { root })).toEqual([]);
  });

  it('atomic write leaves no .tmp leftovers', async () => {
    const scope = { kind: 'user' };
    await writeIndex(scope, [{ path: 'user/entries/x.md', title: 'X', updated: '2026-04-27' }], { root });
    // Directory should only contain index.md, no .tmp.* siblings.
    const dir = join(root, 'user');
    const { readdirSync } = await import('fs');
    const files = readdirSync(dir);
    expect(files.some(f => f.includes('.tmp.'))).toBe(false);
    expect(files).toContain('index.md');
  });

  it('upsertIndexRow replaces existing path and prepends new ones', async () => {
    const scope = { kind: 'group', id: 'eng' };
    await writeIndex(scope, [
      { path: 'a.md', title: 'A', updated: '2026-01-01' },
    ], { root });
    await upsertIndexRow(scope, { path: 'b.md', title: 'B', updated: '2026-04-21' }, { root });
    await upsertIndexRow(scope, { path: 'a.md', title: 'A2', updated: '2026-04-25' }, { root });
    const rows = await readIndex(scope, { root });
    // newest first: a.md (2026-04-25) then b.md (2026-04-21)
    expect(rows.map(r => r.path)).toEqual(['a.md', 'b.md']);
    expect(rows[0].title).toBe('A2');
  });
});

describe('capIndexRows', () => {
  it('caps to K rows preserving the order of input', () => {
    const input = Array.from({ length: 250 }, (_, i) => ({ path: `e${i}.md`, title: `t${i}` }));
    expect(capIndexRows(input, 200)).toHaveLength(200);
    expect(capIndexRows(input, 200)[0].path).toBe('e0.md');
  });
  it('returns input copy when under K', () => {
    const input = [{ path: 'a.md', title: 'A' }];
    expect(capIndexRows(input, 10)).toEqual(input);
  });
  it('default K is 200', () => {
    const input = Array.from({ length: 300 }, (_, i) => ({ path: `e${i}.md`, title: `t${i}` }));
    expect(capIndexRows(input)).toHaveLength(200);
  });
});

describe('summary.md round-trip', () => {
  it('writes and reads', async () => {
    const scope = { kind: 'group', id: 'eng' };
    await writeSummary(scope, '  eng team — kernel + release \n', { root });
    expect(await readSummary(scope, { root })).toBe('eng team — kernel + release');
  });

  it('readSummary returns "" when missing', async () => {
    expect(await readSummary({ kind: 'user' }, { root })).toBe('');
  });
});

describe('ensureScopeSync', () => {
  it('creates the scope dir + entries/', () => {
    ensureScopeSync({ kind: 'task', id: 't_99' }, { root });
    expect(existsSync(join(root, 'tasks/t_99/entries'))).toBe(true);
  });
});

describe('parseEntry tolerates files written by hand', () => {
  it('returns body intact when no frontmatter present', () => {
    expect(parseEntry('hello world')).toEqual({ frontmatter: {}, body: 'hello world' });
  });
  it('reads tag arrays', () => {
    const text = '---\ntitle: t\ntags: [a, b, "c with space"]\n---\nbody';
    const out = parseEntry(text);
    expect(out.frontmatter.title).toBe('t');
    expect(out.frontmatter.tags).toEqual(['a', 'b', 'c with space']);
    expect(out.body).toBe('body');
  });
});
