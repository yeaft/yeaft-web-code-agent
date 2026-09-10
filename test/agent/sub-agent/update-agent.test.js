import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import updateAgent from '../../../agent/yeaft/tools/update-agent.js';
import spawnAgent, { getAgentRegistry, validateSpec } from '../../../agent/yeaft/tools/agent.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { startSubAgent, buildChildToolRegistry } from '../../../agent/yeaft/sub-agent/runner.js';
import { SubAgentToolRegistry, resolveSubAgentBudget } from '../../../agent/yeaft/sub-agent/execution-control.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { LLMServerError } from '../../../agent/yeaft/llm/adapter.js';
import { resolveActiveToolNames } from '../../../agent/yeaft/tools/activation.js';

const tool = (name, execute = async () => 'ok') => defineTool({ name,
  parameters: { type: 'object', properties: {} }, description: name, execute });
const parent = new ToolRegistry().register(tool('Bash')).register(tool('FileWrite'));
const ctx = { sessionId: 's', senderVpId: 'vp', threadId: 'main', parentEngineDeps: { parentToolRegistry: parent } };
function record(budget = {}) {
  const agent = { id: 'update-agent', name: 'review', mission: 'Review evidence', persona: 'reviewer',
    status: 'running', parentSessionId: 's', parentVpId: 'vp', parentThreadId: 'main',
    budget: resolveSubAgentBudget(budget), usage: { tokens: 10, turns: 0, llmCalls: 0, startedAt: Date.now() },
    abortController: new AbortController(), messages: [], diagnostics: [] };
  getAgentRegistry().set(agent.id, agent);
  return agent;
}
const update = async (input = {}, context = ctx) => JSON.parse(await updateAgent.execute({
  agent_id: 'update-agent', reason: 'Diff inspected; one regression test still needs verification', ...input,
}, context));
afterEach(() => { getAgentRegistry().clear(); vi.useRealTimers(); });

