import { describe, expect, it } from 'vitest';
import {
  getModelEffortOptions, getThinkingCapability, modelSupportsEffort,
  normalizeProviderModels, serializeModelForPersistence,
} from '../../../agent/yeaft/models.js';
import { applyAnthropicThinking } from '../../../agent/yeaft/llm/anthropic.js';
import { filterEffortForModel, normalizeModelEntry } from '../../../agent/yeaft/llm/router.js';
import { captureEffortDecision, enforceSubAgentEffortPayload } from '../../../agent/yeaft/effort.js';

const anthropicOptions = ['low', 'medium', 'high', 'xhigh', 'max'];
const openaiOptions = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

describe('API-based effort capability', () => {
  it('uses the effective API for future models, opaque aliases and IDs from the other vendor', () => {
    for (const model of ['new-model', 'proxy/private-alias', 'gpt-4.1', 'gpt-5.5', 'claude-haiku-3-20250414', 'claude-fable-50', 'anthropic.claude-mythos-preview']) {
      for (const [protocol, thinkingProtocol, effortOptions] of [
        ['anthropic', 'anthropic-adaptive', anthropicOptions],
        ['openai-responses', 'openai-reasoning', openaiOptions],
      ]) {
        expect(getThinkingCapability(model, { protocol }), model).toEqual({
          supportsThinking: true, thinkingProtocol, defaultEffort: protocol === 'anthropic' ? 'high' : null,
          maxBudgetTokens: null, effortOptions,
        });
        expect(getModelEffortOptions(model, { protocol }), model).toEqual(effortOptions);
        expect(modelSupportsEffort(model, { protocol }), model).toBe(true);
      }
    }
    // Legacy callers may still infer the API, but never a model-specific tier list.
    expect(getModelEffortOptions('claude-opus-4-6')).toEqual(anthropicOptions);
    expect(getModelEffortOptions('gpt-future')).toEqual(openaiOptions);
    const copy = getModelEffortOptions('alias', { protocol: 'anthropic' });
    copy.pop();
    expect(getModelEffortOptions('alias', { protocol: 'anthropic' })).toEqual(anthropicOptions);
  });

  it('preserves explicit disable, tier restrictions and legacy manual budgets without overriding the wire API', () => {
    for (const protocol of ['anthropic', 'openai-responses']) {
      for (const override of [{ supportsEffort: false }, { thinkingProtocol: 'none' }]) {
        const entry = normalizeModelEntry({ id: 'alias', ...override });
        const persisted = serializeModelForPersistence(normalizeProviderModels({ models: [entry] })[0]);
        expect(persisted).toMatchObject(override);
        expect(getModelEffortOptions('alias', { protocol, ...persisted })).toEqual([]);
        expect(filterEffortForModel({ model: 'alias', effort: 'high', effortSource: 'user' }, { protocol, entry })).toEqual({ model: 'alias' });
      }
      expect(getModelEffortOptions('alias', { protocol, effortOptions: ['high', 'low', 'low', 'invalid', 'ultra'] }))
        .toEqual(protocol === 'anthropic' ? ['low', 'high'] : ['low', 'high', 'ultra']);
    }
    expect(getThinkingCapability('alias', { protocol: 'openai-responses', thinkingProtocol: 'anthropic' }).thinkingProtocol).toBe('openai-reasoning');
    expect(getThinkingCapability('alias', { protocol: 'anthropic', thinkingProtocol: 'openai-reasoning' }).thinkingProtocol).toBe('anthropic-adaptive');
    expect(getModelEffortOptions('alias', { protocol: 'unsupported' })).toEqual([]);
    expect(getModelEffortOptions('alias', { protocol: 'anthropic', effortOptions: ['ultra'] })).toEqual([]);
    const manual = { protocol: 'anthropic', thinkingProtocol: 'anthropic', maxBudgetTokens: 6000, effortOptions: ['low', 'high', 'max'] };
    const persisted = serializeModelForPersistence(normalizeProviderModels({ models: [{ id: 'legacy-alias', ...manual }] })[0]);
    expect(persisted).toMatchObject(manual);
    const body = { max_tokens: 4096 };
    applyAnthropicThinking(body, 'legacy-alias', 'max', persisted);
    expect(body).toEqual({ max_tokens: 7024, thinking: { type: 'enabled', budget_tokens: 6000 } });
    expect(getModelEffortOptions('legacy-alias', persisted)).toEqual(['low', 'high', 'max']);
  });

  it('retains user effort through router and payload translation while enforcing inherited child ceilings', () => {
    for (const model of ['new-model', 'claude-mythos-preview', 'gpt-4.1']) {
      for (const effort of anthropicOptions) {
        const params = { model, effort, effortSource: 'user' };
        expect(filterEffortForModel(params, { protocol: 'anthropic' })).toEqual(params);
        const body = { max_tokens: 4096 };
        applyAnthropicThinking(body, model, effort);
        expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort } });
      }
      for (const effort of openaiOptions) {
        const params = { model, effort, effortSource: 'user' };
        expect(filterEffortForModel(params, { protocol: 'openai-responses' })).toEqual(params);
      }
      for (const effort of ['minimal', 'ultra', 'invalid']) {
        expect(filterEffortForModel({ model, effort, effortSource: 'user' }, { protocol: 'anthropic' })).toEqual({ model });
      }
      expect(captureEffortDecision({ model, protocol: 'anthropic' })).toMatchObject({ effective: 'high', source: 'model-default', wireMode: 'omitted' });
      for (const protocol of ['anthropic', 'openai-responses']) {
        const body = { max_tokens: 4096, reasoning: { effort: 'ultra' }, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } };
        expect(enforceSubAgentEffortPayload(body, { model, protocol,
          effortConstraint: { parentDecision: { effective: 'medium' } },
        })).toMatchObject({ effective: 'medium', wireMode: protocol === 'anthropic' ? 'adaptive' : 'reasoning-effort' });
        if (protocol === 'anthropic') {
          expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
        } else {
          expect(body).toEqual({ max_tokens: 4096, reasoning: { effort: 'medium' } });
        }
      }
    }
  });
});
