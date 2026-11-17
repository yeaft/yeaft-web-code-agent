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

/**
 * Resolve each reading block to its loaded question, or its own opening for
 * autonomous/partial history. Explicit reply targets never borrow another topic.
 * Keys belong to the current owner-scoped projection, not persisted turn IDs.
 * @param {Array<object>} blocks Projected, ordered conversation blocks.
 * @returns {Map<string, string>} Response key -> navigation target key.
 */
export function personResponseOrigins(blocks) {
  const users = new Map();
  const episodeUsers = new Map();
  const origins = new Map();
  let previousUser;
  for (const block of blocks) {
    if (block.role === 'user') {
      users.set(block.messageId || block.id, block);
      previousUser = block;
      if (block.episodeId && !episodeUsers.has(block.episodeId)) episodeUsers.set(block.episodeId, block);
    } else if (block.role === 'assistant') {
      const targets = replyTargets(block);
      const question = targets !== null
        ? targets.map(id => users.get(id)).find(Boolean)
        : block.episodeId ? episodeUsers.get(block.episodeId) : previousUser;
      origins.set(block.key, question?.key || block.key);
    }
  }
  return origins;
}

/** Keep interleaved episodes in root-prompt order. Supplements retain their
 * episode bucket; legacy records without identity retain their relative order.
 * This is display-only: storage pagination continues to use the original rows.
 */
export function orderPersonEpisodeMessages(messages = []) {
  const buckets = new Map();
  for (const message of messages) {
    const key = message.episodeId || message;
    if (!buckets.has(key)) buckets.set(key, { rows: [], first: buckets.size });
    buckets.get(key).rows.push(message);
  }
  const time = bucket => {
    const root = bucket.rows.find(row => row.role === 'user') || bucket.rows[0];
    const at = new Date(root.createdAt).getTime();
    return Number.isFinite(at) ? at : null;
  };
  return [...buckets.values()].sort((a, b) => {
    const left = time(a), right = time(b);
    return left != null && right != null ? left - right || a.first - b.first : a.first - b.first;
  }).flatMap(bucket => bucket.rows);
}

/** Adapt public Person episodes to the shared user-turn presentation contract.
 * A missing array is a legacy Agent, not evidence that its execution finished.
 */
export function partitionPersonEpisodes(blocks = [], episodes) {
  const pending = [];
  const byId = new Map();
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const id = episode.episodeId || episode.id;
    if (!id || byId.has(id) || !['accepted', 'queued', 'running', 'waiting', 'paused', 'pausing', 'cancelling'].includes(episode.status)) continue;
    const turn = { userTurnId: id, episode, blocks: [],
      state: episode.status === 'cancelling' ? 'cancelling' : ['paused', 'pausing', 'waiting'].includes(episode.status) ? 'waiting'
        : ['queued', 'accepted'].includes(episode.status) ? 'queued' : 'running' };
    byId.set(id, turn);
    pending.push(turn);
  }
  const history = [];
  for (const block of blocks) {
    const turn = byId.get(block.episodeId);
    if (turn) turn.blocks.push(block); else history.push(block);
  }
  const at = turn => new Date(turn.blocks.find(block => block.role === 'user')?.createdAt ?? turn.episode.createdAt).getTime();
  pending.sort((a, b) => (at(a) || 0) - (at(b) || 0));
  for (const turn of pending) {
    // A long-running turn's initial prompt can be outside the latest page.
    const text = turn.episode.inputPreview || turn.blocks.find(block => block.role === 'user')?.text || '';
    const label = text.replace(/\s+/g, ' ').trim();
    turn.label = label.length > 36 ? `${label.slice(0, 36)}…` : label;
  }
  return { history, pending };
}
