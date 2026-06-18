/**
 * close-agent.js — Close a sub-agent and clean up.
 *
 * Marks status='closed' (terminal), aborts the abort controller so any
 * in-flight engine.query stops promptly, and drains any pending re-entry
 * notification for the agent so the engine doesn't redeliver it on the
 * next user turn.
 */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { isTerminalAgentStatus, STATUS } from '../sub-agent/status.js';
import { consumeNotificationForAgent, enqueueTerminalNotification } from '../sub-agent/notifications.js';
import { snapshotLiveness } from '../sub-agent/liveness.js';

export default defineTool({
  name: 'CloseAgent',
  description: {
    en: `Close a sub-agent and release its resources.

Use when a sub-agent's task is complete or no longer needed.
The agent's final \`result\` (if any) is returned in the envelope before closing.

CRITICAL — closing the sub-agent is NOT the end of YOUR turn. After CloseAgent
you MUST relay the \`result\` to the user in your own reply (or summarize what
was accomplished). The user has not seen the sub-agent's reply — only you have.
Do NOT end your turn silently right after CloseAgent.`,
    zh: `关闭子 Agent 并释放其资源。

当子 Agent 的任务完成或不再需要时使用。关闭前会返回子 Agent 的最终 result（如有）。

关键——关闭子 Agent 不是你 turn 的结束。CloseAgent 后你必须用自己的回复将 result 传达给用户
（或总结已完成的内容）。用户看不到子 Agent 的回复——只有你能看到。不要在 CloseAgent 后默默结束 turn。`
  },
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: {
          en: 'The sub-agent ID to close',
          zh: '要关闭的子 Agent ID',
        },
      },
      result: {
        type: 'string',
        description: {
          en: 'Optional final result to set before closing',
          zh: '关闭前设置的可选最终结果',
        },
      },
    },
    required: ['agent_id'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
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
    if (!agentBelongsToCaller(agent, ctx)) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: `Agent not found: ${agent_id}` });
    }

    if (result) {
      agent.result = result;
    }

    // Abort any in-flight engine.query so the driver loop exits promptly.
    // Cooperative — if the driver is mid-stream the adapter receives the
    // signal; if it's idle, status flip ends the wait loop on the next tick.
    if (agent.abortController && !agent.abortController.signal.aborted) {
      try { agent.abortController.abort('closed'); } catch { /* ignore */ }
    }

    const finalResult = (typeof agent.result === 'string' && agent.result)
      ? agent.result
      : (agent.lastResult || '');

    // If the agent had already gone terminal (e.g. failed) before we got
    // here, preserve that status; otherwise mark closed. Either way drain
    // any pending re-entry notification — the parent is explicitly
    // wrapping up so it doesn't need another nudge.
    const wasTerminal = isTerminalAgentStatus(agent.status);
    if (!wasTerminal) {
      agent.status = STATUS.CLOSED;
      if (agent.taskId && ctx?.taskManager && agent.parentSessionId) {
        try {
          ctx.taskManager.completeTask(agent.parentSessionId, agent.taskId, {
            status: 'cancelled',
            error: agent.error || null,
          });
        } catch { /* ignore */ }
      }
      // The driver may not yet have observed the abort / status flip; push
      // a notification so the queue stays consistent (idempotent inside
      // the notifications module). The driver's own finalizeTerminal()
      // would also try to enqueue but the __terminalNotified guard makes
      // that a no-op.
      try {
        enqueueTerminalNotification({
          agentId: agent.id,
          agentName: agent.name,
          status: STATUS.CLOSED,
          result: finalResult,
          error: agent.error || null,
          outputFile: agent.outputFile || null,
          turns: agent.usage?.turns || 0,
          parentVpId: agent.parentVpId || null,
          parentSessionId: agent.parentSessionId || null,
          parentThreadId: agent.parentThreadId || 'main',
        });
      } catch { /* never block close on notification queue */ }
      agent.__terminalNotified = true;
    }

    // The parent is acknowledging the agent right now via this tool
    // call; drop the queued notification so the engine doesn't
    // double-deliver on its next user turn.
    consumeNotificationForAgent(agent.id);

    return JSON.stringify({
      next_steps:
        'Sub-agent is closed. Now reply to the user — summarize what was ' +
        'accomplished and surface the `result` text. Do NOT end your turn ' +
        'without telling the user what happened.',
      success: true,
      agentId: agent_id,
      name: agent.name,
      status: agent.status,
      result: finalResult,
      outputFile: agent.outputFile || null,
      liveness: snapshotLiveness(agent.liveness),
      messages: agent.messages.length,
      turns: agent.usage?.turns || 0,
      message: `Agent "${agent.name}" closed`,
    });
  },
});
