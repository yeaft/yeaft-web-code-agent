/**
 * Tests for the turn-groups aggregator.
 *
 * Pinned behaviours (PR #705 / task-334-ui-b):
 *
 *   moment-1: two VPs replying back-to-back ("ada and steve, debate me on X")
 *   must split into TWO turn groups, each with its own speakerVpId.
 *   Before the fix, they collapsed into one turn under the first speaker's
 *   avatar — the screen lied about who was talking.
 *
 *   moment-2: same VP, same turnId (chunked stream of one logical reply)
 *   stays merged. Same VP across two distinct turnIds (it spoke twice)
 *   splits into two cards — each with its own avatar/timestamp.
 *
 * The rule that drives all three is turnId, not speakerVpId: a single VP
 * that emits two distinct turns deserves two cards even though its avatar
 * is the same.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTurnGroups,
  shouldFlushBeforeAssistant,
} from '../../../../web/stores/helpers/turn-groups.js';

function asst(overrides) {
  return { type: 'assistant', content: '', ...overrides };
}

describe('shouldFlushBeforeAssistant', () => {
  it('does not flush when there is no open turn', () => {
    expect(shouldFlushBeforeAssistant(null, asst({ turnId: 't1' }))).toBe(false);
  });

  it('does not flush when the open turn has not yet latched a turnId', () => {
    // First chunk of a turn — currentTurn was just opened but the latch
    // happens after this check. Don't flush, the latch will set turnId.
    expect(
      shouldFlushBeforeAssistant({ turnId: null }, asst({ turnId: 't1' }))
    ).toBe(false);
  });

  it('does not flush when the incoming message has no turnId (legacy 1:1)', () => {
    expect(
      shouldFlushBeforeAssistant({ turnId: 't1' }, asst({ turnId: undefined }))
    ).toBe(false);
  });

  it('does not flush when turnIds match (chunked stream of one reply)', () => {
    expect(
      shouldFlushBeforeAssistant({ turnId: 't1' }, asst({ turnId: 't1' }))
    ).toBe(false);
  });

  it('flushes when turnIds differ (new utterance arrives)', () => {
    expect(
      shouldFlushBeforeAssistant({ turnId: 't1' }, asst({ turnId: 't2' }))
    ).toBe(true);
  });
});

describe('buildTurnGroups: VP attribution (moment-1, moment-2)', () => {
  it('moment-1: two VPs back-to-back with no user between split into two cards', () => {
    // The exact failure mode: "ada and steve, debate me on X" — server
    // routes the prompt to ada, then steve, with NO user message between
    // their replies. Aggregator must split on turnId so each card gets the
    // right speaker.
    const messages = [
      { type: 'user', content: 'ada and steve, debate me on X' },
      asst({ content: 'ada says', turnId: 't-ada', speakerVpId: 'vp-ada' }),
      asst({ content: ' more from ada', turnId: 't-ada', speakerVpId: 'vp-ada' }),
      asst({ content: 'steve says', turnId: 't-steve', speakerVpId: 'vp-steve' }),
      asst({ content: ' more from steve', turnId: 't-steve', speakerVpId: 'vp-steve' }),
    ];

    const groups = buildTurnGroups(messages);

    // [user, ada-turn, steve-turn]
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe('user');

    expect(groups[1].type).toBe('assistant-turn');
    expect(groups[1].speakerVpId).toBe('vp-ada');
    expect(groups[1].turnId).toBe('t-ada');
    expect(groups[1].textContent).toBe('ada says more from ada');
    expect(groups[1].showSpeakerHeader).toBe(true);

    expect(groups[2].type).toBe('assistant-turn');
    expect(groups[2].speakerVpId).toBe('vp-steve');
    expect(groups[2].turnId).toBe('t-steve');
    expect(groups[2].textContent).toBe('steve says more from steve');
    expect(groups[2].showSpeakerHeader).toBe(true);
  });

  it('moment-2: same VP, same turnId — chunks of one logical reply stay merged', () => {
    const messages = [
      { type: 'user', content: 'hi steve' },
      asst({ content: 'hello', turnId: 't1', speakerVpId: 'vp-steve' }),
      asst({ content: ' world', turnId: 't1', speakerVpId: 'vp-steve' }),
      asst({ content: '!', turnId: 't1', speakerVpId: 'vp-steve' }),
    ];

    const groups = buildTurnGroups(messages);

    expect(groups).toHaveLength(2);
    expect(groups[1].type).toBe('assistant-turn');
    expect(groups[1].speakerVpId).toBe('vp-steve');
    expect(groups[1].textContent).toBe('hello world!');
  });

  it('moment-2: same VP, different turnIds — splits into two cards (it spoke twice)', () => {
    // No user message between, but server emitted two distinct turns —
    // e.g. a tool round-trip split or a continuation. Each turn deserves
    // its own card. Avatar duplicates intentionally.
    const messages = [
      { type: 'user', content: 'go' },
      asst({ content: 'first reply', turnId: 't1', speakerVpId: 'vp-steve' }),
      asst({ content: 'second reply', turnId: 't2', speakerVpId: 'vp-steve' }),
    ];

    const groups = buildTurnGroups(messages);

    expect(groups).toHaveLength(3);
    expect(groups[1].speakerVpId).toBe('vp-steve');
    expect(groups[1].turnId).toBe('t1');
    expect(groups[1].textContent).toBe('first reply');
    expect(groups[2].speakerVpId).toBe('vp-steve');
    expect(groups[2].turnId).toBe('t2');
    expect(groups[2].textContent).toBe('second reply');
  });

  it('user / system / error / feature-message rows always flush the open turn', () => {
    const messages = [
      asst({ content: 'a', turnId: 't1', speakerVpId: 'vp-a' }),
      { type: 'user', content: 'mid' },
      asst({ content: 'b', turnId: 't2', speakerVpId: 'vp-b' }),
      { type: 'system', content: 'sys', id: 's1' },
      asst({ content: 'c', turnId: 't3', speakerVpId: 'vp-c' }),
      { type: 'error', content: 'oops', id: 'e1' },
      asst({ content: 'd', turnId: 't4', speakerVpId: 'vp-d' }),
      { type: 'feature-message', id: 'fm1' },
      asst({ content: 'e', turnId: 't5', speakerVpId: 'vp-e' }),
    ];

    const groups = buildTurnGroups(messages);

    // 5 assistant-turns + 4 separator rows = 9 total
    expect(groups).toHaveLength(9);
    const turnSpeakers = groups
      .filter((g) => g.type === 'assistant-turn')
      .map((g) => g.speakerVpId);
    expect(turnSpeakers).toEqual(['vp-a', 'vp-b', 'vp-c', 'vp-d', 'vp-e']);
  });

  it('legacy 1:1 turn (no speakerVpId) renders no header', () => {
    const messages = [
      { type: 'user', content: 'hi' },
      asst({ content: 'hello' }), // no turnId, no speakerVpId
    ];

    const groups = buildTurnGroups(messages);

    expect(groups).toHaveLength(2);
    expect(groups[1].type).toBe('assistant-turn');
    expect(groups[1].speakerVpId).toBe(null);
    expect(groups[1].showSpeakerHeader).toBe(false);
  });

  it('empty user messages (tool_result artifacts) are skipped without flushing', () => {
    const messages = [
      asst({ content: 'a', turnId: 't1', speakerVpId: 'vp-a' }),
      { type: 'user', content: '' }, // artifact — must NOT split the turn
      asst({ content: 'b', turnId: 't1', speakerVpId: 'vp-a' }),
    ];

    const groups = buildTurnGroups(messages);

    // Single merged turn — empty user did not break the streak.
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('assistant-turn');
    expect(groups[0].textContent).toBe('ab');
  });

  it('latches speakerTimestamp from the first attributed message in the turn', () => {
    const messages = [
      asst({ content: 'a', turnId: 't1', speakerVpId: 'vp-a', timestamp: 1000 }),
      asst({ content: 'b', turnId: 't1', speakerVpId: 'vp-a', timestamp: 2000 }),
    ];

    const groups = buildTurnGroups(messages);

    expect(groups[0].speakerTimestamp).toBe(1000);
  });

  it('isStreaming bubbles up from any message in the turn', () => {
    const messages = [
      asst({ content: 'partial', turnId: 't1', speakerVpId: 'vp-a', isStreaming: true }),
    ];

    const groups = buildTurnGroups(messages);

    expect(groups[0].isStreaming).toBe(true);
  });
});
