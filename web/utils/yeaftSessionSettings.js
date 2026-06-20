export function resolveActiveSessionIdForSettings({ activeSessionFilter = null, sessionsStore = null, topbarGroup = null } = {}) {
  return activeSessionFilter || sessionsStore?.activeSessionId || topbarGroup?.id || null;
}

export function hasUsableYeaftAgent(store = {}) {
  if (store.currentAgentInfo?.online) return true;
  return Array.isArray(store.agents) && store.agents.some(agent => agent && agent.online);
}
