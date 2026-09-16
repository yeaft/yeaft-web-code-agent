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
 *              another bounded WaitAgent or CloseAgent. `result` carries the
 *              mid-stream preview (the driver keeps lastResult fresh
 *              from every text_delta).
 *
 * Every envelope includes `outputFile` (durable per-agent JSONL log) and
 * `liveness` (toolUseCount, usageTokens, outputChars, msSinceLastEvent, recentTools,
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
 * the envelope (the registry's model-context tail truncation would
 * otherwise eat tail-positioned nudges when `result` is long).
 *
 * @param {string} status
 * @param {{ timedOut?: boolean, budgetExceeded?: boolean, stale?: boolean, mustCollectReply?: boolean }} [opts]
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
      'No observable event arrived within the diagnostic threshold. This does ' +
      'not prove the provider or tool is dead. Do NOT keep calling WaitAgent ' +
      'in a blind loop; inspect outputFile, then use CloseAgent only if you ' +
      'actually intend to cancel, or report that the background task is quiet.'
    );
  }
  if (opts.timedOut && opts.mustCollectReply) {
    return (
      'The PromptAgent follow-up reply is still pending and must be collected ' +
      'in this parent turn. Call WaitAgent again with a larger bounded timeout. ' +
      'Do not end the turn or switch to ListAgents/notifications. Stop re-waiting ' +
      'only if the agent becomes stale/stalled, the wait is cancelled, or the ' +
      'agent returns idle/terminal.'
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
  const mustCollectReply = agent.promptReplyPending === true;
  if (!timedOut && (status === STATUS.IDLE || isTerminalAgentStatus(status))) {
    agent.promptReplyPending = false;
    agent.promptReplyPendingAt = null;
  }
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
    next_steps: nextStepsFor(status, {
      timedOut,
      budgetExceeded: !!budgetResult,
      stale: liveness.stale,
      mustCollectReply: mustCollectReply && !liveness.stale,
    }),
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
    mustCollectReply: timedOut ? mustCollectReply : false,
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

Returns JSON with explicit \`status\`, latest \`result\` text, \`liveness\`
counters (actual toolUseCount, provider usageTokens, outputChars, msSinceLastEvent, recentTools), the
durable \`outputFile\` path you can Read at any time, and a status-specific
\`next_steps\` directive telling you what to call next.

Status semantics:
  • completed / closed / failed / abandoned  → terminal. The sub-agent will
    do nothing more. Relay the result to the user (or retry / report the
    failure).
  • idle  → the sub-agent finished a turn and is parked with an empty
    queue. You can PromptAgent for follow-up or CloseAgent to finalize.
  • timedOut=true (with status='running' and runningInBackground=true) →
    the wait elapsed but the sub-agent is STILL working. It does NOT need
    another PromptAgent. Either WaitAgent again with a larger timeout,
    CloseAgent to cut it short, or tell the user it's still working.

After WaitAgent returns, act on the status. A non-stale timeout after PromptAgent
has 'mustCollectReply=true': call WaitAgent again with a larger bounded timeout in
the same parent turn until idle/terminal. A stale diagnostic breaks that blind
wait loop but does not cancel or prove failure: inspect outputFile before deciding.
For ordinary SpawnAgent background work, use ListAgents or later completion
notifications instead of repeatedly re-waiting.

The default wait is a bounded 5000ms poll; callers may request up to 300000ms
(5 minutes). This caps one WaitAgent call only, not the sub-agent lifetime.`,
    zh: `等待子 Agent 的下一次状态变更（turn 结束、终止或等待超时）并获取状态信封。

返回 JSON，含明确的 status、最新的 result 文本、liveness 计数器（实际 toolUseCount、provider usageTokens、outputChars、
msSinceLastEvent、recentTools）、可随时 Read 的持久化 outputFile 路径，以及状态相关的 next_steps
指令告诉你下一步该调用什么。

状态语义：
  - completed / closed / failed / abandoned -> 终止。子 Agent 不再做任何事。将结果传达给用户
    （或重试/报告失败）。
  - idle -> 子 Agent 完成了一个 turn 并停在空队列。你可以 PromptAgent 继续或 CloseAgent 结束。
  - timedOut=true（status='running' 且 runningInBackground=true）-> 等待时间耗尽但子 Agent
    仍在运行。不需要再 PromptAgent。要么用更大 timeout 再次 WaitAgent，要么 CloseAgent 中断，
    要么告知用户它仍在工作。

PromptAgent 后若非 stale/stalled 的有界等待超时，必须在同一父级 turn 使用更大的有界 timeout
再次调用 WaitAgent，直到 idle/terminal；不要改用 ListAgents/notification 丢下未收集的回复。
若信封显示 stale/stalled，应停止盲目等待并检查 outputFile；它只是诊断，不会取消任务，也不能证明
provider 或工具已经卡死。仅在确实要取消时使用 CloseAgent。

普通 SpawnAgent 异步流程仍用 ListAgents 做非阻塞状态检查，并依赖后续 completion
notification；默认 5000ms、最大 300000ms 仅限制单次 WaitAgent 调用，不限制子 Agent 生命周期。`
  },
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: {
          en: 'The sub-agent ID to wait for',
          zh: '要等待的子 Agent ID',
        },
      },
      timeout_ms: {
        type: 'number',
        minimum: 0,
        maximum: 300000,
        description: {
          en: 'Maximum duration of this wait call, not the sub-agent lifetime (default: 5000, max: 300000)',
          zh: '本次等待调用的最长时间，不是子 Agent 生命周期（默认 5000，最大 300000）',
        },
      },
    },
    required: ['agent_id'],
  },
  timeoutMs: 305000,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  cacheWithinQuery: false,
  duplicateCallPolicy: () => 'allow',
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

    // Re-check after the final sleep. The status may have changed just before
    // the deadline without another loop iteration.
    if (isTerminalAgentStatus(agent.status) || agent.status === STATUS.IDLE) {
      consumeNotificationForAgent(agent.id);
      return JSON.stringify(buildEnvelope(agent));
    }

    // Wait elapsed; the sub-agent is still running. Surface mid-stream
    // preview + liveness so the parent has actionable signal.
    return JSON.stringify(buildEnvelope(agent, { timedOut: true }));
  },
});
