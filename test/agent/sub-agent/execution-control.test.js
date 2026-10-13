import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildChildToolRegistry } from '../../../agent/yeaft/sub-agent/runner.js';
import { SubAgentToolRegistry, resolveSubAgentBudget } from '../../../agent/yeaft/sub-agent/execution-control.js';
import { diagnoseAgentLiveness } from '../../../agent/yeaft/sub-agent/liveness.js';

function record(budget = {}) {
  return { id: 'execution-test', name: 'test', mission: 'Find evidence', status: 'created',
    messages: [], diagnostics: [], usage: { tokens: 0, turns: 0, startedAt: Date.now() },
    budget: resolveSubAgentBudget(budget), abortController: new AbortController() };
}
function readTool(execute = async () => 'unchanged') {
  return defineTool({ name: 'FileRead', aliases: ['Read'], description: 'read',
    parameters: { type: 'object', properties: {} }, isReadOnly: () => true, execute });
}

describe('sub-agent execution control', () => {
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
    const child = new SubAgentToolRegistry({ agent });
    child.register(readTool(async () => { calls++; return 'same'; }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => child.execute('Read', {})));
    expect(calls).toBe(3);
    expect(results.filter(r => r.status === 'fulfilled').map(r => r.value)).toEqual(['same', 'same', 'same']);
    expect(agent.execution).toMatchObject({ toolCalls: 3, completedCalls: 3, repeatedResults: 2 });
    const snapshot = diagnoseAgentLiveness(agent);
    expect(snapshot.execution.remainingToolCalls).toBe(0);
    expect(snapshot.execution.progressNote).toContain('not proof');
    expect(snapshot.stalled).toBe(false);
    expect(agent.abortController.signal.aborted).toBe(false);
    expect(child.prepareProviderRequest()).toMatchObject({ finalize: true, maxOutputTokens: 4096 });
  });

  it('does not dispatch any new tool after cancellation', async () => {
    const agent = record();
    agent.abortController.abort('closed');
    let calls = 0;
    const child = new SubAgentToolRegistry({ agent }).register(readTool(async () => { calls++; return 'bad'; }));
    await expect(child.execute('Read', {})).rejects.toThrow('closed');
    expect(calls).toBe(0);
  });
});
