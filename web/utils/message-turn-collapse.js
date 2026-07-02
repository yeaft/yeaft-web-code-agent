const DEFAULT_EXPANDED_RECENT_USER_TURNS = 2;
const RESPONSE_TOGGLE_HEIGHT = 44;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export function messageTurnBlockKey(block, index = 0) {
  return String(
    block?.collapseKey
      || block?.messageId
      || block?.id
      || `message_turn_${index}`
  );
}

export function isUserPromptItem(item) {
  return item?.type === 'user';
}

export function isResponseItem(item) {
  if (!item) return false;
  return item.type !== 'user' && item.type !== 'system' && item.type !== 'error';
}

export function isStreamingResponseItem(item) {
  if (!isResponseItem(item)) return false;
  if (item.isStreaming) return true;
  if (item.turn && item.turn.isStreaming) return true;
  if (item.message && item.message.isStreaming) return true;
  return false;
}

export function visibleItemsForMessageBlock(block) {
  const items = Array.isArray(block?.items) ? block.items : [];
  if (!block?.responseCollapsed) return items;
  return items.filter(item => !isResponseItem(item));
}

export function responseCountForMessageBlock(block) {
  const items = Array.isArray(block?.items) ? block.items : [];
  return items.filter(isResponseItem).length;
}

export function annotateMessageBlocksForResponseCollapse(blocks, collapseStates = {}, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const expandedRecentUserTurns = Math.max(0, Number(
    options.expandedRecentUserTurns ?? DEFAULT_EXPANDED_RECENT_USER_TURNS
  ));
  const userTurnIndexes = [];

  list.forEach((block, index) => {
    if (block?.type !== 'message-block') return;
    const items = Array.isArray(block.items) ? block.items : [];
    if (items.some(isUserPromptItem)) userTurnIndexes.push(index);
  });

  const expandedByDefault = new Set(
    expandedRecentUserTurns > 0 ? userTurnIndexes.slice(-expandedRecentUserTurns) : []
  );

  return list.map((block, index) => {
    if (block?.type !== 'message-block') return block;

    const items = Array.isArray(block.items) ? block.items : [];
    const hasUserPrompt = items.some(isUserPromptItem);
    const responseCount = responseCountForMessageBlock(block);
    const hasStreamingResponse = items.some(isStreamingResponseItem);
    const responseCollapsible = hasUserPrompt && responseCount > 0 && !hasStreamingResponse;
    const responseCollapseKey = messageTurnBlockKey(block, index);
    const defaultCollapsed = responseCollapsible && !expandedByDefault.has(index);
    const responseCollapsed = responseCollapsible
      ? (hasOwn(collapseStates, responseCollapseKey) ? !!collapseStates[responseCollapseKey] : defaultCollapsed)
      : false;

    return {
      ...block,
      responseCollapseKey,
      responseCollapsible,
      responseCollapsed,
      responseCount,
      visibleItemCount: visibleItemsForMessageBlock({ ...block, responseCollapsed }).length,
    };
  });
}

export function estimateCollapsedMessageBlockHeight(block, estimateItemHeight) {
  if (!block?.responseCollapsed || typeof estimateItemHeight !== 'function') return null;
  const visibleItems = visibleItemsForMessageBlock(block);
  if (!visibleItems.length) return RESPONSE_TOGGLE_HEIGHT;
  const childrenHeight = visibleItems.reduce((sum, item) => sum + estimateItemHeight(item), 0);
  const visibleGapHeight = Math.max(0, visibleItems.length - 1) * 18;
  return childrenHeight + visibleGapHeight + RESPONSE_TOGGLE_HEIGHT;
}

export { DEFAULT_EXPANDED_RECENT_USER_TURNS };
