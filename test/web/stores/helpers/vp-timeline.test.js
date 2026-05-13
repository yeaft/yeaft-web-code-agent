// vp-timeline.test.js — pinned contract for the simplified helper.
//
// PR #767 removed VpTimelinePane + this helper along with the Feature
// system. v0.1.767 restored the VP list WITHOUT the feature-aware
// branches. This test pins the simplified shape:
//   - status ∈ {idle, typing, streaming} only
//   - no feature* fields on TimelineRow
//   - selectGroupRosterVpList: roster is source of truth
//   - buildTimelineRows: roster-first ordering, tail pass for transient VPs

import { describe, it, expect } from 'vitest';
import {
  selectGroupRosterVpList,
  buildTimelineRows,
  statusFor,
} from '../../../../web/stores/helpers/vp-timeline.js';

describe('selectGroupRosterVpList', () => {
  it('returns [] when roster is missing or empty', () => {
    expect(selectGroupRosterVpList(null, [])).toEqual([]);
    expect(selectGroupRosterVpList(undefined, [])).toEqual([]);
    expect(selectGroupRosterVpList([], [])).toEqual([]);
  });

  it('preserves roster order', () => {
    const library = [
      { vpId: 'a', displayName: 'A' },
      { vpId: 'b', displayName: 'B' },
      { vpId: 'c', displayName: 'C' },
    ];
    const out = selectGroupRosterVpList(['c', 'a', 'b'], library);
    expect(out.map((v) => v.vpId)).toEqual(['c', 'a', 'b']);
  });

  it('stubs roster ids missing from the library', () => {
    const library = [{ vpId: 'a', displayName: 'A' }];
    const out = selectGroupRosterVpList(['a', 'unknown'], library);
    expect(out).toEqual([
      { vpId: 'a', displayName: 'A' },
      { vpId: 'unknown' },
    ]);
  });

  it('still renders rows when library has not hydrated yet', () => {
    const out = selectGroupRosterVpList(['x', 'y'], null);
    expect(out).toEqual([{ vpId: 'x' }, { vpId: 'y' }]);
  });

  it('de-duplicates roster ids', () => {
    const out = selectGroupRosterVpList(['a', 'a', 'b'], []);
    expect(out.map((v) => v.vpId)).toEqual(['a', 'b']);
  });

  it('skips empty/falsy roster entries', () => {
    const out = selectGroupRosterVpList(['', 'a', null, 'b'], []);
    expect(out.map((v) => v.vpId)).toEqual(['a', 'b']);
  });
});

describe('statusFor', () => {
  it('returns typing when in typingSet', () => {
    expect(statusFor('a', {
      typingSet: new Set(['a']),
      streamingSet: new Set(),
    })).toBe('typing');
  });

  it('returns streaming when in streamingSet (and not typing)', () => {
    expect(statusFor('a', {
      typingSet: new Set(),
      streamingSet: new Set(['a']),
    })).toBe('streaming');
  });

  it('returns idle when in neither set', () => {
    expect(statusFor('a', {
      typingSet: new Set(),
      streamingSet: new Set(),
    })).toBe('idle');
  });

  it('typing wins over streaming (precedence)', () => {
    expect(statusFor('a', {
      typingSet: new Set(['a']),
      streamingSet: new Set(['a']),
    })).toBe('typing');
  });

  it('survives missing ctx fields', () => {
    expect(statusFor('a', {})).toBe('idle');
  });
});

describe('buildTimelineRows', () => {
  it('emits one row per vpList entry in order', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a', displayName: 'A' },
        { vpId: 'b', displayName: 'B' },
      ],
      typingVpIds: [],
      messages: [],
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'b']);
    expect(rows.every((r) => r.status === 'idle')).toBe(true);
  });

  it('tags typing/streaming correctly', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a', displayName: 'A' },
        { vpId: 'b', displayName: 'B' },
        { vpId: 'c', displayName: 'C' },
      ],
      typingVpIds: ['a'],
      messages: [
        { type: 'assistant', vpId: 'b', isStreaming: true },
      ],
    });
    expect(rows.find((r) => r.vpId === 'a').status).toBe('typing');
    expect(rows.find((r) => r.vpId === 'b').status).toBe('streaming');
    expect(rows.find((r) => r.vpId === 'c').status).toBe('idle');
  });

  it('does NOT expose feature-specific fields on rows', () => {
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a', displayName: 'A' }],
      typingVpIds: [],
      messages: [],
    });
    const r = rows[0];
    // The simplified helper exports only vpId / displayName / status.
    expect(Object.keys(r).sort()).toEqual(['displayName', 'status', 'vpId']);
    // Defensive: no feature* fields linger.
    expect(r.featureId).toBeUndefined();
    expect(r.featureTitle).toBeUndefined();
    expect(r.featureStartedAt).toBeUndefined();
  });

  it('tail-appends VPs missing from roster but seen in typing/streaming/messages', () => {
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a', displayName: 'A' }],
      typingVpIds: ['b'],
      messages: [
        { type: 'assistant', vpId: 'c' },
        { type: 'assistant', vpId: 'd', isStreaming: true },
      ],
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'b', 'd', 'c']);
    // typing pass adds 'b' first; streamingSet pass adds 'd'; speakerVps pass
    // would re-add 'd' but it's already seen; 'c' shows up via speakerVps.
    // Order is roster -> typingSet -> speakerVps -> streamingSet. The exact
    // tail order may shift if implementation details change, so the most
    // important assertion is that ALL four VPs end up represented.
    expect(rows.length).toBe(4);
  });

  it('uses vpLabelOf when provided, falls back to displayName, then vpId', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a', displayName: 'fallback-a' },
        { vpId: 'b' }, // no displayName
      ],
      typingVpIds: [],
      messages: [],
      vpLabelOf: (id) => (id === 'a' ? '局长A' : ''),
    });
    expect(rows.find((r) => r.vpId === 'a').displayName).toBe('局长A');
    expect(rows.find((r) => r.vpId === 'b').displayName).toBe('b');
  });

  it('survives malformed args', () => {
    expect(buildTimelineRows(null)).toEqual([]);
    expect(buildTimelineRows({})).toEqual([]);
    expect(buildTimelineRows({ vpList: [], typingVpIds: [], messages: [] })).toEqual([]);
  });

  it('skips entries without vpId in vpList', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a' },
        { displayName: 'no-id' },
        null,
        { vpId: 'b' },
      ],
      typingVpIds: [],
      messages: [],
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'b']);
  });

  it('uses speakerVpId before vpId on messages', () => {
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a' }],
      typingVpIds: [],
      messages: [
        { type: 'assistant', speakerVpId: 'a', vpId: 'WRONG', isStreaming: true },
      ],
    });
    expect(rows[0].status).toBe('streaming');
  });
});
