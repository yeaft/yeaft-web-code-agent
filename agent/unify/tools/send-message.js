/**
 * send-message.js — Send a message to a sub-agent.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'SendMessage',
  description: `Send a message to a sub-agent.

Use this to give tasks, provide instructions, or relay information to a sub-agent.
The message is queued for the agent to process.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The sub-agent ID (returned by Agent tool)',
      },
      message: {
        type: 'string',
        description: 'The message to send to the agent',
      },
    },
    required: ['agent_id', 'message'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { agent_id, message } = input;
    if (!agent_id) return JSON.stringify({ error: 'agent_id is required' });
    if (!message) return JSON.stringify({ error: 'message is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ error: `Agent not found: ${agent_id}` });
    }

    if (agent.status === 'closed') {
      return JSON.stringify({ error: `Agent "${agent.name}" is closed` });
    }

    agent.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });
    agent.status = 'active';

    return JSON.stringify({
      success: true,
      agentId: agent_id,
      name: agent.name,
      messageCount: agent.messages.length,
      message: `Message sent to agent "${agent.name}"`,
    });
  },
});
