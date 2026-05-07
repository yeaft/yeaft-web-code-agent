/**
 * Regression: Group-chat tool action displays inside the VP message block
 * with the avatar header on top — not in a duplicate orphan block AFTER
 * the tool-bearing real turn.
 *
 * Bug shape (reported by user with a screenshot):
 *   ┌─ tool action: "功能 Let me check…"           ← orphan block
 *   ├─ Steve Jobs / Product Strategist (avatar)    ← typing-placeholder
 *   …
 * vs. expected:
 *   ┌─ Steve Jobs / Product Strategist (avatar)    ← speaker header
 *   ├─ tool action: "功能 Let me check…"           ← inside same block
 *   …
 *
 * Root cause: the orphan typing-placeholder synthesis at the bottom of
 * `MessageList.turnGroups` walked the tail run for VPs already covered
 * by an in-flight bubble, but the predicate was
 * `r.isStreaming && r.speakerVpId`. A turn that OPENS with a tool_call
 * (no preceding `assistant` text-delta) never sets
 * `currentTurn.isStreaming` — only `type==='assistant'` deltas flip
 * that flag — so the predicate evaluated false and the placeholder was
 * synthesised AFTER the tool-bearing real turn, producing a duplicate
 * avatar block.
 *
 * Fix: broaden the predicate to "any non-empty assistant-turn for this
 * VP in the tail run carries the speaker", regardless of `isStreaming`.
 *
 * These tests exercise the actual placeholder helper (extracted in
 * PR-720) with realistic fixture turn-lists. A regex-only suite would
 * have asserted "the source string still says coveredVps" — useful to
 * detect a refactor revert, useless to detect a logic regression.
 */
import { describe, it, expect } from 'vitest';
import { appendTypingPlaceholders } from '../../web/stores/helpers/typing-placeholders.js';

const buildToolOnlyTurn = (vpId, { isStreaming = false } = {}) => ({
  type: 'assistant-turn',
  id: 'turn_1',
  textContent: '',
  isStreaming,
  todoMsg: null,
  toolMsgs: [
    { type: 'tool-use', toolName: 'web_search', toolInput: { query: 'q' } },
  ],
  imageMsgs: [],
  askMsg: null,
  messages: [],
  atMessageId: null,
  speakerVpId: vpId,
  speakerTimestamp: 0,
  speakerStateCause: '',
  showSpeakerHeader: true,
  turnId: 'turn_1',
  handoffHints: [],
});

const buildTextTurn = (vpId, { isStreaming = false, text = 'hello' } = {}) => ({
  type: 'assistant-turn',
  id: 'turn_2',
  textContent: text,
  isStreaming,
  todoMsg: null,
  toolMsgs: [],
  imageMsgs: [],
  askMsg: null,
  messages: [],
  atMessageId: null,
  speakerVpId: vpId,
  speakerTimestamp: 0,
  speakerStateCause: '',
  showSpeakerHeader: true,
  turnId: 'turn_2',
  handoffHints: [],
});

