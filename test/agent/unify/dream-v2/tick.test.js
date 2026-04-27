/**
 * Phase 6 — dream tick (DESIGN.md §9.14).
 *
 * Pin the per-scope diff-gate behaviour, error isolation, force flag,
 * cursor-on-success-only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDreamTick } from '../../../../agent/unify/dream-v2/tick.js';
import { readCursor, writeCursor } from '../../../../agent/unify/dream-v2/diff-gate.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-tick-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const scopes = () => [
  { kind: 'group', id: 'eng', scopeDir: 'groups/eng' },
  { kind: 'user', scopeDir: 'user' },
];

describe('runDreamTick', () => {
  it('throws on bad inputs', async () => {
    await expect(runDreamTick({})).rejects.toThrow(/root required/);
    await expect(runDreamTick({ root })).rejects.toThrow(/scopes array required/);
    await expect(runDreamTick({ root, scopes: [] })).rejects.toThrow(/refresh fn required/);
  });

  it('runs every scope on first pass (no_cursor)', async () => {
    const refresh = vi.fn(async () => {});
    const out = await runDreamTick({
      root, scopes: scopes(), refresh,
      computeSig: async (s) => `sig-${s.scopeDir}`,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(out.ran).toEqual([
      { scopeDir: 'groups/eng', reason: 'no_cursor' },
      { scopeDir: 'user', reason: 'no_cursor' },
    ]);
    expect(out.skipped).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('skips scopes whose signature is unchanged', async () => {
    // Pre-seed cursors so no_diff fires.
    await writeCursor({ root, scopeDir: 'groups/eng', sig: 'sig-groups/eng' });
    await writeCursor({ root, scopeDir: 'user', sig: 'sig-user' });
    const refresh = vi.fn(async () => {});
    const out = await runDreamTick({
      root, scopes: scopes(), refresh,
      computeSig: async (s) => `sig-${s.scopeDir}`,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(out.ran).toEqual([]);
    expect(out.skipped.map(s => s.scopeDir)).toEqual(['groups/eng', 'user']);
  });

  it('runs only the diffed scopes', async () => {
    await writeCursor({ root, scopeDir: 'groups/eng', sig: 'old' });
    await writeCursor({ root, scopeDir: 'user', sig: 'sig-user' });
    const refresh = vi.fn(async () => {});
    const out = await runDreamTick({
      root, scopes: scopes(), refresh,
      computeSig: async (s) => `sig-${s.scopeDir}`,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(out.ran.map(r => r.scopeDir)).toEqual(['groups/eng']);
    expect(out.skipped.map(s => s.scopeDir)).toEqual(['user']);
  });

  it('force=true ignores diff-gate', async () => {
    await writeCursor({ root, scopeDir: 'groups/eng', sig: 'sig-groups/eng' });
    await writeCursor({ root, scopeDir: 'user', sig: 'sig-user' });
    const refresh = vi.fn(async () => {});
    const out = await runDreamTick({
      root, scopes: scopes(), refresh, force: true,
      computeSig: async (s) => `sig-${s.scopeDir}`,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(out.ran.every(r => r.reason === 'forced')).toBe(true);
  });

  it('captures per-scope errors and continues', async () => {
    const refresh = vi.fn(async (scope) => {
      if (scope.scopeDir === 'groups/eng') throw new Error('boom');
    });
    const out = await runDreamTick({
      root, scopes: scopes(), refresh,
      computeSig: async (s) => `sig-${s.scopeDir}`,
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].scopeDir).toBe('groups/eng');
    expect(out.errors[0].error.message).toBe('boom');
    expect(out.ran.map(r => r.scopeDir)).toEqual(['user']);
    // Cursor MUST NOT advance for the failed scope (so next tick retries).
    const cur = await readCursor({ root, scopeDir: 'groups/eng' });
    expect(cur.lastSeenSig).toBeNull();
  });

  it('writes cursor with post-refresh sig (refresh changed the scope)', async () => {
    let count = 0;
    const out = await runDreamTick({
      root, scopes: [{ kind: 'group', id: 'eng', scopeDir: 'groups/eng' }],
      refresh: async () => { count += 1; },
      computeSig: async () => `sig-${count}`,
      now: () => '2026-04-27T01:00:00Z',
    });
    expect(out.ran).toHaveLength(1);
    const cur = await readCursor({ root, scopeDir: 'groups/eng' });
    // The first call was sig-0 (count==0), refresh ran (count==1),
    // post-refresh sig is sig-1; that's what gets persisted.
    expect(cur.lastSeenSig).toBe('sig-1');
    expect(cur.lastTickAt).toBe('2026-04-27T01:00:00Z');
  });

  it('skips scope entries with no scopeDir', async () => {
    const refresh = vi.fn(async () => {});
    const out = await runDreamTick({
      root,
      scopes: [{ kind: 'user' }, null, { scopeDir: 'groups/eng' }],
      refresh,
      computeSig: async () => 'x',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(out.ran).toEqual([{ scopeDir: 'groups/eng', reason: 'no_cursor' }]);
  });
});
