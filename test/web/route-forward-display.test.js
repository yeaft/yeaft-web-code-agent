import { describe, expect, it } from 'vitest';
import {
  formatMentionList,
  formatRouteForwardToolLine,
} from '../../web/utils/route-forward-display.js';

describe('RouteForward display formatting', () => {
  it('joins a list of vp ids as @-mentions with the default separator', () => {
    expect(formatMentionList(['linus', 'steve'])).toBe('@linus, @steve');
  });

  it('respects a custom separator', () => {
    expect(formatMentionList(['linus', 'steve'], { separator: ' / ' }))
      .toBe('@linus / @steve');
  });

  it('handles non-array input by returning an empty string', () => {
    expect(formatMentionList(null)).toBe('');
    expect(formatMentionList(undefined)).toBe('');
  });

  it('formats a route_forward tool row as `Route @target: <text>`', () => {
    expect(formatRouteForwardToolLine({ to: 'martin', text: 'review PR #785' }))
      .toBe('Route @martin: review PR #785');
  });

  it('renders `Route @all: ...` when broadcasting', () => {
    expect(formatRouteForwardToolLine({ to: 'all', text: 'please weigh in' }))
      .toBe('Route @all: please weigh in');
  });

  it('falls back to `Route @target` when no text is supplied', () => {
    expect(formatRouteForwardToolLine({ to: 'linus' })).toBe('Route @linus');
  });

  it('uses `?` when the target is missing or non-string', () => {
    expect(formatRouteForwardToolLine({})).toBe('Route @?');
    expect(formatRouteForwardToolLine({ to: '' })).toBe('Route @?');
  });

  it('passes long text through the supplied truncate helper', () => {
    const truncate = (value, max) => value.length > max ? value.slice(0, max) + '…' : value;
    const out = formatRouteForwardToolLine(
      { to: 'martin', text: 'a'.repeat(100) },
      truncate,
    );
    expect(out).toBe('Route @martin: ' + 'a'.repeat(70) + '…');
  });
});
