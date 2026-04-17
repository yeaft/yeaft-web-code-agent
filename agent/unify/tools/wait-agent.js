/**
 * wait-agent.js — Wait for a sub-agent to complete and get its result.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'WaitAgent',
  description: `Wait for a sub-agent to complete its task and retrieve the result.

Returns the agent's final result or current status if still running.
Use after sending a task to an agent via SendMessage.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The sub-agent ID to wait for',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 30000)',
      },
    },
    required: ['agent_id'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { agent_id, timeout_ms = 30000 } = input;
    if (!agent_id) return JSON.stringify({ error: 'agent_id is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ error: `Agent not found: ${agent_id}` });
    }

    // If already completed, return result immediately
    if (agent.status === 'completed' || agent.status === 'closed') {
      return JSON.stringify({
        agentId: agent_id,
        name: agent.name,
        status: agent.status,
        result: agent.result,
        messages: agent.messages.length,
      });
    }

    // Wait for completion with timeout
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (agent.status === 'completed' || agent.status === 'closed') {
        return JSON.stringify({
          agentId: agent_id,
          name: agent.name,
          status: agent.status,
          result: agent.result,
          messages: agent.messages.length,
        });
      }

      // Check abort signal
      if (ctx?.signal?.aborted) {
        return JSON.stringify({ error: 'Wait cancelled', agentId: agent_id });
      }

      // Poll every 500ms
      await new Promise(r => setTimeout(r, 500));
    }

    return JSON.stringify({
      agentId: agent_id,
      name: agent.name,
      status: agent.status,
      timedOut: true,
      message: `Agent "${agent.name}" is still running after ${timeout_ms}ms`,
      messages: agent.messages.length,
    });
  },
});
