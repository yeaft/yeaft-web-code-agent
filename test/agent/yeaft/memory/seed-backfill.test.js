/**
 * memory/seed-backfill.test.js — Pin the surviving contract from
 * `seed-backfill.js`: the VP-stub marker and the `archiveLegacyScopes`
 * one-shot migration helper.
 *
 * Why this file shrank (2026-06-09 — VP per-session isolation):
 *   The previous `backfillVpSummaries` / `backfillGroupSummaries` /
 *   `migrateLegacyVpSummaries` / `runSummaryBackfill` helpers wrote
 *   `summary.md` into BARE paths (`vp/<id>/`, `group/<sid>/`) at the
 *   memory root. The Engine actually reads
 *   `group/<sessionId>/vp/<id>/summary.md` (kind:'group-vp'), so the
 *   backfill produced orphan files no consumer ever loaded.
 *
 *   Per user directive ("VP per-session isolation + clean up dead
 *   backfill code"), those exports were deleted. The marker + stub
 *   detector and `archiveLegacyScopes` survived because they ARE wired
 *   to live code paths (`engine.js#buildResidentEntries` and
 *   `session.js#boot` respectively).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isVpSeedBackfillStub,
  VP_STUB_MARKER,
  archiveLegacyScopes,
} from '../../../../agent/yeaft/memory/seed-backfill.js';

let tmpRoot;
let memoryRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'seed-backfill-'));
  memoryRoot = join(tmpRoot, 'memory');
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isVpSeedBackfillStub', () => {
  it('returns true for a body that carries the marker', () => {
    const body = `${VP_STUB_MARKER}\n\n# Alice\n\n**Role:** PM`;
    expect(isVpSeedBackfillStub(body)).toBe(true);
  });

  it('returns false for an empty / nullish / wrong-shape input', () => {
    expect(isVpSeedBackfillStub('')).toBe(false);
    expect(isVpSeedBackfillStub(null)).toBe(false);
    expect(isVpSeedBackfillStub(undefined)).toBe(false);
    expect(isVpSeedBackfillStub(42)).toBe(false);
  });

  it('returns false for a real Dream-v2 summary lacking the marker', () => {
    const dreamLike = '# Alice\n\nLast week: pushed back on AMS resident dedup.';
    expect(isVpSeedBackfillStub(dreamLike)).toBe(false);
  });

  it('returns true when the marker appears anywhere in the body (e.g. trailing)', () => {
    const body = `# Alice\n\nbody\n\n${VP_STUB_MARKER}\n`;
    expect(isVpSeedBackfillStub(body)).toBe(true);
  });
});

describe('archiveLegacyScopes', () => {
  it('moves top-level vp/ feature/ topic/ dirs into .legacy/', () => {
    mkdirSync(join(memoryRoot, 'vp', 'alice'), { recursive: true });
    writeFileSync(join(memoryRoot, 'vp', 'alice', 'summary.md'), 'old', 'utf-8');
    mkdirSync(join(memoryRoot, 'feature', 'auth'), { recursive: true });
    mkdirSync(join(memoryRoot, 'topic', 'tech'), { recursive: true });

    const r = archiveLegacyScopes(memoryRoot);
    expect(r.moved.sort()).toEqual(['feature', 'topic', 'vp']);

    expect(existsSync(join(memoryRoot, 'vp'))).toBe(false);
    expect(existsSync(join(memoryRoot, 'feature'))).toBe(false);
    expect(existsSync(join(memoryRoot, 'topic'))).toBe(false);
    expect(existsSync(join(memoryRoot, '.legacy', 'vp', 'alice', 'summary.md'))).toBe(true);
  });

  it('is idempotent — second call is a no-op when nothing remains', () => {
    mkdirSync(join(memoryRoot, 'vp', 'alice'), { recursive: true });
    const r1 = archiveLegacyScopes(memoryRoot);
    expect(r1.moved).toEqual(['vp']);
    const r2 = archiveLegacyScopes(memoryRoot);
    expect(r2.moved).toEqual([]);
  });

  it('timestamps a second move if .legacy/<kind>/ already exists', () => {
    mkdirSync(join(memoryRoot, '.legacy', 'vp'), { recursive: true });
    writeFileSync(join(memoryRoot, '.legacy', 'vp', 'sentinel'), 'old', 'utf-8');
    mkdirSync(join(memoryRoot, 'vp', 'newone'), { recursive: true });
    const r = archiveLegacyScopes(memoryRoot);
    expect(r.moved).toEqual(['vp']);
    // The pre-existing `.legacy/vp/sentinel` is preserved.
    expect(existsSync(join(memoryRoot, '.legacy', 'vp', 'sentinel'))).toBe(true);
    // Newly archived dir lives under a timestamped sibling.
    const siblings = readdirSync(join(memoryRoot, '.legacy'));
    const timestamped = siblings.find((n) => n.startsWith('vp.') && n !== 'vp');
    expect(timestamped).toBeTruthy();
    expect(existsSync(join(memoryRoot, '.legacy', timestamped, 'newone'))).toBe(true);
  });

  it('returns empty moved[] when memoryRoot does not exist', () => {
    const r = archiveLegacyScopes(join(tmpRoot, 'nope'));
    expect(r.moved).toEqual([]);
  });
});
