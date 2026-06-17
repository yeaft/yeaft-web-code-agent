/**
 * wait-agent.js — Wait for a sub-agent's next state change.
 *
 * Returns a JSON envelope shaped for the model to make an explicit
 * decision. The shape is stable across statuses; the `next_steps` field
 * always names the exact tool the model should call next.
 *
 * Status semantics returned:
 *   - completed / closed / failed / abandoned (terminal): include
 *     `error` (when applicable), final `result`, and outputFile path
 *     for re-reading. We also drain the agent's queued re-entry
 *     notification so the engine doesn't redeliver it on the next user
 *     turn.
 *   - idle:    sub-agent finished a turn and is parked, waiting for a
 *              PromptAgent or CloseAgent. `result` carries the last
 *              assistant text. Distinct from terminal — the parent can
 *              still send more work.
 *   - running with timedOut=true: we waited and the agent is still
 *              processing. The envelope flags `runningInBackground:
 *              true` (the sub-agent IS continuing — it does NOT need
 *              another PromptAgent to keep going) and recommends either
 *              another WaitAgent or CloseAgent. `result` carries the
 *              mid-stream preview (the driver keeps lastResult fresh
 *              from every text_delta).
 *
 * Every envelope includes `outputFile` (durable per-agent JSONL log) and
 * `liveness` (toolUseCount, tokenCount, msSinceLastEvent, recentTools,
 * lastEventType) so the model can distinguish "stuck" from "still
 * working" and can Read the log directly when it needs the full
 * timeline.
 */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { isTerminalAgentStatus, STATUS } from '../sub-agent/status.js';
import { diagnoseAgentLiveness } from '../sub-agent/liveness.js';
import { consumeNotificationForAgent } from '../sub-agent/notifications.js';

/**
 * Build the status-specific next-step guidance the LLM reads after a wait.
 * Imperative + names actual tools. Always appears as the FIRST field on
 * the envelope (the registry's 1 KiB tail-truncation would otherwise eat
 * tail-positioned nudges when `result` is long).
 *
 * @param {string} status
 * @param {{ timedOut?: boolean, runningInBackground?: boolean, budgetExceeded?: boolean, stale?: boolean }} [opts]
 */
function nextStepsFor(status, opts = {}) {
  if (opts.budgetExceeded) {
    return (
      'Sub-agent stopped because an explicit budget limit was reached. ' +
      'Use `partial_output`, `budget_reason`, and `budget_usage` to decide ' +
      'whether to relay the partial result, spawn a fresh agent with a ' +
      'larger budget, or report the cutoff to the user. Do NOT present this ' +
      'as an ordinary successful completion.'
    );
  }
  if (opts.timedOut && opts.stale) {
    return (
      'Sub-agent still has a running record but appears stalled. Do NOT keep ' +
      'calling WaitAgent in a loop. Use ListAgents/outputFile to inspect it, ' +
      'CloseAgent if you want to stop it, or report the stalled background ' +
      'task and start a fresh agent if needed.'
    );
  }
  if (opts.timedOut) {
    return (
      'Sub-agent is running in the background; it does not need another ' +
      'PromptAgent to keep going. Continue the main task or tell the user it ' +
      'is still running. Use ListAgents later for a non-blocking status check; ' +
      'only call WaitAgent again if the user explicitly wants to wait.'
    );
  }
  switch (status) {
    case STATUS.IDLE:
      return (
        'Sub-agent finished one turn and is idle (queue empty). The ' +
        '`result` above is its reply — relay it to the user in your own ' +
        'words, or send a follow-up via PromptAgent, or finalize via ' +
        'CloseAgent. Do NOT end your turn silently without telling the ' +
        'user what the sub-agent said.'
      );
    case STATUS.COMPLETED:
      return (
        'Sub-agent finished successfully (terminal). Summarize the ' +
        '`result` for the user in your own reply. Do NOT end your turn ' +
        'with no text.'
      );
    case STATUS.CLOSED:
      return (
        'Sub-agent was closed (terminal). Report the final `result` to ' +
        'the user in your reply. Do NOT end your turn silently.'
      );
    case STATUS.FAILED:
      return (
        'Sub-agent failed — see `error`. Decide whether to retry with a ' +
        'fresh SpawnAgent, adjust the mission, or report the failure to ' +
        'the user. Do NOT end your turn silently.'
      );
    case STATUS.ABANDONED:
      return (
        'Sub-agent was abandoned by the idle watchdog — it sat idle too ' +
        'long without a follow-up. The last `result` is its final reply. ' +
        'Either relay it to the user or SpawnAgent fresh with a new ' +
        'mission. Do NOT end your turn silently.'
      );
    default:
      return (
        'Decide what to do next: PromptAgent to send follow-up work, ' +
        'CloseAgent to finalize, or WaitAgent again. Always tell the user ' +
        'what just happened — do NOT end your turn silently.'
      );
  }
}

function errorNextSteps() {
  return (
    'That call failed — see `error`. Either correct the arguments and ' +
    'retry, or tell the user what went wrong. Do NOT end your turn ' +
    'silently after an error envelope; the user has not seen the error, ' +
    'only you have.'
  );
}

/**
 * Build the envelope for a single status snapshot. `result` is taken
 * from `agent.result` (final) if present, else from `agent.lastResult`
 * (mid-stream preview).
 */
