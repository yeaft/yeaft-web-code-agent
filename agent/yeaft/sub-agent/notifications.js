/**
 * notifications.js — Sub-agent → parent re-entry queue.
 *
 * Problem this solves:
 *   The original sub-agent protocol was purely pull-based — the parent had
 *   to keep calling WaitAgent to discover that its child had finished. If
 *   the parent forgot, the child's terminal state was never surfaced and
 *   the orchestration "hung" from the user's perspective. Modeled on
 *   claude-code's `<task-notification>` XML re-entry pattern: when a
 *   child reaches a terminal state we *push* a notification onto a queue
 *   that the parent will see the next time it talks to its engine.
 *
 *   This module is the queue. Two entry points consume it:
 *
 *     1. WaitAgent (drains anything queued for this agent on terminal,
 *        before returning).
 *     2. Engine.query() — when started with a user prompt, it asks
 *        `consumePendingNotifications({ sessionId, parentVpId })` for any queued
 *        terminal events from sub-agents that the parent hasn't yet
 *        acknowledged, and prepends a short XML block to the user
 *        message. The XML block is human-readable for the model and
 *        explicitly tells it "your sub-agent X finished while you were
 *        away; here's the result and what to do next".
 *
 *   The queue is in-memory only. We do NOT persist across process
 *   restarts because (a) sub-agents themselves don't survive restart,
 *   and (b) the durable per-agent outputFile (see output-log.js) is the
 *   long-term record.
 *
 * Keying:
 *   Notifications are bucketed by `(sessionId, parentVpId)` when
 *   the parent runs inside a Yeaft Session. Legacy / test callers that
 *   don't provide a sessionId still bucket by `parentVpId` (or
 *   `'__no_vp__'`) so older in-process callers keep working. WaitAgent
 *   always drains via agentId regardless of bucket, so the bucket only
 *   matters for the engine pre-prompt drain.
 *
 * Dedup:
 *   Each notification carries a unique id (agentId + status + ts). The
 *   `markNotified()` flag on the agent record (set by drainers) prevents
 *   us from emitting more than one terminal notification per agent.
 */

/** @typedef {{ id: string, agentId: string, agentName: string, status: string, result: string, error: string|null, outputFile: string|null, turns: number, parentVpId: string|null, parentSessionId: string|null, budgetExceeded: boolean, budgetReason: string|null, budgetUsage: object|null, createdAt: number }} SubAgentNotification */

/** Map<bucketKey, SubAgentNotification[]> */
const byParent = new Map();
/** Map<agentId, SubAgentNotification> — for WaitAgent agentId drains. */
const byAgent = new Map();

const FALLBACK_BUCKET = '__no_vp__';

function cleanString(value) {
  return (typeof value === 'string' && value.trim()) ? value.trim() : null;
}

function normalizeScope(input, sessionId) {
  if (input && typeof input === 'object') {
    return {
      parentVpId: cleanString(input.parentVpId),
      sessionId: cleanString(input.sessionId ?? input.parentSessionId),
    };
  }
  return {
    parentVpId: cleanString(input),
    sessionId: cleanString(sessionId),
  };
}

function bucketKey(scope, sessionId) {
  const s = normalizeScope(scope, sessionId);
  const vp = s.parentVpId || FALLBACK_BUCKET;
  if (!s.sessionId) return vp;
  return `${s.sessionId}::${vp}`;
}

/**
 * Enqueue a terminal notification for an agent. Idempotent per agent —
 * a second call with the same agentId is a no-op (we only emit one
 * terminal notice per child).
 *
 * @param {{ agentId: string, agentName: string, status: string, result?: string, error?: string|null, outputFile?: string|null, turns?: number, parentVpId?: string|null, parentSessionId?: string|null, sessionId?: string|null, budgetExceeded?: boolean, budgetReason?: string|null, budgetUsage?: object|null }} input
 * @returns {SubAgentNotification|null} the queued record (null if a dup)
 */
export function enqueueTerminalNotification(input) {
  if (!input || !input.agentId || !input.status) return null;
  if (byAgent.has(input.agentId)) return null; // already queued
  const scope = normalizeScope({
    parentVpId: input.parentVpId,
    parentSessionId: input.parentSessionId ?? input.sessionId,
  });
  const rec = {
    id: `${input.agentId}:${input.status}:${Date.now()}`,
    agentId: input.agentId,
    agentName: input.agentName || input.agentId,
    status: input.status,
    result: input.result || '',
    error: input.error || null,
    outputFile: input.outputFile || null,
    turns: typeof input.turns === 'number' ? input.turns : 0,
    parentVpId: scope.parentVpId,
    parentSessionId: scope.sessionId,
    budgetExceeded: Boolean(input.budgetExceeded),
    budgetReason: input.budgetReason || null,
    budgetUsage: input.budgetUsage || null,
    createdAt: Date.now(),
  };
  const key = bucketKey(scope);
  if (!byParent.has(key)) byParent.set(key, []);
  byParent.get(key).push(rec);
  byAgent.set(rec.agentId, rec);
  return rec;
}

