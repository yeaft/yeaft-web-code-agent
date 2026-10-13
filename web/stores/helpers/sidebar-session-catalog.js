import { chatCatalogKey, yeaftCatalogKey } from './session-catalog.js';
import { sortSessionsByActivity } from './session-order.js';

export function sidebarCatalogAuthIsCurrent(store, auth) {
  return store.sidebarCatalogAuthGeneration === auth.authGeneration
    && store.sidebarCatalogOwnerId === (auth.userId || null);
}

export function legacySidebarCatalogReady(store) {
  return store._hasHandledAgentList === true
    && store._hasHandledYeaftSessionHydrate === true
    && !store.yeaftSessionHydrateError;
}

/** Adapt the accepted legacy inventories; never infer an Agent for an ambiguous Session. */
export function adaptLegacySidebarSessionCatalog(store, sessions = []) {
  const agents = new Map((store.agents || []).map(agent => [agent.id, agent]));
  const membership = new Map();
  for (const project of store.sessionProjects || []) {
    for (const member of project.members || []) {
      membership.set(`${member.agentId}\u001f${member.sessionId}`, project.id);
    }
  }
  const rows = [];
  // Legacy Chat has no persisted manual rank; preserve its activity ordering.
  // Native Sessions below already arrive in the sessions store's chosen order.
  for (const conversation of sortSessionsByActivity(store.conversations)) {
    if (!conversation?.id || !conversation.agentId || conversation.type === 'yeaft'
        || conversation.id.startsWith('yeaft-')) continue;
    const runtimeProvider = conversation.provider || 'claude-code';
    if (!['claude-code', 'copilot'].includes(runtimeProvider)) continue;
    rows.push({
      ...conversation,
      catalogKey: chatCatalogKey(conversation.id),
      runtimeProvider,
      routeRef: { runtimeProvider, agentId: conversation.agentId, sessionId: conversation.id },
      title: store.customConversationTitles?.[conversation.id]
        || store.conversationTitles?.[conversation.id] || conversation.title || conversation.id,
      pinned: conversation.pinned === true || (store.pinnedSessions || []).includes(conversation.id),
    });
  }
  for (const session of sessions) {
    if (!session?.id || !session.agentId || session.hidden) continue;
    rows.push({
      ...session,
      catalogKey: yeaftCatalogKey(session.agentId, session.id),
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: session.agentId, sessionId: session.id },
      title: session.name || session.id,
      projectId: membership.get(`${session.agentId}\u001f${session.id}`) || null,
      pinned: !!session.pinned,
      sortRank: Number.isFinite(session.sortOrder) ? session.sortOrder : null,
    });
  }
  const seen = new Set();
  return rows.filter(row => {
    if (row.hidden || seen.has(row.catalogKey)) return false;
    seen.add(row.catalogKey);
    return true;
  }).map((row, index) => ({
    ...row,
    agentName: row.agentName || agents.get(row.routeRef.agentId)?.name || '',
    availability: agents.get(row.routeRef.agentId)?.online ? 'online' : 'offline',
    workDir: row.workDir || '',
    hidden: false,
    sortRank: index,
    metadataUpdatedAt: row.metadataUpdatedAt || row.updatedAt || row.createdAt || null,
  }));
}

export function sidebarSessionCatalogRows(store, sessions = []) {
  if (store.sessionCatalogProtocolSupported === false && legacySidebarCatalogReady(store)) {
    return adaptLegacySidebarSessionCatalog(store, sessions);
  }
  // Unknown is not legacy: cold sockets must wait for authority. Reconnects
  // may show the previous identity-fenced read model, but cannot mutate it.
  return store.sessionCatalog.length > 0 || store.sessionCatalogLoaded
    ? store.sessionCatalog
    : store.sidebarLegacySessionCatalog;
}

export function sidebarSessionCatalogIsLoading(store, sessions = []) {
  if (store.connectionState !== 'connected') return true;
  if (store.sessionCatalogProtocolSupported === false) {
    // The successful accepted inventory boundary also proves a legitimate empty.
    // Failed catalog frames advertise support and cannot reach this branch.
    return !legacySidebarCatalogReady(store);
  }
  return store.sessionCatalogProtocolSupported !== true || !store.sessionCatalogLoaded;
}
