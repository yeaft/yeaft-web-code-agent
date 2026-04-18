/**
 * task-327a: Unify LLM thinking/reasoning — capability matrix + adapter
 * parameter plumbing.
 *
 * Coverage:
 *   - models.js: registry fields + helpers (normalizeEffort,
 *     mapEffortToOpenAIReasoning, thinkingBudgetForEffort, getThinkingCapability)
 *   - anthropic.js: body.thinking = { type: 'enabled', budget_tokens } for
 *     claude-sonnet-4 / opus-4 at 4 effort levels; noop on haiku-3;
 *     max_tokens auto-widens to budget + 1024
 *   - chat-completions.js: body.reasoning.effort set for gpt-5 / o3 / o4-mini;
 *     'max' downgrades to 'high'; noop on deepseek-chat etc.
 *   - router.filterEffortForModel: strips effort when flag off, unknown effort,
 *     or model has thinkingProtocol: 'none'
 *   - Feature flag UNIFY_THINKING_V1 gates everything — default OFF is noop
 *
 * Red lines:
 *   - Not testing engine.js decision tree (that's 327b)
 *   - Not testing streaming protocol changes (unchanged)
 *   - Not breaking old model behavior
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MODEL_REGISTRY,
  normalizeEffort,
  mapEffortToOpenAIReasoning,
  thinkingBudgetForEffort,
  getThinkingCapability,
  ANTHROPIC_THINKING_BUDGETS,
} from '../../../../agent/unify/models.js';
import { filterEffortForModel } from '../../../../agent/unify/llm/router.js';
import { AnthropicAdapter } from '../../../../agent/unify/llm/anthropic.js';
import { ChatCompletionsAdapter } from '../../../../agent/unify/llm/chat-completions.js';

// ─── registry field coverage ────────────────────────────────────

describe('task-327a: MODEL_REGISTRY thinking fields', () => {
  it('claude-sonnet-4 supports anthropic thinking with 32K max budget', () => {
    const e = MODEL_REGISTRY.get('claude-sonnet-4-20250514');
    expect(e.supportsThinking).toBe(true);
    expect(e.thinkingProtocol).toBe('anthropic');
    expect(e.maxBudgetTokens).toBe(32000);
    expect(e.defaultEffort).toBe(null);
  });

  it('claude-opus-4 supports anthropic thinking with 64K max budget (PM decision)', () => {
    const e = MODEL_REGISTRY.get('claude-opus-4-20250514');
    expect(e.supportsThinking).toBe(true);
    expect(e.thinkingProtocol).toBe('anthropic');
    expect(e.maxBudgetTokens).toBe(64000);
  });

  it('claude-haiku-3 does NOT support thinking', () => {
    const e = MODEL_REGISTRY.get('claude-haiku-3-20250414');
    expect(e.supportsThinking).toBe(false);
    expect(e.thinkingProtocol).toBe('none');
  });

  it('gpt-5 supports openai-reasoning protocol', () => {
    const e = MODEL_REGISTRY.get('gpt-5');
    expect(e.supportsThinking).toBe(true);
    expect(e.thinkingProtocol).toBe('openai-reasoning');
  });

  it('o3 and o4-mini support openai-reasoning', () => {
    expect(MODEL_REGISTRY.get('o3').thinkingProtocol).toBe('openai-reasoning');
    expect(MODEL_REGISTRY.get('o4-mini').thinkingProtocol).toBe('openai-reasoning');
  });

  it('deepseek-chat is not registered as a thinking model', () => {
    const cap = getThinkingCapability('deepseek-chat');
    expect(cap.supportsThinking).toBe(false);
    expect(cap.thinkingProtocol).toBe('none');
  });
});

// ─── helper functions ───────────────────────────────────────────

describe('task-327a: helper functions', () => {
  it('normalizeEffort accepts low/medium/high/max and rejects others', () => {
    expect(normalizeEffort('low')).toBe('low');
    expect(normalizeEffort('medium')).toBe('medium');
    expect(normalizeEffort('high')).toBe('high');
    expect(normalizeEffort('max')).toBe('max');
    expect(normalizeEffort('HIGH')).toBe(null);
    expect(normalizeEffort('')).toBe(null);
    expect(normalizeEffort(null)).toBe(null);
    expect(normalizeEffort(undefined)).toBe(null);
    expect(normalizeEffort('super')).toBe(null);
  });

  it('mapEffortToOpenAIReasoning: low/medium/high pass through; max → high', () => {
    expect(mapEffortToOpenAIReasoning('low')).toBe('low');
    expect(mapEffortToOpenAIReasoning('medium')).toBe('medium');
    expect(mapEffortToOpenAIReasoning('high')).toBe('high');
    expect(mapEffortToOpenAIReasoning('max')).toBe('high');
    expect(mapEffortToOpenAIReasoning(null)).toBe(null);
  });

  it('thinkingBudgetForEffort: opus-4 max=64K, sonnet-4 max=32K, medium=8192 all models', () => {
    expect(thinkingBudgetForEffort('claude-opus-4-20250514', 'max')).toBe(64000);
    expect(thinkingBudgetForEffort('claude-sonnet-4-20250514', 'max')).toBe(32000);
    expect(thinkingBudgetForEffort('claude-sonnet-4-20250514', 'medium'))
      .toBe(ANTHROPIC_THINKING_BUDGETS.medium);
    expect(thinkingBudgetForEffort('claude-sonnet-4-20250514', 'high'))
      .toBe(ANTHROPIC_THINKING_BUDGETS.high);
    expect(thinkingBudgetForEffort('claude-sonnet-4-20250514', 'low'))
      .toBe(ANTHROPIC_THINKING_BUDGETS.low);
  });

  it('thinkingBudgetForEffort: unknown model falls back to table for max', () => {
    expect(thinkingBudgetForEffort('unknown-model', 'max'))
      .toBe(ANTHROPIC_THINKING_BUDGETS.max);
  });

  it('thinkingBudgetForEffort: empty/bad effort returns null', () => {
    expect(thinkingBudgetForEffort('claude-opus-4-20250514', null)).toBe(null);
    expect(thinkingBudgetForEffort('claude-opus-4-20250514', 'bogus')).toBe(null);
  });
});

// ─── router.filterEffortForModel ────────────────────────────────

describe('task-327a: router.filterEffortForModel', () => {
  let origFlag;
  beforeEach(() => { origFlag = process.env.UNIFY_THINKING_V1; });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  it('drops effort when feature flag is OFF (default)', () => {
    delete process.env.UNIFY_THINKING_V1;
    const out = filterEffortForModel({ model: 'claude-opus-4-20250514', effort: 'max' });
    expect(out.effort).toBeUndefined();
    expect(out.model).toBe('claude-opus-4-20250514');
  });

  it('keeps effort when flag on + supported model', () => {
    process.env.UNIFY_THINKING_V1 = '1';
    const out = filterEffortForModel({ model: 'claude-opus-4-20250514', effort: 'max' });
    expect(out.effort).toBe('max');
  });

  it('drops effort when model is registered but does not support thinking', () => {
    process.env.UNIFY_THINKING_V1 = '1';
    const out = filterEffortForModel({ model: 'claude-haiku-3-20250414', effort: 'high' });
    expect(out.effort).toBeUndefined();
  });

  it('drops effort on unknown model', () => {
    process.env.UNIFY_THINKING_V1 = '1';
    const out = filterEffortForModel({ model: 'mystery-1', effort: 'high' });
    expect(out.effort).toBeUndefined();
  });

  it('drops invalid effort values', () => {
    process.env.UNIFY_THINKING_V1 = '1';
    const out = filterEffortForModel({ model: 'gpt-5', effort: 'ultra' });
    expect(out.effort).toBeUndefined();
  });

  it('passthrough when params has no effort at all', () => {
    process.env.UNIFY_THINKING_V1 = '1';
    const params = { model: 'gpt-5', messages: [] };
    const out = filterEffortForModel(params);
    expect(out).toBe(params);
  });
});

// ─── adapter body-shape tests ───────────────────────────────────
//
// Instead of mocking fetch, we exercise the adapter by stubbing fetch with a
// capturing stub that rejects once we've seen the outgoing body. This lets us
// assert exactly what `body.thinking` / `body.reasoning` look like.

function captureBody(adapterCall) {
  let captured = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    // Return a "rejected" response so the generator throws quickly.
    return {
      ok: false,
      status: 500,
      text: async () => 'stub',
    };
  };
  return adapterCall()
    .catch(() => {})
    .finally(() => { globalThis.fetch = orig; })
    .then(() => captured);
}

async function drainStream(gen) {
  try {
    for await (const _ of gen) { /* noop */ }
  } catch { /* expected from stub 500 */ }
}

