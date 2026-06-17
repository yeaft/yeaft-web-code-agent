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
this as the primary non-blocking monitor for async sub-agent work, and Read
\`outputFile\` for any single agent if you need its full timeline.

By default only non-closed agents are returned. Pass include_closed=true
to also list closed/failed/abandoned/completed agents.`,
    zh: `列出所有子 Agent 及其当前状态。

返回每个 Agent 的 id、name、status、mission/task 摘要、持久化 outputFile 路径、
liveness 计数器（toolUseCount、tokenCount、msSinceLastEvent、recentTools）、
stale/stalled 诊断、result 尾部和消息数量。将此作为异步子 Agent 工作的主要非阻塞监控工具；
如需查看某个 Agent 的完整时间线，可 Read 其 outputFile。

默认只返回未关闭的 Agent。传 include_closed=true 可同时列出 closed/failed/abandoned/completed 的 Agent。`
  },
  parameters: {
    type: 'object',
    properties: {
      include_closed: {
        type: 'boolean',
        description: 'Include closed/failed/abandoned/completed agents in the list (default: false)',
      },
      include_terminal: {
        type: 'boolean',
        description: 'Alias for include_closed — include all terminal-status agents in the list',
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
