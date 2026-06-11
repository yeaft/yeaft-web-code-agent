/**
 * wait-agent.js — Wait for a sub-agent to complete and get its result.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'WaitAgent',
  description: `Wait for a sub-agent to complete its task and retrieve the result.

Returns the agent's final result or current status if still running.
Use after sending a task to an agent via PromptAgent.

The default wait is 30000ms. Callers may request up to 300000ms (5 minutes).`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The sub-agent ID to wait for',
      },
      timeout_ms: {
        type: 'number',
        minimum: 0,
        maximum: 300000,
        description: 'Maximum time to wait in milliseconds (default: 30000, max: 300000 / 5 minutes)',
      },
    },
    required: ['agent_id'],
  },
  timeoutMs: 305000,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { agent_id, timeout_ms = 30000 } = input;
    if (!agent_id) return JSON.stringify({ error: 'agent_id is required' });
    if (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms < 0 || timeout_ms > 300000) {
      return JSON.stringify({ error: 'timeout_ms must be a number between 0 and 300000' });
    }

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ error: `Agent not found: ${agent_id}` });
    }

    // PR-M1: terminal states return immediately.
    if (agent.status === 'completed' || agent.status === 'closed' || agent.status === 'failed') {
      return JSON.stringify({
        agentId: agent_id,
        name: agent.name,
        status: agent.status,
        result: agent.result || agent.lastResult || '',
        error: agent.error || null,
        messages: agent.messages.length,
        turns: agent.usage?.turns || 0,
      });
    }

    // PR-M1: 'idle' means the sub-agent finished its current turn and is
    // waiting for the next SendMessage. That IS a useful return point for
    // the parent — surface lastResult and let parent decide what's next.
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (agent.status === 'idle' || agent.status === 'completed' || agent.status === 'closed' || agent.status === 'failed') {
        return JSON.stringify({
          agentId: agent_id,
          name: agent.name,
          status: agent.status,
          result: agent.result || agent.lastResult || '',
          error: agent.error || null,
          messages: agent.messages.length,
          turns: agent.usage?.turns || 0,
        });
      }

      if (ctx?.signal?.aborted) {
        return JSON.stringify({ error: 'Wait cancelled', agentId: agent_id });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    return JSON.stringify({
      agentId: agent_id,
      name: agent.name,
      status: agent.status,
      timedOut: true,
      message: `Agent "${agent.name}" is still running after ${timeout_ms}ms`,
      result: agent.lastResult || '',
      messages: agent.messages.length,
      turns: agent.usage?.turns || 0,
    });
  },
});