function buildEnvelope(agent, { timedOut = false } = {}) {
  const status = agent.status;
  const liveness = diagnoseAgentLiveness(agent);
  const budgetResult = agent.result && typeof agent.result === 'object'
    && agent.result.status === 'budget_exceeded'
    ? agent.result
    : null;
  const resultText = budgetResult
    ? (budgetResult.partial_output || '')
    : ((typeof agent.result === 'string' && agent.result)
        ? agent.result
        : (agent.lastResult || ''));
  const env = {
    next_steps: nextStepsFor(status, { timedOut, budgetExceeded: !!budgetResult, stale: liveness.stale }),
    agentId: agent.id,
    name: agent.name,
    status,
    error: agent.error || null,
    outputFile: agent.outputFile || null,
    liveness,
    stale: liveness.stale,
    stalled: liveness.stalled,
    msSinceLastEvent: liveness.msSinceLastEvent,
    lastEventType: liveness.lastEventType,
    diagnostic: liveness.diagnostic,
    messages: Array.isArray(agent.messages) ? agent.messages.length : 0,
    turns: agent.usage?.turns || 0,
  };
  if (timedOut) {
    env.timedOut = true;
    env.runningInBackground = true;
    env.message = `Agent "${agent.name}" is still running in the background.`;
  }
  if (budgetResult) {
    env.budgetExceeded = true;
    env.budget_status = budgetResult.status;
    env.budget_reason = budgetResult.reason || null;
    env.partial_output = budgetResult.partial_output || '';
    env.budget_usage = budgetResult.usage || null;
  }
  env.result = resultText;
  return env;
}

export default defineTool({
  name: 'WaitAgent',
  description: {
    en: `Wait for a sub-agent's next state change (turn end, terminal, or wait-timeout) and retrieve a status envelope.

This is a minor utility — ListAgents is the primary non-blocking status
surface. WaitAgent is a short-poll convenience for the rare case where you
need a synchronous checkpoint (e.g. "did it finish this turn?"). NEVER
call WaitAgent in a polling loop — use ListAgents to check progress
asynchronously.

Default timeout: 5 seconds. Pass a shorter timeout_ms for a quick poll.
On timeout the envelope includes "still_running" + liveness + next_steps.
On stale/stalled agents the next_steps will explicitly advise against
further waits.

Legacy note: earlier versions encouraged repeated WaitAgent polling;
that pattern is deprecated. Use SpawnAgent → Continue → ListAgents.`,
    zh: `等待子 Agent 的下一个状态变化（turn 结束、终止或等待超时）并获取状态 envelope。

这是次要工具 — ListAgents 是主要的非阻塞状态查看入口。WaitAgent 是
短轮询的便利工具，仅用于你需要同步检查点的罕见场景（如"它这个 turn 完成了吗？"）。
绝不要在轮询循环中调用 WaitAgent — 使用 ListAgents 异步检查进度。

默认超时：5 秒。传较短的 timeout_ms 可做快速轮询。
超时时 envelope 包含 "still_running" + liveness + next_steps。
对于 stale/stalled 的 Agent，next_steps 会明确建议不要再继续等待。

旧版说明：早期版本鼓励重复 WaitAgent 轮询；该模式已弃用。
使用 SpawnAgent → Continue → ListAgents。`,
  },   parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: { en: 'The sub-agent ID to wait for', zh: '要等待的子 Agent ID' },
      },
      timeout_ms: {
        type: 'number',
        minimum: 0,
        maximum: 300000,
        description: { en: 'Maximum time to wait in milliseconds (default: 5000 short poll, max: 300000 / 5 minutes)', zh: '最长等待时间，单位毫秒（默认 5000 短轮询，最大 300000 / 5 分钟）' },
      },
    },
    required: ['agent_id'],
  },
  timeoutMs: 305000,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { agent_id, timeout_ms = 5000 } = input;
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
    if (!agentBelongsToCaller(agent, ctx)) {
      return JSON.stringify({ next_steps: errorNextSteps(), error: `Agent not found: ${agent_id}` });
    }

    // Terminal already — return immediately and drain the notification
    // so the engine doesn't redeliver it on the next user turn.
    if (isTerminalAgentStatus(agent.status)) {
      consumeNotificationForAgent(agent.id);
      return JSON.stringify(buildEnvelope(agent));
    }
    if (agent.status === STATUS.IDLE) {
      consumeNotificationForAgent(agent.id);
      return JSON.stringify(buildEnvelope(agent));
    }
    if (ctx?.signal?.aborted) {
      return JSON.stringify({ next_steps: errorNextSteps(), error: 'Wait cancelled', agentId: agent_id });
    }

    // Block until next interesting state change, capped at timeout_ms.
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (isTerminalAgentStatus(agent.status)) {
        consumeNotificationForAgent(agent.id);
        return JSON.stringify(buildEnvelope(agent));
      }
      if (agent.status === STATUS.IDLE) {
        consumeNotificationForAgent(agent.id);
        return JSON.stringify(buildEnvelope(agent));
      }
      if (ctx?.signal?.aborted) {
        return JSON.stringify({ next_steps: errorNextSteps(), error: 'Wait cancelled', agentId: agent_id });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Wait elapsed; the sub-agent is still running. Surface mid-stream
    // preview + liveness so the parent has actionable signal.
    return JSON.stringify(buildEnvelope(agent, { timedOut: true }));
  },
});
