/** UI identity is the root user message, never an engine execution turnId. */
export function isPendingUserTurn(turn) {
  return ['running', 'waiting', 'queued', 'cancelling'].includes(turn?.state);
}

export function userTurnExcerpt(message) {
  const text = String(message?.content || '').replace(/\s+/g, ' ').trim();
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

const epoch = value => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * A Session stays in parallel layout while a live root overlaps another root
 * that actually ran: both are live, the other started during the live span, or
 * the other ended after that span began. A root reopened by a task result or
 * leftover supplement starts its span at `activeSince`, so turns that ran
 * between its two spans are not parallel. Derived from the Agent snapshot
 * alone, so navigation, reload and other tabs agree. Without `endedAt` (older
 * Agents) the "earlier root finished first" case falls back to one column.
 * @param {Array<{ userTurnId: string, state: string, startedAt?: number, activeSince?: number, endedAt?: number, executions?: object[] }>} turns
 * @returns {boolean}
 */
export function hasParallelUserTurns(turns = []) {
  const live = turns.filter(isPendingUserTurn);
  if (live.length > 1) return true;
  const start = epoch(live[0]?.activeSince) ?? epoch(live[0]?.startedAt);
  if (start == null) return false;
  return turns.some(turn => turn.userTurnId !== live[0].userTurnId
    // A routed root that never got an execution produced no answer to overlap.
    && (turn.executions?.length > 0 || epoch(turn.endedAt) != null)
    && ((epoch(turn.startedAt) ?? -Infinity) >= start || (epoch(turn.endedAt) ?? -Infinity) > start));
}

/** Snapshot-known roots settle in completion order; live roots stay last. */
function settleKnownRoots(keys, turns) {
  const rank = new Map();
  for (const turn of turns) {
    if (!turn?.userTurnId) continue;
    if (isPendingUserTurn(turn)) rank.set(turn.userTurnId, [1, 0]);
    else if (epoch(turn.endedAt) != null) rank.set(turn.userTurnId, [0, turn.endedAt]);
    // A finished root without an end time (older Agent, or a routed root that
    // never ran) has no completion position and keeps its question-order slot.
  }
  const known = keys.filter(key => rank.has(key));
  if (known.length < 2) return keys;
  const index = new Map(keys.map((key, position) => [key, position]));
  known.sort((left, right) => {
    const [leftGroup, leftValue] = rank.get(left);
    const [rightGroup, rightValue] = rank.get(right);
    return leftGroup - rightGroup || leftValue - rightValue || index.get(left) - index.get(right);
  });
  // Only the slots of ranked roots are permuted: older history and optimistic
  // sends that the Agent has not routed yet keep their question-order slots.
  let cursor = 0;
  return keys.map(key => (rank.has(key) ? known[cursor++] : key));
}

/** Stable root buckets keep supplements and interleaved executions together.
 * Message objects are not cloned: quote/search/fork references retain identity.
 * With an Agent `session_turns` snapshot, finished roots read in the order they
 * finished and live roots stay below them, so completing an earlier question
 * never reorders answers that already settled.
 * @param {object[]} messages Visible transcript rows (repository order).
 * @param {object[]} [turns] Normalized `session_turns` rows for the same Session.
 */
export function orderUserTurnMessages(messages = [], turns = []) {
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
  const keys = settleKnownRoots([...buckets.keys()].sort((a, b) => {
    const left = time(a);
    const right = time(b);
    return left && right ? left - right : 0;
  }), Array.isArray(turns) ? turns : []);
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
