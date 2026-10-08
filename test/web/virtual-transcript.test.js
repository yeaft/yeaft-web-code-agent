import { describe, expect, it } from 'vitest';
import {
  adjustedScrollTopForMeasuredHeight,
  buildVirtualOffsets,
  computeVirtualWindow,
  computeVirtualWindowFromLayout,
  estimateVirtualItemHeight,
  getVirtualItemKey,
  historyPrefetchThreshold,
  isTranscriptScrollbarPointer,
  isTranscriptScrollKey,
  resolveTranscriptBottomFollow,
  resolveTranscriptUserFollow,
  shouldFollowTranscriptBottom,
  shouldMarkTranscriptKeyScroll,
  virtualScrollTopForIndex,
  virtualTranscriptDefaults,
} from '../../web/utils/virtual-transcript.js';

function turns(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    type: 'assistant-turn',
    text: `assistant response ${index}`,
    toolMsgs: [],
  }));
}

describe('virtual transcript targeted navigation', () => {
  it('computes a centered offset for an unmounted item from cached heights', () => {
    const items = turns(10);
    const heightCache = Object.fromEntries(items.map(item => [item.id, 100]));
    expect(virtualScrollTopForIndex(items, 5, heightCache, {
      viewportHeight: 300,
      itemGap: 0,
      align: 'center',
    })).toBe(400);
  });
});

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

  it('reuses precomputed offsets across scroll window updates', () => {
    const items = turns(1000);
    let estimateCalls = 0;
    const estimateHeight = () => {
      estimateCalls += 1;
      return 100;
    };
    const layout = buildVirtualOffsets(items, {}, { itemGap: 0, estimateHeight });

    for (let scrollTop = 0; scrollTop < 50000; scrollTop += 500) {
      const window = computeVirtualWindowFromLayout(items, layout, {
        scrollTop,
        viewportHeight: 300,
        overscan: 1,
      });
      expect(window.items.length).toBeLessThan(8);
    }

    expect(estimateCalls).toBe(items.length);
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
    const longTurn = { id: 'long', type: 'assistant-turn', textContent: 'x'.repeat(5000), toolMsgs: [{ toolName: 'Bash' }] };

    expect(estimateVirtualItemHeight(longTurn)).toBeGreaterThan(estimateVirtualItemHeight(shortTurn));
    expect(getVirtualItemKey(longTurn, 0)).toBe('long');
  });

  it('prefetches history before the viewport reaches the loaded boundary', () => {
    expect(virtualTranscriptDefaults.historyPrefetchViewports).toBe(2);
    expect(virtualTranscriptDefaults.historyPrefetchMinPx).toBe(600);
    expect(historyPrefetchThreshold(720)).toBe(1440);
    expect(historyPrefetchThreshold(200)).toBe(600);
  });

  it('distinguishes bottom-follow from reading history', () => {
    expect(virtualTranscriptDefaults.bottomThreshold).toBe(80);
    expect(virtualTranscriptDefaults.resumeBottomThreshold).toBe(2);
    expect(shouldFollowTranscriptBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 })).toBe(true);
    expect(shouldFollowTranscriptBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 80 })).toBe(false);
  });

  it('keeps bottom following disabled across layout updates until the user returns', () => {
    expect(resolveTranscriptBottomFollow({ following: false, atBottom: true })).toBe(false);
    expect(resolveTranscriptBottomFollow({ following: true, atBottom: false })).toBe(true);
    expect(resolveTranscriptBottomFollow({ following: true, atBottom: true })).toBe(true);
    expect(resolveTranscriptBottomFollow({ following: false, atBottom: true, userScroll: true })).toBe(true);
    expect(resolveTranscriptBottomFollow({ following: true, atBottom: false, userScroll: true })).toBe(false);

    // A user scroll can remain inside the near-bottom threshold. User intent
    // still owns the viewport, so live messages must not resume follow.
    expect(resolveTranscriptUserFollow({ following: true, atBottom: true, userScroll: true })).toBe(false);
    expect(resolveTranscriptUserFollow({ following: true, atBottom: false, userScroll: true })).toBe(false);
    expect(resolveTranscriptUserFollow({ following: false, atBottom: true, userScroll: true })).toBe(false);
    expect(resolveTranscriptUserFollow({ following: true, atBottom: true, userScroll: false })).toBe(true);
    expect(resolveTranscriptUserFollow({ following: true, atBottom: false, userScroll: false })).toBe(true);
    expect(resolveTranscriptUserFollow({ following: false, atBottom: true, userScroll: false })).toBe(false);
    expect(shouldFollowTranscriptBottom({ scrollTop: 890, scrollHeight: 1000, clientHeight: 80, threshold: 80 })).toBe(true);
    expect(shouldFollowTranscriptBottom({ scrollTop: 890, scrollHeight: 1000, clientHeight: 80, threshold: 2 })).toBe(false);
  });

  it('recognizes keyboard actions that explicitly scroll the transcript', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
      expect(isTranscriptScrollKey(key)).toBe(true);
    }
    expect(isTranscriptScrollKey('Enter')).toBe(false);
    expect(isTranscriptScrollKey('a')).toBe(false);
  });

  it('only treats primary pointer input in the transcript scrollbar gutter as scrolling', () => {
    const scroller = {
      clientWidth: 780,
      offsetWidth: 800,
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 100, bottom: 700 }),
    };

    expect(isTranscriptScrollbarPointer({ button: 0, clientX: 790, clientY: 400 }, scroller)).toBe(true);
    expect(isTranscriptScrollbarPointer({ button: 0, clientX: 400, clientY: 400 }, scroller)).toBe(false);
    expect(isTranscriptScrollbarPointer({ button: 1, clientX: 790, clientY: 400 }, scroller)).toBe(false);
    expect(isTranscriptScrollbarPointer({ button: 0, clientX: 790, clientY: 50 }, scroller)).toBe(false);
  });

  it('only marks unhandled scroll keys aimed at the transcript surface', () => {
    const body = { closest: () => null };
    const documentElement = { closest: () => null };
    const scroller = { closest: () => null };
    const documentRef = { body, documentElement };
    const button = { closest: selector => selector.startsWith('button') ? button : null };
    const messageChild = { closest: () => null };
    const link = { closest: () => null };
    const editor = { closest: selector => selector.startsWith('input') ? editor : null };
    scroller.contains = target => [button, messageChild, link, editor].includes(target);

    expect(shouldMarkTranscriptKeyScroll({ key: 'End', target: scroller }, scroller, documentRef)).toBe(true);
    expect(shouldMarkTranscriptKeyScroll({ key: 'PageDown', target: body }, scroller, documentRef)).toBe(true);
    expect(shouldMarkTranscriptKeyScroll({ key: ' ', target: button }, scroller, documentRef)).toBe(false);
    expect(shouldMarkTranscriptKeyScroll({ key: 'End', target: messageChild }, scroller, documentRef)).toBe(true);
    expect(shouldMarkTranscriptKeyScroll({ key: 'PageUp', target: link }, scroller, documentRef)).toBe(true);
    expect(shouldMarkTranscriptKeyScroll({ key: 'PageUp', target: button }, scroller, documentRef)).toBe(true);
    expect(shouldMarkTranscriptKeyScroll({ key: 'PageUp', target: editor }, scroller, documentRef)).toBe(false);
    expect(shouldMarkTranscriptKeyScroll({ key: 'End', target: scroller, defaultPrevented: true }, scroller, documentRef)).toBe(false);
    expect(shouldMarkTranscriptKeyScroll({ key: 'Enter', target: scroller }, scroller, documentRef)).toBe(false);
  });

  it('does not resume paused following after non-scroll controls trigger layout work', () => {
    const scroller = {
      clientWidth: 780,
      offsetWidth: 800,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }),
    };
    const button = { closest: () => button };
    const pointerQualified = isTranscriptScrollbarPointer({ button: 0, clientX: 400, clientY: 300 }, scroller);
    const keyQualified = shouldMarkTranscriptKeyScroll({ key: ' ', target: button }, scroller, { body: {} });

    expect(resolveTranscriptBottomFollow({ following: false, atBottom: true, userScroll: pointerQualified })).toBe(false);
    expect(resolveTranscriptBottomFollow({ following: false, atBottom: true, userScroll: keyQualified })).toBe(false);
  });

  it('keeps following paused even when a scrollbar drag or transcript End reaches bottom', () => {
    const scroller = {
      clientWidth: 780,
      offsetWidth: 800,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }),
    };
    const pointerQualified = isTranscriptScrollbarPointer({ button: 0, clientX: 790, clientY: 300 }, scroller);
    const keyQualified = shouldMarkTranscriptKeyScroll({ key: 'End', target: scroller }, scroller, { body: {} });

    expect(resolveTranscriptUserFollow({ following: true, atBottom: true, userScroll: pointerQualified })).toBe(false);
    expect(resolveTranscriptUserFollow({ following: true, atBottom: true, userScroll: keyQualified })).toBe(false);
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
