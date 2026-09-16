/** Compact, caller-scoped status projection for sub-agent orchestration. */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { isTerminalAgentStatus, STATUS } from '../sub-agent/status.js';
import { diagnoseAgentLiveness } from '../sub-agent/liveness.js';

function nextStepFor(agent, liveness) {
  if (isTerminalAgentStatus(agent.status)) {
    return 'Use WaitAgent to collect the final result, or read outputFile for the full timeline.';
  }
  if (agent.status === STATUS.IDLE) {
    return 'Use WaitAgent to collect the reply; PromptAgent only if follow-up guidance is needed.';
  }
  if (liveness.stale) {
    return 'Diagnostic only: inspect outputFile before deciding whether to CloseAgent; do not assume the work is dead.';
  }
  return 'Continue parent work; completion arrives by notification. Read outputFile only when detailed progress is needed.';
}

export default defineTool({
  name: 'ListAgents',
  description: {
    en: `List caller-owned sub-agents as compact status references.

Returns identity, status, bounded mission summary, durable outputFile, actual tool/LLM/token usage, recent activity, diagnostic staleness, and an actionable next step. It does not copy result text or the full log; use WaitAgent for a reply and Read outputFile for the timeline.

By default terminal agents are omitted. Pass include_closed=true to include them.`,
    zh: `以紧凑状态引用列出调用方拥有的子 Agent。

返回身份、状态、有界任务摘要、持久化 outputFile、真实工具/LLM/token 用量、最近活动、诊断性 stale 状态和有效下一步。不复制结果文本或完整日志；回复用 WaitAgent 获取，时间线用 Read outputFile 查看。

默认省略终止 Agent；传 include_closed=true 可包含。`,
  },
  parameters: {
    type: 'object',
    properties: {
      include_closed: {
        type: 'boolean',
        description: {
          en: 'Include terminal agents (default: false)',
          zh: '包含终止 Agent（默认 false）',
        },
      },
      include_terminal: {
        type: 'boolean',
        description: {
          en: 'Backward-compatible alias for include_closed',
          zh: 'include_closed 的兼容别名',
        },
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  cacheWithinQuery: false,
  duplicateCallPolicy: () => 'allow',
  async execute(input, ctx) {
    const includeTerminal = Boolean(input?.include_closed || input?.include_terminal);
    const now = Date.now();
    const agents = [];

    for (const [id, agent] of getAgentRegistry()) {
      if (!agentBelongsToCaller(agent, ctx)) continue;
      if (!includeTerminal && isTerminalAgentStatus(agent.status)) continue;
      const live = diagnoseAgentLiveness(agent, { now });
      const execution = live.execution;
      agents.push({
        id,
        name: agent.name,
        status: agent.status,
        task: typeof agent.task === 'string' ? agent.task.slice(0, 200) : null,
        outputFile: agent.outputFile || null,
        activity: {
          lastEventAt: live.lastEventAt,
          msSinceLastEvent: live.msSinceLastEvent,
          lastEventType: live.lastEventType,
          recentTools: live.recentTools,
          outputChars: live.outputChars,
        },
        usage: {
          toolExecutions: execution?.toolCalls || 0,
          llmRequests: execution?.llmCalls || agent.usage?.llmCalls || 0,
          providerTokens: live.usageTokens,
          turns: agent.usage?.turns || 0,
        },
        control: {
          limits: execution?.limits || { ...agent.budget },
          remainingToolCalls: execution?.remainingToolCalls ?? null,
          remainingLlmCalls: execution?.remainingLlmCalls ?? null,
          remainingWallTimeMs: execution?.remainingWallTimeMs ?? null,
          reportingLlmCalls: execution?.reportingLlmCalls || 0,
          allowTools: execution?.allowTools || [...(agent.allowTools || [])],
          controlRevision: execution?.controlRevision || 0,
        },
        stale: live.stale,
        diagnostic: live.diagnostic,
        error: agent.error || null,
        hasResult: Boolean(agent.result || agent.lastResult),
        next_step: nextStepFor(agent, live),
      });
    }

    return JSON.stringify({
      agents,
      ...(agents.length === 0 ? {
        message: includeTerminal
          ? 'No sub-agents in the registry'
          : 'No active sub-agents (pass include_closed=true to see terminal ones)',
      } : {}),
    });
  },
});
