/**
 * wait-agent.js — Wait for a sub-agent to complete and get its result.
 *
 * Loop-stall fix (2026-06-11):
 *
 * Symptom — when the LLM called WaitAgent inside a sub-agent orchestration,
 * the assistant turn ended silently right after the tool returned. The user
 * saw a stuck "tool ran" panel and no follow-up text or further tool calls.
 *
 * Cause — the engine loop is correct (it appends the tool result and re-enters
 * `adapter.stream()`), but the LLM was reading the bare JSON envelope (status +
 * result + turns…) as a "complete answer" and emitting `end_turn` with no
 * text. The previous description ("Returns the agent's final result or current
 * status") gave it zero guidance about what to do next.
 *
 * Fix — every WaitAgent response now carries an explicit, status-dependent
 * `next_steps` field that names the exact tool to call next, and the tool
 * description spells out the full SpawnAgent → PromptAgent → WaitAgent →
 * CloseAgent loop. The same nudge pattern lives on the companion tools.
 */

import { defineTool } from './types.js';
import { getAgentRegistry } from './agent.js';

/**
 * Build the status-specific next-step guidance the LLM reads after a wait.
 *
 * The wording is imperative and names actual tools so the model has a clear
 * action to take — leaving it implicit was the bug.
 *
 * @param {string} status
 * @param {boolean} [timedOut]
 */
function nextStepsFor(status, timedOut = false) {
  if (timedOut) {
    return (
      'Sub-agent is still running. Either (a) call WaitAgent again with a ' +
      'larger timeout_ms to keep waiting, (b) call CloseAgent if you want to ' +
      'cut it short and use partial output, or (c) explain to the user that ' +
      'the agent is still working and ask whether to keep waiting. Do NOT ' +
      'end your turn silently.'
    );
  }
  switch (status) {
    case 'idle':
      return (
        'Sub-agent finished one turn and is idle. The `result` above is its ' +
        'reply — relay it to the user in your own words, or send a follow-up ' +
        'via PromptAgent, or finalize via CloseAgent. Do NOT end your turn ' +
        'silently without telling the user what the sub-agent said.'
      );
    case 'completed':
      return (
        'Sub-agent finished successfully (terminal). Summarize the `result` ' +
        'for the user in your own reply. Do NOT end your turn with no text.'
      );
    case 'closed':
      return (
        'Sub-agent was closed (terminal). Report the final `result` to the ' +
        'user in your reply. Do NOT end your turn silently.'
      );
    case 'failed':
      return (
        'Sub-agent failed — see `error`. Decide whether to retry with a fresh ' +
        'SpawnAgent, adjust the mission, or report the failure to the user. ' +
        'Do NOT end your turn silently.'
      );
    default:
      return (
        'Decide what to do next: PromptAgent to send follow-up work, ' +
        'CloseAgent to finalize, or WaitAgent again. Always tell the user ' +
        'what just happened — do NOT end your turn silently.'
      );
  }
}

/**
 * Nudge for the `{error: ...}` error envelopes. The error path used to ship a
 * naked `{error}` blob — same shape that caused the silent-end_turn bug on the
 * happy path. Tell the LLM what to do about an error (correct the call, or
 * report the failure to the user) so it does not end its turn silently after a
 * fat-finger like a wrong agent_id.
 */
function errorNextSteps() {
  return (
    'That call failed — see `error`. Either correct the arguments and retry, ' +
    'or tell the user what went wrong. Do NOT end your turn silently after an ' +
    'error envelope; the user has not seen the error, only you have.'
  );
}

export default defineTool({
  name: 'WaitAgent',
  description: `Wait for a sub-agent to complete its current turn and retrieve its reply.

Returns a JSON envelope with the sub-agent's status, latest \`result\` text, and
an explicit \`next_steps\` field telling you what to do next. Read \`next_steps\`
every time — the wait is part of an orchestration loop, not a terminal answer.

CRITICAL — after WaitAgent returns you MUST take one of these actions:
  • status='idle' / 'completed' / 'closed': RELAY the \`result\` to the user
    in your own words (or send follow-up work via PromptAgent, or finalize
    via CloseAgent).
  • status='failed': report the failure to the user OR retry with a fresh
    SpawnAgent.
  • timedOut=true: call WaitAgent again with a larger timeout, OR CloseAgent
    to cut it short, OR tell the user the agent is still working.

NEVER end your turn silently right after WaitAgent — the user has not seen the
sub-agent's reply yet; only you have. The orchestration loop is
SpawnAgent → (PromptAgent ↔ WaitAgent)+ → CloseAgent → final reply to user.

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
    // NB: `next_steps` is intentionally the FIRST field in every envelope
    // below. `agent/yeaft/tools/registry.js` caps each tool result at
    // TOOL_RESULT_MAX_BYTES (1 KiB) by truncating the tail — if `next_steps`
    // were last, a long `result` would push the directive off the end and the
    // LLM would never see the very nudge this PR delivers.
    if (!agent_id) {
      return JSON.stringify({ next_steps: errorNextSteps(), error: 'agent_id is required' });
    }
    if (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms < 0 || timeout_ms > 300000) {
      return JSON.stringify({ next_steps: errorNextSteps(), error: 'timeout_ms must be a number between 0 and 300000' });
    }

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ next_steps: errorNextSteps(), error: `Agent not found: ${agent_id}` });
    }

    // Terminal states return immediately.
    if (agent.status === 'completed' || agent.status === 'closed' || agent.status === 'failed') {
      return JSON.stringify({
        next_steps: nextStepsFor(agent.status),
        agentId: agent_id,
        name: agent.name,
        status: agent.status,
        result: agent.result || agent.lastResult || '',
        error: agent.error || null,
        messages: agent.messages.length,
        turns: agent.usage?.turns || 0,
      });
    }

    // 'idle' means the sub-agent finished its current turn and is waiting
    // for the next SendMessage. That IS a useful return point for the
    // parent — surface lastResult and let parent decide what's next.
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (agent.status === 'idle' || agent.status === 'completed' || agent.status === 'closed' || agent.status === 'failed') {
        return JSON.stringify({
          next_steps: nextStepsFor(agent.status),
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
        return JSON.stringify({ next_steps: errorNextSteps(), error: 'Wait cancelled', agentId: agent_id });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    return JSON.stringify({
      next_steps: nextStepsFor(agent.status, true),
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
