import { clearLiveSessionTools } from './session-tool-details.js';

const RETIRED_CONVERSATION_LIMIT = 8;

function retiredConversationIds(store, agentId) {
  return agentId && Array.isArray(store?._yeaftRetiredConversationIdsByAgent?.[agentId])
    ? store._yeaftRetiredConversationIdsByAgent[agentId]
    : [];
}

export function isRetiredYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId) return false;
  return retiredConversationIds(store, agentId).includes(conversationId);
}

function replacementMap(store, agentId) {
  const map = store?._yeaftRetiredConversationTargetsByAgent?.[agentId];
  return map && typeof map === 'object' ? map : {};
}

export function resolveCurrentYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId) return null;
  const replacements = replacementMap(store, agentId);
  let current = conversationId;
  const visited = new Set();
  for (let i = 0; i < RETIRED_CONVERSATION_LIMIT; i++) {
    if (visited.has(current)) return null;
    visited.add(current);
    const next = replacements[current];
    if (!next || next === current) return current === conversationId ? null : current;
    current = next;
  }
  return null;
}

export function retireYeaftConversation(store, agentId, conversationId, replacementConversationId = null) {
  if (!agentId || !conversationId) return;
  clearLiveSessionTools(store, { agentId, conversationId });
  const nextRetired = retiredConversationIds(store, agentId)
    .filter(id => id !== conversationId)
    .concat(conversationId)
    .slice(-RETIRED_CONVERSATION_LIMIT);
  store._yeaftRetiredConversationIdsByAgent = {
    ...(store._yeaftRetiredConversationIdsByAgent || {}),
    [agentId]: nextRetired,
  };

  const priorReplacements = replacementMap(store, agentId);
  const nextReplacements = {};
  for (const retiredId of nextRetired) {
    const priorTarget = priorReplacements[retiredId];
    if (priorTarget) {
      nextReplacements[retiredId] = priorTarget === conversationId && replacementConversationId
        ? replacementConversationId
        : priorTarget;
    }
  }
  if (replacementConversationId && replacementConversationId !== conversationId) {
    nextReplacements[conversationId] = replacementConversationId;
  }
  store._yeaftRetiredConversationTargetsByAgent = {
    ...(store._yeaftRetiredConversationTargetsByAgent || {}),
    [agentId]: nextReplacements,
  };
}

export function reviveYeaftConversation(store, agentId, conversationId) {
  if (!agentId || !conversationId || !store?._yeaftRetiredConversationIdsByAgent) return;
  const nextRetired = retiredConversationIds(store, agentId).filter(id => id !== conversationId);
  store._yeaftRetiredConversationIdsByAgent = {
    ...store._yeaftRetiredConversationIdsByAgent,
    [agentId]: nextRetired,
  };
  const nextReplacements = { ...replacementMap(store, agentId) };
  delete nextReplacements[conversationId];
  store._yeaftRetiredConversationTargetsByAgent = {
    ...(store._yeaftRetiredConversationTargetsByAgent || {}),
    [agentId]: nextReplacements,
  };
}
