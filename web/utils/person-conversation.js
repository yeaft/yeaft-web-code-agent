/**
 * Project one owner's ordered Digital Person message window into reading blocks.
 * Only adjacent assistant records with an explicit episode identity are grouped;
 * stored records, pagination cursors and ordinary Session rendering stay intact.
 * Keys count same-episode runs from the tail so an older page can extend a reply
 * without replacing its article or the already-visible section DOM nodes.
 * @param {Array<object>} messages Ordered, deduplicated Person message records.
 * @returns {Array<object>} User/system records or assistant blocks with parts.
 */
export function projectPersonConversation(messages) {
  const blocks = [];
  for (const message of messages) {
    const previous = blocks.at(-1);
    const episodeId = typeof message.episodeId === 'string' && message.episodeId ? message.episodeId : null;
    if (message.role === 'assistant' && episodeId && previous?.role === 'assistant' && previous.episodeId === episodeId) {
      previous.parts.push(message);
    } else {
      blocks.push({ ...message, key: `message:${message.id}`, episodeId,
        ...(message.role === 'assistant' ? { parts: [message] } : {}) });
    }
  }
  const runs = new Map();
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role !== 'assistant' || !block.episodeId) continue;
    const run = runs.get(block.episodeId) || 0;
    runs.set(block.episodeId, run + 1);
    block.key = JSON.stringify(['reply', block.episodeId, run]);
  }
  return blocks;
}
