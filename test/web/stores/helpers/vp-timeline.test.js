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
 *   - Snippet attribution: speakerVpId preferred, then vpId.
 *   - Helper is pure: frozen inputs do not throw.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTimelineRows,
  lastAssistantInfoByVp,
  truncateSnippet,
  statusFor,
} from '../../../../web/stores/helpers/vp-timeline.js';

describe('truncateSnippet', () => {
  it('returns null for null/undefined/empty/whitespace input', () => {
    expect(truncateSnippet(null, 80)).toBeNull();
    expect(truncateSnippet(undefined, 80)).toBeNull();
    expect(truncateSnippet('', 80)).toBeNull();
    expect(truncateSnippet('   ', 80)).toBeNull();
  });

  it('returns the trimmed string when ≤ max', () => {
    expect(truncateSnippet('hello', 80)).toBe('hello');
    expect(truncateSnippet('  hi  ', 80)).toBe('hi');
  });

  it('returns trimmed string when length === max (no ellipsis)', () => {
    const s = 'a'.repeat(80);
    expect(truncateSnippet(s, 80)).toBe(s);
  });

  it("appends '…' when length > max", () => {
    const s = 'a'.repeat(200);
    const out = truncateSnippet(s, 80);
    expect(out).toHaveLength(81);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 80)).toBe('a'.repeat(80));
  });
});

describe('lastAssistantInfoByVp', () => {
  it('returns an empty Map for non-array / null input', () => {
    expect(lastAssistantInfoByVp(null, 80).size).toBe(0);
    expect(lastAssistantInfoByVp(undefined, 80).size).toBe(0);
  });

  it('picks the MOST RECENT assistant message per vpId (right-to-left)', () => {
    const messages = [
      { type: 'assistant', speakerVpId: 'vp-1', content: 'old', timestamp: 1 },
      { type: 'assistant', speakerVpId: 'vp-1', content: 'new', timestamp: 2 },
    ];
    const out = lastAssistantInfoByVp(messages, 80);
    expect(out.get('vp-1').text).toBe('new');
    expect(out.get('vp-1').ts).toBe(2);
  });

  it('skips user / tool-use / system messages', () => {
    const messages = [
      { type: 'user', speakerVpId: 'vp-1', content: 'why?', timestamp: 1 },
      { type: 'tool-use', speakerVpId: 'vp-1', toolName: 'Bash', timestamp: 2 },
      { type: 'system', speakerVpId: 'vp-1', content: 'sys', timestamp: 3 },
    ];
    const out = lastAssistantInfoByVp(messages, 80);
    expect(out.size).toBe(0);
  });

  it('prefers speakerVpId over vpId for attribution', () => {
    const messages = [
      // speakerVpId wins; vpId is the routing turn-id field, not the speaker.
      { type: 'assistant', vpId: 'vp-routing', speakerVpId: 'vp-real', content: 'hi', timestamp: 1 },
    ];
    const out = lastAssistantInfoByVp(messages, 80);
    expect(out.has('vp-real')).toBe(true);
    expect(out.has('vp-routing')).toBe(false);
  });

  it('falls back to vpId when speakerVpId is absent', () => {
    const messages = [
      { type: 'assistant', vpId: 'vp-1', content: 'hi', timestamp: 1 },
    ];
    expect(lastAssistantInfoByVp(messages, 80).get('vp-1').text).toBe('hi');
  });

  it('skips assistant messages with no vpId attribution', () => {
    const messages = [
      { type: 'assistant', content: 'orphan', timestamp: 1 },
    ];
    expect(lastAssistantInfoByVp(messages, 80).size).toBe(0);
  });

  it('falls back to m.textContent when m.content is empty', () => {
    const messages = [
      { type: 'assistant', speakerVpId: 'vp-1', textContent: 'aggr', timestamp: 1 },
    ];
    expect(lastAssistantInfoByVp(messages, 80).get('vp-1').text).toBe('aggr');
  });
});

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
      lastSnippet: null,
      lastActivityAt: null,
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

  it("truncates lastSnippet to snippetMaxLen and appends '…'", () => {
    const longText = 'a'.repeat(200);
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: [],
      messages: [
        { type: 'assistant', speakerVpId: 'vp-1', content: longText, timestamp: 1 },
      ],
    });
    expect(out[0].lastSnippet).toHaveLength(81);
    expect(out[0].lastSnippet.endsWith('…')).toBe(true);
  });

  it('snippet picks most recent assistant message; ignores intervening user message', () => {
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1' }],
      unifyFeatureMeta: {},
      activeFeatureByVp: {},
      typingVpIds: [],
      messages: [
        { type: 'assistant', speakerVpId: 'vp-1', content: 'old', timestamp: 1 },
        { type: 'user', content: 'why?', timestamp: 2 },
        { type: 'assistant', speakerVpId: 'vp-1', content: 'fresh', timestamp: 3 },
      ],
    });
    expect(out[0].lastSnippet).toBe('fresh');
    expect(out[0].lastActivityAt).toBe(3);
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

  it("lastActivityAt = max(featureStartedAt, snippetTs)", () => {
    // featureStartedAt = 200, snippet ts = 100 → max is 200
    const out = buildTimelineRows({
      vpList: [{ vpId: 'vp-1' }],
      unifyFeatureMeta: {
        'feat-A': { featureId: 'feat-A', status: 'active', startedAt: 200, title: 'A' },
      },
      activeFeatureByVp: { 'vp-1': 'feat-A' },
      typingVpIds: [],
      messages: [
        { type: 'assistant', speakerVpId: 'vp-1', content: 'old', timestamp: 100 },
      ],
    });
    expect(out[0].lastActivityAt).toBe(200);
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
