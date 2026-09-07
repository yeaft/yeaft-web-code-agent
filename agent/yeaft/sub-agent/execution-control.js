/** Sub-agent-local execution policy. No Session config or parent registry is mutated. */
import { createHash } from 'node:crypto';
import { ToolRegistry, isToolErrorOutput } from '../tools/registry.js';

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
  constructor({ allows = () => true, agent = null, stopBudget = null } = {}) {
    super();
    this.allows = allows;
    this.agent = agent;
    this.stopBudget = stopBudget;
    this.recentFingerprints = [];
  }

  register(tool) {
    if (this.allows(tool)) super.register(tool);
    return this;
  }

  async execute(name, input, ctx = {}) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown or disallowed child tool: ${name}`);
    const agent = this.agent;
    if (!agent) return super.execute(name, input, ctx);
    // Serial dispatch can resume after a tool_start yield; never start a write
    // after cancellation, even when the underlying tool ignores AbortSignal.
    const signal = agent.abortController?.signal;
    if (signal?.aborted) throw new Error(String(signal.reason || 'Sub-agent aborted'));
    const stats = agent.execution || (agent.execution = createExecutionStats());
    const limit = agent.budget?.max_tool_calls;
    if (limit !== undefined && stats.toolCalls >= limit) {
      const reason = `max_tool_calls (${limit}) reached; return partial evidence to the parent before extending scope`;
      this.stopBudget?.(reason);
      throw new Error(reason);
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
