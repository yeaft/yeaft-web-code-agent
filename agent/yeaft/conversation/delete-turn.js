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
  const newClientsByRoot = new Map();
  const clients = new Map();
  for (const row of rows.filter(interactive)) {
    const key = rootKey(row);
    human.set(row.id, key);
    const client = scope(row, row.clientMessageId);
    if (row.userTurnId && client && row.relation !== 'supplement') {
      const newClients = newClientsByRoot.get(key) || new Set();
      newClients.add(client);
      newClientsByRoot.set(key, newClients);
    }
    if (client) {
      const keys = clients.get(client) || new Set();
      keys.add(key);
      clients.set(client, keys);
    }
  }
  const target = human.get(messageId);
  if ((newClientsByRoot.get(target)?.size || 0) > 1) throw bad();
  const knownRoots = new Set(human.values());
  function explicit(row, seen = new Set()) {
    if (human.has(row.id)) return human.get(row.id);
    const root = scope(row, row.userTurnId);
    const knownRoot = root && knownRoots.has(root) ? root : null;
    if (!row.causalRootId || seen.has(row.id)) return knownRoot;
    seen.add(row.id);
    const parent = records.get(row.causalRootId);
    const causal = new Set(clients.get(scope(row, row.causalRootId)) || []);
    // Materialized fork/merge references may explicitly link an internal row
    // to a different origin via its stable local row ID.
    const parentOwner = parent && explicit(parent, seen);
    if (parentOwner) causal.add(parentOwner);
    if (knownRoot) causal.add(knownRoot);
    if (causal.size > 1 && causal.has(target)) throw bad();
    return causal.size === 1 ? causal.values().next().value : knownRoot;
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
  // Append order is not ownership evidence: even an execution's first row
  // can land after a newer human request. Order only rules out rows that
  // predate the selected root. If later ownership is uncertain, fail closed.
  const firstTarget = rows.findIndex(row => human.get(row.id) === target);
  const potentiallyTarget = (row, index) => index >= firstTarget && stream(row) === stream(selected);
  const idsFor = row => executions.get(execution(row));
  const ownerOf = row => direct.get(row.id) || (idsFor(row)?.size === 1 ? idsFor(row).values().next().value : null);
  const removed = new Set();
  const byCall = new Map();
  for (const [index, row] of rows.entries()) {
    const owner = ownerOf(row);
    if (owner === target) removed.add(row.id);
    for (const call of Array.isArray(row.toolCalls) ? row.toolCalls : []) {
      if (!call?.id) continue;
      const key = scope(row, call.id);
      const calls = byCall.get(key) || [];
      calls.push({ row, index });
      byCall.set(key, calls);
    }
  }
  for (const [index, row] of rows.entries()) {
    const owner = ownerOf(row);
    if (row.role === 'tool' && row.toolCallId) {
      const calls = (byCall.get(scope(row, row.toolCallId)) || []).filter(call => call.index < index
        && (!row.turnId || row.turnId === call.row.turnId)
        && (!(row.speakerVpId || row.vpId) || (row.speakerVpId || row.vpId) === (call.row.speakerVpId || call.row.vpId))
        && (!row.threadId || (call.row.threadId || 'main') === row.threadId));
      if (calls.length > 0) {
        const any = calls.some(call => removed.has(call.row.id));
        const all = calls.every(call => removed.has(call.row.id));
        if (any !== all || (owner && (owner === target) !== all)) throw bad();
        if (all) removed.add(row.id);
        else if (!owner && calls.some(call => !ownerOf(call.row) && potentiallyTarget(call.row, call.index))) throw bad();
        continue;
      }
    }
    if (owner || !potentiallyTarget(row, index) || !['assistant', 'tool', 'user'].includes(row.role)) continue;
    if (row._reflection && Array.isArray(row.foldedMessageIds) && row.foldedMessageIds.length) continue;
    throw bad();
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
