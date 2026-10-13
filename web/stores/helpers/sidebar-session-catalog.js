import { chatCatalogKey, yeaftCatalogKey } from './session-catalog.js';

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
  for (const conversation of store.conversations || []) {
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
  }).map(row => ({
    ...row,
    agentName: row.agentName || agents.get(row.routeRef.agentId)?.name || '',
    availability: agents.get(row.routeRef.agentId)?.online ? 'online' : 'offline',
    workDir: row.workDir || '',
    hidden: false,
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
    // A Server omitting capability metadata cannot prove an empty catalog: it
    // could also be a pre-capability Server whose catalog projection failed.
    return !legacySidebarCatalogReady(store)
      || (!store.sessionCatalogLegacyConfirmed
        && adaptLegacySidebarSessionCatalog(store, sessions).length === 0);
  }
  return store.sessionCatalogProtocolSupported !== true || !store.sessionCatalogLoaded;
}
