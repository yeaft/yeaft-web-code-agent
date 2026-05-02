/**
 * ams-budget.test.js — H2.b AMS + budget + summary-store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeBudget, approxTokens, packWithinBudget,
  ABSOLUTE_CAP, MODEL_FRACTION,
} from '../../../../agent/unify/memory/budget.js';
import { ActiveMemorySet } from '../../../../agent/unify/memory/ams.js';
import { makeSegment } from '../../../../agent/unify/memory/segment.js';
import {
  readSummary, writeSummary, summaryPath,
} from '../../../../agent/unify/memory/summary-store.js';

let TEST_DIR;
beforeEach(() => { TEST_DIR = mkdtempSync(join(tmpdir(), 'h2b-')); });
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {} });

describe('budget.computeBudget', () => {
  it('caps at ABSOLUTE_CAP for huge model contexts', () => {
    const b = computeBudget(1_000_000);
    expect(b.total).toBe(ABSOLUTE_CAP);
  });

  it('uses MODEL_FRACTION for small model contexts', () => {
    const b = computeBudget(200_000);
    expect(b.total).toBe(40_000);
  });

  it('splits into resident/recent/onDemand', () => {
    const b = computeBudget(200_000);
    expect(b.resident + b.recent + b.onDemand).toBeLessThanOrEqual(b.total);
    expect(b.resident).toBeGreaterThan(b.recent);
    expect(b.onDemand).toBeGreaterThan(b.recent);
  });

  it('falls back when modelMaxContext invalid', () => {
    const b = computeBudget(0);
    expect(b.total).toBeGreaterThan(0);
  });

  it('honours custom ratio', () => {
    const b = computeBudget(100_000, { resident: 0.6, recent: 0.2, onDemand: 0.2 });
    expect(b.resident).toBeGreaterThan(b.recent);
    expect(b.recent).toBeCloseTo(b.onDemand, -1);
  });

  it('exposes constants', () => {
    expect(MODEL_FRACTION).toBe(0.20);
    expect(ABSOLUTE_CAP).toBe(100_000);
  });
});

describe('budget.approxTokens', () => {
  it('returns 0 for empty', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens(null)).toBe(0);
  });
  it('counts CJK ~1 per char', () => {
    expect(approxTokens('你好')).toBeGreaterThanOrEqual(2);
  });
  it('counts ascii ~1 per 4 chars', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcdefgh')).toBe(2);
  });
});

describe('budget.packWithinBudget', () => {
  it('packs items greedily within budget', () => {
    const items = [
      { c: 5 }, { c: 10 }, { c: 4 }, { c: 100 }, { c: 1 },
    ];
    const r = packWithinBudget(items, 20, x => x.c);
    expect(r.cost).toBeLessThanOrEqual(20);
    expect(r.picked).toContain(items[0]);
    expect(r.dropped).toContain(items[3]);   // 100 too big
  });
});

describe('ActiveMemorySet', () => {
  function mkAms(opts = {}) {
    return new ActiveMemorySet({
      budget: computeBudget(200_000),
      ...opts,
    });
  }

  it('setResident dedupes by scope', () => {
    const ams = mkAms();
    ams.setResident([
      { scope: 'user', summary: 'a' },
      { scope: 'user', summary: 'A2' },
    ]);
    expect(ams.residentScopes()).toEqual(['user']);
  });

  it('setResident drops foreign vp', () => {
    const ams = mkAms({ ownVpId: 'alice' });
    ams.setResident([
      { scope: 'user', summary: 'u' },
      { scope: 'vp/alice', summary: 'a' },
      { scope: 'vp/bob', summary: 'b' },
    ]);
    expect(ams.residentScopes().sort()).toEqual(['user', 'vp/alice']);
  });

  it('touchRecent maintains LRU order', () => {
    const ams = mkAms({ recentCapacity: 2 });
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'B' });
    const c = makeSegment({ scope: 'user', kind: 'fact', body: 'C' });
    ams.touchRecent(a);
    ams.touchRecent(b);
    ams.touchRecent(c);            // evicts a
    expect(ams.recentIds()).toEqual([b.id, c.id]);
    ams.touchRecent(b);             // moves b to most-recent
    expect(ams.recentIds()).toEqual([c.id, b.id]);
  });

  it('setOnDemand drops foreign vp segs', () => {
    const ams = mkAms({ ownVpId: 'alice' });
    const own = makeSegment({ scope: 'vp/alice', kind: 'fact', body: 'a' });
    const foreign = makeSegment({ scope: 'vp/bob', kind: 'fact', body: 'b' });
    ams.setOnDemand([own, foreign]);
    expect(ams.onDemandIds()).toEqual([own.id]);
  });

  it('addOnDemand + removeOnDemand work bidirectionally', () => {
    const ams = mkAms();
    const a = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    const b = makeSegment({ scope: 'user', kind: 'fact', body: 'B' });
    ams.setOnDemand([a]);
    ams.addOnDemand([b]);
    expect(ams.onDemandIds()).toEqual([a.id, b.id]);
    ams.removeOnDemand([a.id]);
    expect(ams.onDemandIds()).toEqual([b.id]);
  });

  it('snapshot honours budget — drops overflow', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 100, resident: 40, recent: 20, onDemand: 40 },
    });
    // resident: 3 items, each 20 tokens → fits 2
    ams.setResident([
      { scope: 'user', summary: 'x'.repeat(80) },              // 20 tok
      { scope: 'group/g1', summary: 'y'.repeat(80) },           // 20 tok
      { scope: 'feature/f1', summary: 'z'.repeat(80) },         // 20 tok → drop
    ]);
    const snap = ams.snapshot();
    expect(snap.resident).toHaveLength(2);
    expect(snap.usage.resident).toBeLessThanOrEqual(40);
  });

  it('snapshot returns full picked layers + usage', () => {
    const ams = mkAms();
    ams.setResident([{ scope: 'user', summary: 'hi' }]);
    const seg = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    ams.touchRecent(seg);
    ams.setOnDemand([seg]);
    const snap = ams.snapshot();
    expect(snap.resident).toHaveLength(1);
    expect(snap.recent).toHaveLength(1);
    expect(snap.onDemand).toHaveLength(1);
    expect(snap.usage.total).toBeGreaterThan(0);
  });

  it('size() counts all three layers', () => {
    const ams = mkAms();
    ams.setResident([{ scope: 'user', summary: 'x' }]);
    const seg = makeSegment({ scope: 'user', kind: 'fact', body: 'A' });
    ams.touchRecent(seg);
    ams.setOnDemand([seg]);
    expect(ams.size()).toBe(3);
  });
});

describe('summary-store', () => {
  it('writeSummary + readSummary round-trips', () => {
    writeSummary(TEST_DIR, 'user', 'User uses zsh and prefers vim keybindings.');
    expect(readSummary(TEST_DIR, 'user')).toBe('User uses zsh and prefers vim keybindings.');
  });

  it('readSummary returns empty when missing', () => {
    expect(readSummary(TEST_DIR, 'nonexistent/path')).toBe('');
  });

  it('writeSummary creates nested dirs', () => {
    writeSummary(TEST_DIR, 'topic/lang/js', 'JS notes');
    expect(readSummary(TEST_DIR, 'topic/lang/js')).toBe('JS notes');
  });

  it('writeSummary writes a metadata header', () => {
    writeSummary(TEST_DIR, 'user', 'hi');
    const raw = readFileSync(summaryPath(TEST_DIR, 'user'), 'utf8');
    expect(raw).toMatch(/<!-- updatedAt: /);
    expect(raw).toContain('hi');
  });

  it('writeSummary("") wipes content but keeps file', () => {
    writeSummary(TEST_DIR, 'user', 'hi');
    writeSummary(TEST_DIR, 'user', '');
    expect(readSummary(TEST_DIR, 'user')).toBe('');
  });
});
