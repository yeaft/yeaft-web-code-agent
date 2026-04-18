import { describe, it, expect } from 'vitest';
import { smartTruncate } from '../../../agent/crew/routing.js';

const MARKER = '…(truncated, full in feature file)';

describe('smartTruncate (task-330c)', () => {
  // ─── Pass-through (under or at limit) ─────────────────────────────

  it('returns text unchanged when shorter than max', () => {
    expect(smartTruncate('hello world', 400)).toBe('hello world');
  });

  it('returns text unchanged at exactly max length (199 with max=200)', () => {
    const t = 'x'.repeat(199);
    expect(smartTruncate(t, 200)).toBe(t);
    expect(smartTruncate(t, 200)).not.toContain(MARKER);
  });

  it('returns text unchanged at exactly max length (200 with max=200)', () => {
    const t = 'x'.repeat(200);
    expect(smartTruncate(t, 200)).toBe(t);
  });

  // ─── Boundary triggers truncation ────────────────────────────────

  it('truncates when length > max (201 with max=200)', () => {
    const t = 'x'.repeat(201);
    const out = smartTruncate(t, 200);
    expect(out).toContain(MARKER);
    expect(out.length).toBeLessThanOrEqual(200 + MARKER.length);
  });

  it('returns unchanged at 399 with max=400', () => {
    const t = 'x'.repeat(399);
    expect(smartTruncate(t, 400)).toBe(t);
  });

  it('returns unchanged at exactly 400 with max=400', () => {
    const t = 'x'.repeat(400);
    expect(smartTruncate(t, 400)).toBe(t);
  });

  it('truncates at 401 with max=400', () => {
    const t = 'x'.repeat(401);
    const out = smartTruncate(t, 400);
    expect(out).toContain(MARKER);
  });

  // ─── Smart boundary cuts (sentence-aware) ────────────────────────

  it('cuts at the last period in the [70%, 100%) window', () => {
    // Build a string with a clear period in the cut window for max=100.
    // Window = [70, 100). Place a period at index 85.
    const head = 'A'.repeat(85) + '.' + 'B'.repeat(40); // total 126
    const out = smartTruncate(head, 100);
    expect(out.endsWith('.' + MARKER)).toBe(true);
    expect(out).not.toContain('B');
  });

  it('cuts at the last newline in window when no period', () => {
    const head = 'C'.repeat(80) + '\n' + 'D'.repeat(40);
    const out = smartTruncate(head, 100);
    expect(out).toContain(MARKER);
    expect(out).not.toContain('D');
  });

  it('supports Chinese full-width period 。 as boundary', () => {
    const head = '中'.repeat(80) + '。' + '文'.repeat(40);
    const out = smartTruncate(head, 100);
    expect(out).toContain('。' + MARKER);
    expect(out).not.toContain('文');
  });

  it('supports !? boundaries', () => {
    const head = 'X'.repeat(80) + '!' + 'Y'.repeat(40);
    const out = smartTruncate(head, 100);
    expect(out.endsWith('!' + MARKER)).toBe(true);
  });

  // ─── No-boundary fallback (hard cut) ─────────────────────────────

  it('hard-cuts at max when no boundary in window (no periods, no newlines)', () => {
    const t = 'z'.repeat(500); // no boundary at all
    const out = smartTruncate(t, 400);
    expect(out).toBe('z'.repeat(400) + MARKER);
  });

  it('does not cut early using a boundary BEFORE the 70% window', () => {
    // Period at index 10 (well before 70% of max=100); should NOT be used
    // as the cut point — we'd lose 60+ chars of meaningful tail.
    const head = 'P'.repeat(10) + '.' + 'Q'.repeat(200);
    const out = smartTruncate(head, 100);
    // Output should NOT end at index 11 (the early period) — it should
    // have used a later boundary (none here) or hard-cut at 100.
    expect(out.length).toBeGreaterThan(50);
  });

  // ─── Multi-newline / multi-sentence ──────────────────────────────

  it('uses the LAST boundary in window when multiple are present', () => {
    // periods at 75 and 90 within max=100 window — should use 90.
    const head = 'A'.repeat(75) + '.' + 'B'.repeat(14) + '.' + 'C'.repeat(40);
    const out = smartTruncate(head, 100);
    // Must contain both periods, end at the second one.
    expect(out).toContain('A'.repeat(75) + '.');
    expect(out.endsWith('.' + MARKER)).toBe(true);
    expect(out).not.toContain('C');
  });

  it('handles multi-newline input by cutting at last \\n in window', () => {
    const head = 'L1'.repeat(35) + '\n' + 'L2'.repeat(10) + '\n' + 'L3'.repeat(40);
    // total length > 100, max=100
    const out = smartTruncate(head, 100);
    expect(out).toContain(MARKER);
    // Should not include L3 tail (cut before it).
    expect(out.includes('L3L3')).toBe(false);
  });

  // ─── Defensive / edge inputs ─────────────────────────────────────

  it('returns empty string for non-string input', () => {
    expect(smartTruncate(null, 400)).toBe('');
    expect(smartTruncate(undefined, 400)).toBe('');
    expect(smartTruncate(12345, 400)).toBe('');
  });

  it('returns empty string for non-positive max', () => {
    expect(smartTruncate('abc', 0)).toBe('');
    expect(smartTruncate('abc', -1)).toBe('');
    expect(smartTruncate('abc', NaN)).toBe('');
  });

  it('trims trailing whitespace after the cut for cleaner output', () => {
    const head = 'A'.repeat(70) + '.   \n   ' + 'B'.repeat(40);
    const out = smartTruncate(head, 100);
    // The cut piece should not end with whitespace before the marker.
    const beforeMarker = out.slice(0, out.length - MARKER.length);
    expect(beforeMarker).toBe(beforeMarker.replace(/\s+$/, ''));
  });

  it('marker is exactly "…(truncated, full in feature file)"', () => {
    const t = 'x'.repeat(500);
    const out = smartTruncate(t, 400);
    expect(out.endsWith(MARKER)).toBe(true);
  });
});
