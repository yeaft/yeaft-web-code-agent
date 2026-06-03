/**
 * store-v2.test.js — group-isolated memory layout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
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
  seedSummaryIfMissing,
  ensureScope,
  listScopes,
  SCOPE_KINDS,
} from '../../../agent/yeaft/memory/store-v2.js';

describe('store-v2: SCOPE_KINDS contract', () => {
  it('exposes the group-isolated scope kinds, frozen', () => {
    expect(SCOPE_KINDS).toEqual([
      'user', 'group', 'group-user', 'group-vp', 'group-feature', 'group-topic', 'chat', 'chat-vp',
    ]);
    expect(Object.isFrozen(SCOPE_KINDS)).toBe(true);
  });
});

describe('A. scopeDir', () => {
  it('user → "user"', () => {
    expect(scopeDir({ kind: 'user' })).toBe('user');
  });
  it('group → "group/<id>"', () => {
    expect(scopeDir({ kind: 'group', id: 'g-eng' })).toBe('group/g-eng');
  });
  it('group-user → "group/<g>/user"', () => {
    expect(scopeDir({ kind: 'group-user', groupId: 'g1' })).toBe('group/g1/user');
  });
  it('group-vp → "group/<g>/vp/<id>"', () => {
    expect(scopeDir({ kind: 'group-vp', groupId: 'g1', id: 'zhang-san' }))
      .toBe('group/g1/vp/zhang-san');
  });
  it('group-feature → "group/<g>/feature/<id>"', () => {
    expect(scopeDir({ kind: 'group-feature', groupId: 'g1', id: 'abc-123' }))
      .toBe('group/g1/feature/abc-123');
  });
  it('group-topic 1-level → "group/<g>/topic/<l1>"', () => {
    expect(scopeDir({ kind: 'group-topic', groupId: 'g1', path: ['work'] }))
      .toBe('group/g1/topic/work');
  });
  it('group-topic 2-level → "group/<g>/topic/<l1>/<l2>"', () => {
    expect(scopeDir({ kind: 'group-topic', groupId: 'g1', path: ['science', 'physics'] }))
      .toBe('group/g1/topic/science/physics');
  });
  it('group-topic CJK in path is allowed', () => {
    expect(scopeDir({ kind: 'group-topic', groupId: 'g1', path: ['科学', '物理'] }))
      .toBe('group/g1/topic/科学/物理');
  });
  it('throws on legacy root vp kind', () => {
    expect(() => scopeDir({ kind: 'vp', id: 'x' })).toThrow(/unknown kind/);
  });
  it('throws on legacy root feature/topic kinds', () => {
    expect(() => scopeDir({ kind: 'feature', id: 'x' })).toThrow(/unknown kind/);
    expect(() => scopeDir({ kind: 'topic', path: ['x'] })).toThrow(/unknown kind/);
  });
});

describe('B. scopeDir rejection paths', () => {
  it('throws on missing scope', () => {
    expect(() => scopeDir(null)).toThrow();
  });
  it('throws when group/group-vp/group-feature lack id', () => {
    expect(() => scopeDir({ kind: 'group' })).toThrow();
    expect(() => scopeDir({ kind: 'group-vp', groupId: 'g' })).toThrow();
    expect(() => scopeDir({ kind: 'group-feature', groupId: 'g' })).toThrow();
  });
  it('throws when group-* lacks groupId', () => {
    expect(() => scopeDir({ kind: 'group-user' })).toThrow();
    expect(() => scopeDir({ kind: 'group-vp', id: 'v' })).toThrow();
    expect(() => scopeDir({ kind: 'group-topic', path: ['a'] })).toThrow();
  });
  it('throws on group-topic with no path', () => {
    expect(() => scopeDir({ kind: 'group-topic', groupId: 'g' })).toThrow();
  });
  it('throws on group-topic path exceeding 2 levels', () => {
    expect(() => scopeDir({ kind: 'group-topic', groupId: 'g', path: ['a', 'b', 'c'] }))
      .toThrow(/1 or 2 segments/);
  });
  it('throws on path-traversal segments', () => {
    expect(() => scopeDir({ kind: 'group-vp', groupId: 'g', id: '..' })).toThrow();
    expect(() => scopeDir({ kind: 'group-topic', groupId: 'g', path: ['..', 'foo'] })).toThrow();
  });
  it('throws on separator in segment', () => {
    expect(() => scopeDir({ kind: 'group-vp', groupId: 'g', id: 'a/b' })).toThrow();
    expect(() => scopeDir({ kind: 'group-topic', groupId: 'g', path: ['a/b'] })).toThrow();
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
    const scope = { kind: 'group-topic', groupId: 'g1', path: ['life', 'parenting'] };
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
      expect(f.includes('.tmp.')).toBe(false);
    }
  });

  it('append concatenates without overwriting prior content', async () => {
    const scope = { kind: 'group-feature', groupId: 'g1', id: 'f-1' };
    await writeMemory(scope, 'L1\n', { root });
    await appendMemory(scope, 'L2\n', { root });
    await appendMemory(scope, 'L3\n', { root });
    expect(await readMemory(scope, { root })).toBe('L1\nL2\nL3\n');
  });

  it('append on missing file creates the file', async () => {
    const scope = { kind: 'group-feature', groupId: 'g1', id: 'f-fresh' };
    await appendMemory(scope, 'first\n', { root });
    expect(await readMemory(scope, { root })).toBe('first\n');
  });

  it('append empty string is a no-op', async () => {
    const scope = { kind: 'group-feature', groupId: 'g1', id: 'f-empty' };
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
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'zhang-san' };
    await writeSummary(scope, '   one-liner.   \n', { root });
    expect(await readSummary(scope, { root })).toBe('one-liner.');
    const onDisk = readFileSync(
      join(root, 'group', 'g1', 'vp', 'zhang-san', 'summary.md'), 'utf8');
    expect(onDisk).toBe('one-liner.\n');
  });
  it('writeSummary("") writes "\\n"', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'li-si' };
    await writeSummary(scope, '', { root });
    const onDisk = readFileSync(
      join(root, 'group', 'g1', 'vp', 'li-si', 'summary.md'), 'utf8');
    expect(onDisk).toBe('\n');
    expect(await readSummary(scope, { root })).toBe('');
  });

  it('writes Chinese summaries to summary.zh.md and falls back to summary.md when missing', async () => {
    const scope = { kind: 'group', id: 'g-zh' };
    await writeSummary(scope, 'English fallback', { root });
    expect(await readSummary(scope, { root, language: 'zh-CN' })).toBe('English fallback');

    await writeSummary(scope, '中文摘要', { root, language: 'zh-CN' });
    expect(readFileSync(join(root, 'group', 'g-zh', 'summary.md'), 'utf8')).toBe('English fallback\n');
    expect(readFileSync(join(root, 'group', 'g-zh', 'summary.zh.md'), 'utf8')).toBe('中文摘要\n');
    expect(await readSummary(scope, { root, language: 'zh-CN' })).toBe('中文摘要');
    expect(await readSummary(scope, { root, language: 'en' })).toBe('English fallback');
  });

  it('unknown summary language uses the English summary.md path', async () => {
    const scope = { kind: 'group', id: 'g-unknown' };
    await writeSummary(scope, 'fallback summary', { root, language: 'fr' });
    expect(readFileSync(join(root, 'group', 'g-unknown', 'summary.md'), 'utf8')).toBe('fallback summary\n');
    expect(await readSummary(scope, { root, language: 'fr' })).toBe('fallback summary');
  });

  it('seedSummaryIfMissing writes when summary.md is absent', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'seedy' };
    const seeded = await seedSummaryIfMissing(scope, 'seed body', { root });
    expect(seeded).toBe(true);
    expect(await readSummary(scope, { root })).toBe('seed body');
  });

  it('seedSummaryIfMissing is a no-op when a non-empty summary.md exists', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'protected' };
    await writeSummary(scope, 'KEEP ME', { root });
    const seeded = await seedSummaryIfMissing(scope, 'overwrite attempt', { root });
    expect(seeded).toBe(false);
    expect(await readSummary(scope, { root })).toBe('KEEP ME');
  });

  it('seedSummaryIfMissing rewrites an empty summary.md', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'empty-existing' };
    await writeSummary(scope, '', { root });
    const seeded = await seedSummaryIfMissing(scope, 'fresh seed', { root });
    expect(seeded).toBe(true);
    expect(await readSummary(scope, { root })).toBe('fresh seed');
  });
});

describe('E. VP ACL', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mem-v2-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('isVpForeign matches group/<g>/vp/<other> only', () => {
    expect(isVpForeign('group/g1/vp/A/memory.md', 'A')).toBe(false);
    expect(isVpForeign('group/g1/vp/B/memory.md', 'A')).toBe(true);
    expect(isVpForeign('group/g2/vp/B/memory.md', 'A')).toBe(true);
    expect(isVpForeign('user/memory.md', 'A')).toBe(false);
    expect(isVpForeign('group/g1/memory.md', 'A')).toBe(false);
    expect(isVpForeign('group/g1/feature/f/memory.md', 'A')).toBe(false);
    expect(isVpForeign('group/g1/vp/A', 'A')).toBe(false);
  });

  it('readMemory of group/<g>/vp/<other> with currentVpId throws acl_blocked', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'B' };
    await writeMemory(scope, 'secret', { root });
    await expect(readMemory(scope, { root, currentVpId: 'A' }))
      .rejects.toMatchObject({ code: 'acl_blocked' });
  });

  it('writeMemory of group/<g>/vp/<other> with currentVpId throws acl_blocked', async () => {
    await expect(
      writeMemory({ kind: 'group-vp', groupId: 'g1', id: 'B' }, 'x', { root, currentVpId: 'A' })
    ).rejects.toMatchObject({ code: 'acl_blocked' });
  });

  it('same vp passes', async () => {
    const scope = { kind: 'group-vp', groupId: 'g1', id: 'A' };
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

  it('enumerates user + group/<g>/{user,vp,feature,topic}', async () => {
    await ensureScope({ kind: 'user' }, { root });
    await ensureScope({ kind: 'group', id: 'g-eng' }, { root });
    await ensureScope({ kind: 'group-user', groupId: 'g-eng' }, { root });
    await ensureScope({ kind: 'group-vp', groupId: 'g-eng', id: 'zhang-san' }, { root });
    await ensureScope({ kind: 'group-vp', groupId: 'g-eng', id: 'li-si' }, { root });
    await ensureScope({ kind: 'group-feature', groupId: 'g-eng', id: 'f-1' }, { root });
    await ensureScope({ kind: 'group-topic', groupId: 'g-eng', path: ['science', 'physics'] }, { root });
    await ensureScope({ kind: 'group-topic', groupId: 'g-eng', path: ['life', 'parenting'] }, { root });
    await writeMemory({ kind: 'group-topic', groupId: 'g-eng', path: ['work'] }, '', { root });

    const scopes = await listScopes({ root });
    const sorted = scopes.map(s => JSON.stringify(s)).sort();
    expect(sorted).toEqual([
      JSON.stringify({ kind: 'user' }),
      JSON.stringify({ kind: 'group', id: 'g-eng' }),
      JSON.stringify({ kind: 'group-user', groupId: 'g-eng' }),
      JSON.stringify({ kind: 'group-vp', groupId: 'g-eng', id: 'li-si' }),
      JSON.stringify({ kind: 'group-vp', groupId: 'g-eng', id: 'zhang-san' }),
      JSON.stringify({ kind: 'group-feature', groupId: 'g-eng', id: 'f-1' }),
      JSON.stringify({ kind: 'group-topic', groupId: 'g-eng', path: ['life', 'parenting'] }),
      JSON.stringify({ kind: 'group-topic', groupId: 'g-eng', path: ['science', 'physics'] }),
      JSON.stringify({ kind: 'group-topic', groupId: 'g-eng', path: ['work'] }),
    ].sort());
  });

  it('skips .legacy/ and unsafe segment names', async () => {
    mkdirSync(join(root, 'group', 'g1', 'vp', 'has space'), { recursive: true });
    mkdirSync(join(root, 'group', 'g1', 'vp', 'with@symbol'), { recursive: true });
    mkdirSync(join(root, 'group', 'g1', 'vp', 'ok'), { recursive: true });
    writeFileSync(join(root, 'group', 'g1', 'vp', 'stray.md'), 'x');
    mkdirSync(join(root, '.legacy', 'vp', 'old'), { recursive: true });
    const scopes = await listScopes({ root });
    const sorted = scopes.map(s => JSON.stringify(s)).sort();
    expect(sorted).toEqual([
      JSON.stringify({ kind: 'group', id: 'g1' }),
      JSON.stringify({ kind: 'group-vp', groupId: 'g1', id: 'ok' }),
    ].sort());
  });

  it('1-level topic without memory.md/summary.md is hidden', async () => {
    mkdirSync(join(root, 'group', 'g1', 'topic', 'empty-l1'), { recursive: true });
    const scopes = await listScopes({ root });
    expect(scopes).toEqual([{ kind: 'group', id: 'g1' }]);
  });
});

describe('G. isValidTopic', () => {
  it('accepts 1-level and 2-level group-topic', () => {
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['x'] })).toBe(true);
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['x', 'y'] })).toBe(true);
  });
  it('rejects non-topic kinds', () => {
    expect(isValidTopic({ kind: 'user' })).toBe(false);
    expect(isValidTopic({ kind: 'group-vp', groupId: 'g', id: 'a' })).toBe(false);
  });
  it('rejects missing groupId', () => {
    expect(isValidTopic({ kind: 'group-topic', path: ['x'] })).toBe(false);
  });
  it('rejects empty / overlong paths', () => {
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: [] })).toBe(false);
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['a', 'b', 'c'] })).toBe(false);
  });
  it('rejects unsafe segments', () => {
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['..'] })).toBe(false);
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['a/b'] })).toBe(false);
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: [''] })).toBe(false);
    expect(isValidTopic({ kind: 'group-topic', groupId: 'g', path: ['ok', '..'] })).toBe(false);
  });
});
