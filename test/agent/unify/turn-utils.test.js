/**
 * Tests for `turn-utils.js`. The shared turn-identity primitives that
 * `history-compact.js` and `ConversationStore` both use to:
 *   - count turns (with `@vp-X` fan-out collapsing),
 *   - find the boundary of the (n)-th-from-end turn,
 *   - slice the last N turns out of a flat message array.
 */

import { describe, it, expect } from 'vitest';
import {
  stripVpMentionPrefix,
  countTurns,
  indexOfNthTurnFromEnd,
  sliceLastNTurns,
} from '../../../agent/unify/turn-utils.js';

describe('stripVpMentionPrefix', () => {
  it('strips the `@vp-<id> ` prefix', () => {
    expect(stripVpMentionPrefix('@vp-alice hello world')).toBe('hello world');
    expect(stripVpMentionPrefix('@vp-bob42 do the thing')).toBe('do the thing');
  });
  it('passes plain text through unchanged', () => {
    expect(stripVpMentionPrefix('plain prompt')).toBe('plain prompt');
  });
  it('handles non-string input', () => {
    expect(stripVpMentionPrefix(null)).toBe('');
    expect(stripVpMentionPrefix(undefined)).toBe('');
    expect(stripVpMentionPrefix(42)).toBe('');
  });
  it('does NOT strip mid-string @vp-X (only leading)', () => {
    expect(stripVpMentionPrefix('hi @vp-bob look at this')).toBe('hi @vp-bob look at this');
  });
});

describe('countTurns', () => {
  it('counts each distinct user message as one turn', () => {
    const ms = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    expect(countTurns(ms)).toBe(2);
  });

  it('collapses consecutive `@vp-X` variants of the same canonical text into one turn', () => {
    const ms = [
      { role: 'user', content: '@vp-a hello team' },
      { role: 'user', content: '@vp-b hello team' },
      { role: 'user', content: '@vp-c hello team' },
      { role: 'assistant', content: 'r' },
    ];
    expect(countTurns(ms)).toBe(1);
  });

  it('counts distinct turns even when each fans out to multiple VPs', () => {
    const ms = [
      { role: 'user', content: '@vp-a t1' },
      { role: 'user', content: '@vp-b t1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: '@vp-a t2' },
      { role: 'user', content: '@vp-b t2' },
      { role: 'assistant', content: 'r2' },
    ];
    expect(countTurns(ms)).toBe(2);
  });

  it('returns 0 for empty / null input', () => {
    expect(countTurns([])).toBe(0);
    expect(countTurns(null)).toBe(0);
  });
});

describe('indexOfNthTurnFromEnd', () => {
  it('returns -1 when fewer turns than requested', () => {
    const ms = [
      { role: 'user', content: 'only' },
      { role: 'assistant', content: 'r' },
    ];
    expect(indexOfNthTurnFromEnd(ms, 2)).toBe(-1);
  });

  it('returns -1 on empty input', () => {
    expect(indexOfNthTurnFromEnd([], 1)).toBe(-1);
    expect(indexOfNthTurnFromEnd(null, 1)).toBe(-1);
  });

  it('returns idx of the (n)-th-from-end turn for plain user msgs', () => {
    const ms = [
      { role: 'user', content: 'u0' },         // 0
      { role: 'assistant', content: 'a0' },    // 1
      { role: 'user', content: 'u1' },         // 2
      { role: 'assistant', content: 'a1' },    // 3
      { role: 'user', content: 'u2' },         // 4
      { role: 'assistant', content: 'a2' },    // 5
    ];
    expect(indexOfNthTurnFromEnd(ms, 1)).toBe(4); // u2
    expect(indexOfNthTurnFromEnd(ms, 2)).toBe(2); // u1
    expect(indexOfNthTurnFromEnd(ms, 3)).toBe(0); // u0
  });

  it('extends boundary backwards through @vp variants of the kept turn', () => {
    const ms = [
      { role: 'user', content: '@vp-a t1' },     // 0
      { role: 'user', content: '@vp-b t1' },     // 1
      { role: 'assistant', content: 'r1' },      // 2
      { role: 'user', content: '@vp-a t2' },     // 3
      { role: 'user', content: '@vp-b t2' },     // 4
      { role: 'user', content: '@vp-c t2' },     // 5
      { role: 'assistant', content: 'r2' },      // 6
      { role: 'user', content: '@vp-a t3' },     // 7
      { role: 'user', content: '@vp-b t3' },     // 8
      { role: 'assistant', content: 'r3' },      // 9
    ];
    // n=1 → start of t3 = idx 7
    expect(indexOfNthTurnFromEnd(ms, 1)).toBe(7);
    // n=2 → start of t2's FIRST @vp variant = idx 3 (not idx 5)
    expect(indexOfNthTurnFromEnd(ms, 2)).toBe(3);
    // n=3 → start of t1's FIRST @vp variant = idx 0
    expect(indexOfNthTurnFromEnd(ms, 3)).toBe(0);
  });

  it('n=0 returns past-the-end (caller treats as drop-everything)', () => {
    const ms = [{ role: 'user', content: 'u' }];
    expect(indexOfNthTurnFromEnd(ms, 0)).toBe(1);
  });
});

describe('sliceLastNTurns', () => {
  it('returns the suffix starting at the (n)-th-from-end turn', () => {
    const ms = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ];
    expect(sliceLastNTurns(ms, 2)).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('keeps the whole array if there are fewer turns than asked for', () => {
    const ms = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
    ];
    expect(sliceLastNTurns(ms, 5)).toEqual(ms);
    expect(sliceLastNTurns(ms, 5)).not.toBe(ms); // copy
  });

  it('returns [] for n<=0 or empty input', () => {
    expect(sliceLastNTurns([], 5)).toEqual([]);
    expect(sliceLastNTurns([{ role: 'user', content: 'u' }], 0)).toEqual([]);
  });

  it('keeps all `@vp-X` variants of the boundary turn together', () => {
    const ms = [
      { role: 'user', content: '@vp-a old' },
      { role: 'assistant', content: 'r-old' },
      { role: 'user', content: '@vp-a kept' },
      { role: 'user', content: '@vp-b kept' },
      { role: 'user', content: '@vp-c kept' },
      { role: 'assistant', content: 'r-kept' },
    ];
    const out = sliceLastNTurns(ms, 1);
    // All three @vp variants of the kept turn must be present.
    expect(out.filter(m => m.role === 'user').length).toBe(3);
    expect(out[0].content).toBe('@vp-a kept');
    expect(out[out.length - 1].content).toBe('r-kept');
  });

  it('preserves an `[assistant(toolCalls), tool…]` arc inside the kept window', () => {
    const ms = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old-r' },
      // kept turn:
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', toolCallId: 't1', content: 'output' },
      { role: 'assistant', content: 'done' },
    ];
    const out = sliceLastNTurns(ms, 1);
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe('user');
    expect(out[1].toolCalls?.[0].id).toBe('t1');
    expect(out[2].toolCallId).toBe('t1');
  });
});
