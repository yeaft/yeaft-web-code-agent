/**
 * list-agents.js — List all active sub-agents.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'ListAgents',
  description: `List all sub-agents and their current status.

Shows agent IDs, names, tasks, status (created/active/completed/closed),
and message counts. Use to monitor parallel task progress.`,
  parameters: {
    type: 'object',
    properties: {
      include_closed: {
        type: 'boolean',
        description: 'Include closed agents in the list (default: false)',
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { include_closed = false } = input;
    const agents = getAgentRegistry();

    const agentList = [];
    for (const [id, agent] of agents) {
      if (!include_closed && agent.status === 'closed') continue;
      agentList.push({
        id,
        name: agent.name,
        status: agent.status,
        task: agent.task?.slice(0, 200),
        messages: agent.messages.length,
        hasResult: !!agent.result,
        createdAt: agent.createdAt,
      });
    }

    if (agentList.length === 0) {
      return JSON.stringify({
        agents: [],
        message: 'No active sub-agents',
      });
    }

    return JSON.stringify({
      agents: agentList,
      totalCount: agentList.length,
    }, null, 2);
  },
});
