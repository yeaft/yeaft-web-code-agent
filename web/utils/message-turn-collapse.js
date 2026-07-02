const DEFAULT_EXPANDED_RECENT_USER_TURNS = 2;
const COLLAPSED_RESPONSE_PREVIEW_HEIGHT = 36;
const RESPONSE_TOGGLE_HEIGHT = 28;

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

export function responseItemsForMessageBlock(block) {
  const items = Array.isArray(block?.items) ? block.items : [];
  return items.filter(isResponseItem);
}

export function responseCountForMessageBlock(block) {
  return responseItemsForMessageBlock(block).length;
}

export function firstResponseItemForMessageBlock(block) {
  const responses = responseItemsForMessageBlock(block);
  return responses.length ? responses[0] : null;
}

export function textContentOfResponseItem(item) {
  const text = item?.textContent ?? item?.text ?? item?.content ?? item?.message?.content ?? '';
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text.map(entry => {
      if (typeof entry === 'string') return entry;
      if (entry && entry.type === 'text') return entry.text || '';
      return '';
    }).join('');
  }
  return text == null ? '' : String(text);
}

export function collapsedResponsePreviewForMessageBlock(block) {
  if (!block?.responseCollapsed) return '';
  const firstResponse = firstResponseItemForMessageBlock(block);
  const text = textContentOfResponseItem(firstResponse)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\(([^)]*)\)/g, '')
    .replace(/[#>*_~\-]+/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return text || '';
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
    const explicitCollapsed = collapseStates?.[responseCollapseKey];
    const hasExplicitState = responseCollapseKey in (collapseStates || {});
    const responseCollapsed = responseCollapsible
      ? (hasExplicitState ? !!explicitCollapsed : defaultCollapsed)
      : false;

    return {
      ...block,
      responseCollapseKey,
      responseCollapsible,
      responseCollapsed,
      responseCount,
      collapsedResponsePreview: responseCollapsed ? collapsedResponsePreviewForMessageBlock({ ...block, responseCollapsed }) : '',
      visibleItemCount: visibleItemsForMessageBlock({ ...block, responseCollapsed }).length,
    };
  });
}

export function estimateCollapsedMessageBlockHeight(block, estimateItemHeight) {
  if (!block?.responseCollapsed || typeof estimateItemHeight !== 'function') return null;
  const visibleItems = visibleItemsForMessageBlock(block);
  const previewHeight = collapsedResponsePreviewForMessageBlock(block) ? COLLAPSED_RESPONSE_PREVIEW_HEIGHT : 0;
  const visibleChildren = visibleItems.length + (previewHeight ? 1 : 0);
  if (!visibleItems.length) return previewHeight + RESPONSE_TOGGLE_HEIGHT;
  const childrenHeight = visibleItems.reduce((sum, item) => sum + estimateItemHeight(item), 0);
  const visibleGapHeight = Math.max(0, visibleChildren - 1) * 18;
  return childrenHeight + visibleGapHeight + previewHeight + RESPONSE_TOGGLE_HEIGHT;
}

export { DEFAULT_EXPANDED_RECENT_USER_TURNS };
