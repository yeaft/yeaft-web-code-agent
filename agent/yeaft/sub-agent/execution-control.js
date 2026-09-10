/** Sub-agent-local execution policy. No Session config or parent registry is mutated. */
import { createHash } from 'node:crypto';
import { ToolRegistry, isToolErrorOutput } from '../tools/registry.js';

export const BUDGET_FIELDS = ['max_tokens', 'max_turns', 'max_tool_calls', 'max_llm_calls', 'wall_time_ms'];

/** Validate a partial budget. Updates use absolute lifetime ceilings, never reset usage. */
export function validateBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return 'budget must be an object';
  for (const key of Object.keys(budget)) {
    if (!BUDGET_FIELDS.includes(key)) return `unknown budget field: ${key}`;
    const value = budget[key];
    if (!Number.isFinite(value) || value <= 0
        || (key !== 'max_tokens' && !Number.isSafeInteger(value))) {
      return `budget.${key} must be finite and positive (counts and milliseconds must be integers)`;
    }
  }
  return null;
}

/** Defaults are safety ceilings, not targets; explicit positive limits override each field. */
export function resolveSubAgentBudget(budget, persona) {
  return {
    max_tool_calls: persona === 'implementer' ? 128 : 64,
    wall_time_ms: 15 * 60 * 1000,
    ...budget,
  };
}

export function createExecutionStats() {
  return { toolCalls: 0, completedCalls: 0, failedCalls: 0, repeatedResults: 0, recentCalls: [], warning: null };
}

