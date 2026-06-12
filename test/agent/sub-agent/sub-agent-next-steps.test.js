/**
 * sub-agent-next-steps.test.js — pin the next_steps contract on every
 * sub-agent orchestration tool envelope.
 *
 * Symptom we're guarding against (bug 2026-06-11):
 *   When the parent LLM called WaitAgent (or SpawnAgent/PromptAgent/CloseAgent)
 *   the turn ended silently right after the tool returned. Cause was that the
 *   returned JSON envelope had no explicit "what to do next" field, so the
 *   LLM treated the wait result as a complete answer and emitted end_turn
 *   with no text. The user saw a stuck "tool ran" panel and no follow-up.
 *
 * Fix shape that these tests pin:
 *   1. Every WaitAgent envelope (terminal / idle / timedOut) carries a
 *      non-empty `next_steps` string that names actual tools and tells the
 *      LLM not to end its turn silently.
 *   2. SpawnAgent / PromptAgent / CloseAgent envelopes carry the same
 *      `next_steps` nudge.
 *   3. The tool descriptions all name the canonical companion tools
 *      (SpawnAgent / PromptAgent / WaitAgent / CloseAgent) so the parent
 *      LLM sees the full orchestration loop on every turn — not just in
 *      this PR's commit message.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { truncateToolResultIfNeeded, TOOL_RESULT_MAX_BYTES } from '../../../agent/yeaft/tools/registry.js';

/** Scripted adapter — emits a reply and end_turn for every stream() call. */
class TextAdapter {
  constructor(reply = 'done') { this.reply = reply; this.streamCalls = []; }
  async *stream(params) {
    this.streamCalls.push({ system: params.system, messages: params.messages });
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
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
    parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
    ...overrides,
  };
}

const vpTestCtx = { parentEngineDeps: { parentVpId: 'vp-test', parentThreadId: 'main' } };

/** Polls until agent leaves 'running'/'created' or the deadline fires. */
async function settleAgent(agent, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && agent.status !== 'idle' && agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'closed') {
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('WaitAgent: every envelope carries next_steps so the LLM does not end turn silently', () => {
  beforeEach(() => _resetAgentRegistry());

  it('terminal (completed) envelope carries next_steps', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-c', {
      id: 'agent-c', name: 'c', status: 'completed', result: 'finished',
      error: null, messages: [], usage: { turns: 1 },
    });
    const out = JSON.parse(await waitAgent.execute({ agent_id: 'agent-c' }, {}));
    expect(out.status).toBe('completed');
    expect(out.result).toBe('finished');
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
    // Names a real action, not just generic "ok".
    expect(out.next_steps.toLowerCase()).toContain('user');
  });

  it('terminal (closed) envelope carries next_steps', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-cl', {
      id: 'agent-cl', name: 'cl', status: 'closed', result: 'wrap',
      error: null, messages: [], usage: { turns: 1 },
    });
    const out = JSON.parse(await waitAgent.execute({ agent_id: 'agent-cl' }, {}));
    expect(out.status).toBe('closed');
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
  });

  it('terminal (failed) envelope carries next_steps that names SpawnAgent and tells the LLM to surface to the user', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-f', {
      id: 'agent-f', name: 'f', status: 'failed', result: '',
      error: 'boom', messages: [], usage: { turns: 0 },
    });
    const out = JSON.parse(await waitAgent.execute({ agent_id: 'agent-f' }, {}));
    expect(out.status).toBe('failed');
    expect(out.error).toBe('boom');
    expect(typeof out.next_steps).toBe('string');
    // Both required — alternation lets a regression that drops both slide
    // through if any token happens to appear in the wording.
    expect(out.next_steps).toMatch(/SpawnAgent/);
    expect(out.next_steps.toLowerCase()).toContain('user');
  });

  it('idle envelope (post-first-turn) carries next_steps that names PromptAgent / CloseAgent', async () => {
    const adapter = new TextAdapter('first reply');
    const deps = mkDeps(adapter);
    const spawn = JSON.parse(await agentTool.execute(
      { name: 'replier', mission: 'Reply once.' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(spawn.agentId);
    await settleAgent(agent, 2000);
    expect(agent.status).toBe('idle');

    const out = JSON.parse(await waitAgent.execute({ agent_id: spawn.agentId }, vpTestCtx));
    expect(out.status).toBe('idle');
    expect(out.result).toBe('first reply');
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps).toMatch(/PromptAgent/);
    expect(out.next_steps).toMatch(/CloseAgent/);
  });

  it('timedOut envelope carries next_steps that names WaitAgent retry / CloseAgent', async () => {
    // Plant a running agent with no driver attached — WaitAgent will time out.
    const agents = getAgentRegistry();
    agents.set('agent-stuck', {
      id: 'agent-stuck', name: 'stuck', status: 'running',
      result: '', lastResult: '', error: null,
      messages: [], usage: { turns: 0 },
    });
    const out = JSON.parse(await waitAgent.execute(
      { agent_id: 'agent-stuck', timeout_ms: 100 },
      {},
    ));
    expect(out.timedOut).toBe(true);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps).toMatch(/WaitAgent/);
    expect(out.next_steps).toMatch(/CloseAgent/);
  });
});

