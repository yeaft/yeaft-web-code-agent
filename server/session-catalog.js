const CHAT_RUNTIME_PROVIDERS = new Set(['claude-code', 'copilot']);

export function normalizeChatRuntimeProvider(provider) {
  if (provider == null || provider === '') return 'claude-code';
  if (CHAT_RUNTIME_PROVIDERS.has(provider)) return provider;
  throw new Error(`Unknown Chat runtime provider: ${provider}`);
}

export function chatCatalogKey(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new Error('Chat catalog key requires conversationId');
  }
  return `chat:${conversationId}`;
}

export function yeaftCatalogKey(agentId, sessionId) {
  if (typeof agentId !== 'string' || !agentId || typeof sessionId !== 'string' || !sessionId) {
    throw new Error('Yeaft catalog key requires agentId and sessionId');
  }
  return `yeaft:${agentId}:${sessionId}`;
}

function timestampValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string' || !value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasCompleteSortRanks(rows) {
  if (rows.length === 0) return false;
  const ranks = rows.map(row => row.sortRank);
  return ranks.every(Number.isFinite) && new Set(ranks).size === rows.length;
}

function catalogSort(left, right, ranked = false) {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (ranked) {
    const leftRank = Number.isFinite(left.sortRank) ? left.sortRank : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(right.sortRank) ? right.sortRank : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  const metadataDelta = timestampValue(right.metadataUpdatedAt) - timestampValue(left.metadataUpdatedAt);
  if (metadataDelta !== 0) return metadataDelta;
  return left.catalogKey.localeCompare(right.catalogKey);
}

export function projectSessionCatalog({
  chatSessions = [],
  yeaftSessions = [],
  metadata = [],
  onlineAgentIds = new Set(),
  includeHidden = false,
} = {}) {
  const metadataByKey = new Map(metadata.map(row => [row.catalogKey, row]));
  const onlineAgents = onlineAgentIds instanceof Set ? onlineAgentIds : new Set(onlineAgentIds);
  const rows = [];

  for (const session of chatSessions) {
    if (session.is_active === 0) continue;
    const catalogKey = chatCatalogKey(session.id);
    const runtimeProvider = normalizeChatRuntimeProvider(session.provider);
    const meta = metadataByKey.get(catalogKey) || {};
    if (!includeHidden && meta.hidden === true) continue;
    rows.push({
      catalogKey,
      runtimeProvider,
      routeRef: { runtimeProvider, agentId: session.agent_id, sessionId: session.id },
      title: session.title || session.id,
      workDir: session.work_dir || '',
      agentId: session.agent_id,
      agentName: session.agent_name || '',
      availability: onlineAgents.has(session.agent_id) ? 'online' : 'offline',
      pinned: meta.pinned ?? session.is_pinned === 1,
      hidden: meta.hidden === true,
      sortRank: meta.sortRank ?? null,
      createdAt: session.created_at || null,
      metadataUpdatedAt: session.metadata_updated_at ?? session.created_at ?? null,
    });
  }

  for (const session of yeaftSessions) {
    const catalogKey = yeaftCatalogKey(session.agentId, session.id);
    const meta = metadataByKey.get(catalogKey) || {};
    if (!includeHidden && meta.hidden === true) continue;
    rows.push({
      catalogKey,
      runtimeProvider: 'yeaft',
      ...(session.task ? { task: session.task } : {}),
      routeRef: { runtimeProvider: 'yeaft', agentId: session.agentId, sessionId: session.id },
      title: session.name || session.id,
      workDir: session.workDir || '',
      agentId: session.agentId,
      agentName: session.agentName || '',
      availability: onlineAgents.has(session.agentId) ? 'online' : 'offline',
      pinned: meta.pinned ?? !!session.pinned,
      hidden: meta.hidden === true,
      sortRank: meta.sortRank ?? null,
      createdAt: session.createdAt || null,
      metadataUpdatedAt: session.metadataUpdatedAt ?? session.createdAt ?? null,
    });
  }

  const ranked = hasCompleteSortRanks(rows);
  return rows.sort((left, right) => catalogSort(left, right, ranked));
}
