import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../../agent/yeaft/engine.js';
import { startSubAgent } from '../../../agent/yeaft/sub-agent/runner.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import {
  EFFORT_LEVELS, captureEffortDecision, snapshotEffortDecision,
  resolveSubAgentEffort, enforceSubAgentEffortPayload, pickEffort,
} from '../../../agent/yeaft/effort.js';
import agentTool, { getAgentRegistry, _resetAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import promptTool from '../../../agent/yeaft/tools/send-message.js';
import { enqueueSubAgentPrompt } from '../../../agent/yeaft/sub-agent/prompt-queue.js';

const parent = effective => snapshotEffortDecision({ requested: effective, effective, source: 'query',
  model: 'gpt-5.5', wireMode: 'reasoning-effort', thinkingEnabled: true });
const responses = (effective, overrides = {}) => ({ model: 'gpt-5', protocol: 'openai-responses',
  effortConstraint: { parentDecision: parent(effective) }, ...overrides });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); _resetAgentRegistry(); });

describe('child effort capability ceiling', () => {
  it.each(EFFORT_LEVELS)('inherits parent %s without exceeding high, regardless of flag or override', level => {
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    const expected = ['xhigh', 'max', 'ultra'].includes(level) ? 'high' : level;
    for (const requested of EFFORT_LEVELS) {
      const body = { reasoning: { effort: requested, summary: 'auto' } };
      const decision = enforceSubAgentEffortPayload(body, responses(level));
      expect(EFFORT_LEVELS.indexOf(body.reasoning.effort)).toBeLessThanOrEqual(EFFORT_LEVELS.indexOf(expected));
      expect(decision.cap).toBe(expected);
      expect(body.reasoning.summary).toBe('auto');
      expect(Object.isFrozen(decision)).toBe(true);
    }
    const body = {};
    expect(enforceSubAgentEffortPayload(body, responses(level)).effective).toBe(expected);
    expect(body.reasoning.effort).toBe(expected);
  });

  it('selects the highest supported ordinal <= target, not array or lexical ordering', () => {
    const options = { model: 'custom', protocol: 'openai-responses',
      effortContext: { supportsEffort: true, effortOptions: ['high', 'minimal', 'low'] } };
    expect(resolveSubAgentEffort({ ...options, parentDecision: parent('medium') }).effective).toBe('low');
    expect(() => resolveSubAgentEffort({ ...options, parentDecision: parent('minimal'),
      effortContext: { supportsEffort: true, effortOptions: ['high', 'low'] } }))
      .toThrow(/cannot express effort <= minimal.*compatible/);
  });

  it('keeps child constraints through nesting, including unsupported intermediate models', () => {
    const first = enforceSubAgentEffortPayload({}, responses('low'));
    const second = resolveSubAgentEffort({ parentDecision: first, model: 'claude-3-haiku-20240307' });
    expect(second).toMatchObject({ effective: null, cap: 'low', wireMode: 'unsupported' });
    const thirdBody = { reasoning: { effort: 'max' } };
    expect(enforceSubAgentEffortPayload(thirdBody, responses(null, {
      effortConstraint: { parentDecision: second },
    })).effective).toBe('low');
  });

  it('falls back to explicit medium only when parent effective/default is unknown', () => {
    const unknown = captureEffortDecision({ body: {}, model: 'gpt-5', protocol: 'openai-responses', requested: 'max' });
    expect(unknown.effective).toBeNull();
    const body = {};
    expect(enforceSubAgentEffortPayload(body, responses(null, {
      effortConstraint: { parentDecision: unknown },
    }))).toMatchObject({ effective: 'medium', source: 'fallback' });
    const known = captureEffortDecision({ body: {}, model: 'custom', protocol: 'openai-responses',
      effortContext: { supportsEffort: true, defaultEffort: 'low' }, requested: 'max' });
    expect(known).toMatchObject({ effective: 'low', source: 'model-default', wireMode: 'omitted' });
    expect(resolveSubAgentEffort({ model: 'gpt-5', parentDecision: known }).effective).toBe('low');
  });

  it('removes incompatible fields for truly unsupported models', () => {
    const body = { reasoning: { effort: 'ultra' }, thinking: { type: 'enabled', budget_tokens: 90000 }, output_config: { effort: 'max', format: 'json' } };
    expect(enforceSubAgentEffortPayload(body, responses('high', { model: 'claude-3-haiku-20240307' })))
      .toMatchObject({ effective: null, wireMode: 'unsupported', thinkingEnabled: false });
    expect(body).toEqual({ output_config: { format: 'json' } });
  });

  it('does not change ordinary scenario defaults or explicit overrides', () => {
    expect(pickEffort({ scenario: 'chat' })).toBe('max');
    for (const userEffort of EFFORT_LEVELS) {
      expect(pickEffort({ userEffort, toolLoopTurns: 100 })).toBe(userEffort);
    }
  });
});

