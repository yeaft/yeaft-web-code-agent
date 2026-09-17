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
    en: 'Adjust a live child in place after inspecting its progress: absolute lifetime budgets, extra tool grants, or request a cooperative evidence-only final report. Finalization is control, not a prompt containing reason. Does not reset usage or revive a terminal/reporting child. Already dispatched work is not undone.',
    zh: '检查进展后原地调整活跃子 Agent：累计预算、额外工具授权，或请求基于现有证据协作收尾。收尾是控制信号，不会把 reason 冒充提示词。不清零用量、不复活终止/报告中的任务，也不撤回已派发操作。',
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
      request_finalize: {
        type: 'boolean',
        description: { en: 'Request one tool-free final report from existing evidence, then end the child lifecycle normally', zh: '请求仅基于现有证据生成一次无工具最终报告，然后正常结束子任务生命周期' },
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
    if (isTerminalAgentStatus(agent.status) || agent.budgetReportStarted || agent.finalizationRequested || agent.budgetStopReason
        || agent.abortController?.signal.aborted) return fail('Agent is terminal, stopping or already reporting; it cannot be extended');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) return fail('reason must contain 1..2000 characters of evidence and remaining work');
    if (input.budget === undefined && input.allow_tools === undefined && input.request_finalize !== true) return fail('budget, allow_tools, or request_finalize=true is required');
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
    if (input.request_finalize === true) agent.finalizationRequested = true;
    agent.controlRevision = (agent.controlRevision || 0) + 1;
    if (agent.execution && (agent.budget.max_tool_calls === undefined
        || agent.execution.toolCalls < agent.budget.max_tool_calls * 0.75)) agent.execution.warning = null;
    if (!agent.budgetReportStarted) {
      agent.toolBudgetReason = null;
      agent.executionBudgetReason = null;
    }
    agent.refreshToolPolicy?.();
    agent.rearmWallTimeWatchdog?.();
    const event = { type: 'sub_agent_control_updated', at: Date.now(), reason: input.reason.trim(),
      requestFinalize: input.request_finalize === true,
      previousBudget, budget: { ...agent.budget }, previousTools, allowTools: [...(agent.allowTools || [])] };
    agent.diagnostics ||= [];
    agent.diagnostics.push(event);
    if (agent.diagnostics.length > 100) agent.diagnostics.shift();
    try { agent.outputLog?.write(event); } catch { /* diagnostics must not fail the applied update */ }
    return JSON.stringify({ success: true, agentId: agent.id, status: agent.status,
      budget: agent.budget, allow_tools: agent.allowTools || [], liveness: diagnoseAgentLiveness(agent),
      finalizationRequested: agent.finalizationRequested === true,
      next_steps: input.request_finalize === true
        ? 'Cooperative wrap-up requested without turning reason into a child prompt. Use WaitAgent to collect the evidence-only final report; already dispatched work may finish first.'
        : 'Adjustment applied without restarting work. Continue the parent task; use PromptAgent only if new guidance is needed, then collect its reply. Revocation does not cancel already dispatched work.' });
  },
});
