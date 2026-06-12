/**
 * dream/snapshot.test.js — §16.3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { snapshotScope, pruneOldSnapshots, tsForBackup, BACKUP_DIRNAME } from '../../../../agent/yeaft/dream/snapshot.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-snap-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('snapshotScope', () => {
  it('copies memory.md + summary.md when present', async () => {
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(join(root, 'user', 'memory.md'), 'mem');
    writeFileSync(join(root, 'user', 'summary.md'), 'sum');
    const r = await snapshotScope(root, 'TS', 'user');
    expect(r.copied.sort()).toEqual(['memory.md', 'summary.md']);
    expect(readFileSync(join(root, BACKUP_DIRNAME, 'TS', 'user', 'memory.md'), 'utf8')).toBe('mem');
  });
  it('creates empty backup dir when source is missing', async () => {
    const r = await snapshotScope(root, 'TS', 'topic/new/path');
    expect(r.copied).toEqual([]);
    expect(existsSync(join(root, BACKUP_DIRNAME, 'TS', 'topic', 'new', 'path'))).toBe(true);
  });
});

describe('pruneOldSnapshots', () => {
  it('keeps the N newest', async () => {
    for (let i = 1; i <= 10; i += 1) {
      mkdirSync(join(root, BACKUP_DIRNAME, `2026-04-28T0${i}-00-00-000Z`), { recursive: true });
    }
    const r = await pruneOldSnapshots(root, 3);
    expect(r.kept.length).toBe(3);
    expect(r.removed.length).toBe(7);
    const remaining = readdirSync(join(root, BACKUP_DIRNAME)).sort();
    expect(remaining.length).toBe(3);
  });
  it('no-op when fewer than N', async () => {
    mkdirSync(join(root, BACKUP_DIRNAME, '2026-01-01T00-00-00-000Z'), { recursive: true });
    const r = await pruneOldSnapshots(root, 7);
    expect(r.removed.length).toBe(0);
    expect(r.kept.length).toBe(1);
  });
  it('no-op when backup dir absent', async () => {
    const r = await pruneOldSnapshots(root, 5);
    expect(r).toEqual({ kept: [], removed: [] });
  });
});

describe('tsForBackup', () => {
  it('returns a filesystem-safe ISO string', () => {
    const ts = tsForBackup(new Date('2026-04-28T03:07:00.000Z'));
    expect(ts).toBe('2026-04-28T03-07-00-000Z');
  });
});
