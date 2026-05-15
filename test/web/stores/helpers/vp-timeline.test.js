// vp-timeline.test.js — pinned contract for the agent-authoritative
// status helper (feat-vp-status-from-agent, 2026-05-15).
//
// Previously this helper reverse-inferred status from messages
// (`m.isStreaming === true`) plus a `typingVpIds` array. Both signals
// dropped on reconnect / tool windows / persisted history rehydration,
// stranding the timeline row in stale "streaming". The new contract:
//
//   - status comes from `ctx.vpStatuses[vpId].state` (mirrored from
//     the agent broker's `vp_status_changed` events)
//   - when `ctx.connectionState !== 'connected'` every row reads as
//     `'offline'` regardless of the cached status (a connection drop
//     means the cached state is stale by definition)
//   - the row schema is still { vpId, displayName, status }
//   - buildTimelineRows roster pass first, then a tail pass for VPs
//     that appear in `vpStatuses` but not the roster (e.g. a VP that
//     emitted a status event before its vp_snapshot landed)
//
// The old reverse-inference (messages → streamingSet, typingVpIds →
// typingSet) is GONE and these tests must keep it that way.

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
  it('reads state from vpStatuses[vpId]', () => {
    const ctx = {
      connectionState: 'connected',
      vpStatuses: {
        a: { state: 'streaming' },
        b: { state: 'tool' },
        c: { state: 'error' },
      },
    };
    expect(statusFor('a', ctx)).toBe('streaming');
    expect(statusFor('b', ctx)).toBe('tool');
    expect(statusFor('c', ctx)).toBe('error');
  });

  it('returns idle when the VP has no entry yet', () => {
    expect(statusFor('a', { connectionState: 'connected', vpStatuses: {} }))
      .toBe('idle');
  });

  it('returns offline when connectionState is not "connected"', () => {
    // Connection drop = cached state is stale by definition. Single
    // unambiguous signal beats a stale "streaming" any day.
    const ctx = {
      connectionState: 'disconnected',
      vpStatuses: { a: { state: 'streaming' } },
    };
    expect(statusFor('a', ctx)).toBe('offline');
  });

  it.each([
    'connecting',
    'reconnecting',
    'disconnected',
    'updating',
  ])('treats %s as offline', (s) => {
    expect(statusFor('a', {
      connectionState: s,
      vpStatuses: { a: { state: 'streaming' } },
    })).toBe('offline');
  });

  it('survives missing ctx', () => {
    expect(statusFor('a', null)).toBe('idle');
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
      vpStatuses: {},
      connectionState: 'connected',
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'b']);
    expect(rows.every((r) => r.status === 'idle')).toBe(true);
  });

  it('tags rows from vpStatuses', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a', displayName: 'A' },
        { vpId: 'b', displayName: 'B' },
        { vpId: 'c', displayName: 'C' },
      ],
      vpStatuses: {
        a: { state: 'typing' },
        b: { state: 'streaming' },
        // c has no entry → idle
      },
      connectionState: 'connected',
    });
    expect(rows.find((r) => r.vpId === 'a').status).toBe('typing');
    expect(rows.find((r) => r.vpId === 'b').status).toBe('streaming');
    expect(rows.find((r) => r.vpId === 'c').status).toBe('idle');
  });

  it('forces every row to offline on connection drop', () => {
    // The whole point of the offline overlay: when the agent is gone,
    // it doesn't matter what the cached statuses say.
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a' },
        { vpId: 'b' },
      ],
      vpStatuses: {
        a: { state: 'streaming' },
        b: { state: 'tool' },
      },
      connectionState: 'disconnected',
    });
    expect(rows.every((r) => r.status === 'offline')).toBe(true);
  });

  it('does NOT expose feature-specific fields on rows', () => {
    // The Feature system was deleted 2026-05-13; no row should re-grow
    // these fields by accident.
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a', displayName: 'A' }],
      vpStatuses: {},
      connectionState: 'connected',
    });
    const r = rows[0];
    expect(Object.keys(r).sort()).toEqual(['displayName', 'status', 'vpId']);
    expect(r.featureId).toBeUndefined();
    expect(r.featureTitle).toBeUndefined();
    expect(r.featureStartedAt).toBeUndefined();
  });

  it('tail-appends VPs present in vpStatuses but missing from roster', () => {
    // Race: status event arrives before vp_snapshot. Without the tail
    // pass the row would silently disappear; the user would see
    // activity in the logs that doesn't show up in the timeline.
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a' }],
      vpStatuses: {
        a: { state: 'thinking' },
        ghost: { state: 'streaming' },
      },
      connectionState: 'connected',
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'ghost']);
    expect(rows.find((r) => r.vpId === 'ghost').status).toBe('streaming');
  });

  it('uses vpLabelOf when provided, falls back to displayName, then vpId', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a', displayName: 'fallback-a' },
        { vpId: 'b' },
      ],
      vpStatuses: {},
      connectionState: 'connected',
      vpLabelOf: (id) => (id === 'a' ? '局长A' : ''),
    });
    expect(rows.find((r) => r.vpId === 'a').displayName).toBe('局长A');
    expect(rows.find((r) => r.vpId === 'b').displayName).toBe('b');
  });

  it('survives malformed args', () => {
    expect(buildTimelineRows(null)).toEqual([]);
    expect(buildTimelineRows({})).toEqual([]);
    expect(buildTimelineRows({ vpList: [], vpStatuses: {} })).toEqual([]);
  });

  it('skips entries without vpId in vpList', () => {
    const rows = buildTimelineRows({
      vpList: [
        { vpId: 'a' },
        { displayName: 'no-id' },
        null,
        { vpId: 'b' },
      ],
      vpStatuses: {},
      connectionState: 'connected',
    });
    expect(rows.map((r) => r.vpId)).toEqual(['a', 'b']);
  });

  it('does not reverse-infer status from messages (regression guard)', () => {
    // The old contract took a `messages` arg and computed
    // streamingSet from `m.isStreaming === true`. The new helper must
    // ignore that field entirely — even if a caller forwards messages
    // by accident, the status should still come from vpStatuses (or
    // default to idle).
    const rows = buildTimelineRows({
      vpList: [{ vpId: 'a' }],
      vpStatuses: {},
      connectionState: 'connected',
      // Intentionally pass shape the old helper consumed.
      messages: [{ type: 'assistant', vpId: 'a', isStreaming: true }],
      typingVpIds: ['a'],
    });
    expect(rows[0].status).toBe('idle');
  });
});
