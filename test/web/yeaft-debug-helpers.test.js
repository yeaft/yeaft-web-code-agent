import { describe, expect, it } from 'vitest';

import {
  approxTokens,
  apportionToBuckets,
  formatClockTime,
  splitTokenBreakdown,
} from '../../web/components/yeaft-debug-helpers.js';

describe('yeaft-debug-helpers · approxTokens', () => {
  it('returns 0 for empty / null input', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens(null)).toBe(0);
    expect(approxTokens(undefined)).toBe(0);
  });

  it('counts ASCII as char/4 ceiling', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2); // 5/4=1.25 → 2
    expect(approxTokens('hello world')).toBe(3); // 11/4=2.75 → 3
  });

  it('counts CJK glyphs as ~1 token each', () => {
    expect(approxTokens('你好')).toBe(2);
    expect(approxTokens('你好世界')).toBe(4);
  });

  it('coerces non-strings safely', () => {
    expect(approxTokens(1234)).toBe(approxTokens('1234'));
  });
});

describe('yeaft-debug-helpers · splitTokenBreakdown', () => {
  it('returns zero-buckets for empty loop', () => {
    const out = splitTokenBreakdown({});
    expect(out).toEqual({
      inputMessageTokens: 0,
      inputToolTokens: 0,
      outputMessageTokens: 0,
      outputToolTokens: 0,
      inputTotalEstimated: 0,
      outputTotalEstimated: 0,
    });
  });

  it('attributes plain string user/assistant content to message bucket', () => {
    const loop = {
      messages: [
        { role: 'user', content: 'hello assistant' },
        { role: 'assistant', content: 'hi there user' },
      ],
    };
    const out = splitTokenBreakdown(loop);
    expect(out.inputMessageTokens).toBeGreaterThan(0);
    expect(out.inputToolTokens).toBe(0);
  });

  it('attributes assistant toolCalls (sibling field shape) to tool bucket', () => {
    const loop = {
      messages: [
        { role: 'user', content: 'do thing' },
        {
          role: 'assistant',
          content: 'sure',
          toolCalls: [{ id: 'c1', name: 'file_read', input: { path: '/tmp/x' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'file contents go here' },
      ],
    };
    const out = splitTokenBreakdown(loop);
    expect(out.inputMessageTokens).toBeGreaterThan(0); // 'do thing' + 'sure'
    expect(out.inputToolTokens).toBeGreaterThan(0); // tool name + input + tool result
  });

  it('attributes Anthropic block-array content correctly (text → message, tool_use/tool_result → tool)', () => {
    const loop = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'please look this up' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool_use', name: 'web_search', input: { q: 'rust async' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'search results: ...' },
          ],
        },
      ],
    };
    const out = splitTokenBreakdown(loop);
    expect(out.inputMessageTokens).toBeGreaterThan(0);
    expect(out.inputToolTokens).toBeGreaterThan(0);
    // assistant text should be in message bucket
    const messageOnly = splitTokenBreakdown({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'please look this up' }] }],
    });
    expect(messageOnly.inputToolTokens).toBe(0);
  });

  it('splits output: response text → message, toolCalls → tool', () => {
    const out = splitTokenBreakdown({
      response: 'here is the answer text',
      toolCalls: [{ id: 'c1', name: 'shell_run', input: { cmd: 'ls' } }],
    });
    expect(out.outputMessageTokens).toBeGreaterThan(0);
    expect(out.outputToolTokens).toBeGreaterThan(0);
  });

  it('handles tool_result with array content (multi-part)', () => {
    const loop = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [
                { type: 'text', text: 'part one of result' },
                { type: 'text', text: 'part two' },
              ],
            },
          ],
        },
      ],
    };
    const out = splitTokenBreakdown(loop);
    expect(out.inputToolTokens).toBeGreaterThan(0);
    expect(out.inputMessageTokens).toBe(0);
  });

  it('estimate totals equal sum of buckets', () => {
    const loop = {
      messages: [
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: 'xyz', toolCalls: [{ name: 't', input: 1 }] },
      ],
      response: 'reply text',
      toolCalls: [{ name: 'do', input: { a: 1 } }],
    };
    const out = splitTokenBreakdown(loop);
    expect(out.inputTotalEstimated).toBe(out.inputMessageTokens + out.inputToolTokens);
    expect(out.outputTotalEstimated).toBe(out.outputMessageTokens + out.outputToolTokens);
  });
});

describe('yeaft-debug-helpers · apportionToBuckets', () => {
  it('returns zero buckets when realTotal is 0', () => {
    expect(apportionToBuckets(0, 100, 50)).toEqual({ message: 0, tool: 0 });
  });

  it('returns realTotal in message when estimate is 0/0', () => {
    expect(apportionToBuckets(120, 0, 0)).toEqual({ message: 120, tool: 0 });
  });

  it('sum of buckets always equals realTotal (no drift)', () => {
    for (const [total, em, et] of [[100, 70, 30], [99, 13, 7], [1, 9, 5], [1234, 0, 5], [777, 3, 0]]) {
      const { message, tool } = apportionToBuckets(total, em, et);
      expect(message + tool).toBe(total);
      expect(message).toBeGreaterThanOrEqual(0);
      expect(tool).toBeGreaterThanOrEqual(0);
    }
  });

  it('apportions ratio close to estimate ratio', () => {
    const { message, tool } = apportionToBuckets(1000, 800, 200);
    // 80/20 split
    expect(message).toBe(800);
    expect(tool).toBe(200);
  });

  it('handles negative / NaN inputs by clamping to 0', () => {
    expect(apportionToBuckets(-5, 0, 0)).toEqual({ message: 0, tool: 0 });
    expect(apportionToBuckets(NaN, 10, 5)).toEqual({ message: 0, tool: 0 });
  });
});

describe('yeaft-debug-helpers · formatClockTime', () => {
  it('returns empty string for null / undefined / NaN', () => {
    expect(formatClockTime(null)).toBe('');
    expect(formatClockTime(undefined)).toBe('');
    expect(formatClockTime('')).toBe('');
    expect(formatClockTime(NaN)).toBe('');
    expect(formatClockTime('not-a-date')).toBe('');
  });

  it('formats epoch ms to HH:MM:SS (zero-padded, 24h)', () => {
    // Construct a date with known local-time components, then format.
    const d = new Date(2026, 5, 17, 9, 5, 7); // June 17, 09:05:07 local
    expect(formatClockTime(d.getTime())).toBe('09:05:07');
  });

  it('formats midnight as 00:00:00', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(formatClockTime(d.getTime())).toBe('00:00:00');
  });

  it('formats 23:59:59', () => {
    const d = new Date(2026, 11, 31, 23, 59, 59);
    expect(formatClockTime(d.getTime())).toBe('23:59:59');
  });

  it('parses ISO string input', () => {
    const d = new Date(2026, 5, 17, 14, 30, 45);
    const iso = d.toISOString();
    expect(formatClockTime(iso)).toBe('14:30:45');
  });

  it('parses numeric string input', () => {
    const d = new Date(2026, 5, 17, 8, 0, 0);
    expect(formatClockTime(String(d.getTime()))).toBe('08:00:00');
  });

  it('output matches HH:MM:SS regex always', () => {
    const samples = [
      Date.now(),
      0, // epoch — locale dependent but still valid HH:MM:SS form
      new Date(2026, 5, 17, 1, 2, 3).getTime(),
    ];
    for (const s of samples) {
      const out = formatClockTime(s);
      expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});