describe('parent-owned live child controls', () => {
  it('exposes UpdateAgent alongside child management, not on unrelated requests', () => {
    const toolNames = ['FileRead', 'SpawnAgent', 'UpdateAgent', 'WaitAgent'];
    expect(resolveActiveToolNames({ toolNames, prompt: 'read package.json' }).has('UpdateAgent')).toBe(false);
    for (const options of [{ prompt: 'delegate a review' }, { subAgentToolsActivated: true }, { activeTasks: [{ kind: 'sub_agent' }] }]) {
      expect(resolveActiveToolNames({ toolNames, ...options }).has('UpdateAgent')).toBe(true);
    }
  });

  it('updates absolute limits without clearing usage, and validates atomically', async () => {
    const agent = record();
    agent.rearmWallTimeWatchdog = vi.fn();
    const originalUsage = { ...agent.usage };
    expect((await update({ budget: { max_llm_calls: 12, max_tool_calls: 90, wall_time_ms: 1800000 } })).success).toBe(true);
    expect(agent.usage).toEqual(originalUsage);
    expect(agent.budget).toMatchObject({ max_llm_calls: 12, max_tool_calls: 90, wall_time_ms: 1800000 });
    expect(agent.rearmWallTimeWatchdog).toHaveBeenCalledTimes(1);
    expect(agent.diagnostics[0]).toMatchObject({ type: 'sub_agent_control_updated', previousBudget: { max_tool_calls: 64 } });
    const before = { ...agent.budget };
    expect((await update({ budget: { max_tool_calls: 120 }, allow_tools: ['Unavailable'] })).error).toBeTruthy();
    expect(agent.budget).toEqual(before);
    for (const budget of [[], { max_llm_calls: 0 }, { max_llm_calls: 1.5 }, { wall_time_ms: Infinity }, { typo: 5 }]) {
      expect((await update({ budget })).error).toBeTruthy();
      expect(validateSpec({ name: 'x', mission: 'y', budget }).ok).toBe(false);
    }
    expect((await update({ budget: {}, reason: '' })).error).toBeTruthy();
  });

  it('preserves owner boundaries and cannot revive terminal, cancelled or reporting tasks', async () => {
    const agent = record();
    for (const foreign of [{ ...ctx, sessionId: 'other' }, { ...ctx, senderVpId: 'other' }, { ...ctx, threadId: 'other' }]) {
      expect((await update({ budget: { max_tool_calls: 100 } }, foreign)).error).toContain('not found');
    }
    for (const status of ['completed', 'failed', 'closed', 'abandoned']) {
      agent.status = status;
      expect((await update({ budget: { max_tool_calls: 100 } })).error).toContain('terminal');
    }
    agent.status = 'running';
    agent.budgetReportStarted = true;
    expect((await update({ budget: { max_tool_calls: 100 } })).error).toContain('reporting');
    agent.budgetReportStarted = false;
    agent.abortController.abort();
    expect((await update({ budget: { max_tool_calls: 100 } })).error).toBeTruthy();
    expect(agent.budget.max_tool_calls).toBe(64);
  });

  it('grants and revokes reviewer tools without changing the parent or allowing self-elevation', async () => {
    const agent = record();
    const child = buildChildToolRegistry(parent, { agent });
    expect(child.has('Bash')).toBe(false);
    expect((await update({ allow_tools: ['Bash', 'FileWrite'] })).success).toBe(true);
    expect(await child.execute('Bash', {})).toBe('ok');
    expect(child.has('FileWrite')).toBe(true);
    expect((await update({ allow_tools: [] })).success).toBe(true);
    await expect(child.execute('Bash', {})).rejects.toThrow();
    expect(parent.has('Bash')).toBe(true);
    expect(child.has('UpdateAgent')).toBe(false);
    const result = JSON.parse(await spawnAgent.execute({ name: 'granted-review', mission: 'verify', persona: 'reviewer', allow_tools: ['Bash'] }, ctx));
    expect(result).toMatchObject({ success: true, allow_tools: ['Bash'] });
    expect(JSON.parse(await spawnAgent.execute({ name: 'bad', mission: 'x', allow_tools: ['NoTool'] }, ctx)).error).toBeTruthy();
  });

  it('reserves real provider dispatches and permits only one separate report', () => {
    const agent = record({ max_llm_calls: 2 });
    const child = new SubAgentToolRegistry({ agent });
    child.reserveProviderRequest();
    child.reserveProviderRequest();
    expect(child.prepareProviderRequest()).toMatchObject({ finalize: true });
    expect(() => child.reserveProviderRequest()).toThrow(/max_llm_calls/);
    child.reserveProviderRequest({ reporting: true });
    expect(() => child.reserveProviderRequest({ reporting: true })).toThrow(/already used/);
    expect(agent.usage).toMatchObject({ llmCalls: 3, reportingLlmCalls: 1 });
  });

  it.each([false, true])('enforces LLM cap in the Engine, or continues in place after update (extend=%s)', async extend => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-child-update-'));
    const agent = record({ max_llm_calls: 1, max_tool_calls: extend ? 1 : 4 });
    agent.status = 'created';
    agent.taskId = 'task';
    const requests = [];
    let tools = 0;
    const registry = new ToolRegistry().register(tool('FileRead', async () => {
      tools++;
      if (extend) expect((await update({ budget: { max_tool_calls: 4, max_llm_calls: 4 } })).success).toBe(true);
      return 'verified evidence';
    }));
    const adapter = {
      async *stream(params) {
        requests.push(params);
        if (requests.length === 1) {
          yield { type: 'tool_call', name: 'FileRead', id: 'r', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'Report: verified evidence.' };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
      async call() { return { text: '', usage: {} }; },
    };
    try {
      startSubAgent(agent, { adapter, parentToolRegistry: registry, parentSessionId: 's', parentVpId: 'vp', parentThreadId: 'main',
        config: { model: 'test', _readOnly: true }, trace: new NullTrace(), subAgentLogDir: dir, yeaftDir: dir,
        taskManager: { completeTask() {}, refreshTaskLog() {}, renderActiveTasksForPrompt() { return ''; } } });
      const deadline = Date.now() + 4000;
      while (agent.__driverStarted && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect(agent.__driverStarted).toBe(false);
      expect(requests).toHaveLength(2);
      expect(tools).toBe(1);
      expect(agent.usage.llmCalls).toBe(2);
      if (extend) {
        expect(agent.result).toBe('Report: verified evidence.');
        expect(requests[1].tools.length).toBeGreaterThan(0);
      } else {
        expect(agent.result).toMatchObject({ status: 'budget_exceeded', partial_output: 'Report: verified evidence.', reporting: { received: true } });
        expect(requests[1].tools || []).toHaveLength(0);
        expect(agent.usage.reportingLlmCalls).toBe(1);
      }
    } finally {
      agent.abortController.abort('cleanup');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('counts retries at captured dispatch and reserves a single report (failReport=%s)', async failReport => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-child-retry-'));
    const agent = record({ max_llm_calls: 2 });
    agent.taskId = 'task';
    const requests = [];
    const adapter = {
      captureRequest() { return { captureStream: params => this.stream(params) }; },
      async *stream(params) {
        params.onRequestStart();
        requests.push(params);
        if (requests.length <= 2 || failReport) throw new LLMServerError('temporary failure', 503);
        yield { type: 'text_delta', text: 'Blocked: provider failed twice.' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call() { return { text: '', usage: {} }; },
    };
    try {
      startSubAgent(agent, { adapter, parentToolRegistry: parent, parentSessionId: 's', parentVpId: 'vp', parentThreadId: 'main',
        config: { model: 'test', _readOnly: true, llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
        trace: new NullTrace(), subAgentLogDir: dir, yeaftDir: dir,
        taskManager: { completeTask() {}, refreshTaskLog() {}, renderActiveTasksForPrompt() { return ''; } } });
      const deadline = Date.now() + 4000;
      while (agent.__driverStarted && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect(agent.__driverStarted).toBe(false);
      expect(requests).toHaveLength(3);
      expect(agent.usage).toMatchObject({ llmCalls: 3, reportingLlmCalls: 1 });
      expect(requests[2].tools || []).toHaveLength(0);
      expect(agent.result).toMatchObject({ status: 'budget_exceeded', reporting: { attempted: true, received: !failReport } });
      if (failReport) expect(agent.result.reporting.error).toContain('temporary failure');
    } finally {
      agent.abortController.abort('cleanup');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-arms the original wall deadline on extension and reduction, without leaking timers', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-child-deadline-'));
    const agent = record({ wall_time_ms: 1000 });
    const adapter = {
      async *stream({ signal }) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('aborted');
      },
      async call() { return { text: '', usage: {} }; },
    };
    try {
      startSubAgent(agent, { adapter, parentToolRegistry: parent, parentSessionId: 's', parentVpId: 'vp',
        trace: new NullTrace(), config: { model: 'test', _readOnly: true }, yeaftDir: dir, subAgentLogDir: dir });
      await vi.advanceTimersByTimeAsync(500);
      expect((await update({ budget: { wall_time_ms: 2500 } })).success).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(agent.abortController.signal.aborted).toBe(false);
      // Already-elapsed lower ceiling expires immediately, rather than 800 ms from update.
      expect((await update({ budget: { wall_time_ms: 800 } })).success).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(agent.abortController.signal.aborted).toBe(true);
      expect(agent.result.reason).toContain('wall_time_ms (800)');
      expect(agent.rearmWallTimeWatchdog).toBe(null);
    } finally {
      agent.abortController.abort('cleanup');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