describe('task-327a: AnthropicAdapter body.thinking injection', () => {
  let origFlag;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  const mkAdapter = () => new AnthropicAdapter({ apiKey: 'test', baseUrl: 'https://stub' });

  it('effort=low → thinking.budget_tokens=4096 for sonnet-4', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'low',
    })));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('effort=high → thinking.budget_tokens=16384 for sonnet-4', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
    })));
    expect(body.thinking.budget_tokens).toBe(16384);
  });

  it('effort=max on opus-4 → budget_tokens=64000 (PM decision) and max_tokens widens', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-opus-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8192,
      effort: 'max',
    })));
    expect(body.thinking.budget_tokens).toBe(64000);
    expect(body.max_tokens).toBeGreaterThanOrEqual(64000 + 1024);
  });

  it('effort=max on sonnet-4 → budget_tokens=32000', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    })));
    expect(body.thinking.budget_tokens).toBe(32000);
  });

  it('no thinking field when no effort passed', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })));
    expect(body.thinking).toBeUndefined();
  });

  it('noop on haiku-3 (unsupported)', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-haiku-3-20250414',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    })));
    expect(body.thinking).toBeUndefined();
  });

  it('noop when feature flag OFF even with effort=high', async () => {
    delete process.env.UNIFY_THINKING_V1;
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
    })));
    expect(body.thinking).toBeUndefined();
  });
});

describe('task-327a: ChatCompletionsAdapter body.reasoning injection', () => {
  let origFlag;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  const mkAdapter = () => new ChatCompletionsAdapter({
    apiKey: 'test',
    baseUrl: 'https://stub/v1',
  });

  it('gpt-5 + effort=medium → reasoning.effort=medium', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'medium',
    })));
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });

  it('o3 + effort=high → reasoning.effort=high', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'o3',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
    })));
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('o4-mini + effort=low → reasoning.effort=low', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'o4-mini',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'low',
    })));
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('gpt-5 + effort=max → reasoning.effort=high (OpenAI has no max)', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
    })));
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('noop on deepseek-chat (non-reasoning)', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'deepseek-chat',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
    })));
    expect(body.reasoning).toBeUndefined();
  });

  it('noop when feature flag OFF', async () => {
    delete process.env.UNIFY_THINKING_V1;
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
    })));
    expect(body.reasoning).toBeUndefined();
  });

  it('noop when no effort is passed', async () => {
    const body = await captureBody(() => drainStream(mkAdapter().stream({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })));
    expect(body.reasoning).toBeUndefined();
  });
});
