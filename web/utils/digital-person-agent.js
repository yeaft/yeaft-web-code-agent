/** Connected Digital Person destinations with the browser's per-Agent opt-in.
 * Session selection must not hide another Agent's available Digital Person.
 */
export function availableDigitalPersonAgents(chat) {
  return (chat?.agents || []).filter(agent => agent?.online
    && agent.capabilities?.includes('digital_person')
    && chat.digitalPersonUiEnabledByAgent?.[agent.id] === true);
}

/** Keep the last Person destination independent of the current Session route. */
export function resolveDigitalPersonAgentId(chat) {
  const agents = availableDigitalPersonAgents(chat);
  for (const agentId of [chat?.digitalPersonAgentId, chat?.activeSessionRoute?.agentId || chat?.currentAgent]) {
    if (agents.some(agent => agent.id === agentId)) return agentId;
  }
  return agents[0]?.id || null;
}
