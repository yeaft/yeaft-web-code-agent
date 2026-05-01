/**
 * Tests for `pair-sanitize.js`. The helper must drop tool_use/tool_result
 * orphans (Strategy B) so a sliced message stream is safe to send to the
 * Anthropic / Chat-Completions adapter — both reject mismatched pairs.
 */

import { describe, it, expect } from 'vitest';
import { pairSanitize, hasOrphanPairs } from '../../../agent/unify/pair-sanitize.js';

describe('pairSanitize', () => {
  it('returns [] for empty / non-array input', () => {
    expect(pairSanitize([])).toEqual([]);
    expect(pairSanitize(null)).toEqual([]);
    expect(pairSanitize(undefined)).toEqual([]);
  });

  it('passes through a clean message stream untouched', () => {
    const ms = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', toolCallId: 't1', content: 'output' },
      { role: 'assistant', content: 'done' },
    ];
    const out = pairSanitize(ms);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(ms[0]);
    expect(out[1]).not.toBe(ms[1]); // copy (we replace toolCalls)
    expect(out[1].toolCalls).toEqual([{ id: 't1', name: 'bash', input: {} }]);
    expect(out[2]).toBe(ms[2]);
    expect(out[3]).toBe(ms[3]);
  });

  it('drops a tool message whose owning assistant is missing', () => {
    // Simulates a slice that landed mid-arc: tool_result without preceding tool_use.
    const ms = [
      { role: 'tool', toolCallId: 't1', content: 'orphan output' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'ok' },
    ];
    const out = pairSanitize(ms);
    expect(out).toEqual([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('strips orphan toolCalls from an assistant whose tool result is missing', () => {
    // Simulates a slice that ended mid-arc: tool_use never gets its tool_result.
    const ms = [
      {
        role: 'assistant',
        content: 'running things',
        toolCalls: [
          { id: 't1', name: 'bash', input: { command: 'ls' } },
          { id: 't2', name: 'bash', input: { command: 'pwd' } },
        ],
      },
      { role: 'tool', toolCallId: 't1', content: 'output A' },
      // t2 has no tool_result in the slice.
    ];
    const out = pairSanitize(ms);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe('running things');
    expect(out[0].toolCalls).toEqual([{ id: 't1', name: 'bash', input: { command: 'ls' } }]);
    expect(out[1]).toEqual({ role: 'tool', toolCallId: 't1', content: 'output A' });
  });

  it('drops an assistant message whose every tool_use is orphaned and has no text', () => {
    const ms = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'orphan', name: 'bash', input: {} }],
      },
      // No tool_result for `orphan` in slice → assistant is empty → drop.
      { role: 'user', content: 'next' },
    ];
    const out = pairSanitize(ms);
    expect(out).toEqual([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('keeps an assistant whose tool_uses are orphaned IF it has text', () => {
    const ms = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'I tried but the result is gone',
        toolCalls: [{ id: 'orphan', name: 'bash', input: {} }],
      },
    ];
    const out = pairSanitize(ms);
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe('I tried but the result is gone');
    expect(out[1].toolCalls).toEqual([]); // emptied, not removed
  });

  it('drops a tool message that has no toolCallId at all', () => {
    const ms = [
      { role: 'user', content: 'x' },
      { role: 'tool', content: 'mystery output' }, // missing toolCallId
    ];
    const out = pairSanitize(ms);
    expect(out).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('handles a multi-call assistant where some calls survive', () => {
    const ms = [
      {
        role: 'assistant',
        content: 'parallel calls',
        toolCalls: [
          { id: 'a', name: 'bash', input: {} },
          { id: 'b', name: 'bash', input: {} },
          { id: 'c', name: 'bash', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: 'A' },
      { role: 'tool', toolCallId: 'c', content: 'C' },
      // b orphaned
    ];
    const out = pairSanitize(ms);
    expect(out).toHaveLength(3);
    expect(out[0].toolCalls.map(t => t.id)).toEqual(['a', 'c']);
    expect(out[1].toolCallId).toBe('a');
    expect(out[2].toolCallId).toBe('c');
  });

  it('is idempotent (sanitize(sanitize(x)) === sanitize(x))', () => {
    const ms = [
      { role: 'tool', toolCallId: 'x', content: 'orphan' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', toolCalls: [{ id: 'unmatched', name: 'bash', input: {} }] },
    ];
    const once = pairSanitize(ms);
    const twice = pairSanitize(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate the input array', () => {
    const ms = [
      { role: 'tool', toolCallId: 't', content: 'orphan' },
      { role: 'user', content: 'q' },
    ];
    const before = JSON.parse(JSON.stringify(ms));
    pairSanitize(ms);
    expect(ms).toEqual(before);
  });

  it('handles a tail-half slice (begins with orphan tool, ends mid-arc)', () => {
    // Realistic: someone did `messages.slice(-N)` and landed in the middle.
    const ms = [
      // orphan leading tool from a now-folded assistant
      { role: 'tool', toolCallId: 'old', content: 'old result' },
      { role: 'user', content: 'fresh question' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'bash', input: {} }] },
      // tool_result for 'new' got cut off the END of the slice
    ];
    const out = pairSanitize(ms);
    // 'old' tool dropped (orphan), 'new' assistant dropped (tool_use orphan + no text).
    expect(out).toEqual([{ role: 'user', content: 'fresh question' }]);
  });
});

describe('hasOrphanPairs', () => {
  it('returns false on a clean stream', () => {
    expect(hasOrphanPairs([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'bash', input: {} }] },
      { role: 'tool', toolCallId: 't', content: 'r' },
    ])).toBe(false);
  });

  it('returns true when an orphan tool message exists', () => {
    expect(hasOrphanPairs([
      { role: 'tool', toolCallId: 'orphan', content: 'r' },
    ])).toBe(true);
  });

  it('returns true when an assistant has an orphan tool_use', () => {
    expect(hasOrphanPairs([
      { role: 'assistant', content: '', toolCalls: [{ id: 'orphan', name: 'bash', input: {} }] },
    ])).toBe(true);
  });

  it('returns false on empty / null input', () => {
    expect(hasOrphanPairs([])).toBe(false);
    expect(hasOrphanPairs(null)).toBe(false);
  });
});
