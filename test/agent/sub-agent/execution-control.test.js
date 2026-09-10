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
import { Engine } from '../../../agent/yeaft/engine.js';

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

  it('does not apply the child reporting hook to a parent Engine', async () => {
    let calls = 0;
    const registry = new ToolRegistry().register(readTool(async () => { calls++; return 'evidence'; }));
    registry.prepareProviderRequest = () => { throw new Error('child-only policy'); };
    let requests = 0;
    const adapter = {
      async *stream() {
        if (++requests === 1) {
          yield { type: 'tool_call', id: 'parent-read', name: 'Read', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'parent result' };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    const engine = new Engine({ adapter, trace: new NullTrace(), toolRegistry: registry,
      config: { model: 'test', maxOutputTokens: 1024, _readOnly: true } });
    const events = [];
    for await (const event of engine.query({ prompt: 'read evidence', messages: [] })) events.push(event);
    expect(calls).toBe(1);
    expect(requests).toBe(2);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
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

  it.each(['tools', 'tokens', 'empty', 'error', 'truncated', 'parallel', 'report-tokens', 'wall-time'])('finishes an actual Engine at the %s boundary without losing evidence', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-execution-'));
    const agent = record({ max_tool_calls: 2,
      ...(['tokens', 'report-tokens'].includes(mode) ? { max_tokens: 10 } : {}),
      ...(mode === 'wall-time' ? { wall_time_ms: 1500 } : {}),
    });
    agent.persona = 'explorer';
    agent.expected_output = { type: 'object', properties: { evidence: { type: 'string' } } };
    getAgentRegistry().set(agent.id, agent);
    let calls = 0;
    const requests = [];
    const events = [];
    const completions = [];
    agent.taskId = 'task-budget';
    agent.parentSessionId = 'session-budget';
    const taskManager = {
      renderActiveTasksForPrompt() { return ''; },
      refreshTaskLog() {},
      completeTask(sessionId, taskId, result) { completions.push({ sessionId, taskId, ...result }); },
    };
    const adapter = {
      async *stream(params) {
        requests.push(JSON.parse(JSON.stringify({ system: params.system, messages: params.messages,
          tools: params.tools, maxTokens: params.maxTokens })));
        const reporting = agent.budgetReportStarted;
        if (reporting) {
          if (mode === 'error') {
            yield { type: 'error', error: new Error('report unavailable'), retryable: true };
            return;
          }
          if (mode === 'wall-time') {
            while (!params.signal.aborted) await new Promise(r => setTimeout(r, 10));
            throw new Error('deadline');
          }
          if (mode !== 'empty') yield { type: 'text_delta', text: 'FINAL: evidence-1 and evidence-2; unchecked scope remains.' };
          if (mode === 'report-tokens') yield { type: 'usage', inputTokens: 8, outputTokens: 3 };
          // A noncompliant adapter cannot restart investigation or persist an orphan call.
          yield { type: 'tool_call', id: 'unsolicited', name: 'FileRead', input: {} };
          yield { type: 'stop', stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn' };
          return;
        }
        if (mode !== 'empty') yield { type: 'text_delta', text: 'progress; ' };
        if (mode === 'tokens') yield { type: 'usage', inputTokens: 8, outputTokens: 3 };
        for (let i = 0; i < (mode === 'parallel' ? 5 : 1); i++) {
          yield { type: 'tool_call', id: `call-${requests.length}-${i}`, name: 'FileRead', input: { offset: requests.length + i } };
        }
        yield { type: 'stop', stopReason: 'tool_use' };
      },
      async call() { return { text: 'ok', usage: {} }; },
    };
    try {
      startSubAgent(agent, { adapter, config: { model: 'test', maxOutputTokens: 8192, _readOnly: true },
        trace: new NullTrace(), parentToolRegistry: new ToolRegistry().register(readTool(async () => {
          const number = ++calls;
          await new Promise(r => setTimeout(r, 5));
          return `evidence-${number}`;
        })), taskManager, parentSessionId: agent.parentSessionId, onEvent: (_id, event) => events.push(event),
        parentVpPersona: { persona: 'PARENT SOUL' }, subAgentLogDir: dir, yeaftDir: dir });
      await waitForCleanup(agent);
      expect(calls).toBe(mode === 'tokens' ? 0 : 2);
      expect(requests).toHaveLength(mode === 'tokens' ? 1 : mode === 'parallel' ? 2 : 3);
      expect(agent.result.status).toBe('budget_exceeded');
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ sessionId: 'session-budget', taskId: 'task-budget', status: 'failed' });
      expect(JSON.parse(completions[0].summary)).toEqual(agent.result);
      expect(agent.result.reason).toContain(['tokens', 'report-tokens'].includes(mode) ? 'max_tokens'
        : mode === 'wall-time' ? 'wall_time_ms' : 'max_tool_calls');
      if (mode === 'empty') expect(agent.result.partial_output).toContain('No final report');
      else if (mode === 'error' || mode === 'tokens' || mode === 'wall-time') {
        expect(agent.result.partial_output).toContain('progress;');
      } else expect(agent.result.partial_output).toContain('FINAL: evidence-1 and evidence-2');
      if (!['tokens', 'report-tokens', 'wall-time'].includes(mode)) {
        expect(agent.result.reporting).toMatchObject({ attempted: true, received: !['empty', 'error'].includes(mode) });
        if (mode === 'error') expect(agent.result.reporting.error).toContain('report unavailable');
        else if (mode !== 'empty') expect(agent.result.partial_output).not.toContain('progress;');
      }
      if (mode !== 'tokens') {
        const last = requests.at(-1);
        expect(last.tools || []).toHaveLength(0);
        expect(last.maxTokens).toBeLessThanOrEqual(4096);
        expect(last.system).toContain('single reserved reporting response');
        expect(last.messages.filter(m => m.role === 'tool').map(m => m.content))
          .toEqual(expect.arrayContaining(['evidence-1', 'evidence-2']));
        expect(events.some(e => e.type === 'tool_call' && e.id === 'unsolicited')).toBe(false);
      }
      expect(agent.subEngine).toBe(null);
      expect(requests[0].system).toContain('expected_output');
      expect(requests[0].system).toContain('PARENT SOUL');
      expect(requests[0].system).toContain('Explorer Persona');
      if (['tokens', 'report-tokens'].includes(mode)) expect(agent.result.usage.tokens).toBe(11);
      expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toHaveLength(1);
      const log = fs.readFileSync(agent.outputFile, 'utf8');
      expect(log).toContain(agent.result.reason);
      if (!['empty', 'error', 'tokens', 'wall-time'].includes(mode)) expect(log).toContain('FINAL: evidence-1');
    } finally {
      agent.abortController.abort('cleanup');
      getAgentRegistry().delete(agent.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
