/**
 * dream-v2/segment.test.js — §17
 *
 * Pure functions: truncateMessage, segmentDiff, batchSourcesForApply,
 * needsBatchedApply.
 */

import { describe, it, expect } from 'vitest';
import {
  truncateMessage, segmentDiff, estimateTokens, estimateMessagesTokens,
  batchSourcesForApply, needsBatchedApply,
} from '../../../../agent/yeaft/dream-v2/segment.js';
import { MAX_SINGLE_MESSAGE_CHARS, DREAM_OVERLAP } from '../../../../agent/yeaft/dream-v2/limits.js';

describe('truncateMessage', () => {
  it('passes short bodies through', () => {
    expect(truncateMessage('hello')).toBe('hello');
  });
  it('truncates long bodies and appends notice', () => {
    const big = 'x'.repeat(MAX_SINGLE_MESSAGE_CHARS + 1000);
    const out = truncateMessage(big);
    expect(out.length).toBeLessThanOrEqual(MAX_SINGLE_MESSAGE_CHARS);
    expect(out).toContain('[message truncated for dream');
  });
  it('is idempotent on already-truncated bodies', () => {
    const big = 'x'.repeat(MAX_SINGLE_MESSAGE_CHARS + 1000);
    const a = truncateMessage(big);
    const b = truncateMessage(a);
    expect(a).toBe(b);
  });
});

describe('segmentDiff', () => {
  it('returns [] for empty diff', () => {
    expect(segmentDiff([])).toEqual([]);
  });
  it('returns one segment when total fits', () => {
    const msgs = [{ role: 'user', body: 'hi', id: 'm1' }, { role: 'assistant', body: 'hello', id: 'm2' }];
    const segs = segmentDiff(msgs, 100000);
    expect(segs.length).toBe(1);
    expect(segs[0].overlapCount).toBe(0);
    expect(segs[0].newCount).toBe(2);
  });
  it('splits with 3-message overlap between adjacent segments', () => {
    // 10 messages, ~100 chars each = ~25 tokens each. Cap at ~80 tokens
    // forces multiple segments.
    const msgs = Array.from({ length: 10 }, (_, i) =>
      ({ role: 'user', body: 'x'.repeat(100), id: `m${i + 1}` }));
    const segs = segmentDiff(msgs, 80, 3);
    expect(segs.length).toBeGreaterThan(1);
    // First segment has no overlap.
    expect(segs[0].overlapCount).toBe(0);
    // Subsequent segments have overlap up to 3.
    for (let i = 1; i < segs.length; i += 1) {
      expect(segs[i].overlapCount).toBeGreaterThan(0);
      expect(segs[i].overlapCount).toBeLessThanOrEqual(3);
    }
    // Union of `new` counts equals total messages.
    const totalNew = segs.reduce((acc, s) => acc + s.newCount, 0);
    expect(totalNew).toBe(10);
  });
  it('always advances even when one message exceeds the cap', () => {
    const big = { role: 'user', body: 'x'.repeat(10000), id: 'm-big' };
    const segs = segmentDiff([big], 10);
    expect(segs.length).toBe(1);
    expect(segs[0].newCount).toBe(1);
  });
});

describe('batched apply', () => {
  it('needsBatchedApply respects the cap', () => {
    const merged = {
      memoryMd: 'x'.repeat(20),
      summaryMd: '',
      sources: [{ sessionId: 'g1', diff: [{ role: 'user', body: 'x'.repeat(20) }] }],
    };
    expect(needsBatchedApply(merged, 1000)).toBe(false);
    expect(needsBatchedApply(merged, 2)).toBe(true);
  });
  it('batchSourcesForApply packs sources without exceeding cap', () => {
    const merged = {
      memoryMd: '',
      summaryMd: '',
      sources: [
        { sessionId: 'g1', diff: [{ role: 'user', body: 'x'.repeat(40) }] }, // ~10 tokens
        { sessionId: 'g2', diff: [{ role: 'user', body: 'x'.repeat(40) }] },
        { sessionId: 'g3', diff: [{ role: 'user', body: 'x'.repeat(40) }] },
      ],
    };
    const batches = batchSourcesForApply(merged, 25);
    expect(batches.length).toBeGreaterThan(1);
    // Each batch's sources flatten back to the original ordered sources.
    const flat = batches.flat().map(s => s.sessionId);
    expect(flat).toEqual(['g1', 'g2', 'g3']);
  });
  it('a single oversized source still becomes its own batch', () => {
    const merged = {
      memoryMd: '',
      summaryMd: '',
      sources: [
        { sessionId: 'big', diff: [{ role: 'user', body: 'x'.repeat(4000) }] }, // ~1000 tokens
      ],
    };
    const batches = batchSourcesForApply(merged, 50);
    expect(batches.length).toBe(1);
    expect(batches[0][0].sessionId).toBe('big');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateMessagesTokens([])).toBe(0);
  });
  it('grows with content', () => {
    const t1 = estimateTokens('x'.repeat(8));
    const t2 = estimateTokens('x'.repeat(80));
    expect(t2).toBeGreaterThan(t1);
  });
});
