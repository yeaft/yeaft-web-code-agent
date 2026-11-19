import { yeaftHistoryIdentityKey } from './yeaft-history-identity.js';

export const YEAFT_DELETE_TURN_TIMEOUT_MS = 15_000;

export function supportsYeaftTurnDeletion(store, agent) {
  return store.yeaftSessionDeleteTurnSupported === true && Array.isArray(agent?.capabilities)
    && agent.capabilities.includes('session_delete_turn');
}

// Native history ids are mNNNN. UI keys, client ids and tool sub-row ids are
// not valid boundaries. Live echoes can confirm persistence before a replay.
export function persistedYeaftUserMessageId(row) {
  if (row?.type !== 'user' || row.isStreaming || row.status === 'pending') return null;
  const id = row.persistedMessageId || row.messageId;
  return typeof id === 'string' && /^m\d+$/.test(id) && id !== row.clientMessageId ? id : null;
}

export function yeaftTurnDeletionFence(store, auth) {
  return {
    authGeneration: auth.authGeneration,
    ownerId: auth.userId || null,
    connectionGeneration: store.chatHistoryConnectionGeneration,
  };
}

export function isYeaftTurnDeletionFenceCurrent(store, auth, fence) {
  const current = yeaftTurnDeletionFence(store, auth);
  return Object.keys(current).every(key => fence[key] === current[key]);
}

export function isYeaftTurnDeletionFrameCurrent(msg, auth) {
  return !Object.hasOwn(msg, '_wsAuthGeneration') || (
    msg._wsAuthGeneration === auth.authGeneration && msg._wsAuthOwnerId === (auth.userId || null)
  );
}

export function settleYeaftTurnDeletion(store, pending, result) {
  const key = yeaftHistoryIdentityKey(pending.agentId, pending.sessionId);
  if (store._yeaftTurnDeletePending[key]?.requestId !== pending.requestId) return false;
  clearTimeout(pending.timer);
  const { [key]: _settled, ...remaining } = store._yeaftTurnDeletePending;
  store._yeaftTurnDeletePending = remaining;
  pending.resolve(result);
  return true;
}
