/**
 * send-message.js — Send a follow-up prompt to a sub-agent.
 *
 * Tool name: PromptAgent (canonical) / SendMessage (legacy alias for
 * historical jsonl replay — see registry alias map).
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';
import { isTerminalAgentStatus, isPromptableAgentStatus, STATUS, describeAgentStatus } from '../sub-agent/status.js';

export default defineTool({
  name: 'PromptAgent',
  aliases: ['SendMessage'],
  description: `Send a follow-up prompt to a sub-agent you previously spawned.

Use this to give the sub-agent more work, additional instructions, or relay
information. The prompt is queued for the agent to process on its next turn.

IMPORTANT — PromptAgent only QUEUES the message; it does NOT block. After this
returns you almost always want to call WaitAgent next to collect the reply.
Do NOT end your turn after PromptAgent without either (a) calling WaitAgent,
(b) explaining to the user what you just asked the sub-agent, or (c) calling
CloseAgent. The orchestration loop is
SpawnAgent → (PromptAgent ↔ WaitAgent)+ → CloseAgent → final reply to user.

PromptAgent is rejected if the sub-agent is in a terminal state
(completed/failed/closed/abandoned). Use SpawnAgent to start a fresh one.`,
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
    // NB: next_steps is the FIRST envelope field — the registry's 1 KiB
    // tail-truncation would eat it if it lived at the end.
    const ERROR_NEXT_STEPS =
      'That call failed — see `error`. Either correct the arguments and ' +
      'retry, or tell the user what went wrong. Do NOT end your turn ' +
      'silently after an error envelope.';

    const { agent_id, message } = input;
    if (!agent_id) return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: 'agent_id is required' });
    if (!message) return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: 'message is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: `Agent not found: ${agent_id}` });
    }

    if (isTerminalAgentStatus(agent.status)) {
      // Build a specific error message per status. Telling the model
      // "agent is closed" vs "agent failed: <error>" vs "agent was
      // abandoned (idle too long)" gives it a clear next action.
      const desc = describeAgentStatus(agent.status);
      const detail = agent.status === STATUS.FAILED && agent.error
        ? `: ${agent.error}`
        : '';
      return JSON.stringify({
        next_steps: ERROR_NEXT_STEPS,
        error: `Agent "${agent.name}" is ${desc}${detail}. Spawn a new agent if you need more work.`,
        agentId: agent_id,
        status: agent.status,
      });
    }

    if (!isPromptableAgentStatus(agent.status)) {
      // Defensive — covers any future status that isn't terminal but
      // also isn't ready for prompts.
      return JSON.stringify({
        next_steps: ERROR_NEXT_STEPS,
        error: `Agent "${agent.name}" is in status "${agent.status}", which does not accept new prompts.`,
        agentId: agent_id,
      });
    }

    // Queue as a pending prompt the driver will pull. This wakes the
    // driver out of its idle wait and starts a new turn.
    if (!Array.isArray(agent.pendingPrompts)) agent.pendingPrompts = [];
    agent.pendingPrompts.push(message);
    agent.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });
    if (agent.status === STATUS.IDLE || agent.status === STATUS.CREATED) {
      agent.status = STATUS.RUNNING;
    }

    return JSON.stringify({
      next_steps:
        'Message is queued — the sub-agent has NOT replied yet. Call WaitAgent ' +
        'next to collect the reply, then relay it to the user. Do NOT end your ' +
        'turn here without either waiting for the reply or telling the user ' +
        'what you just asked.',
      success: true,
      agentId: agent_id,
      name: agent.name,
      messageCount: agent.messages.length,
      pending: agent.pendingPrompts.length,
      message: `Message sent to agent "${agent.name}". Use WaitAgent to collect its reply.`,
    });
  },
});
