/**
 * dream-v2-refresh.test.js — PR-J
 *
 * Verifies the real (non-no-op) refresh hook for dream-v2/tick:
 *   J-a  buildScopeSynopsis renders the top-N most-recent rows
 *        as a deterministic markdown bullet list
 *   J-b  empty index ⇒ buildScopeSynopsis returns ''
 *   J-c  createScopeRefreshHook reads index.md and writes summary.md
 *   J-d  cold-start scope (empty index) ⇒ summary.md is NOT touched
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildScopeSynopsis,
  createScopeRefreshHook,
  refToScope,
  DEFAULT_TOP_N,
} from '../../agent/unify/dream-v2/refresh.js';

describe('J-a buildScopeSynopsis renders top-N rows', () => {
  it('orders by updated desc and caps at topN', () => {
    const rows = [
      { path: 'a.md', title: 'Old item',   tags: ['x'], kind: 'fact', updated: '2026-01-01' },
      { path: 'b.md', title: 'New item',   tags: ['y'], kind: 'lesson', updated: '2026-04-01' },
      { path: 'c.md', title: 'Mid item',   tags: [],    kind: 'fact', updated: '2026-02-01' },
    ];
    const out = buildScopeSynopsis({ scopeDir: 'user' }, rows, 2);
    const lines = out.split('\n');
    expect(lines[0]).toBe('# user — recent context');
    // Two bullet rows; the oldest one is excluded by topN=2.
    const bullets = lines.filter(l => l.startsWith('- '));
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain('New item');
    expect(bullets[1]).toContain('Mid item');
    expect(out).not.toContain('Old item');
  });

  it('default topN is 12', () => {
    expect(DEFAULT_TOP_N).toBe(12);
  });
});

describe('J-b empty index ⇒ empty synopsis', () => {
  it('returns empty string for an empty rows array', () => {
    expect(buildScopeSynopsis({ scopeDir: 'user' }, [])).toBe('');
    expect(buildScopeSynopsis({ scopeDir: 'user' }, null)).toBe('');
  });
});

describe('J-c refresh hook writes summary.md from index.md', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-v2-refresh-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('reads index.md and writes summary.md atomically', async () => {
    const userDir = join(root, 'user');
    mkdirSync(userDir, { recursive: true });
    const index = [
      '# index — user',
      '',
      '| path | title | tags | kind | updated |',
      '| ---- | ----- | ---- | ---- | ------- |',
      '| entries/2026-04-01-foo.md | Foo entry | a,b | fact | 2026-04-01 |',
      '| entries/2026-03-01-bar.md | Bar entry |     | lesson | 2026-03-01 |',
      '',
    ].join('\n');
    writeFileSync(join(userDir, 'index.md'), index, 'utf8');

    const refresh = createScopeRefreshHook({ root });
    await refresh({ kind: 'user', scopeDir: 'user' });

    const summary = readFileSync(join(userDir, 'summary.md'), 'utf8');
    expect(summary).toContain('# user — recent context');
    expect(summary).toContain('Foo entry');
    expect(summary).toContain('Bar entry');
    // Newer entry appears before older one.
    expect(summary.indexOf('Foo entry')).toBeLessThan(summary.indexOf('Bar entry'));
  });
});

describe('J-d cold-start scope leaves summary.md alone', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-v2-refresh-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('does not write summary.md when index is empty / missing', async () => {
    const refresh = createScopeRefreshHook({ root });
    await refresh({ kind: 'user', scopeDir: 'user' });

    expect(existsSync(join(root, 'user', 'summary.md'))).toBe(false);
  });

  it('does not overwrite a pre-existing summary.md when index is empty', async () => {
    const userDir = join(root, 'user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'summary.md'), 'PRESERVED\n', 'utf8');

    const refresh = createScopeRefreshHook({ root });
    await refresh({ kind: 'user', scopeDir: 'user' });

    expect(readFileSync(join(userDir, 'summary.md'), 'utf8')).toBe('PRESERVED\n');
  });
});

describe('refToScope translates ScopeRef → Scope', () => {
  it('user', () => { expect(refToScope({ kind: 'user', scopeDir: 'user' })).toEqual({ kind: 'user' }); });
  it('group', () => {
    expect(refToScope({ kind: 'group', id: 'g1', scopeDir: 'groups/g1' }))
      .toEqual({ kind: 'group', id: 'g1' });
  });
  it('throws when group missing id', () => {
    expect(() => refToScope({ kind: 'group', scopeDir: 'groups/' })).toThrow(/id/);
  });
});
