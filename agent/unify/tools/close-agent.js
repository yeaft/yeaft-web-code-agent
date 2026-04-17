/**
 * close-agent.js — Close a sub-agent and clean up.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'CloseAgent',
  description: `Close a sub-agent and release its resources.

Use when a sub-agent's task is complete or no longer needed.
The agent's result (if any) is returned before closing.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The sub-agent ID to close',
      },
      result: {
        type: 'string',
        description: 'Optional final result to set before closing',
      },
    },
    required: ['agent_id'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { agent_id, result } = input;
    if (!agent_id) return JSON.stringify({ error: 'agent_id is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ error: `Agent not found: ${agent_id}` });
    }

    if (result) {
      agent.result = result;
    }

    const finalResult = agent.result;
    agent.status = 'closed';

    return JSON.stringify({
      success: true,
      agentId: agent_id,
      name: agent.name,
      result: finalResult,
      messages: agent.messages.length,
      message: `Agent "${agent.name}" closed`,
    });
  },
});
