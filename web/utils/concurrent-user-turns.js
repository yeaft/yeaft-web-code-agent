/** UI identity is the root user message, never an engine execution turnId. */
export function isPendingUserTurn(turn) {
  return ['running', 'waiting', 'queued', 'cancelling'].includes(turn?.state);
}

export function userTurnExcerpt(message) {
  const text = String(message?.content || '').replace(/\s+/g, ' ').trim();
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

/** Stable root buckets keep supplements and interleaved executions together.
 * Message objects are not cloned: quote/search/fork references retain identity.
 */
export function orderUserTurnMessages(messages = []) {
  const userTurnByMessage = new Map();
  const roots = new Map();
  const buckets = new Map();
  let currentRoot = '';
  for (const message of messages) {
    if (message.type === 'user' && message.turnRelation !== 'supplement') {
      currentRoot = message.userTurnId || message.id || '';
      if (!roots.has(currentRoot)) roots.set(currentRoot, message);
    }
    const root = message.userTurnId || currentRoot;
    userTurnByMessage.set(message, root);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(message);
  }
  const time = id => {
    const row = roots.get(id);
    const value = row?.timestamp || row?.createdAt;
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  // An all-legacy transcript retains its exact original layout/order.
  if (!messages.some(message => message.userTurnId)) return { messages, userTurnByMessage, roots };
  const keys = [...buckets.keys()].sort((a, b) => {
    const left = time(a);
    const right = time(b);
    return left && right ? left - right : 0;
  });
  const ordered = keys.flatMap(key => {
    const bucket = buckets.get(key);
    // A confirmed append is another input to the original response, not a
    // response boundary. Keep inputs together before aggregating VP executions
    // so tools/text on either side of the append render in one AI block. Only
    // move explicitly routed supplements; optimistic/legacy user rows remain
    // boundaries. Stored order and message objects stay untouched.
    const supplements = bucket.filter(message => message.type === 'user'
      && message.userTurnId === key && message.turnRelation === 'supplement');
    if (!supplements.length) return bucket;
    const supplementSet = new Set(supplements);
    const rest = bucket.filter(message => !supplementSet.has(message));
    const rootIndex = rest.indexOf(roots.get(key));
    rest.splice(rootIndex + 1, 0, ...supplements);
    return rest;
  });
  return { messages: ordered, userTurnByMessage, roots };
}

export function partitionUserTurnBlocks(blocks = [], turns = []) {
  const pending = turns.filter(isPendingUserTurn).map(turn => ({ ...turn, blocks: [] }));
  const byId = new Map(pending.map(turn => [turn.userTurnId, turn]));
  const history = [];
  for (const block of blocks) {
    const turn = byId.get(block?.userTurnId);
    if (turn) turn.blocks.push(block);
    else history.push(block);
  }
  return { history, pending };
}
