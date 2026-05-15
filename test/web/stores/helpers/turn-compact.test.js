import { describe, it, expect } from 'vitest';
import {
  compactBody,
  isExpanded,
  toggleState,
  reconcileStreamingState,
  formatElapsed,
} from '../../../../web/stores/helpers/turn-compact.js';

describe('compactBody', () => {
  it('returns empty for null/undefined/empty input', () => {
    expect(compactBody(null)).toEqual({ text: '', truncated: false, totalLines: 0 });
    expect(compactBody(undefined)).toEqual({ text: '', truncated: false, totalLines: 0 });
    expect(compactBody('')).toEqual({ text: '', truncated: false, totalLines: 0 });
  });

  it('returns the whole body when ≤ maxLines', () => {
    const text = 'a\nb\nc';
    expect(compactBody(text, 6)).toEqual({
      text: 'a\nb\nc',
      truncated: false,
      totalLines: 3,
    });
  });

  it('returns last N lines when source exceeds maxLines', () => {
    const text = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8';
    const out = compactBody(text, 6);
    expect(out.text).toBe('l3\nl4\nl5\nl6\nl7\nl8');
    expect(out.truncated).toBe(true);
    expect(out.totalLines).toBe(8);
  });

  it('strips trailing empty lines (a trailing newline mid-stream)', () => {
    const text = 'a\nb\nc\n';
    expect(compactBody(text, 6)).toEqual({
      text: 'a\nb\nc',
      truncated: false,
      totalLines: 3,
    });
  });

  it('strips multiple trailing empty lines', () => {
    const text = 'a\nb\n\n\n';
    const out = compactBody(text, 6);
    expect(out.totalLines).toBe(2);
    expect(out.text).toBe('a\nb');
  });

  it('preserves leading empty lines (treats them as content)', () => {
    const text = '\n\nfirst\nsecond';
    const out = compactBody(text, 6);
    expect(out.totalLines).toBe(4);
    expect(out.text).toBe('\n\nfirst\nsecond');
  });

  it('honours custom maxLines', () => {
    const text = 'l1\nl2\nl3\nl4\nl5';
    expect(compactBody(text, 2)).toEqual({
      text: 'l4\nl5',
      truncated: true,
      totalLines: 5,
    });
  });

  it('falls back to default 6 when maxLines is 0 or negative', () => {
    const text = 'l1\nl2\nl3\nl4\nl5\nl6\nl7';
    const out = compactBody(text, 0);
    expect(out.totalLines).toBe(7);
    expect(out.text.split('\n').length).toBe(6);
  });

  it('coerces non-string input to string', () => {
    expect(compactBody(42)).toEqual({
      text: '42',
      truncated: false,
      totalLines: 1,
    });
  });

  it('boundary: exactly maxLines is not truncated', () => {
    const text = 'l1\nl2\nl3\nl4\nl5\nl6';
    const out = compactBody(text, 6);
    expect(out.totalLines).toBe(6);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(text);
  });

  it('boundary: maxLines+1 truncates by exactly one line', () => {
    const text = 'l1\nl2\nl3\nl4\nl5\nl6\nl7';
    const out = compactBody(text, 6);
    expect(out.totalLines).toBe(7);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe('l2\nl3\nl4\nl5\nl6\nl7');
  });

  it('returns 0 totalLines for whitespace-only that fully strips', () => {
    expect(compactBody('\n\n\n')).toEqual({
      text: '',
      truncated: false,
      totalLines: 0,
    });
  });
});

describe('isExpanded', () => {
  it('streaming, auto-expanded, and user-expanded → true', () => {
    expect(isExpanded('streaming')).toBe(true);
    expect(isExpanded('auto-expanded')).toBe(true);
    expect(isExpanded('user-expanded')).toBe(true);
  });
  it('auto-collapsed and user-collapsed → false', () => {
    expect(isExpanded('auto-collapsed')).toBe(false);
    expect(isExpanded('user-collapsed')).toBe(false);
  });
  it('unknown state → false (defensive)', () => {
    expect(isExpanded('garbage')).toBe(false);
    expect(isExpanded(undefined)).toBe(false);
  });
});

describe('toggleState', () => {
  it('expanded states → user-collapsed', () => {
    expect(toggleState('streaming')).toBe('user-collapsed');
    expect(toggleState('auto-expanded')).toBe('user-collapsed');
    expect(toggleState('user-expanded')).toBe('user-collapsed');
  });
  it('collapsed states → user-expanded', () => {
    expect(toggleState('auto-collapsed')).toBe('user-expanded');
    expect(toggleState('user-collapsed')).toBe('user-expanded');
  });
});

describe('reconcileStreamingState', () => {
  it('NOT-streaming → streaming forces "streaming" from auto state', () => {
    expect(reconcileStreamingState('auto-collapsed', true)).toBe('streaming');
  });
  it('NOT-streaming → streaming preserves user intent', () => {
    expect(reconcileStreamingState('user-expanded', true)).toBe('user-expanded');
    expect(reconcileStreamingState('user-collapsed', true)).toBe('user-collapsed');
  });
  it('streaming → NOT-streaming auto-expands by default', () => {
    expect(reconcileStreamingState('streaming', false)).toBe('auto-expanded');
  });
  it('streaming → NOT-streaming preserves user intent', () => {
    // a user clicked toggle DURING streaming; even though the upstream
    // is still streaming we honour the click. When streaming ends the
    // user's choice should still hold.
    expect(reconcileStreamingState('user-expanded', false)).toBe('user-expanded');
    expect(reconcileStreamingState('user-collapsed', false)).toBe('user-collapsed');
  });
  it('idempotent for steady states', () => {
    expect(reconcileStreamingState('streaming', true)).toBe('streaming');
    expect(reconcileStreamingState('auto-expanded', false)).toBe('auto-expanded');
    expect(reconcileStreamingState('auto-collapsed', false)).toBe('auto-collapsed');
  });
});

describe('formatElapsed', () => {
  it('< 60s → "Ns"', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(500)).toBe('0s');     // < 1s rounds down
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(45000)).toBe('45s');
    expect(formatElapsed(59999)).toBe('59s');
  });
  it('60s ≤ ms < 1h → "M:SS"', () => {
    expect(formatElapsed(60000)).toBe('1:00');
    expect(formatElapsed(127000)).toBe('2:07');
    expect(formatElapsed(3599000)).toBe('59:59');
  });
  it('≥ 1h → "Hh M:SS"', () => {
    expect(formatElapsed(3600000)).toBe('1h 0:00');
    expect(formatElapsed(3727000)).toBe('1h 2:07');
    expect(formatElapsed(7325000)).toBe('2h 2:05');
  });
  it('defensive: negative / NaN / non-number → "0s"', () => {
    expect(formatElapsed(-1)).toBe('0s');
    expect(formatElapsed(NaN)).toBe('0s');
    expect(formatElapsed(Infinity)).toBe('0s');
    expect(formatElapsed('123')).toBe('0s');
    expect(formatElapsed(null)).toBe('0s');
  });
});
