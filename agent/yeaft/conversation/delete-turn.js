import { historyError, isHumanRequest } from './session-history.js';

const nonempty = values => [...new Set(values.filter(id => typeof id === 'string' && id))];
const interactive = row => isHumanRequest(row) && row.executionOrigin !== 'scheduled_task';

/** Resolve ownership before mutating anything. Never use prompt text to match rows. */
export function planTurnDeletion({ rows, sessionId, streamId }, messageId) {
  const bad = () => historyError('ambiguous_turn', 'This turn cannot be safely separated from the surrounding history.');
  const records = new Map(rows.map(row => [row.id, row]));
  const selected = records.get(messageId);
  if (!interactive(selected)) throw historyError('message_not_found', 'A saved user message was not found.');
  if (records.size !== rows.length) throw bad();
  const stream = row => row.origin?.streamId || streamId;
  const scope = (row, id) => id ? JSON.stringify([stream(row), id]) : null;
  const execution = row => scope(row, row.turnId ? JSON.stringify([row.speakerVpId || row.vpId || '', row.turnId]) : null);
  const rootKey = row => row.userTurnId ? scope(row, row.userTurnId)
    : row.clientMessageId ? scope(row, JSON.stringify(['legacy-client', row.clientMessageId, row.time || row.ts || null]))
      : scope(row, JSON.stringify(['legacy-row', row.id]));
  const human = new Map();
  const clients = new Map();
  for (const row of rows.filter(interactive)) {
    const key = rootKey(row);
    human.set(row.id, key);
    const client = scope(row, row.clientMessageId);
    if (client) {
      const keys = clients.get(client) || new Set();
      keys.add(key);
      clients.set(client, keys);
    }
  }
  const target = human.get(messageId);
  const knownRoots = new Set(human.values());
  function explicit(row, seen = new Set()) {
    if (human.has(row.id)) return human.get(row.id);
    const root = scope(row, row.userTurnId);
    if (root && knownRoots.has(root)) return root;
    if (!row.causalRootId || seen.has(row.id)) return root;
    seen.add(row.id);
    const parent = records.get(row.causalRootId);
    if (parent) return explicit(parent, seen) || root;
    const keys = clients.get(scope(row, row.causalRootId));
    if (keys?.size > 1 && keys.has(target)) throw bad();
    return (keys?.size === 1 ? keys.values().next().value : null) || root;
  }
  const direct = new Map();
  const executions = new Map();
  for (const row of rows) {
    const key = explicit(row);
    direct.set(row.id, key);
    const exec = execution(row);
    if (!exec || !key) continue;
    const keys = executions.get(exec) || new Set();
    keys.add(key);
    if (keys.size > 1 && keys.has(target)) throw bad();
    executions.set(exec, keys);
  }
  const removed = new Set();
  const byCall = new Map();
  const unresolvedTools = [];
  let current = null;
  for (const row of rows) {
    // Legacy, sequential records without stable metadata use the closest
    // human boundary from the same origin. Modern turns must prove ownership.
    if (interactive(row)) current = row;
    const keys = executions.get(execution(row));
    const owner = direct.get(row.id) || (keys?.size === 1 ? keys.values().next().value : null);
    const legacy = !owner && current && !current.userTurnId && stream(current) === stream(row)
      && ['assistant', 'tool', 'user'].includes(row.role) && !row.causalRootId;
    if (owner === target || (legacy && human.get(current.id) === target)) removed.add(row.id);
    for (const call of Array.isArray(row.toolCalls) ? row.toolCalls : []) {
      if (!call?.id) continue;
      const key = scope(row, call.id);
      const calls = byCall.get(key) || [];
      calls.push(row);
      byCall.set(key, calls);
    }
    if (row.role === 'tool' && row.toolCallId && !owner) {
      const calls = (byCall.get(scope(row, row.toolCallId)) || []).filter(call =>
        (!row.turnId || row.turnId === call.turnId)
        && (!(row.speakerVpId || row.vpId) || (row.speakerVpId || row.vpId) === (call.speakerVpId || call.vpId))
        && (!row.threadId || (call.threadId || 'main') === row.threadId));
      unresolvedTools.push({ row, calls });
    }
  }
  for (const { row, calls } of unresolvedTools) {
    if (calls.length > 1 && calls.some(call => removed.has(call.id)) && calls.some(call => !removed.has(call.id))) throw bad();
    if (calls.length && calls.every(call => removed.has(call.id))) removed.add(row.id);
    // Strong tool linkage to another request beats the legacy fallback.
    if (calls.length && calls.every(call => !removed.has(call.id))) removed.delete(row.id);
  }
  // Reflections may carry earlier tool/user content into a later turn. Drop
  // the derived row, not that later turn; preserve all its original rows.
  const dependents = new Map();
  for (const row of rows) {
    for (const id of [...(Array.isArray(row.foldedMessageIds) ? row.foldedMessageIds : []),
      ...(Array.isArray(row.sourceMessageIds) ? row.sourceMessageIds : [])]) {
      const list = dependents.get(id) || [];
      list.push(row.id);
      dependents.set(id, list);
    }
  }
  const owned = rows.filter(row => removed.has(row.id));
  for (const id of removed) for (const dependent of dependents.get(id) || []) {
    if (!human.has(dependent)) removed.add(dependent);
  }
  const inputs = owned.filter(interactive);
  const executionIds = nonempty(owned.map(row => row.turnId));
  // The trace/coordinator stores use unscoped IDs. Imported rows have their
  // own origin; never let their legacy client/VP IDs erase a local collision.
  const localRows = owned.filter(row => !row.origin || row.origin.sessionId === sessionId);
  const otherRows = rows.filter(row => !removed.has(row.id));
  const otherExecutions = new Set(otherRows.map(row => row.turnId));
  const otherClients = new Set(otherRows.filter(interactive).map(row => row.clientMessageId));
  const localClientMessageIds = nonempty(localRows.filter(interactive).map(row => row.clientMessageId))
    .filter(id => !otherClients.has(id));
  const localExecutionIds = nonempty(localRows.map(row => row.turnId)).filter(id => !otherExecutions.has(id));
  return {
    version: 1, sessionId, turnId: selected.userTurnId || selected.id,
    reflectionSources: nonempty(rows.filter(row => removed.has(row.id) && row._reflection)
      .flatMap(row => Array.isArray(row.foldedMessageIds) ? row.foldedMessageIds : [])),
    anchorMessageIds: inputs.map(row => row.id),
    messageIds: [...removed],
    clientMessageIds: localClientMessageIds,
    executionIds: localExecutionIds,
    referenceIds: nonempty([...removed, ...executionIds.filter(id => !otherExecutions.has(id)), ...localClientMessageIds,
      ...(selected.userTurnId && !otherRows.some(row => row.userTurnId === selected.userTurnId) ? [selected.userTurnId] : [])]),
  };
}
