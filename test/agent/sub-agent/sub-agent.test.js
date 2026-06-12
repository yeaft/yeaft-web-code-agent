/**
 * sub-agent.test.js — End-to-end test of the sub-agent driver.
 *
 * Verifies:
 *   1. Agent.execute spawns a real child Engine and runs the mission
 *      to end_turn, populating agent.result with the assistant text.
 *   2. The child ToolRegistry has the restricted set unregistered
 *      (Agent / SendMessage / WaitAgent / CloseAgent / RouteForward / AskUser).
 *   3. The parent's vpPersona body is concatenated with the spawned
 *      preamble in the child's system prompt (verified via adapter.stream
 *      message-snapshot inspection).
 *   4. SendMessage queues a follow-up prompt and the driver consumes it.
 *   5. WaitAgent returns lastResult once the agent goes idle.
 *   6. CloseAgent aborts and marks the agent closed.
 *   7. Sub-agent events are forwarded via the onEvent sink.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetAgentRegistry, checkBudget, getAgentRegistry, validateSpec } from '../../../agent/yeaft/tools/agent.js';
import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildChildToolRegistry, isRestrictedToolName } from '../../../agent/yeaft/sub-agent/runner.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

// recall-r6 was deleted in GC.1 follow-up; engine now recalls via FTS5
// pre-flow only when memoryIndex is wired (it isn't here), so no mock
// needed.

/**
 * Scripted adapter that emits text and end_turn for every stream() call.
 * Snapshots inputs so tests can assert on the system/messages.
 */
