/**
 * sub-agent-tool-stats.test.js — guards the wiring fix where per-VP and
 * per-sub-agent Engines were silently dropping tool-call counts because
 * `toolStats` was never passed into their constructors.
 *
 * Two layers, two tests:
 *
 *   1. The sub-agent runner forwards `deps.toolStats` into its child
 *      Engine. When the child runs a tool, `toolStats.record(...)` is
 *      called with the tool name — i.e. the bug ("sub-agent tool calls
 *      never appear in the on-disk snapshot") cannot regress.
 *
 *   2. The parent Engine, when invoking a tool, hands the tool a
 *      `parentEngineDeps` carrying its own `toolStats`. This is the
 *      hop that lets a spawning Agent tool propagate stats into the
 *      child it just created. Tested by registering a fake `Agent`-shape
 *      tool that captures `ctx.parentEngineDeps` and asserting the
 *      forwarded reference is the same instance the parent received.
 *
 * Together these pin the contract: from the session-level toolStats all
 * the way down to a grand-child sub-agent, the same `record()`-receiving
 * object is reachable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/unify/tools/agent.js';
import agentTool from '../../../agent/unify/tools/agent.js';
import { mkStatsStub, OneShotToolAdapter } from '../../helpers/tool-stats.js';

describe('Engine threads its own #toolStats into parentEngineDeps', () => {
  it('a tool invoked by the parent engine receives ctx.parentEngineDeps.toolStats === the engine stats instance', async () => {
    const stats = mkStatsStub();
    let capturedCtx = null;
    const capturingAgentTool = defineTool({
      name: 'Agent',
      description: 'fake Agent tool used to capture ctx',
      parameters: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        capturedCtx = ctx;
        return JSON.stringify({ ok: true });
      },
    });

    const registry = new ToolRegistry();
    registry.register(capturingAgentTool);

    const adapter = new OneShotToolAdapter('Agent');
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
      toolRegistry: registry,
      toolStats: stats,
    });

    // Drain the query — adapter emits one Agent tool_call, engine executes
    // it (filling capturedCtx), then end_turn.
    for await (const _evt of engine.query({ prompt: 'spawn one', messages: [] })) {
      // consume
    }

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx.parentEngineDeps).toBeTruthy();
    // Same instance — not a clone — so a sub-agent that records into it
    // updates the snapshot the parent (and the unify_fetch_tool_stats
    // handler) reads.
    expect(capturedCtx.parentEngineDeps.toolStats).toBe(stats);
  });
});

describe('sub-agent runner: tool calls are counted into deps.toolStats', () => {
  beforeEach(() => _resetAgentRegistry());

  it('a sub-agent that invokes a tool records into deps.toolStats', async () => {
    const stats = mkStatsStub();

    // The sub-agent's parent ToolRegistry must contain an `echo` tool so
    // the child registry (built by `buildChildToolRegistry`, which strips
    // the orchestration set) still has it.
    const echoTool = defineTool({
      name: 'echo',
      description: 'echo input',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'ok'; },
    });
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(echoTool);

    const adapter = new OneShotToolAdapter('echo');
    const deps = {
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
      parentToolRegistry: parentRegistry,
      parentName: 'TestParent',
      parentVpId: 'vp-test',
      parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
      toolStats: stats,
    };

    const out = JSON.parse(await agentTool.execute(
      { name: 'tool-user', mission: 'Run echo once.' },
      { parentEngineDeps: deps },
    ));
    expect(out.success).toBe(true);
    const id = out.agentId;

    const agents = getAgentRegistry();
    const agent = agents.get(id);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && agent.status !== 'idle' && agent.status !== 'completed' && agent.status !== 'failed') {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(agent.status).toBe('idle');
    // The sub-engine ran one tool — `echo` — and the stub captured it.
    const echoCalls = stats.calls.filter(c => c.name === 'echo');
    expect(echoCalls.length).toBe(1);
    expect(echoCalls[0]).toMatchObject({ name: 'echo', isError: false });
    expect(typeof echoCalls[0].durationMs).toBe('number');
  });

  it('a sub-agent with no toolStats in deps still runs (defensive null)', async () => {
    const echoTool = defineTool({
      name: 'echo',
      description: 'echo input',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'ok'; },
    });
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(echoTool);

    const adapter = new OneShotToolAdapter('echo');
    const deps = {
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
      parentToolRegistry: parentRegistry,
      parentName: 'TestParent',
      parentVpId: 'vp-test',
      parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
      // intentionally omit toolStats — must still work
    };

    const out = JSON.parse(await agentTool.execute(
      { name: 'no-stats-user', mission: 'Run echo.' },
      { parentEngineDeps: deps },
    ));
    expect(out.success).toBe(true);

    const agent = getAgentRegistry().get(out.agentId);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && agent.status !== 'idle' && agent.status !== 'failed') {
      await new Promise(r => setTimeout(r, 20));
    }
    // No throw, no failure — sub-agent should reach idle even without stats.
    expect(agent.status).toBe('idle');
  });
});
