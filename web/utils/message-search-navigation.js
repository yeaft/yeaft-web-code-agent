function addPersistedMessageId(ids, value) {
  if (typeof value !== 'string' || !/^m\d+$/.test(value) || ids.includes(value)) return;
  ids.push(value);
}

export function persistedMessageIdsForRenderedItem(item) {
  if (!item) return [];
  const ids = [];
  for (const message of Array.isArray(item.messages) ? item.messages : []) {
    addPersistedMessageId(ids, message?.id);
    addPersistedMessageId(ids, message?.messageId);
    addPersistedMessageId(ids, message?.persistedMessageId);
    for (const sourceId of Array.isArray(message?.sourceMessageIds) ? message.sourceMessageIds : []) {
      addPersistedMessageId(ids, sourceId);
    }
  }
  addPersistedMessageId(ids, item.message?.id);
  addPersistedMessageId(ids, item.messageId);
  addPersistedMessageId(ids, item.atMessageId);
  if (item.type !== 'assistant-turn') addPersistedMessageId(ids, item.id);
  return ids;
}

function renderedEntryIds(item) {
  const ids = [];
  const add = value => {
    if (typeof value === 'string' && value && !ids.includes(value)) ids.push(value);
  };
  add(item?.entryId);
  add(item?.message?.entryId);
  for (const message of Array.isArray(item?.messages) ? item.messages : []) add(message?.entryId);
  return ids;
}

const HISTORY_SEARCH_SURFACE_SELECTOR = [
  '.yeaft-conversation-outline',
  '.yeaft-conversation-outline-sender-menu',
  '.yeaft-search-btn',
].join(', ');

export function shouldDismissHistorySearch(target, eventPath = []) {
  if (target?.closest?.(HISTORY_SEARCH_SURFACE_SELECTOR)) return false;
  // A panel action can synchronously update state and remove its button before
  // the click reaches document. The dispatch-time composed path still records
  // that the click originated inside the panel, unlike target.closest().
  return !eventPath.some(node => node?.matches?.(HISTORY_SEARCH_SURFACE_SELECTOR));
}

export async function revealOutlineResult({ result, revealWindow, nextTick, revealMessage, isMobile, closeOutline }) {
  if (!result) return false;
  const expanded = await revealWindow?.(result);
  if (!expanded) return false;
  await nextTick?.();
  const revealed = await revealMessage?.(result);
  if (revealed && isMobile) closeOutline?.();
  return !!revealed;
}

export function resolvePersistedMessageTarget(blocks, target) {
  const entryId = typeof target?.entryId === 'string' ? target.entryId : null;
  const messageIds = [];
  for (const id of [
    ...(Array.isArray(target?.sourceMessageIds) ? target.sourceMessageIds : []),
    target?.messageId,
    typeof target === 'string' ? target : null,
  ]) addPersistedMessageId(messageIds, id);
  if (!entryId && messageIds.length === 0) return null;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue;
    const items = Array.isArray(block.items) ? block.items : [block];
    for (const item of items) {
      const entryMatches = entryId && renderedEntryIds(item).includes(entryId);
      const sourceMatches = messageIds.some(messageId => persistedMessageIdsForRenderedItem(item).includes(messageId));
      if (!entryMatches && !sourceMatches) continue;
      const rowId = item?.id;
      const blockId = block?.id;
      if (!rowId || !blockId) return null;
      return {
        blockId,
        rowId,
        collapseKey: block.responseCollapseKey || null,
        requiresExpansion: !!(block.responseCollapsed && item.type === 'assistant-turn'),
      };
    }
  }
  return null;
}

export async function navigateToPersistedMessage({
  blocks,
  target,
  messageId,
  collapseStates,
  scrollToBlock,
  findRow,
  anchorRow,
  flashRow,
  nextTick,
  align = 'start',
}) {
  const resolvedTarget = resolvePersistedMessageTarget(blocks, target || messageId);
  if (!resolvedTarget || typeof scrollToBlock !== 'function' || typeof findRow !== 'function') return false;

  if (resolvedTarget.requiresExpansion) {
    if (!resolvedTarget.collapseKey || !collapseStates) return false;
    collapseStates[resolvedTarget.collapseKey] = false;
    await nextTick?.();
  }

  const moved = await scrollToBlock(resolvedTarget.blockId, { align });
  if (!moved) return false;
  await nextTick?.();

  const row = findRow(resolvedTarget.rowId);
  if (!row) return false;
  if (typeof anchorRow === 'function') anchorRow(resolvedTarget.blockId, resolvedTarget.rowId, row, { align });
  else row.scrollIntoView?.({ block: align, inline: 'nearest' });
  flashRow?.(resolvedTarget.rowId);
  return true;
}
