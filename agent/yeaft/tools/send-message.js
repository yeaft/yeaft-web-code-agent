/**
 * send-message.js — Send a follow-up prompt to a sub-agent.
 *
 * Tool name: PromptAgent (canonical) / SendMessage (legacy alias for
 * historical jsonl replay — see registry alias map).
 */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { enqueueSubAgentPrompt } from '../sub-agent/prompt-queue.js';
import { captureParentEffortDecision } from '../effort.js';
import { isTerminalAgentStatus, isPromptableAgentStatus, STATUS, describeAgentStatus } from '../sub-agent/status.js';

export default defineTool({
  name: 'PromptAgent',
  aliases: ['SendMessage'],
  description: {
    en: `Send a follow-up prompt to a sub-agent you previously spawned.

Use this to give the sub-agent more work, additional instructions, or relay
information. The prompt is queued for the agent to process on its next turn.

IMPORTANT — PromptAgent only QUEUES the message; it does NOT block. A follow-up
is unfinished until you collect the reply. After PromptAgent returns, call
WaitAgent in the same parent turn. If WaitAgent reports running/timedOut, call
WaitAgent again with a larger bounded timeout unless the agent is stale/stalled.
When the reply arrives, relay the result to the user or
continue the work that depends on it. Do not end the parent turn immediately
after PromptAgent.

PromptAgent is rejected if the sub-agent is in a terminal state
(completed/failed/closed/abandoned). Use SpawnAgent to start a fresh one.`,
    zh: `向之前创建的子 Agent 发送后续提示。

用于给子 Agent 更多工作、额外指令或传递信息。提示会排队等待子 Agent 在其下一个 turn 处理。

重要——PromptAgent 仅将消息排队，不阻塞。后续任务只有拿到回复才算完成。PromptAgent 返回后，
父级必须在同一个 turn 调用 WaitAgent。如果 WaitAgent 返回 running/timedOut，除非 Agent 已经
stale/stalled，否则必须使用更大的有界 timeout 再次调用 WaitAgent。回复到达后，必须向用户转述结果或继续执行
依赖该结果的工作。禁止在 PromptAgent 后立刻结束父级 turn。

如果子 Agent 处于终止状态（completed/failed/closed/abandoned），PromptAgent 会被拒绝。
用 SpawnAgent 启动新的。`
  },
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: {
          en: 'The sub-agent ID (returned by Agent tool)',
          zh: '子 Agent ID（由 Agent 工具返回）',
        },
      },
      message: {
        type: 'string',
        description: {
          en: 'The message to send to the agent',
          zh: '要发送给 Agent 的消息',
        },
      },
    },
    required: ['agent_id', 'message'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  // Queueing a prompt can resume an existing writable child after this
  // orchestration call returns, so parent filesystem snapshots are stale-risk.
  mayMutateWorkspaceAfterReturn: () => true,
  async execute(input, ctx) {
    // NB: next_steps is the FIRST envelope field — the registry's
    // model-context tail truncation would eat it if it lived at the end.
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
    if (!agentBelongsToCaller(agent, ctx)) {
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
    enqueueSubAgentPrompt(agent, message, {
      parentEffortDecision: captureParentEffortDecision(ctx),
      projectSessionIds: ctx?.parentEngineDeps?.projectSessionIds,
      projectLabel: ctx?.parentEngineDeps?.projectLabel,
      projectInstruction: ctx?.parentEngineDeps?.projectInstruction,
    });
    agent.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });
    // WaitAgent uses this marker to distinguish an explicitly queued follow-up
    // from an ordinary asynchronous SpawnAgent run. A bounded timeout must not
    // silently downgrade the same-parent-turn collection contract.
    agent.promptReplyPending = true;
    agent.promptReplyPendingAt = Date.now();
    if (agent.status === STATUS.IDLE || agent.status === STATUS.CREATED) {
      agent.status = STATUS.RUNNING;
    }

    return JSON.stringify({
      next_steps:
        'Message is queued — the sub-agent has NOT replied yet. Call WaitAgent ' +
        'in this parent turn and collect the reply. If it is still running, call ' +
        'WaitAgent again with a larger bounded timeout unless it is stale/stalled. ' +
        'Relay the reply or continue the dependent work; do NOT end now.',
      success: true,
      agentId: agent_id,
      name: agent.name,
      messageCount: agent.messages.length,
      pending: agent.pendingPrompts.length,
      message: `Message sent to agent "${agent.name}". Call WaitAgent now; the reply is still pending.`,
    });
  },
});
