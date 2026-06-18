const DEFAULT_ITEM_HEIGHT = 260;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const DEFAULT_OVERSCAN = 1;
const DEFAULT_ITEM_GAP = 18;
const MAX_ESTIMATED_HEIGHT = 1400;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function textLengthOf(value) {
  if (!value) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + textLengthOf(entry), 0);
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, entry) => sum + textLengthOf(entry), 0);
  }
  return String(value).length;
}

function estimateMessageHeight(message) {
  if (!message) return DEFAULT_ITEM_HEIGHT;
  const contentLength = textLengthOf(message.content || message.text || message.message || '');
  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  return clamp(110 + Math.ceil(contentLength / 90) * 18 + attachmentCount * 120, 120, MAX_ESTIMATED_HEIGHT);
}

function estimateAssistantTurnHeight(turn) {
  if (!turn) return DEFAULT_ITEM_HEIGHT;
  const textLength = textLengthOf(turn.text || turn.content || '');
  const toolCount = Array.isArray(turn.toolMsgs) ? turn.toolMsgs.length : 0;
  const imageCount = Array.isArray(turn.images) ? turn.images.length : 0;
  const askCount = Array.isArray(turn.askRequests) ? turn.askRequests.length : 0;
  return clamp(160 + Math.ceil(textLength / 95) * 18 + toolCount * 56 + imageCount * 140 + askCount * 96, 160, MAX_ESTIMATED_HEIGHT);
}

export function estimateVirtualItemHeight(item) {
  if (!item) return DEFAULT_ITEM_HEIGHT;
  if (item.type === 'message-block') {
    const children = Array.isArray(item.items) ? item.items : [];
    if (!children.length) return DEFAULT_ITEM_HEIGHT;
    return children.reduce((sum, child) => sum + estimateVirtualItemHeight(child), 0) + Math.max(0, children.length - 1) * DEFAULT_ITEM_GAP;
  }
  if (item.type === 'assistant-turn') return estimateAssistantTurnHeight(item);
  if (item.message) return estimateMessageHeight(item.message);
  return estimateMessageHeight(item);
}

export function getVirtualItemKey(item, index = 0) {
  return String(item?.id || item?.messageId || item?.turnId || `virtual_${index}`);
}

function heightForItem(item, index, heightCache, estimateHeight) {
  const key = getVirtualItemKey(item, index);
  const measured = heightCache instanceof Map ? heightCache.get(key) : heightCache?.[key];
  if (Number.isFinite(measured) && measured > 0) return measured;
  const estimated = estimateHeight ? estimateHeight(item, index) : estimateVirtualItemHeight(item);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : DEFAULT_ITEM_HEIGHT;
}

export function buildVirtualOffsets(items, heightCache = {}, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const itemGap = Math.max(0, Number(options.itemGap ?? DEFAULT_ITEM_GAP));
  const estimateHeight = options.estimateHeight || estimateVirtualItemHeight;
  const offsets = [0];
  const heights = [];

  for (let i = 0; i < list.length; i += 1) {
    const height = heightForItem(list[i], i, heightCache, estimateHeight);
    heights.push(height);
    offsets.push(offsets[i] + height + (i < list.length - 1 ? itemGap : 0));
  }

  return { offsets, heights, totalHeight: offsets[offsets.length - 1] || 0, itemGap };
}

function findStartIndex(offsets, scrollTop) {
  let lo = 0;
  let hi = Math.max(0, offsets.length - 2);
  let answer = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid + 1] <= scrollTop) {
      answer = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function findEndIndex(offsets, viewportBottom, itemCount) {
  let index = findStartIndex(offsets, viewportBottom);
  while (index < itemCount && offsets[index] < viewportBottom) index += 1;
  return clamp(index, 0, itemCount);
}

export function computeVirtualWindow(items, params = {}) {
  const list = Array.isArray(items) ? items : [];
  const itemCount = list.length;
  if (!itemCount) {
    return {
      start: 0,
      end: 0,
      visibleStart: 0,
      visibleEnd: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
      items: [],
    };
  }

  const scrollTop = Math.max(0, Number(params.scrollTop || 0));
  const viewportHeight = Math.max(1, Number(params.viewportHeight || DEFAULT_VIEWPORT_HEIGHT));
  const overscan = Math.max(0, Number(params.overscan ?? DEFAULT_OVERSCAN));
  const { offsets, totalHeight } = buildVirtualOffsets(list, params.heightCache || {}, params);
  const viewportBottom = scrollTop + viewportHeight;
  const visibleStart = clamp(findStartIndex(offsets, scrollTop), 0, itemCount - 1);
  const visibleEnd = clamp(findEndIndex(offsets, viewportBottom, itemCount), visibleStart + 1, itemCount);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(itemCount, visibleEnd + overscan);

  return {
    start,
    end,
    visibleStart,
    visibleEnd,
    topSpacerHeight: offsets[start] || 0,
    bottomSpacerHeight: Math.max(0, totalHeight - (offsets[end] || totalHeight)),
    totalHeight,
    items: list.slice(start, end).map((item, localIndex) => {
      const index = start + localIndex;
      return {
        item,
        index,
        key: getVirtualItemKey(item, index),
        top: offsets[index] || 0,
      };
    }),
  };
}

export function shouldFollowTranscriptBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, threshold = 80 } = {}) {
  return Math.max(0, Number(scrollHeight) - Number(scrollTop) - Number(clientHeight)) <= Math.max(0, Number(threshold));
}

export function adjustedScrollTopForMeasuredHeight({
  scrollTop = 0,
  itemIndex = 0,
  windowStart = 0,
  previousHeight = 0,
  nextHeight = 0,
  wasNearBottom = false,
  nextScrollHeight = 0,
} = {}) {
  if (wasNearBottom) return Math.max(0, Number(nextScrollHeight));
  if (Number(itemIndex) < Number(windowStart) && Number.isFinite(previousHeight) && Number.isFinite(nextHeight)) {
    return Math.max(0, Number(scrollTop) + Number(nextHeight) - Number(previousHeight));
  }
  return Math.max(0, Number(scrollTop));
}

export const virtualTranscriptDefaults = Object.freeze({
  itemHeight: DEFAULT_ITEM_HEIGHT,
  viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
  overscan: DEFAULT_OVERSCAN,
  itemGap: DEFAULT_ITEM_GAP,
});
