import { describe, expect, it } from 'vitest';
import {
  adjustedScrollTopForMeasuredHeight,
  buildVirtualOffsets,
  computeVirtualWindow,
  estimateVirtualItemHeight,
  getVirtualItemKey,
  shouldFollowTranscriptBottom,
} from '../../web/utils/virtual-transcript.js';

function turns(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    type: 'assistant-turn',
    text: `assistant response ${index}`,
    toolMsgs: [],
  }));
}

describe('virtual transcript range calculation', () => {
  it('renders only viewport-adjacent turns from a large transcript', () => {
    const items = turns(1000);
    const heightCache = Object.fromEntries(items.map((item) => [item.id, 100]));

    const window = computeVirtualWindow(items, {
      heightCache,
      scrollTop: 0,
      viewportHeight: 300,
      overscan: 1,
      itemGap: 0,
    });

    expect(window.start).toBe(0);
    expect(window.end).toBe(4);
    expect(window.items.map((entry) => entry.key)).toEqual(['turn-0', 'turn-1', 'turn-2', 'turn-3']);
    expect(window.items.length).toBeLessThan(8);
    expect(window.bottomSpacerHeight).toBe(99600);
  });

  it('switches the render window when scrolling into the middle', () => {
    const items = turns(1000);
    const heightCache = Object.fromEntries(items.map((item) => [item.id, 100]));

    const window = computeVirtualWindow(items, {
      heightCache,
      scrollTop: 50000,
      viewportHeight: 300,
      overscan: 1,
      itemGap: 0,
    });

    expect(window.start).toBe(499);
    expect(window.end).toBe(504);
    expect(window.items.map((entry) => entry.key)).toEqual(['turn-499', 'turn-500', 'turn-501', 'turn-502', 'turn-503']);
    expect(window.topSpacerHeight).toBe(49900);
    expect(window.bottomSpacerHeight).toBe(49600);
  });

  it('keeps Yeaft message-block children together as one virtual item', () => {
    const items = [
      {
        id: 'session-turn-1',
        type: 'message-block',
        vpId: 'vp-dev',
        items: [
          { id: 'user-1', type: 'user', message: { content: 'Build it' } },
          { id: 'vp-1', type: 'assistant-turn', speakerVpId: 'vp-dev', text: 'Done' },
        ],
      },
      { id: 'session-turn-2', type: 'assistant-turn', speakerVpId: 'vp-review', text: 'Review' },
    ];

    const window = computeVirtualWindow(items, {
      heightCache: { 'session-turn-1': 240, 'session-turn-2': 120 },
      scrollTop: 0,
      viewportHeight: 180,
      overscan: 0,
      itemGap: 18,
    });

    expect(window.items).toHaveLength(1);
    expect(window.items[0].item.type).toBe('message-block');
    expect(window.items[0].item.items.map((item) => item.id)).toEqual(['user-1', 'vp-1']);
  });

  it('accounts for measured heights and item gaps in spacers', () => {
    const items = turns(4);
    const offsets = buildVirtualOffsets(items, {
      'turn-0': 50,
      'turn-1': 60,
      'turn-2': 70,
      'turn-3': 80,
    }, { itemGap: 10 });

    expect(offsets.offsets).toEqual([0, 60, 130, 210, 290]);
    expect(offsets.totalHeight).toBe(290);

    const window = computeVirtualWindow(items, {
      heightCache: {
        'turn-0': 50,
        'turn-1': 60,
        'turn-2': 70,
        'turn-3': 80,
      },
      scrollTop: 130,
      viewportHeight: 70,
      overscan: 0,
      itemGap: 10,
    });

    expect(window.start).toBe(2);
    expect(window.topSpacerHeight).toBe(130);
    expect(window.bottomSpacerHeight).toBe(80);
  });

  it('estimates taller heights for long messages before measurement', () => {
    const shortTurn = { id: 'short', type: 'assistant-turn', text: 'ok', toolMsgs: [] };
    const longTurn = { id: 'long', type: 'assistant-turn', text: 'x'.repeat(5000), toolMsgs: [{ toolName: 'Bash' }] };

    expect(estimateVirtualItemHeight(longTurn)).toBeGreaterThan(estimateVirtualItemHeight(shortTurn));
    expect(getVirtualItemKey(longTurn, 0)).toBe('long');
  });

  it('distinguishes bottom-follow from reading history', () => {
    expect(shouldFollowTranscriptBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80, threshold: 80 })).toBe(true);
    expect(shouldFollowTranscriptBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 80, threshold: 80 })).toBe(false);
  });

  it('keeps the current anchor stable when measured heights above the window change', () => {
    expect(adjustedScrollTopForMeasuredHeight({
      scrollTop: 500,
      itemIndex: 2,
      windowStart: 5,
      previousHeight: 100,
      nextHeight: 140,
    })).toBe(540);

    expect(adjustedScrollTopForMeasuredHeight({
      scrollTop: 500,
      itemIndex: 6,
      windowStart: 5,
      previousHeight: 100,
      nextHeight: 140,
    })).toBe(500);
  });

  it('pins to the bottom when the user was already at the bottom', () => {
    expect(adjustedScrollTopForMeasuredHeight({
      scrollTop: 900,
      itemIndex: 2,
      windowStart: 5,
      previousHeight: 100,
      nextHeight: 140,
      wasNearBottom: true,
      nextScrollHeight: 1200,
    })).toBe(1200);
  });
});
