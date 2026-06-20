import { describe, expect, it } from 'vitest';

import YeaftDebugPanel from '../../web/components/YeaftDebugPanel.js';

function callMethod(name, ...args) {
  const methods = YeaftDebugPanel.methods;
  return methods[name].call(methods, ...args);
}

describe('Yeaft debug cache token display', () => {
  it('shows cached prompt tokens as part of total input', () => {
    const usage = {
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      totalInputTokens: 1220,
      totalTokens: 1227,
    };

    expect(callMethod('usageTotalInputTokens', usage)).toBe(1220);
    expect(callMethod('usageTotalTokens', usage)).toBe(1227);
    expect(callMethod('formatUsageBreakdown', usage)).toBe(
      '1220 in / 7 out / 1227 total (fresh 20, cache read 1000, cache write 200)'
    );
  });

  it('does not imply cached OpenAI tokens are additional when already included', () => {
    const usage = { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 0, totalInputTokens: 100, totalTokens: 125 };

    expect(callMethod('usageTotalInputTokens', usage)).toBe(100);
    expect(callMethod('usageTotalTokens', usage)).toBe(125);
    expect(callMethod('formatUsageBreakdown', usage)).toBe(
      '100 in / 25 out / 125 total (input includes cache read 40, cache write 0)'
    );
  });

  it('keeps non-cached usage display unchanged', () => {
    const usage = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };

    expect(callMethod('usageTotalInputTokens', usage)).toBe(100);
    expect(callMethod('usageTotalTokens', usage)).toBe(125);
    expect(callMethod('formatUsageBreakdown', usage)).toBe('100 in / 25 out / 125 total');
  });
});


describe('Yeaft debug request-level token distribution', () => {
  it('selects the highest-token loop for the request header split', () => {
    const turn = callMethod('decorateTurnTokenBreakdowns', {
      turnId: 'turn-1',
      totalTokens: 120,
      loops: [
        { loopNumber: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, messages: [{ role: 'user', content: 'small' }] },
        { loopNumber: 2, usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 }, messages: [{ role: 'user', content: 'large request body' }] },
      ],
    });

    expect(turn.maxLoopNumber).toBe(2);
    expect(turn.maxLoopTokenTotal).toBe(120);
    expect(turn.maxLoopTokenBreakdown).toBeTruthy();
  });
});
