/**
 * close-agent.js — Close a sub-agent and clean up.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

export default defineTool({
  name: 'CloseAgent',
  description: `Close a sub-agent and release its resources.

Use when a sub-agent's task is complete or no longer needed.
The agent's final \`result\` (if any) is returned in the envelope before closing.

CRITICAL — closing the sub-agent is NOT the end of YOUR turn. After CloseAgent
you MUST relay the \`result\` to the user in your own reply (or summarize what
was accomplished). The user has not seen the sub-agent's reply — only you have.
Do NOT end your turn silently right after CloseAgent.`,
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
    // NB: next_steps is the FIRST envelope field — the registry's 1 KiB
    // tail-truncation would eat it if it lived at the end.
    const ERROR_NEXT_STEPS =
      'That call failed — see `error`. Either correct the arguments and ' +
      'retry, or tell the user what went wrong. Do NOT end your turn ' +
      'silently after an error envelope.';

    const { agent_id, result } = input;
    if (!agent_id) return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: 'agent_id is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: `Agent not found: ${agent_id}` });
    }

    if (result) {
      agent.result = result;
    }

    // PR-M1: abort any in-flight engine.query so the driver loop exits
    // promptly. This is cooperative — if the driver is mid-stream the
    // adapter receives the signal; if it's idle, status flip ends the
    // wait loop on the next 50ms tick.
    if (agent.abortController && !agent.abortController.signal.aborted) {
      try { agent.abortController.abort('closed'); } catch { /* ignore */ }
    }

    const finalResult = agent.result || agent.lastResult || '';
    agent.status = 'closed';

    return JSON.stringify({
      next_steps:
        'Sub-agent is closed. Now reply to the user — summarize what was ' +
        'accomplished and surface the `result` text. Do NOT end your turn ' +
        'without telling the user what happened.',
      success: true,
      agentId: agent_id,
      name: agent.name,
      result: finalResult,
      messages: agent.messages.length,
      turns: agent.usage?.turns || 0,
      message: `Agent "${agent.name}" closed`,
    });
  },
});