describe('final Anthropic payload fence', () => {
  const manual = effective => responses(effective, { model: 'claude-sonnet-4-20250514', protocol: 'anthropic' });
  const adaptive = effective => responses(effective, { model: 'claude-opus-4-6', protocol: 'anthropic' });

  it.each([['low', 4096], ['medium', 8192], ['high', 16384], ['ultra', 16384]])('caps manual %s after extraBody budget override', (level, budget) => {
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    const body = { thinking: { type: 'enabled', budget_tokens: 64000 }, max_tokens: 65024,
      output_config: { effort: 'max' }, reasoning: { effort: 'ultra' } };
    const decision = enforceSubAgentEffortPayload(body, manual(level));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
    expect(decision.budgetTokens).toBe(budget);
    expect(body.output_config).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });

  it('bounds manual budgets by output size and model cap, rejects impossible minimal/output', () => {
    const body = { max_tokens: 4096 };
    expect(enforceSubAgentEffortPayload(body, manual('high')).budgetTokens).toBe(4095);
    expect(enforceSubAgentEffortPayload({ max_tokens: 32000 }, {
      ...manual('high'), effortContext: { supportsEffort: true, maxBudgetTokens: 2048 },
    }).budgetTokens).toBe(2048);
    expect(() => enforceSubAgentEffortPayload({ max_tokens: 1024 }, manual('low'))).toThrow(/1024 thinking tokens/);
    expect(() => enforceSubAgentEffortPayload({ max_tokens: 32000 }, manual('minimal')))
      .toThrowError(expect.objectContaining({ code: 'SUB_AGENT_EFFORT_UNREPRESENTABLE' }));
  });

  it.each(['low', 'medium', 'high', 'max', 'ultra'])('caps adaptive %s after extraBody mode/effort override', level => {
    const body = { thinking: { type: 'enabled', budget_tokens: 64000 }, output_config: { effort: 'max', format: 'json' } };
    const decision = enforceSubAgentEffortPayload(body, adaptive(level));
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config.effort).toBe(['max', 'ultra'].includes(level) ? 'high' : level);
    expect(body.output_config.format).toBe('json');
    expect(decision.wireMode).toBe('adaptive');
  });

  it('captures wire budget conservatively and wire effort instead of requested config', () => {
    expect(captureEffortDecision({ body: { thinking: { type: 'enabled', budget_tokens: 5000 } },
      model: 'claude-sonnet-4-20250514', protocol: 'anthropic', requested: 'low' }))
      .toMatchObject({ requested: 'low', effective: 'medium', budgetTokens: 5000 });
    expect(captureEffortDecision({ body: { reasoning: { effort: 'low' } },
      model: 'gpt-5', protocol: 'openai-responses', requested: 'ultra' }))
      .toMatchObject({ requested: 'ultra', effective: 'low' });
    expect(captureEffortDecision({ body: { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
      model: 'claude-opus-4-6', protocol: 'anthropic', requested: 'max' }))
      .toMatchObject({ requested: 'max', effective: 'medium', wireMode: 'adaptive' });
  });
});

describe('SpawnAgent and PromptAgent immutable request snapshots', () => {
  it('captures spawn at tool execution and snapshots every queued follow-up independently', async () => {
    const effortDecision = { ...parent('low') };
    const ctx = { effortDecision, currentVpId: 'test-vp', sessionId: 'test-session' };
    const result = JSON.parse(await agentTool.execute({ name: 'effort-test', mission: 'Find evidence' }, ctx));
    expect(result.success).toBe(true);
    const agent = getAgentRegistry().get(result.agentId);
    effortDecision.effective = 'ultra';
    expect(agent.parentEffortDecision.effective).toBe('low');
    expect(Object.isFrozen(agent.parentEffortDecision)).toBe(true);
    await promptTool.execute({ agent_id: agent.id, message: 'follow up 1' }, ctx);
    effortDecision.effective = 'medium';
    await promptTool.execute({ agent_id: agent.id, message: 'follow up 2' }, ctx);
    effortDecision.effective = 'max';
    expect(agent.pendingPrompts.map(entry => entry.parentEffortDecision.effective)).toEqual(['ultra', 'medium']);
    expect(agent.pendingPrompts.every(entry => Object.isFrozen(entry.parentEffortDecision))).toBe(true);
  });

  it('runner restores and consumes each saved snapshot rather than live parent config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-effort-runner-'));
    const record = { id: 'effort-runner', name: 'effort-runner', mission: 'initial', status: 'created',
      parentEffortDecision: JSON.parse(JSON.stringify(parent('low'))),
      pendingPrompts: [], messages: [], diagnostics: [], budget: {},
      usage: { tokens: 0, turns: 0, startedAt: Date.now() }, abortController: new AbortController() };
    const calls = [];
    vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (params) {
      calls.push(params);
      if (calls.length === 1) {
        enqueueSubAgentPrompt(record, 'medium follow-up', { parentEffortDecision: parent('medium') });
        enqueueSubAgentPrompt(record, 'unknown follow-up');
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'stop', stopReason: 'end_turn' };
      yield { type: 'turn_end', terminal: true };
    });
    try {
      startSubAgent(record, { adapter: { stream() {}, call() {} },
        config: { model: 'gpt-5', modelEffort: 'ultra', _readOnly: true },
        trace: new NullTrace(), parentToolRegistry: new ToolRegistry(), subAgentLogDir: dir, yeaftDir: dir });
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      record.status = 'closed';
      record.abortController.abort('test complete');
      await vi.waitFor(() => expect(record.__driverStarted).toBe(false));
      expect(calls.map(call => call.parentEffortDecision.effective)).toEqual(['low', 'medium', null]);
      expect(calls.every(call => call.scenario === 'sub_agent' && call.isSubAgent === true)).toBe(true);
      expect(calls.every(call => Object.isFrozen(call.parentEffortDecision))).toBe(true);
      const log = fs.readFileSync(record.outputFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(log.filter(event => event.type === 'sub_agent_effort_snapshot')
        .map(event => event.parentEffortDecision.effective)).toEqual(['low', 'medium', null]);
    } finally {
      record.abortController.abort('cleanup');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing follow-up decision is explicit unknown, not stale spawn effort', () => {
    const agent = { parentEffortDecision: parent('ultra') };
    enqueueSubAgentPrompt(agent, 'unknown parent');
    expect(agent.pendingPrompts[0].parentEffortDecision.effective).toBeNull();
    expect(resolveSubAgentEffort({ model: 'gpt-5', parentDecision: agent.pendingPrompts[0].parentEffortDecision }).effective).toBe('medium');
  });
});
