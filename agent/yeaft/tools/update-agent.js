/** Parent-owned, in-place child controls; never resumes a terminal or reporting child. */
import { defineTool } from './types.js';
import { getAgentRegistry, agentBelongsToCaller } from './agent.js';
import { isTerminalAgentStatus } from '../sub-agent/status.js';
import { validateBudget } from '../sub-agent/execution-control.js';
import { validateToolGrants } from '../sub-agent/tool-access.js';
import { diagnoseAgentLiveness } from '../sub-agent/liveness.js';

export default defineTool({
  name: 'UpdateAgent',
  description: {
    en: 'Adjust a live child in place after inspecting its progress: absolute lifetime time/tool/LLM budgets and explicit extra tool grants. Does not queue a prompt, reset usage, or revive a terminal/reporting child. Give evidence and the remaining task in reason; do not extend stalled or repeating work blindly. Bash permits arbitrary shell and writes, not a read-only sandbox; grant only necessary parent tools and isolate writable workspaces. Already dispatched work is not undone by revocation.',
    zh: '检查进展后原地调整活跃子 Agent：累计时间/工具/LLM 上限及额外工具授权。不排队提示、不清零用量、不复活终止或收尾中的任务。reason 说明已有证据和剩余工作，勿盲目给停滞/重复任务扩额。Bash 可执行任意 Shell 和写入，并非只读沙箱；只授予必要的父级工具，写任务隔离 workspace。撤销不撤回已执行操作。',
  },
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      reason: { type: 'string', description: { en: 'Observed progress, remaining work and why this adjustment is necessary', zh: '实际进展、剩余工作及调整原因' } },
      budget: {
        type: 'object',
        properties: {
          max_tokens: { type: 'number', minimum: 1 },
          max_turns: { type: 'integer', minimum: 1 },
          max_tool_calls: { type: 'integer', minimum: 1 },
          max_llm_calls: { type: 'integer', minimum: 1 },
          wall_time_ms: { type: 'integer', minimum: 1 },
        },
        description: { en: 'Partial absolute lifetime ceilings, not added quota. Unspecified limits stay unchanged. LLM cap excludes one reserved reporting request; time is measured from original spawn.', zh: '部分累计上限，不是增加的额度；未指定项不变。LLM 上限之外保留一次报告请求；时间从最初启动计算。' },
      },
      allow_tools: {
        type: 'array', items: { type: 'string' }, maxItems: 32,
        description: { en: 'Replace extra persona grants with these canonical parent tool names (e.g. Bash, FileEdit); [] revokes extras, omission leaves grants unchanged', zh: '替换 persona 额外授权（如 Bash、FileEdit）；[] 撤销额外授权，省略则不变' },
      },
    },
    required: ['agent_id', 'reason'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  mayMutateWorkspaceAfterReturn: () => true,
  async execute(input, ctx) {
    const fail = error => JSON.stringify({ error, next_steps: 'Inspect the current agent state and correct the request; do not respawn or repeat blindly.' });
    const agent = getAgentRegistry().get(input.agent_id);
    if (!agent || !agentBelongsToCaller(agent, ctx)) return fail(`Agent not found: ${input.agent_id}`);
    if (isTerminalAgentStatus(agent.status) || agent.budgetReportStarted || agent.budgetStopReason
        || agent.abortController?.signal.aborted) return fail('Agent is terminal, stopping or already reporting; it cannot be extended');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) return fail('reason must contain 1..2000 characters of evidence and remaining work');
    if (input.budget === undefined && input.allow_tools === undefined) return fail('budget or allow_tools is required');
    if (input.budget !== undefined) {
      const error = validateBudget(input.budget);
      if (error) return fail(error);
    }
    const parentRegistry = ctx?.parentEngineDeps?.parentToolRegistry;
    const grants = input.allow_tools === undefined ? null : validateToolGrants(input.allow_tools, parentRegistry);
    if (grants && !grants.ok) return fail(grants.error);
    const previousBudget = { ...agent.budget };
    const previousTools = [...(agent.allowTools || [])];
    // All validation precedes mutation. Original usage/deadline origin are retained.
    agent.budget = { ...agent.budget, ...input.budget };
    if (grants) agent.allowTools = grants.tools;
    agent.controlRevision = (agent.controlRevision || 0) + 1;
    if (agent.execution && agent.execution.toolCalls < agent.budget.max_tool_calls * 0.75) agent.execution.warning = null;
    if (!agent.budgetReportStarted) {
      agent.toolBudgetReason = null;
      agent.executionBudgetReason = null;
    }
    agent.refreshToolPolicy?.();
    agent.rearmWallTimeWatchdog?.();
    const event = { type: 'sub_agent_control_updated', at: Date.now(), reason: input.reason.trim(),
      previousBudget, budget: { ...agent.budget }, previousTools, allowTools: [...(agent.allowTools || [])] };
    agent.diagnostics ||= [];
    agent.diagnostics.push(event);
    if (agent.diagnostics.length > 100) agent.diagnostics.shift();
    try { agent.outputLog?.write(event); } catch { /* diagnostics must not fail the applied update */ }
    return JSON.stringify({ success: true, agentId: agent.id, status: agent.status,
      budget: agent.budget, allow_tools: agent.allowTools || [], liveness: diagnoseAgentLiveness(agent),
      next_steps: 'Adjustment applied without restarting work. Continue the parent task; use PromptAgent only if new guidance is needed, then collect its reply. Revocation does not cancel already dispatched work.' });
  },
});