/**
 * Drain and return pending notifications for a parent VP. Pass null to
 * drain the fallback bucket. Returns [] when nothing pending.
 *
 * Engine calls this at the start of every user-driven turn so the
 * parent model sees terminal events that arrived while it was idle.
 *
 * @param {string|{parentVpId?: string|null, sessionId?: string|null, parentSessionId?: string|null}|null} scope
 * @returns {SubAgentNotification[]}
 */
export function consumePendingNotifications(scope) {
  const key = bucketKey(scope);
  const list = byParent.get(key) || [];
  byParent.set(key, []);
  // Don't drop from byAgent yet — WaitAgent may still query by agentId
  // and we want it to be a no-op on already-drained records (the
  // `notified` flag on the agent itself is the real dedup gate).
  return list.slice();
}

/**
 * Return pending notifications without acknowledging them. Engine uses this
 * while constructing a prompt; it acknowledges only after the parent turn
 * completes successfully so abort/error paths don't lose the notification.
 *
 * @param {string|{parentVpId?: string|null, sessionId?: string|null, parentSessionId?: string|null}|null} scope
 * @returns {SubAgentNotification[]}
 */
export function peekPendingNotifications(scope) {
  const key = bucketKey(scope);
  const list = byParent.get(key) || [];
  return list.slice();
}

/**
 * Acknowledge notifications previously returned by peekPendingNotifications.
 * Removes them from both parent and per-agent maps.
 *
 * @param {string|{parentVpId?: string|null, sessionId?: string|null, parentSessionId?: string|null}|null} scope
 * @param {string[]} ids
 */
export function acknowledgePendingNotifications(scope, ids = []) {
  const idSet = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
  if (idSet.size === 0) return;
  const key = bucketKey(scope);
  const list = byParent.get(key) || [];
  const kept = [];
  for (const rec of list) {
    if (idSet.has(rec.id)) {
      byAgent.delete(rec.agentId);
    } else {
      kept.push(rec);
    }
  }
  byParent.set(key, kept);
}

/**
 * Drain and return the pending notification for a single agent, or null.
 * Used by WaitAgent on terminal so the same notification isn't also
 * re-prepended to the next user turn.
 *
 * @param {string} agentId
 * @returns {SubAgentNotification|null}
 */
export function consumeNotificationForAgent(agentId) {
  if (!agentId) return null;
  const rec = byAgent.get(agentId);
  if (!rec) return null;
  byAgent.delete(agentId);
  // Also remove from the parent bucket so the engine drain doesn't
  // re-emit it.
  const key = bucketKey({
    parentVpId: rec.parentVpId,
    sessionId: rec.parentSessionId,
  });
  const list = byParent.get(key);
  if (Array.isArray(list)) {
    const idx = list.findIndex(r => r.id === rec.id);
    if (idx >= 0) list.splice(idx, 1);
  }
  return rec;
}

/**
 * Format a notification batch as a single XML-tagged block to prepend
 * to the user's next prompt. The model sees this as system-emitted
 * out-of-band context (we wrap with a literal tag so it's visually
 * obvious in transcripts).
 *
 * @param {SubAgentNotification[]} notifs
 * @returns {string} '' when notifs is empty
 */
export function formatNotificationsForPrompt(notifs) {
  if (!Array.isArray(notifs) || notifs.length === 0) return '';
  const parts = [];
  parts.push('<sub-agent-notifications>');
  parts.push(
    'The following sub-agent(s) reached a terminal state while you were ' +
    'away. The user has NOT seen any of this — only you have. You MUST ' +
    'either (a) relay the result(s) to the user in your reply, or (b) act ' +
    'on the result(s) before replying. Do NOT ignore these.',
  );
  for (const n of notifs) {
    parts.push('');
    parts.push(`<notification agent="${n.agentName}" id="${n.agentId}" status="${n.status}" turns="${n.turns}">`);
    if (n.error) parts.push(`  error: ${n.error}`);
    if (n.budgetExceeded) {
      parts.push('  budgetExceeded: true');
      if (n.budgetReason) parts.push(`  budgetReason: ${n.budgetReason}`);
      if (n.budgetUsage) parts.push(`  budgetUsage: ${JSON.stringify(n.budgetUsage)}`);
    }
    if (n.outputFile) parts.push(`  outputFile: ${n.outputFile}`);
    if (n.result) {
      const r = n.result.length > 1500 ? n.result.slice(0, 1500) + '…(truncated)' : n.result;
      parts.push('  result:');
      parts.push(`    ${r.split('\n').join('\n    ')}`);
    }
    parts.push('</notification>');
  }
  parts.push('</sub-agent-notifications>');
  return parts.join('\n');
}

/** Reset both maps. Tests only. */
export function _resetNotifications() {
  byParent.clear();
  byAgent.clear();
}

/** Inspect the queue. Tests only. */
export function _peekAll() {
  return {
    byParent: Object.fromEntries([...byParent.entries()].map(([k, v]) => [k, v.slice()])),
    byAgent: Object.fromEntries(byAgent.entries()),
  };
}