class TextAdapter {
  constructor(reply = 'mission accomplished') {
    this.reply = reply;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({
      system: params.system,
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() {
    return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  async execute(input) { return JSON.stringify({ echo: input }); },
});

function mkParentRegistry() {
  const reg = new ToolRegistry();
  reg.registerAll([echoTool, agentTool, sendMessage, waitAgent, closeAgent]);
  return reg;
}

function mkDeps(adapter, overrides = {}) {
  return {
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    parentToolRegistry: mkParentRegistry(),
    parentName: 'TestParent',
    parentVpId: 'vp-test',
    parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona, an unflappable engineer.' },
    ...overrides,
  };
}

const vpTestCtx = { parentEngineDeps: { parentVpId: 'vp-test', parentThreadId: 'main' } };

describe('sub-agent: tool subset', () => {
  it('child registry strips SpawnAgent/PromptAgent/WaitAgent/CloseAgent/RouteForward/AskUser', () => {
    const parent = new ToolRegistry();
    const fakes = ['SpawnAgent', 'PromptAgent', 'WaitAgent', 'CloseAgent', 'ListAgents', 'RouteForward', 'AskUser', 'Bash', 'Grep'].map((name) =>
      defineTool({ name, description: name, parameters: { type: 'object', properties: {} }, async execute() { return ''; } }),
    );
    parent.registerAll(fakes);
    const child = buildChildToolRegistry(parent);
    expect(child.has('Bash')).toBe(true);
    expect(child.has('Grep')).toBe(true);
    expect(child.has('SpawnAgent')).toBe(false);
    expect(child.has('PromptAgent')).toBe(false);
    expect(child.has('WaitAgent')).toBe(false);
    expect(child.has('CloseAgent')).toBe(false);
    expect(child.has('ListAgents')).toBe(false);
    expect(child.has('RouteForward')).toBe(false);
    expect(child.has('AskUser')).toBe(false);
  });

  it('isRestrictedToolName has the right list', () => {
    expect(isRestrictedToolName('SpawnAgent')).toBe(true);
    expect(isRestrictedToolName('Agent')).toBe(true); // legacy alias still restricted
    expect(isRestrictedToolName('Bash')).toBe(false);
  });
});

describe('sub-agent: tool timeout metadata', () => {
  it('gives WaitAgent enough registry-level time for a 5 minute wait', () => {
    expect(waitAgent.timeoutMs).toBeGreaterThanOrEqual(300000);
  });
});

describe('sub-agent: spec budget validation', () => {
  it('does not apply default max_tokens or max_turns limits', () => {
    const validation = validateSpec({ name: 'open-ended', mission: 'Investigate thoroughly.' });

    expect(validation.ok).toBe(true);
    expect(validation.spec.budget).toBeNull();
    expect(checkBudget({ budget: validation.spec.budget, usage: { tokens: 1_000_000, turns: 1_000, startedAt: 0 } }, 60_000)).toEqual({ exceeded: false });
  });

  it('keeps explicit budget limits as safety cutoffs', () => {
    const validation = validateSpec({
      name: 'bounded',
      mission: 'Stop after one turn.',
      budget: { max_turns: 1, max_tokens: 10, wall_time_ms: 5000 },
    });

    expect(validation.ok).toBe(true);
    expect(validation.spec.budget).toEqual({ max_turns: 1, max_tokens: 10, wall_time_ms: 5000 });
    expect(checkBudget({ budget: validation.spec.budget, usage: { tokens: 9, turns: 1, startedAt: 0 } }, 1000)).toMatchObject({ exceeded: true, limit: 'max_turns' });
    expect(checkBudget({ budget: validation.spec.budget, usage: { tokens: 10, turns: 0, startedAt: 0 } }, 1000)).toMatchObject({ exceeded: true, limit: 'max_tokens' });
    expect(checkBudget({ budget: validation.spec.budget, usage: { tokens: 0, turns: 0, startedAt: 0 } }, 5000)).toMatchObject({ exceeded: true, limit: 'wall_time_ms' });
  });
});

describe('sub-agent: spawn + first turn', () => {
  beforeEach(() => _resetAgentRegistry());

  it('runs the mission to end_turn and stores assistant text in agent.result', async () => {
    const adapter = new TextAdapter('mission accomplished');
    const deps = mkDeps(adapter);

    const out = JSON.parse(await agentTool.execute(
      { name: 'investigate', mission: 'Read the ledger and summarise.' },
      { parentEngineDeps: deps },
    ));
    expect(out.success).toBe(true);
    const id = out.agentId;

    // Wait for the driver — poll up to 2s.
    const agents = getAgentRegistry();
    const agent = agents.get(id);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && agent.status !== 'idle' && agent.status !== 'completed' && agent.status !== 'failed') {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(agent.status).toBe('idle');
    expect(agent.result).toBe('mission accomplished');
    expect(agent.usage.turns).toBe(1);

    // Adapter was called exactly once with the mission as the user prompt.
    expect(adapter.streamCalls).toHaveLength(1);
    const lastUser = adapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(lastUser.content).toContain('Read the ledger');
    // System prompt carries the spawned preamble.
    expect(adapter.streamCalls[0].system).toContain('You are a sub-agent');
    // And carries the parent persona body (continuity of voice).
    expect(adapter.streamCalls[0].system).toContain('TestPersona');
  });

  it('forwards every sub-engine event to the onEvent sink', async () => {
    const adapter = new TextAdapter('done');
    const events = [];
    const deps = mkDeps(adapter, {
      onEvent: (agentId, evt) => events.push({ agentId, type: evt.type, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'evt-watcher', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;

    const agents = getAgentRegistry();
    const agent = agents.get(id);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && agent.status === 'running') {
      await new Promise(r => setTimeout(r, 20));
    }
    // Saw at least one text_delta + a turn-end event tagged with agentId.
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
    expect(events.some(e => e.type === 'sub_agent_turn_end' && e.agentId === id)).toBe(true);
    expect(events.every(e => e.agentId === id)).toBe(true);
  });
});

describe('sub-agent: SendMessage / WaitAgent / CloseAgent round-trip', () => {
  beforeEach(() => _resetAgentRegistry());

  it('WaitAgent schema allows waits up to 5 minutes', () => {
    expect(waitAgent.parameters.properties.timeout_ms.maximum).toBe(300000);
    expect(waitAgent.parameters.properties.timeout_ms.description).toContain('300000');
  });

  it('WaitAgent accepts an explicit 300000ms timeout for terminal agents', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-done', {
      id: 'agent-done',
      name: 'done',
      status: 'completed',
      result: 'finished',
      error: null,
      messages: [],
      usage: { turns: 0 },
    });

    const wait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-done', timeout_ms: 300000 }, {}));
    expect(wait.status).toBe('completed');
    expect(wait.result).toBe('finished');
  });

  it('WaitAgent rejects waits above 5 minutes', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-running', {
      id: 'agent-running',
      name: 'running',
      status: 'running',
      messages: [],
      usage: { turns: 0 },
    });

    const wait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-running', timeout_ms: 300001 }, {}));
    expect(wait.error).toContain('300000');
  });

  it('SendMessage queues a follow-up the driver consumes; WaitAgent collects each result', async () => {
    const adapter = new TextAdapter('first reply');
    const deps = mkDeps(adapter);
    const ctx = { parentEngineDeps: deps };

    const spawn = JSON.parse(await agentTool.execute(
      { name: 'chatter', mission: 'Initial mission.' },
      ctx,
    ));
    const id = spawn.agentId;

    // Wait #1 — first mission turn.
    const w1 = JSON.parse(await waitAgent.execute({ agent_id: id, timeout_ms: 2000 }, vpTestCtx));
    expect(w1.status).toBe('idle');
    expect(w1.result).toBe('first reply');

    // Send follow-up.
    adapter.reply = 'second reply';
    const sm = JSON.parse(await sendMessage.execute(
      { agent_id: id, message: 'follow up please' },
      vpTestCtx,
    ));
    expect(sm.success).toBe(true);

    const w2 = JSON.parse(await waitAgent.execute({ agent_id: id, timeout_ms: 2000 }, vpTestCtx));
    expect(w2.status).toBe('idle');
    expect(w2.result).toBe('second reply');
    expect(w2.turns).toBe(2);

    // Adapter saw two streams; the second carried the prior assistant turn
    // (continuity) plus the new user message.
    expect(adapter.streamCalls).toHaveLength(2);
    const secondMsgs = adapter.streamCalls[1].messages;
    expect(secondMsgs.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(secondMsgs[secondMsgs.length - 1]).toEqual({ role: 'user', content: 'follow up please' });
  });

  it('CloseAgent flips status and aborts in-flight work', async () => {
    const adapter = new TextAdapter('one shot');
    const deps = mkDeps(adapter);

    const spawn = JSON.parse(await agentTool.execute(
      { name: 'short-lived', mission: 'do' },
      { parentEngineDeps: deps },
    ));
    const id = spawn.agentId;

    // Wait for first turn to land.
    await waitAgent.execute({ agent_id: id, timeout_ms: 2000 }, vpTestCtx);

    const cls = JSON.parse(await closeAgent.execute({ agent_id: id, result: 'wrap' }, vpTestCtx));
    expect(cls.success).toBe(true);
    expect(cls.result).toBe('wrap');

    const agent = getAgentRegistry().get(id);
    expect(agent.status).toBe('closed');
    expect(agent.abortController.signal.aborted).toBe(true);
  });
});

describe('sub-agent: failure surfacing (option A)', () => {
  beforeEach(() => _resetAgentRegistry());

  it('a failing adapter marks the agent failed and WaitAgent returns the error', async () => {
    class FailAdapter {
      async *stream() {
        throw new Error('adapter exploded');
      }
      async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
    }
    const adapter = new FailAdapter();
    const deps = mkDeps(adapter);

    const spawn = JSON.parse(await agentTool.execute(
      { name: 'doomed', mission: 'try' },
      { parentEngineDeps: deps },
    ));
    const id = spawn.agentId;

    const wait = JSON.parse(await waitAgent.execute({ agent_id: id, timeout_ms: 2000 }, vpTestCtx));
    expect(wait.status).toBe('failed');
    expect(wait.error).toContain('adapter exploded');
  });
});