function fingerprint(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * Structural child-only fence, including aliases and MCP hot registration. The
 * synchronous reservation precedes execute(), so parallel calls cannot overshoot.
 * Parent Active Tool Set checks remain independent and must not be bypassed.
 */
export class SubAgentToolRegistry extends ToolRegistry {
  constructor({ allows = () => true, agent = null } = {}) {
    super();
    this.allows = allows;
    this.agent = agent;
    this.recentFingerprints = [];
  }

  register(tool) {
    if (this.allows(tool)) super.register(tool);
    return this;
  }

  /** Provider-boundary guidance: leave the original tool results untouched. */
  prepareProviderRequest() {
    const agent = this.agent;
    if (!agent) return null;
    const stats = agent.execution || createExecutionStats();
    const limit = agent.budget?.max_tool_calls;
    const llmLimit = agent.budget?.max_llm_calls;
    const llmCalls = agent.usage?.llmCalls || 0;
    const reason = limit && stats.toolCalls >= limit ? `max_tool_calls (${limit}) reached`
      : llmLimit && llmCalls >= llmLimit ? `max_llm_calls (${llmLimit}) reached` : null;
    if (reason) {
      agent.executionBudgetReason ||= reason;
      agent.budgetReportStarted = true;
      return {
        finalize: true,
        maxOutputTokens: 4096,
        prompt: `[Sub-agent execution limit] ${reason}; ${stats.toolCalls} tools and ${llmCalls} LLM requests used. No more tools are available. Use the evidence already in this conversation to return your final handoff now: conclusion, supported findings, actual verification, and any unexamined scope or blockers. Do not claim a complete review if checks remain unfinished. This is the single reserved reporting response; do not plan further work.`,
      };
    }
    const nearLimit = (limit && stats.toolCalls >= Math.ceil(limit * 0.75))
      || (llmLimit && llmCalls >= Math.ceil(llmLimit * 0.75));
    const elapsedMs = Date.now() - (agent.usage?.startedAt || Date.now());
    const nearTime = agent.budget?.wall_time_ms && elapsedMs >= agent.budget.wall_time_ms * 0.75;
    const updated = agent.controlRevision ? `[Parent control revision ${agent.controlRevision}] Current lifetime ceilings replace the initial preamble: ${JSON.stringify(agent.budget)}. Extra tool grants: ${JSON.stringify(agent.allowTools || [])}. Use DiscoverTools if an allowed tool is not yet visible.\n` : '';
    return nearLimit || nearTime || updated ? {
      prompt: `${updated}[Sub-agent execution budget] ${stats.toolCalls}/${limit ?? 'unset'} tools, ${llmCalls}/${llmLimit ?? 'unset'} LLM requests used; ${Math.max(0, (agent.budget?.wall_time_ms || 0) - elapsedMs)}ms remaining. Finish the assigned result using existing evidence where possible. Investigate only essential remaining unknowns, then return a conclusion.`,
    } : null;
  }

  /** Reserve at actual Engine dispatch (including retries), not UI turn_start. */
  reserveProviderRequest({ reporting = false } = {}) {
    const agent = this.agent;
    if (!agent) return;
    if (agent.abortController?.signal.aborted) throw new Error('Sub-agent aborted');
    const usage = agent.usage ||= { tokens: 0, turns: 0, startedAt: Date.now() };
    if (reporting) {
      if (usage.reportingLlmCalls) throw new Error('Sub-agent reporting request already used');
      usage.reportingLlmCalls = 1;
    } else if (agent.budget?.max_llm_calls && (usage.llmCalls || 0) >= agent.budget.max_llm_calls) {
      throw new Error(`max_llm_calls (${agent.budget.max_llm_calls}) reached before dispatch`);
    }
    usage.llmCalls = (usage.llmCalls || 0) + 1;
  }

  async execute(name, input, ctx = {}) {
    const tool = this.get(name);
    if (!tool || !this.allows(tool)) throw new Error(`Unknown or disallowed child tool: ${name}`);
    const agent = this.agent;
    if (!agent) return super.execute(name, input, ctx);
    // Serial dispatch can resume after a tool_start yield; never start a write
    // after cancellation, even when the underlying tool ignores AbortSignal.
    const signal = agent.abortController?.signal;
    if (signal?.aborted) throw new Error(String(signal.reason || 'Sub-agent aborted'));
    const stats = agent.execution || (agent.execution = createExecutionStats());
    const limit = agent.budget?.max_tool_calls;
    if (limit !== undefined && stats.toolCalls >= limit) {
      // Fence dispatch without aborting already reserved parallel calls. The
      // next provider boundary gets one tool-free response with their evidence.
      agent.toolBudgetReason ||= `max_tool_calls (${limit}) reached`;
      throw new Error(`${agent.toolBudgetReason}; no further tools may execute. Return findings from the available evidence.`);
    }
    stats.toolCalls += 1;
    agent.usage ||= { tokens: 0, turns: 0, startedAt: Date.now() };
    agent.usage.toolCalls = stats.toolCalls;
    const entry = { name: tool.name, status: 'running' };
    stats.recentCalls.push(entry);
    if (stats.recentCalls.length > 8) stats.recentCalls.shift();
    if (limit && stats.toolCalls >= Math.ceil(limit * 0.75)) {
      stats.warning = 'Tool budget nearly exhausted. Collect the current evidence; do not restart the same investigation.';
    }
    try {
      const output = await super.execute(name, input, ctx);
      const failed = tool.errorOutput === 'json-error-envelope' && isToolErrorOutput(output);
      entry.status = failed ? 'error' : 'completed';
      stats.completedCalls += 1;
      if (failed) stats.failedCalls += 1;
      // Advisory only: repeated results are not proof of semantic non-progress.
      // Read ranges, cursors and changed outputs have distinct fingerprints.
      try {
        if (tool.isReadOnly?.(input) === true) {
          const key = fingerprint([tool.name, input, output]);
          if (this.recentFingerprints.includes(key)) stats.repeatedResults += 1;
          this.recentFingerprints.push(key);
          if (this.recentFingerprints.length > 12) this.recentFingerprints.shift();
        }
      } catch { /* Advisory instrumentation must never turn a successful tool into a retry. */ }
      return output;
    } catch (error) {
      entry.status = 'error';
      stats.completedCalls += 1;
      stats.failedCalls += 1;
      throw error;
    }
  }
}
