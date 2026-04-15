/**
 * agent.js — Create a sub-agent for parallel task execution.
 *
 * Sub-agents run in isolated contexts and can be assigned
 * independent tasks. They communicate via send-message/wait-agent.
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';

/** In-memory sub-agent registry. */
const agents = new Map();

/** Get the global agents map for other tools to access. */
export function getAgentRegistry() {
  return agents;
}

export default defineTool({
  name: 'Agent',
  description: `Create a sub-agent to work on an independent task in parallel.

Sub-agents run in their own context and can be given specific tasks.
Use for parallel execution of independent subtasks.

Guidelines:
- Give each agent a clear, focused task description
- Use unique, descriptive names
- Sub-agents share the same tools but have independent conversations
- Use SendMessage to communicate with agents, WaitAgent to collect results
- Close agents with CloseAgent when done`,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A descriptive name for the sub-agent (e.g. "test-writer", "refactor-auth")',
      },
      task: {
        type: 'string',
        description: 'The task description for the sub-agent',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the sub-agent (optional, defaults to parent cwd)',
      },
    },
    required: ['name', 'task'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { name, task, cwd } = input;
    if (!name) return JSON.stringify({ error: 'name is required' });
    if (!task) return JSON.stringify({ error: 'task is required' });

    // Check for name collision
    for (const [, agent] of agents) {
      if (agent.name === name && agent.status !== 'closed') {
        return JSON.stringify({
          error: `Agent "${name}" already exists. Close it first or use a different name.`,
          agentId: agent.id,
        });
      }
    }

    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const agent = {
      id: agentId,
      name,
      task,
      cwd: cwd || ctx?.cwd || process.cwd(),
      status: 'created',
      messages: [],
      result: null,
      createdAt: Date.now(),
    };

    agents.set(agentId, agent);

    return JSON.stringify({
      success: true,
      agentId,
      name,
      message: `Sub-agent "${name}" created (${agentId}). Use SendMessage to give it work.`,
    });
  },
});
