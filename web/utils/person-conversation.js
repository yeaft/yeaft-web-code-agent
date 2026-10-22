// Canonical set identity: order/duplicates do not create another answer, while
// absent legacy metadata remains distinct from an explicit target set.
const replyTargets = message => Array.isArray(message.replyToMessageIds)
  ? [...new Set(message.replyToMessageIds.filter(id => typeof id === 'string' && id))].sort() : null;
const replyIdentity = message => JSON.stringify(replyTargets(message));

/**
 * Project one owner's ordered Digital Person message window into reading blocks.
 * Only adjacent assistant records with the same episode and reply targets group;
 * stored records, pagination cursors and ordinary Session rendering stay intact.
 * @param {Array<object>} messages Ordered, deduplicated Person message records.
 * @returns {Array<object>} User/system records or assistant blocks with parts.
 */
export function projectPersonConversation(messages) {
  const blocks = [];
  for (const message of messages) {
    const previous = blocks.at(-1);
    const episodeId = typeof message.episodeId === 'string' && message.episodeId ? message.episodeId : null;
    if (message.role === 'assistant' && episodeId && previous?.role === 'assistant' && previous.episodeId === episodeId
      && replyIdentity(previous) === replyIdentity(message)) {
      previous.parts.push(message);
    } else {
      blocks.push({ ...message, key: `message:${message.id}`, episodeId,
        ...(message.role === 'assistant' ? { parts: [message] } : {}) });
    }
  }
  return blocks;
}

/**
 * Create a view-owned projector retaining run identities by original part IDs.
 * The cache is bounded to the current window and reset on owner/Agent/Person
 * scope changes; neither ordinal position nor an extended first ID is identity.
 * @returns {(messages: Array<object>, scope: string) => Array<object>}
 */
export function createPersonConversationProjector() {
  let previousScope;
  let previousParts = new Map();
  let nextKey = 0;
  return (messages, scope) => {
    if (scope !== previousScope) {
      previousScope = scope;
      previousParts.clear();
      nextKey = 0;
    }
    const blocks = projectPersonConversation(messages);
    const nextParts = new Map();
    const usedKeys = new Set();
    for (const block of blocks) {
      if (block.role !== 'assistant' || !block.episodeId) continue;
      const targets = replyIdentity(block);
      const identity = block.parts.map(part => previousParts.get(part.id))
        .find(candidate => candidate?.episodeId === block.episodeId && candidate.targets === targets && !usedKeys.has(candidate.key));
      block.key = identity?.key || JSON.stringify(['reply', scope, nextKey++]);
      usedKeys.add(block.key);
      for (const part of block.parts) nextParts.set(part.id, { key: block.key, episodeId: block.episodeId, targets });
    }
    previousParts = nextParts;
    return blocks;
  };
}
