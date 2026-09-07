import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildChildToolRegistry, startSubAgent } from '../../../agent/yeaft/sub-agent/runner.js';
import { SubAgentToolRegistry, resolveSubAgentBudget } from '../../../agent/yeaft/sub-agent/execution-control.js';
import { validateSpec, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { diagnoseAgentLiveness } from '../../../agent/yeaft/sub-agent/liveness.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

function record(budget = {}) {
  return { id: 'execution-test', name: 'test', mission: 'Find evidence', status: 'created',
    messages: [], diagnostics: [], usage: { tokens: 0, turns: 0, startedAt: Date.now() },
    budget: resolveSubAgentBudget(budget), abortController: new AbortController() };
}
function readTool(execute = async () => 'unchanged') {
  return defineTool({ name: 'FileRead', aliases: ['Read'], description: 'read',
    parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute });
}

async function waitForCleanup(agent) {
  const deadline = Date.now() + 4000;
  while (agent.__driverStarted && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  expect(agent.__driverStarted).toBe(false);
}

describe('sub-agent execution control', () => {
  it('applies overridable ceilings and rejects invalid budget values', () => {
    expect(resolveSubAgentBudget(null)).toMatchObject({ max_tool_calls: 64, wall_time_ms: 900000 });
    expect(resolveSubAgentBudget({ wall_time_ms: 2000 }, 'implementer')).toEqual({ max_tool_calls: 128, wall_time_ms: 2000 });
    for (const value of [NaN, Infinity, 0, -1, 1.5]) {
      expect(validateSpec({ name: 'test', mission: 'read', budget: { max_tool_calls: value } }).ok).toBe(false);
    }
  });

  it('fences aliases, discovery and hot-registered tools without mutating the parent', async () => {
    const parent = new ToolRegistry().register(readTool());
    const write = defineTool({ name: 'FileWrite', description: 'write', parameters: {}, execute: async () => 'written' });
    parent.register(write);
    const child = buildChildToolRegistry(parent, { agent: { ...record(), persona: 'explorer' } });
    expect(child.getToolNames()).toEqual(['FileRead']);
    expect(await child.execute('Read', {})).toBe('unchanged');
    child.register(write);
    child.replaceMcpTools({}, () => [defineTool({ ...write, name: 'mcp__write' })]);
    expect(child.has('FileWrite')).toBe(false);
    expect(child.has('mcp__write')).toBe(false);
    await expect(child.execute('FileWrite', {})).rejects.toThrow();
    expect(parent.has('FileWrite')).toBe(true);
  });

  it('reserves parallel calls atomically, preserves raw output and reports repetitions without claiming progress', async () => {
    const agent = record({ max_tool_calls: 3 });
    let calls = 0;
    const child = new SubAgentToolRegistry({ agent, stopBudget: reason => agent.abortController.abort(reason) });
    child.register(readTool(async () => { calls++; return 'same'; }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => child.execute('Read', {})));
    expect(calls).toBe(3);
    expect(results.filter(r => r.status === 'fulfilled').map(r => r.value)).toEqual(['same', 'same', 'same']);
    expect(agent.execution).toMatchObject({ toolCalls: 3, completedCalls: 3, repeatedResults: 2 });
    const snapshot = diagnoseAgentLiveness(agent);
    expect(snapshot.execution.remainingToolCalls).toBe(0);
    expect(snapshot.execution.progressNote).toContain('not proof');
    expect(snapshot.stalled).toBe(false);
  });

  it('does not dispatch any new tool after cancellation', async () => {
    const agent = record();
    agent.abortController.abort('closed');
    let calls = 0;
    const child = new SubAgentToolRegistry({ agent }).register(readTool(async () => { calls++; return 'bad'; }));
    await expect(child.execute('Read', {})).rejects.toThrow('closed');
    expect(calls).toBe(0);
  });

  it.each([false, true])('counts cached tokens without duplication and returns current follow-up evidence (included=%s)', async included => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-execution-followup-'));
    const agent = record({ max_tokens: included ? 10 : 100 });
    let requests = 0;
    const adapter = {
      async *stream() {
        requests++;
        if (requests === 1) {
          agent.pendingPrompts = [{ prompt: 'follow up' }];
          yield { type: 'text_delta', text: 'PREVIOUS RESULT' };
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
          yield { type: 'stop', stopReason: 'end_turn' };
        } else {
          yield { type: 'text_delta', text: 'CURRENT EVIDENCE' };
          yield { type: 'usage', inputTokens: included ? 8 : 1, outputTokens: 1,
            cacheReadTokens: 200, cacheWriteTokens: 2, cacheTokensAreIncludedInInput: included };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    getAgentRegistry().set(agent.id, agent);
    try {
      startSubAgent(agent, { adapter, config: { model: 'test', maxOutputTokens: 1024, _readOnly: true },
        trace: new NullTrace(), parentToolRegistry: new ToolRegistry(), subAgentLogDir: dir, yeaftDir: dir });
      await waitForCleanup(agent);
      expect(requests).toBe(2);
      expect(agent.result).toMatchObject({ status: 'budget_exceeded', partial_output: 'CURRENT EVIDENCE' });
      expect(agent.result.usage.tokens).toBe(included ? 11 : 206);
    } finally {
      agent.abortController.abort('cleanup');
      getAgentRegistry().delete(agent.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['tools', 'tokens', 'empty'])('stops an actual Engine tool loop at the %s boundary and preserves the contract', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-execution-'));
    const agent = record(mode === 'tokens' ? { max_tokens: 10 } : { max_tool_calls: 2 });
    agent.persona = 'explorer';
    agent.expected_output = { type: 'object', properties: { evidence: { type: 'string' } } };
    getAgentRegistry().set(agent.id, agent);
    let calls = 0;
    let requests = 0;
    let system = '';
    const adapter = {
      async *stream(params) {
        requests++;
        system = params.system;
        if (mode !== 'empty') yield { type: 'text_delta', text: 'partial evidence' };
        if (mode === 'tokens') yield { type: 'usage', inputTokens: 8, outputTokens: 3 };
        yield { type: 'tool_call', id: `call-${requests}`, name: 'FileRead', input: { offset: requests } };
        yield { type: 'stop', stopReason: 'tool_use' };
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    try {
      startSubAgent(agent, { adapter, config: { model: 'test', maxOutputTokens: 1024, _readOnly: true },
        trace: new NullTrace(), parentToolRegistry: new ToolRegistry().register(readTool(async () => { calls++; return `evidence-${calls}`; })),
        parentVpPersona: { persona: 'PARENT SOUL' }, subAgentLogDir: dir, yeaftDir: dir });
      await waitForCleanup(agent);
      expect(calls).toBe(mode === 'tokens' ? 0 : 2);
      expect(agent.result.status).toBe('budget_exceeded');
      expect(agent.result.reason).toContain(mode === 'tokens' ? 'max_tokens' : 'max_tool_calls');
      expect(agent.result.partial_output).toBe(mode === 'empty' ? '' : agent.lastResult);
      if (mode !== 'empty') expect(agent.result.partial_output).toContain('partial evidence');
      expect(agent.subEngine).toBe(null);
      expect(system).toContain('expected_output');
      expect(system).toContain('PARENT SOUL');
      expect(system).toContain('Explorer Persona');
      if (mode === 'tokens') expect(agent.result.usage.tokens).toBe(11);
    } finally {
      agent.abortController.abort('cleanup');
      getAgentRegistry().delete(agent.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
