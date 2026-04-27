/**
 * Phase 6 — diff-gate (DESIGN.md §9.14).
 *
 * Cursor read/write atomic, shouldRunDream is a pure decision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cursorPath,
  readCursor,
  writeCursor,
  shouldRunDream,
} from '../../../../agent/unify/dream-v2/diff-gate.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'diff-gate-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('cursorPath', () => {
  it('builds canonical path', () => {
    expect(cursorPath('/r', 'groups/eng')).toBe('/r/groups/eng/.dream-cursor.json');
  });
});

describe('readCursor', () => {
  it('returns nulls when missing', async () => {
    expect(await readCursor({ root, scopeDir: 'groups/eng' }))
      .toEqual({ lastTickAt: null, lastSeenSig: null });
  });

  it('returns parsed values', async () => {
    await writeCursor({ root, scopeDir: 'groups/eng', sig: 'abc', tickAt: '2026-04-27T00:00:00Z' });
    const out = await readCursor({ root, scopeDir: 'groups/eng' });
    expect(out).toEqual({ lastTickAt: '2026-04-27T00:00:00Z', lastSeenSig: 'abc' });
  });

  it('tolerates corrupt cursor file (returns nulls)', async () => {
    mkdirSync(join(root, 'groups/eng'), { recursive: true });
    writeFileSync(join(root, 'groups/eng/.dream-cursor.json'), '{not-json');
    const out = await readCursor({ root, scopeDir: 'groups/eng' });
    expect(out).toEqual({ lastTickAt: null, lastSeenSig: null });
  });
});

describe('writeCursor', () => {
  it('atomic-renames so no .tmp leaks', async () => {
    await writeCursor({ root, scopeDir: 'groups/eng', sig: 's' });
    const dir = join(root, 'groups/eng');
    expect(readdirSync(dir).some(f => f.includes('.tmp.'))).toBe(false);
    expect(readdirSync(dir)).toContain('.dream-cursor.json');
  });
});

describe('shouldRunDream', () => {
  it('runs when no cursor (cold start)', () => {
    expect(shouldRunDream({ lastSeenSig: null }, 'abc'))
      .toEqual({ skip: false, reason: 'no_cursor' });
    expect(shouldRunDream(null, 'abc'))
      .toEqual({ skip: false, reason: 'no_cursor' });
  });

  it('skips when sig unchanged', () => {
    expect(shouldRunDream({ lastSeenSig: 'abc' }, 'abc'))
      .toEqual({ skip: true, reason: 'no_diff' });
  });

  it('runs when sig differs', () => {
    expect(shouldRunDream({ lastSeenSig: 'abc' }, 'xyz'))
      .toEqual({ skip: false, reason: 'diff' });
  });
});
