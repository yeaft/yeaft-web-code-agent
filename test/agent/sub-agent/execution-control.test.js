import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildChildToolRegistry } from '../../../agent/yeaft/sub-agent/runner.js';
import { SubAgentToolRegistry, resolveSubAgentBudget } from '../../../agent/yeaft/sub-agent/execution-control.js';

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

  it('does not dispatch any new tool after cancellation', async () => {
    const agent = record();
    agent.abortController.abort('closed');
    let calls = 0;
    const child = new SubAgentToolRegistry({ agent }).register(readTool(async () => { calls++; return 'bad'; }));
    await expect(child.execute('Read', {})).rejects.toThrow('closed');
    expect(calls).toBe(0);
  });
});
