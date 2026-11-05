const MAX_PAGES_PER_GESTURE = 3;
const GESTURE_IDLE_MS = 250;

/** Nested tool/code output owns input while it can scroll in that direction. */
export function isHistoryScrollInput(target, scroller, direction) {
  if (!direction || !target || !scroller?.contains(target)) return false;
  let element = target.nodeType === 1 ? target : target.parentElement;
  while (element && element !== scroller) {
    const style = getComputedStyle(element);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
      const canScroll = direction < 0 ? element.scrollTop > 0
        : element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      if (canScroll || ['contain', 'none'].includes(style.overscrollBehaviorY)) return false;
    }
    element = element.parentElement;
  }
  return true;
}

/**
 * A user-owned budget for older-history prefetch. Layout/scroll events never
 * replenish it. Wheel bursts share a budget; touch/key/scrollbar handlers can
 * explicitly identify a new gesture. A click starts a fresh bounded batch.
 */
export function createHistoryPageBudget() {
  let remaining = 0;
  let lastInputAt = null;
  let lastDirection = 0;

  return {
    recordInput({ direction, newGesture, now = Date.now() }) {
      if (!direction) return;
      if (direction < 0) {
        if (newGesture === true || (newGesture !== false
          && (lastDirection !== -1 || lastInputAt == null || now - lastInputAt >= GESTURE_IDLE_MS))) {
          remaining = MAX_PAGES_PER_GESTURE;
        }
        lastDirection = -1;
      } else {
        remaining = 0;
        lastDirection = 1;
      }
      lastInputAt = now;
    },
    start() {
      remaining = MAX_PAGES_PER_GESTURE;
      lastInputAt = Date.now();
      lastDirection = -1;
    },
    consume() {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
    stop() {
      remaining = 0;
    },
    reset() {
      remaining = 0;
      lastInputAt = null;
      lastDirection = 0;
    },
  };
}
