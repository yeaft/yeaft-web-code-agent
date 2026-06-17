/**
 * list-agents.js — List all active (and optionally terminal) sub-agents.
 *
 * Returns: { agents: [{ id, name, status, task, outputFile, liveness,
 * lastEventAt, msSinceLastEvent, error, hasResult, createdAt }, …] }.
 *
 * The default filter drops `closed` agents to stay tidy; pass
 * include_closed=true (or include_terminal=true) to see them all. The
 * include_closed alias is kept for backward-compat with the old shape.
 */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { isTerminalAgentStatus } from '../sub-agent/status.js';
import { diagnoseAgentLiveness } from '../sub-agent/liveness.js';

export default defineTool({
  name: 'ListAgents',
  description: {
    en: `List all sub-agents and their current status.

Returns id, name, status, mission/task summary, durable outputFile path,
liveness counters (toolUseCount, tokenCount, msSinceLastEvent, recentTools),
stale/stalled diagnostics, result tail, and message count for each agent. Use
this as the primary non-blocking way to check sub-agent progress.

Filtering:
- By default, hides "closed" agents to keep the view tidy.
- Pass include_closed=true (or include_terminal=true) to see closed agents.
- Pass include_terminal=true to see all agents including failed/completed.

Note: WaitAgent is now a minor utility; ListAgents is the main async
monitoring surface. The caller's owner VP sees all agents it spawned. Use
include_terminal to inspect completed/failed results.`,
    zh: `列出所有子 Agent 及其当前状态。

返回每个 Agent 的 id、name、status、任务摘要、持久化 outputFile 路径、
活跃度计数（toolUseCount、tokenCount、msSinceLastEvent、recentTools）、
stale/stalled 诊断、结果尾部片段和消息数量。作为主要的非阻塞方式
检查子 Agent 进度。

过滤：
- 默认隐藏 "closed" 状态的 Agent 以保持视图整洁
- 传 include_closed=true（或 include_terminal=true）查看已关闭的 Agent
- 传 include_terminal=true 查看所有 Agent，包括 failed/completed

注意：WaitAgent 现在是次要工具；ListAgents 是主要的异步监控入口。
调用方的 owner VP 可看到它生成的所有 Agent。使用 include_terminal
来检查已完成/失败的结果。`,
  },
  parameters: {
    type: 'object',
    properties: {
      include_closed: {
        type: 'boolean',
        description: { en: 'Include closed/failed/abandoned/completed agents in the list (default: false)', zh: '在列表中包含已关闭/失败/放弃/完成的 Agent（默认 false）' },
      },
      include_terminal: {
        type: 'boolean',
        description: { en: 'Alias for include_closed — include all terminal-status agents in the list', zh: 'include_closed 的别名 — 列出所有已终止状态的 Agent' },
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const includeTerminal = Boolean(input?.include_closed || input?.include_terminal);
    const agents = getAgentRegistry();
    const now = Date.now();

    const agentList = [];
    for (const [id, agent] of agents) {
      if (!agentBelongsToCaller(agent, ctx)) continue;
      if (!includeTerminal && isTerminalAgentStatus(agent.status)) continue;
      const liveness = diagnoseAgentLiveness(agent, { now });
      const resultText = (typeof agent.result === 'string' && agent.result)
        ? agent.result
        : (agent.lastResult || '');
      agentList.push({
        id,
        name: agent.name,
        status: agent.status,
        task: typeof agent.task === 'string' ? agent.task.slice(0, 200) : null,
        outputFile: agent.outputFile || null,
        liveness,
        lastEventAt: liveness.lastEventAt,
        msSinceLastEvent: liveness.msSinceLastEvent,
        lastEventType: liveness.lastEventType,
        stale: liveness.stale,
        stalled: liveness.stalled,
        diagnostic: liveness.diagnostic,
        error: agent.error || null,
        hasResult: Boolean(agent.result || agent.lastResult),
        resultTail: resultText ? resultText.slice(-1000) : '',
        messages: Array.isArray(agent.messages) ? agent.messages.length : 0,
        turns: agent.usage?.turns || 0,
        createdAt: agent.createdAt,
      });
    }

    if (agentList.length === 0) {
      return JSON.stringify({
        agents: [],
        message: includeTerminal
          ? 'No sub-agents in the registry'
          : 'No active sub-agents (pass include_closed=true to see terminal ones)',
      });
    }

    return JSON.stringify({
      agents: agentList,
      totalCount: agentList.length,
    }, null, 2);
  },
});