describe('appendTypingPlaceholders — orphan-block regression', () => {
  it('does NOT synthesise a placeholder when the tail turn is a tool-only non-streaming bubble for the same VP', () => {
    // This is the screenshot bug: tool-only turn → isStreaming false →
    // earlier predicate false → duplicate placeholder appended AFTER →
    // avatar shows BELOW the tool action.
    const items = [buildToolOnlyTurn('jobs', { isStreaming: false })];
    const out = appendTypingPlaceholders(items, ['jobs'], {});
    const placeholders = out.filter((r) => r.id && r.id.startsWith('turn_typing_'));
    expect(placeholders).toHaveLength(0);
    // The original tool-bearing turn is still the only turn in the result.
    expect(out).toHaveLength(1);
    expect(out[0].toolMsgs).toHaveLength(1);
    expect(out[0].speakerVpId).toBe('jobs');
  });

  it('does NOT synthesise a placeholder when the tail turn is a finished text bubble for the same VP', () => {
    // Same predicate broadening: a turn whose stream just ended
    // (vp_typing_end may lag the last delta) should not trigger a
    // duplicate avatar AFTER it.
    const items = [buildTextTurn('jobs', { isStreaming: false })];
    const out = appendTypingPlaceholders(items, ['jobs'], {});
    expect(out.filter((r) => r.id && r.id.startsWith('turn_typing_'))).toHaveLength(0);
  });

  it('DOES synthesise a placeholder when the VP has no turn in the tail run at all', () => {
    // The placeholder's actual purpose: bridge the gap between
    // vp_typing_start and the first chunk. With nothing in `result`
    // the avatar must still appear from the moment typing flag flips on.
    const out = appendTypingPlaceholders([], ['jobs'], {});
    expect(out).toHaveLength(1);
    expect(out[0].speakerVpId).toBe('jobs');
    expect(out[0].id).toBe('turn_typing_jobs');
    expect(out[0].showSpeakerHeader).toBe(true);
    expect(out[0].toolMsgs).toEqual([]);
    expect(out[0].textContent).toBe('');
  });

  it('still synthesises a placeholder for VP-B when only VP-A has a turn in the tail', () => {
    // Multi-VP fan-out: A finished its tool, B just started typing.
    // B's avatar should appear immediately even though the tail is A.
    const items = [buildToolOnlyTurn('jobs')];
    const out = appendTypingPlaceholders(items, ['jobs', 'rams'], {});
    const placeholders = out.filter((r) => r.id && r.id.startsWith('turn_typing_'));
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].speakerVpId).toBe('rams');
  });

  it('breaks the tail walk on the first non-assistant-turn row (e.g. user message)', () => {
    // A user row in the tail means same-VP turns further back are NOT
    // adjacent to the typing flag — the placeholder must still appear.
    const items = [
      buildTextTurn('jobs', { text: 'old reply from earlier' }),
      { type: 'user', id: 'u1', message: { content: 'follow-up' } },
    ];
    const out = appendTypingPlaceholders(items, ['jobs'], {});
    const placeholders = out.filter((r) => r.id && r.id.startsWith('turn_typing_'));
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].speakerVpId).toBe('jobs');
  });

  it('inherits activeFeatureByVp[vpId] onto the placeholder', () => {
    // PR-2 (feature-pill): the in-flight feature run must not be split
    // by an untagged placeholder during the typing gap.
    const out = appendTypingPlaceholders([], ['jobs'], { jobs: 'feat-deploy-bot' });
    expect(out[0].featureId).toBe('feat-deploy-bot');
  });

  it('falls back to null featureId when the VP is not in the active-feature map', () => {
    const out = appendTypingPlaceholders([], ['jobs'], {});
    expect(out[0].featureId).toBeNull();
  });

  it('returns the input unchanged when there are no typing VPs', () => {
    const items = [buildToolOnlyTurn('jobs')];
    const out = appendTypingPlaceholders(items, [], {});
    expect(out).toBe(items);
    expect(out).toHaveLength(1);
  });

  it('returns the input unchanged when given a non-array items value', () => {
    expect(appendTypingPlaceholders(null, ['jobs'], {})).toEqual([]);
    expect(appendTypingPlaceholders(undefined, ['jobs'], {})).toEqual([]);
  });

  it('does not over-suppress: an empty turn (no speakerVpId) does not count as covering anything', () => {
    // finishTurn() refuses to push empty turns, so this shouldn't happen
    // in practice — but the helper must still behave defensively.
    const items = [{ type: 'assistant-turn', id: 't', speakerVpId: null, toolMsgs: [] }];
    const out = appendTypingPlaceholders(items, ['jobs'], {});
    const placeholders = out.filter((r) => r.id && r.id.startsWith('turn_typing_'));
    expect(placeholders).toHaveLength(1);
  });
});