describe('SpawnAgent / PromptAgent / CloseAgent envelopes carry next_steps', () => {
  beforeEach(() => _resetAgentRegistry());

  it('SpawnAgent envelope nudges the LLM to call WaitAgent next', async () => {
    const adapter = new TextAdapter('hi');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'sleepy', mission: 'sleep' },
      { parentEngineDeps: deps },
    ));
    expect(out.success).toBe(true);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps).toMatch(/WaitAgent/);
  });

  it('PromptAgent envelope nudges the LLM to call WaitAgent next', async () => {
    // Need an agent in a state that PromptAgent will accept.
    const adapter = new TextAdapter('first');
    const deps = mkDeps(adapter);
    const spawn = JSON.parse(await agentTool.execute(
      { name: 'queueable', mission: 'queue' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(spawn.agentId);
    await settleAgent(agent, 2000);

    const out = JSON.parse(await sendMessage.execute(
      { agent_id: spawn.agentId, message: 'follow up' },
      vpTestCtx,
    ));
    expect(out.success).toBe(true);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps).toMatch(/WaitAgent/);
  });

  it('CloseAgent envelope nudges the LLM to relay the result to the user', async () => {
    const adapter = new TextAdapter('done');
    const deps = mkDeps(adapter);
    const spawn = JSON.parse(await agentTool.execute(
      { name: 'finisher', mission: 'finish' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(spawn.agentId);
    await settleAgent(agent, 2000);

    const out = JSON.parse(await closeAgent.execute(
      { agent_id: spawn.agentId, result: 'final' },
      vpTestCtx,
    ));
    expect(out.success).toBe(true);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.toLowerCase()).toContain('user');
  });
});

describe('Tool descriptions name the full orchestration loop', () => {
  // The descriptions are sent to the LLM on every turn (function-call schema).
  // If a tool drops the cross-reference, the LLM loses the contract — which
  // is exactly the stall the bug reported.
  it('WaitAgent description names SpawnAgent / PromptAgent / CloseAgent', () => {
    const d = waitAgent.description;
    expect(d).toMatch(/SpawnAgent/);
    expect(d).toMatch(/PromptAgent/);
    expect(d).toMatch(/CloseAgent/);
    expect(d.toLowerCase()).toContain('silently');
  });

  it('SpawnAgent description names WaitAgent / PromptAgent / CloseAgent', () => {
    const d = agentTool.description;
    expect(d).toMatch(/WaitAgent/);
    expect(d).toMatch(/PromptAgent/);
    expect(d).toMatch(/CloseAgent/);
  });

  it('PromptAgent description names WaitAgent / CloseAgent', () => {
    const d = sendMessage.description;
    expect(d).toMatch(/WaitAgent/);
    expect(d).toMatch(/CloseAgent/);
  });

  it('CloseAgent description tells the LLM to relay to the user', () => {
    const d = closeAgent.description;
    expect(d.toLowerCase()).toContain('user');
    expect(d.toLowerCase()).toContain('silently');
  });
});

describe('Error envelopes also carry next_steps — same bug-shape vulnerability', () => {
  // The fix premise is "naked terminal-looking envelopes cause silent end_turn".
  // An {error: '...'} blob is the MOST terminal-looking envelope possible —
  // and the most likely error in production is a fat-fingered agent_id. Make
  // sure every error path nudges the LLM out of silent end_turn.
  beforeEach(() => _resetAgentRegistry());

  it('WaitAgent: unknown agent_id error envelope carries next_steps', async () => {
    const out = JSON.parse(await waitAgent.execute({ agent_id: 'no-such-agent' }, {}));
    expect(out.error).toMatch(/not found/i);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
    expect(out.next_steps.toLowerCase()).toContain('user');
  });

  it('WaitAgent: missing agent_id error envelope carries next_steps', async () => {
    const out = JSON.parse(await waitAgent.execute({}, {}));
    expect(out.error).toMatch(/agent_id/);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
  });

  it('PromptAgent: unknown agent_id error envelope carries next_steps', async () => {
    const out = JSON.parse(await sendMessage.execute(
      { agent_id: 'no-such-agent', message: 'hi' },
      {},
    ));
    expect(out.error).toMatch(/not found/i);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
  });

  it('CloseAgent: unknown agent_id error envelope carries next_steps', async () => {
    const out = JSON.parse(await closeAgent.execute({ agent_id: 'no-such-agent' }, {}));
    expect(out.error).toMatch(/not found/i);
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
  });

  it('SpawnAgent: validation-failure error envelope carries next_steps', async () => {
    const out = JSON.parse(await agentTool.execute({ /* no name */ }, {}));
    expect(out.error).toBeTruthy();
    expect(typeof out.next_steps).toBe('string');
    expect(out.next_steps.length).toBeGreaterThan(0);
  });
});

describe('Envelope field ordering survives the 1 KiB tool-result cap', () => {
  // registry.js caps every tool result at TOOL_RESULT_MAX_BYTES (1024) by
  // truncating the tail. If next_steps lived at the END of the envelope, a
  // long `result` would push the directive off the end and the LLM would
  // never see it — re-introducing the exact bug this PR fixes. Pin field
  // order by asserting the directive survives the cap when result is large.
  beforeEach(() => _resetAgentRegistry());

  it('WaitAgent: next_steps survives truncation when result is long', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-long', {
      id: 'agent-long', name: 'long', status: 'completed',
      // Stuff `result` larger than the cap so naive (last-position)
      // field ordering would chop next_steps off the end.
      result: 'x'.repeat(TOOL_RESULT_MAX_BYTES * 2),
      error: null, messages: [], usage: { turns: 1 },
    });
    const raw = await waitAgent.execute({ agent_id: 'agent-long' }, {});
    const capped = truncateToolResultIfNeeded(raw, { toolName: 'WaitAgent' });
    expect(capped.length).toBeGreaterThan(0);
    // The directive body must show up BEFORE the truncation marker — i.e.
    // inside the first TOOL_RESULT_MAX_BYTES bytes of the JSON envelope.
    expect(capped).toMatch(/next_steps/);
    expect(capped.toLowerCase()).toContain('user');
  });

  it('SpawnAgent: next_steps survives truncation when envelope is padded', async () => {
    // SpawnAgent envelope is naturally small; pad agent name to force size.
    const out = await agentTool.execute(
      { name: 'a'.repeat(900), mission: 'm' },
      {},
    );
    const capped = truncateToolResultIfNeeded(out, { toolName: 'SpawnAgent' });
    expect(capped).toMatch(/next_steps/);
    expect(capped).toMatch(/WaitAgent/);
  });
});
