import { timelineErrors } from './vp-timeline.js';
import { LIVE_SESSION_TURN_STATES } from './yeaft-session-turns.js';
import { yeaftSessionIdentityKey, yeaftTurnIdentityKey } from './yeaft-session-identity.js';
import { YEAFT_RUNNING_VP_STATES } from './yeaft-runtime-state.js';
import { userTurnExcerpt } from '../../utils/concurrent-user-turns.js';

const executionKey = (row) => JSON.stringify([row.vpId, row.turnId || null, row.threadId || 'main']);
const scopedTo = (row, agentId, sessionId) => row?.agentId === agentId && (row.sessionId ?? row.groupId) === sessionId;

/** Project activity by user Turn, not by the internal executor. Older and
 * background executions without a root remain individually stoppable by ID. */
export function sessionActivityRows(store, { agentId, sessionId, legacyRoster = [], sessions = [] }) {
  if (!agentId || !sessionId) return [];
  const online = store.connectionState === 'connected' && store.agents?.some(agent => agent.id === agentId && agent.online);
  const generation = Number(store.chatHistoryConnectionGeneration || 0);
  const conversationId = store.yeaftConversationIdsByAgent?.[agentId];
  const current = row => !!conversationId && row?.connectionGeneration === generation && row.conversationId === conversationId;
  const snapshot = store.yeaftSessionTurnsBySession?.[yeaftSessionIdentityKey(agentId, sessionId)];
  const hasCurrentSnapshot = current(snapshot);
  const awaitingRoots = !hasCurrentSnapshot && store.hasAgentCapability?.(agentId, 'session_scenes');
  const turns = online && hasCurrentSnapshot ? snapshot.turns : [];
  const rows = new Map();
  const ownerByExecution = new Map();
  const terminalExecutions = new Set();
  const rootOwners = new Set();
  const knownRootExecutions = new Set();
  // Retired snapshots can tell us to await a fresh root, never authorize Stop.
  for (const turn of snapshot?.turns || []) {
    for (const execution of turn.executions) {
      if (execution.turnId) knownRootExecutions.add(executionKey(execution));
    }
  }
  for (const turn of turns || []) {
    const live = LIVE_SESSION_TURN_STATES.has(turn.state);
    const active = turn.executions.filter(execution => LIVE_SESSION_TURN_STATES.has(execution.state));
    const state = turn.state === 'running' && active.length && active.every(execution => execution.state === 'queued')
      ? 'queued' : turn.state;
    for (const execution of turn.executions) {
      if (!execution.turnId) continue;
      if (live && LIVE_SESSION_TURN_STATES.has(execution.state)) {
        ownerByExecution.set(executionKey(execution), turn.userTurnId);
        rootOwners.add(execution.vpId);
      } else terminalExecutions.add(executionKey(execution));
    }
    if (!live) continue;
    rows.set(`user:${turn.userTurnId}`, {
      key: `user:${turn.userTurnId}`, agentId, sessionId, userTurnId: turn.userTurnId, userMessageId: turn.userMessageId,
      startedAt: turn.startedAt, status: state, canStop: turn.state !== 'cancelling', errors: [], observations: [],
    });
  }

  const executionRows = new Map();
  // Active metadata supplies start time (broker `since` is only phase time).
  for (const [key, active] of Object.entries(store.activeVpTurns || {})) {
    if (!online || !scopedTo(active, agentId, sessionId) || !current(active)) continue;
    executionRows.set(executionKey(active), { ...active, status: 'running', isStopping: !!store.stoppingVpTurnIds?.[key] });
  }
  const legacyMembers = new Set(legacyRoster);
  const errors = [];
  const statuses = Object.values(store.vpStatuses || {}).filter(status => status?.vpId
    && status.connectionGeneration === generation && (!status.conversationId || status.conversationId === conversationId));
  // An exact idle/terminal row is also authoritative: a looser legacy row
  // must not keep role-scoped Stop available after the execution has settled.
  const scopedOwners = new Set(statuses.filter(status => scopedTo(status, agentId, sessionId)).map(status => status.vpId));
  for (const status of statuses) {
    const statusSession = status.sessionId ?? status.groupId;
    const exact = scopedTo(status, agentId, sessionId);
    // An older broker can omit Session ownership. Only infer it if this VP
    // is in exactly one known roster for that Agent. A missing Agent stamp
    // additionally requires the bound conversation and an unambiguous owner.
    if (!exact) {
      if (scopedOwners.has(status.vpId) || !legacyMembers.has(status.vpId) || (statusSession && statusSession !== sessionId)
          || (status.agentId && status.agentId !== agentId)
          || (!status.agentId && (!conversationId || status.conversationId !== conversationId))) continue;
      const candidates = sessions.filter(row => (statusSession ? row.id === statusSession : row.roster?.includes(status.vpId))
        && (!status.agentId || !row.agentId || row.agentId === status.agentId));
      if (candidates.length !== 1 || candidates[0].id !== sessionId || candidates[0].agentId !== agentId) continue;
    }
    for (const detail of timelineErrors(status)) errors.push({ ...detail, vpId: status.vpId });
    if (!online) continue;
    // The aggregate may point at an idle sibling; use the full inventory
    // when it exists. Older brokers expose only the aggregate.
    for (const thread of Array.isArray(status.threads) ? status.threads : [status]) {
      const state = thread?.state || thread?.status;
      if (!YEAFT_RUNNING_VP_STATES.has(state)) continue;
      const execution = { vpId: status.vpId, turnId: thread.turnId, threadId: thread.threadId };
      const key = executionKey(execution);
      const active = executionRows.get(key);
      executionRows.set(key, { ...active, ...execution, userTurnId: active?.userTurnId || thread.userTurnId,
        isStopping: active?.isStopping || !!store.stoppingVpTurnIds?.[yeaftTurnIdentityKey(agentId, thread.turnId)],
        legacyStop: !thread.turnId && !Array.isArray(status.threads) && legacyMembers.has(status.vpId),
        status: state, since: thread.since || 0 });
    }
  }

  // Route labels use only the current Session's user messages, not role names
  // or thread titles. Also handles reconnect with no prompt in the window.
  const labels = new Map();
  const labelIds = new Set([...rows.values()].flatMap(row => [row.userTurnId, row.userMessageId]));
  for (const execution of executionRows.values()) {
    if (execution.userTurnId) labelIds.add(execution.userTurnId);
  }
  if (labelIds.size) {
    for (const message of store.messagesMap?.[conversationId] || []) {
      if (message.type !== 'user' || message.turnRelation === 'supplement'
          || (message.sessionId ?? message.groupId) !== sessionId || (message.agentId && message.agentId !== agentId)) continue;
      const ids = [message.userTurnId, message.id, message.messageId, message.clientMessageId]
        .filter(id => labelIds.has(id) && !labels.has(id));
      if (!ids.length) continue;
      const label = userTurnExcerpt(message);
      if (label) for (const id of ids) labels.set(id, label);
    }
  }
  const exactOwners = new Set([...rootOwners, ...[...executionRows.values()].filter(row => row.turnId).map(row => row.vpId)]);
  const rowForExecution = (key, execution) => {
    const userTurnId = ownerByExecution.get(key) || execution.userTurnId;
    const root = userTurnId && rows.get(`user:${userTurnId}`);
    if (root) return root;
    const rowKey = `engine:${key}`;
    if (!rows.has(rowKey)) rows.set(rowKey, {
      key: rowKey, agentId, sessionId, vpId: execution.vpId, turnId: execution.turnId,
      label: labels.get(userTurnId), startedAt: execution.startedAt,
      status: execution.status, legacyStop: execution.legacyStop && !exactOwners.has(execution.vpId),
      canStop: execution.status !== 'error' && !awaitingRoots && !userTurnId && !knownRootExecutions.has(key)
        && (!!execution.turnId || (execution.legacyStop && !exactOwners.has(execution.vpId))),
      isStopping: execution.isStopping, errors: [], observations: [],
    });
    return rows.get(rowKey);
  };
  for (const [key, execution] of executionRows) {
    if ((terminalExecutions.has(key) && !ownerByExecution.has(key))
        || (execution.legacyStop && exactOwners.has(execution.vpId))) continue;
    const row = rowForExecution(key, execution);
    if (row.userTurnId && row.status !== 'cancelling' && YEAFT_RUNNING_VP_STATES.has(execution.status)
        && (!row.phaseSince || execution.since >= row.phaseSince)) {
      row.status = execution.status;
      row.phaseSince = execution.since;
    }
    const progress = execution.queryProgress;
    if (progress && progress.threadId === (execution.threadId || 'main')) row.observations.push(progress);
  }
  for (const detail of errors) {
    const key = executionKey(detail);
    const { vpId: _owner, ...error } = detail;
    rowForExecution(key, { ...detail, status: 'error' }).errors.push(error);
  }
  return [...rows.values()].map(row => row.userTurnId
    ? { ...row, label: labels.get(row.userTurnId) || labels.get(row.userMessageId) }
    : row);
}
