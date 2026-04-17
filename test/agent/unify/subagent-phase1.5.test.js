/**
 * subagent-phase1.5.test.js — Budget enforcement in sub-agent execution.
 *
 * Scope (per PM):
 *   - tickAgent(agentId, delta) applies usage delta + checks budget
 *   - on breach: abort signal fires, status→completed, result=envelope
 *   - WaitAgent returns structured envelope (not crash/timeout)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import agentTool, {
  tickAgent,
  getAgentRegistry,
  _resetAgentRegistry,
} from '../../../agent/unify/tools/agent.js';
import waitAgentTool from '../../../agent/unify/tools/wait-agent.js';

async function createAgent(extras = {}) {
  const out = JSON.parse(await agentTool.execute({
    name: `t-${Math.random().toString(36).slice(2, 7)}`,
    task: 'test mission',
    ...extras,
  }));
  return out.agentId;
}

describe('tickAgent: no-ops when no budget', () => {
  beforeEach(() => _resetAgentRegistry());

  it('returns null and accumulates usage', async () => {
    const id = await createAgent();
    const result = tickAgent(id, { tokens: 500, turns: 1 });
    expect(result).toBeNull();
    const agent = getAgentRegistry().get(id);
    expect(agent.usage.tokens).toBe(500);
    expect(agent.usage.turns).toBe(1);
    expect(agent.status).toBe('created');
  });

  it('ignores unknown agent id', () => {
    expect(tickAgent('agent-does-not-exist', { tokens: 10 })).toBeNull();
  });

  it('skips completed/closed agents', async () => {
    const id = await createAgent();
    getAgentRegistry().get(id).status = 'closed';
    expect(tickAgent(id, { tokens: 1 })).toBeNull();
  });
});

describe('tickAgent: max_tokens enforcement', () => {
  beforeEach(() => _resetAgentRegistry());

  it('fires envelope + aborts when tokens breach', async () => {
    const id = await createAgent({ budget: { max_tokens: 100 } });
    const agent = getAgentRegistry().get(id);

    // First tick under limit — no trigger
    expect(tickAgent(id, { tokens: 50 })).toBeNull();
    expect(agent.abortController.signal.aborted).toBe(false);

    // Second tick pushes to 100 — trigger
    const env = tickAgent(id, { tokens: 50, partial_output: 'half done' });
    expect(env).not.toBeNull();
    expect(env.status).toBe('budget_exceeded');
    expect(env.reason).toMatch(/max_tokens/);
    expect(env.partial_output).toBe('half done');
    expect(env.usage.tokens).toBe(100);
    expect(agent.status).toBe('completed');
    expect(agent.abortController.signal.aborted).toBe(true);
    expect(agent.diagnostics[0].limit).toBe('max_tokens');
  });
});

describe('tickAgent: max_turns enforcement', () => {
  beforeEach(() => _resetAgentRegistry());

  it('fires envelope at turn limit', async () => {
    const id = await createAgent({ budget: { max_turns: 2 } });
    expect(tickAgent(id, { turns: 1 })).toBeNull();
    const env = tickAgent(id, { turns: 1 });
    expect(env.status).toBe('budget_exceeded');
    expect(env.reason).toMatch(/max_turns/);
    expect(env.usage.turns).toBe(2);
  });
});

describe('tickAgent: wall_time_ms enforcement', () => {
  beforeEach(() => _resetAgentRegistry());

  it('fires envelope when wall clock exceeds budget', async () => {
    const id = await createAgent({ budget: { wall_time_ms: 1000 } });
    const agent = getAgentRegistry().get(id);
    // Simulate work past wall clock without accumulating tokens/turns
    const future = agent.usage.startedAt + 1500;
    const env = tickAgent(id, {}, future);
    expect(env.status).toBe('budget_exceeded');
    expect(env.reason).toMatch(/wall_time_ms/);
  });
});

describe('tickAgent: idempotent after breach', () => {
  beforeEach(() => _resetAgentRegistry());

  it('subsequent ticks return null (already completed)', async () => {
    const id = await createAgent({ budget: { max_tokens: 10 } });
    tickAgent(id, { tokens: 100 });
    expect(tickAgent(id, { tokens: 100 })).toBeNull();
  });
});

describe('Agent: abortController is attached on create', () => {
  beforeEach(() => _resetAgentRegistry());

  it('new agents have an un-aborted abortController', async () => {
    const id = await createAgent();
    const agent = getAgentRegistry().get(id);
    expect(agent.abortController).toBeInstanceOf(AbortController);
    expect(agent.abortController.signal.aborted).toBe(false);
  });
});

describe('WaitAgent: surfaces budget_exceeded envelope as result', () => {
  beforeEach(() => _resetAgentRegistry());

  it('parent receives structured failure, not crash/timeout', async () => {
    const id = await createAgent({
      budget: { max_tokens: 50 },
    });
    // Simulate runaway subagent
    tickAgent(id, { tokens: 60, partial_output: 'draft output' });

    const waitOut = JSON.parse(
      await waitAgentTool.execute({ agent_id: id, timeout_ms: 100 })
    );
    expect(waitOut.status).toBe('completed');
    expect(waitOut.result).toBeDefined();
    expect(waitOut.result.status).toBe('budget_exceeded');
    expect(waitOut.result.partial_output).toBe('draft output');
    expect(waitOut.result.reason).toMatch(/max_tokens/);
    expect(waitOut.result.usage.tokens).toBe(60);
  });
});
