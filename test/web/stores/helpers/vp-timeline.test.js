/**
 * Tests for the PR-3 VP timeline pure helper.
 *
 * These cover the projection that turns store state (vp roster + feature
 * meta + active pointer + typing set + messages) into the ordered list
 * of TimelineRow objects the right-side pane renders.
 *
 * The contract pinned here:
 *   - Sort is roster order. Tail-append for transient VPs (first-seen).
 *   - Status precedence: in-feature ▸ typing ▸ streaming ▸ idle.
 *   - active pointer with missing meta → status 'streaming', no feature
 *     fields leaked.
 *   - Helper is pure: frozen inputs do not throw.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTimelineRows,
  statusFor,
  selectGroupRosterVpList,
} from '../../../../web/stores/helpers/vp-timeline.js';

describe('statusFor', () => {
  const meta = { 'feat-A': { featureId: 'feat-A', status: 'active' } };
  const ctx = (over) => ({
    activeFeatureByVp: {},
    unifyFeatureMeta: meta,
    typingSet: new Set(),
    streamingSet: new Set(),
    ...over,
  });

  it("'in-feature' wins when active pointer + meta both exist", () => {
    expect(statusFor('vp-1', ctx({
      activeFeatureByVp: { 'vp-1': 'feat-A' },
      typingSet: new Set(['vp-1']),
      streamingSet: new Set(['vp-1']),
    }))).toBe('in-feature');
  });

  it("falls through to 'typing' when active pointer is set but meta missing", () => {
    expect(statusFor('vp-1', ctx({
      activeFeatureByVp: { 'vp-1': 'feat-MISSING' },
      typingSet: new Set(['vp-1']),
    }))).toBe('typing');
  });

  it("falls through to 'streaming' when only streamingSet matches", () => {
    expect(statusFor('vp-1', ctx({ streamingSet: new Set(['vp-1']) }))).toBe('streaming');
  });

  it("returns 'idle' when nothing matches", () => {
    expect(statusFor('vp-1', ctx())).toBe('idle');
  });
});

describe('buildTimelineRows', () => {
  it('returns [] for empty inputs', () => {
    const out = buildTimelineRows({
      vpList: [], unifyFeatureMeta: {}, activeFeatureByVp: {},
      typingVpIds: [], messages: [],
    });
    expect(out).toEqual([]);
  });

  it('emits one idle row for a roster VP with no live signal', () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1', displayName: 'Alice' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: [],
      messages: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      vpId: 'vp-1',
      displayName: 'Alice',
      status: 'idle',
      featureId: null,
    });
  });

  it("flips a roster VP to 'typing' when typingVpIds includes it", () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1', displayName: 'Alice' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: ['vp-1'],
      messages: [],
    });
    expect(out[0].status).toBe('typing');
  });

  it("flips a roster VP to 'in-feature' when active pointer + meta both exist", () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1' }],
      unifyFeatureMeta: {
        'feat-X': {
          featureId: 'feat-X', title: 'Build login flow',
          trigger: 'tool', toolName: 'Bash',
          status: 'active', startedAt: 1000, vpId: 'vp-1',
        },
      },
      activeFeatureByVp: { 'vp-1': 'feat-X' },
      typingVpIds: [],
      messages: [],
    });
    expect(out[0]).toMatchObject({
      status: 'in-feature',
      featureId: 'feat-X',
      featureTitle: 'Build login flow',
      featureTrigger: 'tool',
      featureToolName: 'Bash',
      featureStatus: 'active',
      featureStartedAt: 1000,
    });
  });

  it("RACE: active pointer with missing meta falls through to 'streaming' and leaks no feature fields", () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1' }],
      unifyFeatureMeta: {},                   // meta has not landed yet
      activeFeatureByVp: { 'vp-1': 'feat-Y' }, // pointer is already set
      typingVpIds: [],
      // and a streaming message exists for the vp so streamingSet picks it up
      messages: [
        { type: 'assistant', speakerVpId: 'vp-1', isStreaming: true, content: 'thinking', timestamp: 5 },
      ],
    });
    expect(out[0].status).toBe('streaming');
    expect(out[0].featureId).toBeNull();
    expect(out[0].featureTitle).toBeNull();
    expect(out[0].featureStartedAt).toBeNull();
  });

  it('preserves vpList order when statuses are mixed (sort policy: roster-only)', () => {
    const out = buildTimelineRows({
      vpList: [
        { vpId: 'vp-A', displayName: 'A' },
        { vpId: 'vp-B', displayName: 'B' },
        { vpId: 'vp-C', displayName: 'C' },
      ],
      unifyFeatureMeta: {
        'feat-1': { featureId: 'feat-1', status: 'active', startedAt: 100, title: 'X' },
      },
      activeFeatureByVp: { 'vp-C': 'feat-1' },  // vp-C is busy
      typingVpIds: ['vp-B'],
      messages: [],
    });
    // Output order MUST follow vpList, not status-priority.
    expect(out.map((r) => r.vpId)).toEqual(['vp-A', 'vp-B', 'vp-C']);
    expect(out.map((r) => r.status)).toEqual(['idle', 'typing', 'in-feature']);
  });

  it('tail-appends a VP referenced only by activeFeatureByVp (transient VP)', () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-A' }],   // only A is in the roster
      unifyFeatureMeta: {
        'feat-Z': { featureId: 'feat-Z', status: 'active', startedAt: 50, title: 'Z' },
      },
      activeFeatureByVp: { 'vp-X': 'feat-Z' },  // X is transient
      typingVpIds: [],
      messages: [],
    });
    expect(out.map((r) => r.vpId)).toEqual(['vp-A', 'vp-X']);
    expect(out[1].status).toBe('in-feature');
    expect(out[1].displayName).toBe('vp-X');  // fallback to vpId
  });

  it('tail-appends a VP that only has assistant messages (no roster / typing / feature signal)', () => {
    // The previous implementation surfaced these through `snippetMap.keys()`;
    // post-snippet-cleanup, `speakerVps` plays the same role.
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-A' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: [],
      messages: [
        { type: 'assistant', speakerVpId: 'vp-ghost', content: 'hi', timestamp: 1 },
      ],
    });
    expect(out.map((r) => r.vpId)).toEqual(['vp-A', 'vp-ghost']);
    expect(out[1].status).toBe('idle');
  });

  it('uses vpLabelOf when provided (locale-aware naming)', () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1', displayName: 'EnglishName' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: [],
      messages: [],
      vpLabelOf: (id) => id === 'vp-1' ? '中文名' : id,
    });
    expect(out[0].displayName).toBe('中文名');
  });

  it('does NOT mutate frozen inputs (purity guard)', () => {
    const vpList = Object.freeze([Object.freeze({ vpId: 'vp-1', displayName: 'A' })]);
    const meta = Object.freeze({});
    const active = Object.freeze({});
    const typing = Object.freeze([]);
    const messages = Object.freeze([
      Object.freeze({ type: 'assistant', speakerVpId: 'vp-1', content: 'hi', timestamp: 1 }),
    ]);
    expect(() => buildTimelineRows({
      vpList, unifyFeatureMeta: meta, activeFeatureByVp: active,
      typingVpIds: typing, messages,
    })).not.toThrow();
    // Output is a fresh array of fresh row objects.
    const out = buildTimelineRows({
      vpList, unifyFeatureMeta: meta, activeFeatureByVp: active,
      typingVpIds: typing, messages,
    });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
  });

  // Review regression (Torvalds I1): when the caller has already filtered
  // its inputs to a group's roster, we shouldn't be re-introducing
  // out-of-roster VPs through the typing tail-pass. The chat store's
  // `vpsTypingInCurrentConv` is conversation-scoped, not group-scoped,
  // so UnifyPage filters it before passing to the helper. Pin that the
  // helper itself respects the filtered inputs and does NOT bring back
  // typing VPs that aren't in the (filtered) roster.
  it('TYPING-FILTER: does not surface typing VPs absent from the (group-filtered) roster', () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-A', displayName: 'A' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      // Caller (UnifyPage) has already filtered out cross-group VPs by
      // dropping them from `typingVpIds` before calling the helper —
      // mirror that pre-filter here. The helper must NOT tail-append
      // anything that's not in this list.
      typingVpIds: ['vp-A'],
      messages: [],
    });
    expect(out.map((r) => r.vpId)).toEqual(['vp-A']);
    expect(out[0].status).toBe('typing');
  });
});

// ─────────────────────────────────────────────────────────────────
// selectGroupRosterVpList — the projection the middle "VP 列表"
// column uses to scope its base list to the active group's roster.
// Contract (roster-first, 2026-05-09):
//   Roster is the source of truth. The library only supplies display
//   fields. A roster id missing from the library still produces a row,
//   stubbed as { vpId: id } so the consumer can fall back to the raw
//   id while vp_snapshot hydrates. Empty/null roster → []; empty
//   library is fine (every row gets stubbed).
// ─────────────────────────────────────────────────────────────────
describe('selectGroupRosterVpList', () => {
  const LIBRARY = [
    { vpId: 'ada', displayName: 'Ada Lovelace' },
    { vpId: 'alan', displayName: 'Alan Kay' },
    { vpId: 'alice', displayName: 'Alice Security' },
    { vpId: 'rams', displayName: 'Dieter Rams' },
    { vpId: 'grace', displayName: 'Grace Hopper' },
    { vpId: 'ken', displayName: 'Ken Thompson' },
    { vpId: 'linus', displayName: 'Linus Torvalds' },
    { vpId: 'maggie', displayName: 'Margaret Hamilton' },
    { vpId: 'martin', displayName: 'Martin Fowler' },
    { vpId: 'don', displayName: 'Don Norman' },
    { vpId: 'shannon', displayName: 'Shannon' },
    { vpId: 'jobs', displayName: 'Steve Jobs' },
  ];

  it('returns roster members only, ignoring extra library entries', () => {
    const roster = ['ada', 'linus', 'martin', 'jobs'];
    const out = selectGroupRosterVpList(roster, LIBRARY);
    expect(out.map((v) => v.vpId)).toEqual(['ada', 'linus', 'martin', 'jobs']);
    // Display fields hydrated from library, not invented:
    expect(out[0].displayName).toBe('Ada Lovelace');
  });

  it('preserves roster order even when library is in different order', () => {
    const roster = ['jobs', 'ada', 'martin', 'linus'];
    const out = selectGroupRosterVpList(roster, LIBRARY);
    expect(out.map((v) => v.vpId)).toEqual(['jobs', 'ada', 'martin', 'linus']);
  });

  it('returns [] for empty roster', () => {
    expect(selectGroupRosterVpList([], LIBRARY)).toEqual([]);
  });

  it('returns [] for null/undefined roster', () => {
    expect(selectGroupRosterVpList(null, LIBRARY)).toEqual([]);
    expect(selectGroupRosterVpList(undefined, LIBRARY)).toEqual([]);
  });

  it('stubs every roster id when library is empty/null (hydration race)', () => {
    expect(selectGroupRosterVpList(['ada'], [])).toEqual([{ vpId: 'ada' }]);
    expect(selectGroupRosterVpList(['ada'], null)).toEqual([{ vpId: 'ada' }]);
  });

  it('stubs roster ids not yet in the library while keeping order', () => {
    const roster = ['ada', 'unknown-yet', 'linus'];
    const out = selectGroupRosterVpList(roster, LIBRARY);
    expect(out.map((v) => v.vpId)).toEqual(['ada', 'unknown-yet', 'linus']);
    // Hydrated row carries display fields; stubbed row is bare.
    expect(out[0].displayName).toBe('Ada Lovelace');
    expect(out[1]).toEqual({ vpId: 'unknown-yet' });
    expect(out[2].displayName).toBe('Linus Torvalds');
  });

  it('tolerates malformed library entries', () => {
    const lib = [null, { vpId: 'ada' }, undefined, { displayName: 'noid' }, { vpId: 'linus' }];
    const out = selectGroupRosterVpList(['ada', 'linus'], lib);
    expect(out.map((v) => v.vpId)).toEqual(['ada', 'linus']);
  });

  it('de-duplicates repeated roster ids', () => {
    const out = selectGroupRosterVpList(['ada', 'ada', 'linus', 'ada'], LIBRARY);
    expect(out.map((v) => v.vpId)).toEqual(['ada', 'linus']);
  });

  it('drops falsy roster entries (null / undefined / empty string)', () => {
    const roster = [null, 'ada', undefined, '', 'linus'];
    const out = selectGroupRosterVpList(roster, LIBRARY);
    expect(out.map((v) => v.vpId)).toEqual(['ada', 'linus']);
  });
});
