// Mock only the Agent boundary; settings/discovery travel through the real Server.
import { scheduledTaskAgent } from './scheduled-task-agent.js';

export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1';
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', protocol: 'gemini', contextWindow: 1048576, maxOutput: 65536 },
  { id: 'gemini-4-hydrogen', protocol: 'gemini', contextWindow: 1048576, maxOutput: 65536 },
];

export function geminiAgent(agent) {
  const inventory = scheduledTaskAgent(agent);
  const state = { inventory, config: { providers: [], primaryModel: null }, writes: [], discoveries: [], held: null };
  state.replyDiscovery = (error = '') => {
    const request = state.held;
    if (!request) throw new Error('No pending Gemini discovery');
    agent.send({ type: 'llm_models_discovered', requestId: request.requestId,
      providerType: 'gemini', ...(error ? { error } : { providerModels: structuredClone(GEMINI_MODELS) }) });
    state.held = null;
  };
  agent._messageHandlers.push(request => {
    if (request.type === 'get_llm_config') {
      agent.send({ type: 'llm_config', requestId: request.requestId, agentConfig: state.config });
    } else if (request.type === 'update_llm_config') {
      state.writes.push(request);
      state.config = structuredClone(request.config);
      agent.send({ type: 'llm_config_updated', requestId: request.requestId, agentConfig: state.config });
    } else if (request.type === 'discover_llm_models') {
      state.discoveries.push(request);
      state.held = request;
    } else if (request.type === 'get_models_dev_registry') {
      agent.send({ type: 'models_dev_registry', requestId: request.requestId, fetchedAt: Date.now(), registry: {
        google: { name: 'Google Gemini', api: GEMINI_URL, models: {
          'gemini-2.5-flash': { limit: { context: 1048576, output: 65536 } },
          'gemini-2.5-pro': { limit: { context: 1048576, output: 65536 } },
        } },
      } });
    } else if (request.type === 'yeaft_update_session_config') {
      const session = state.inventory.sessions.get(request.sessionId);
      session.config = { ...session.config, ...request.config };
      agent.send({ type: 'yeaft_output', event: { type: 'session_crud_result', op: 'update_config',
        requestId: request.requestId, sessionId: request.sessionId, ok: true, config: session.config, session } });
    }
  });
  return state;
}
