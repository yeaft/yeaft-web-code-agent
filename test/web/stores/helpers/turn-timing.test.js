import { describe, it, expect } from 'vitest';
import { formatElapsed } from '../../../../web/stores/helpers/turn-timing.js';

describe('formatElapsed', () => {
  it('returns empty for invalid values', () => {
    expect(formatElapsed(-1)).toBe('');
    expect(formatElapsed(Number.NaN)).toBe('');
    expect(formatElapsed(Infinity)).toBe('');
  });

  it('formats seconds before the first minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(125_000)).toBe('2:05');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});
