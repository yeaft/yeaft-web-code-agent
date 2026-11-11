import { describe, expect, it } from 'vitest';
import {
  getModelEffortOptions,
  getThinkingCapability,
  modelSupportsEffort,
} from '../../../agent/yeaft/models.js';
import { applyAnthropicThinking } from '../../../agent/yeaft/llm/anthropic.js';
import { filterEffortForModel } from '../../../agent/yeaft/llm/router.js';
import { captureEffortDecision, enforceSubAgentEffortPayload } from '../../../agent/yeaft/effort.js';

const adaptiveOptions = ['low', 'medium', 'high', 'xhigh', 'max'];
const previewOptions = ['low', 'medium', 'high', 'max'];

describe('Anthropic model effort inference', () => {
  it('recognizes documented Fable/Mythos versions and platform aliases without granting unknown families effort', () => {
    const models = [
      'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2',
      'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2',
      'proxy/claude-fable-5.1', 'proxy/claude-mythos-5.2',
      'proxy/CLAUDE-FABLE-5-2', 'claude-fable-5-2-latest',
      'claude-mythos-5-1-20260901', 'claude-fable-5-2@20261109',
      'anthropic.claude-fable-5-2', 'us.anthropic.claude-mythos-5-2',
      'proxy/global.anthropic.claude-fable-5-2',
      'eu.anthropic.claude-mythos-5-1-v1:0',
      'apac.anthropic.claude-fable-5-20260701-v1:0',
    ];
    for (const model of models) {
      expect(getThinkingCapability(model), model).toEqual({
        supportsThinking: true, thinkingProtocol: 'anthropic-adaptive',
        defaultEffort: 'high', maxBudgetTokens: null, effortOptions: adaptiveOptions,
      });
      expect(getModelEffortOptions(model), model).toEqual(adaptiveOptions);
      expect(modelSupportsEffort(model), model).toBe(true);
    }
    for (const model of ['claude-mythos-preview', 'proxy/claude-mythos-preview-latest', 'anthropic.claude-mythos-preview-20260407-v1:0']) {
      expect(getThinkingCapability(model), model).toMatchObject({
        thinkingProtocol: 'anthropic-adaptive', defaultEffort: 'high', effortOptions: previewOptions,
      });
    }
    for (const model of [
      'claude-unknown-5', 'claude-unknown-4', 'claude-fable-4', 'claude-mythos-3-7',
      'claude-fable-6', 'claude-mythos-5-3', 'claude-fable-5.10',
      'claude-fable-50', 'claude-fable-5-2-other', 'claude-mythos-preview-other',
      'untrusted.anthropic.claude-fable-5-2', 'other.claude-mythos-5-2',
    ]) {
      expect(getThinkingCapability(model), model).toMatchObject({ supportsThinking: false, thinkingProtocol: 'none' });
      expect(getModelEffortOptions(model, { protocol: 'anthropic' }), model).toEqual([]);
    }
    // Registry exclusions and older families keep their existing behavior through aliases.
    expect(getThinkingCapability('proxy/anthropic.claude-haiku-3-20250414')).toMatchObject({ supportsThinking: false });
    expect(getThinkingCapability('proxy/claude-opus-4-20250514')).toMatchObject({ thinkingProtocol: 'anthropic', maxBudgetTokens: 64000 });
    expect(getThinkingCapability('claude-3-7-sonnet-20250219')).toMatchObject({ thinkingProtocol: 'anthropic', maxBudgetTokens: 32000 });
    expect(getModelEffortOptions('claude-opus-4-6')).toEqual(previewOptions);
    expect(getModelEffortOptions('claude-opus-4-8')).toEqual(adaptiveOptions);
    expect(getModelEffortOptions('gpt-5.5')).toContain('ultra');
  });

  it('preserves native adaptive protocol when Anthropic capability metadata enables or narrows effort', () => {
    for (const model of ['claude-fable-5-2', 'proxy/anthropic.claude-mythos-5-1', 'claude-mythos-preview', 'claude-opus-4-8']) {
      for (const metadata of [{ supportsEffort: true }, { effortOptions: ['low', 'high'] }]) {
        expect(getThinkingCapability(model, { protocol: 'anthropic', ...metadata }), model).toMatchObject({
          supportsThinking: true, thinkingProtocol: 'anthropic-adaptive', defaultEffort: 'high',
        });
      }
    }
    expect(getModelEffortOptions('claude-fable-5-2', { protocol: 'anthropic', effortOptions: ['low', 'high', 'ultra'] })).toEqual(['low', 'high']);
    expect(getThinkingCapability('claude-fable-5-2', {
      protocol: 'openai-responses', supportsEffort: true,
    }).thinkingProtocol).toBe('openai-reasoning');
    expect(getThinkingCapability('claude-fable-5-2', {
      protocol: 'anthropic', supportsEffort: true, thinkingProtocol: 'anthropic',
    }).thinkingProtocol).toBe('anthropic');
    expect(getThinkingCapability('unknown-model', { protocol: 'anthropic', supportsEffort: true }).thinkingProtocol).toBe('anthropic');
  });

  it('retains user effort through router filtering and emits adaptive payloads and bounded child effort', () => {
    for (const model of ['claude-fable-5-2', 'proxy/anthropic.claude-mythos-5-1', 'claude-mythos-preview']) {
      const effortContext = { protocol: 'anthropic', supportsEffort: true };
      const options = model.includes('preview') ? previewOptions : adaptiveOptions;
      for (const effort of options) {
        const params = { model, effort, effortSource: 'user' };
        expect(filterEffortForModel(params, { protocol: 'anthropic', entry: effortContext })).toEqual(params);
        const body = { max_tokens: 4096 };
        applyAnthropicThinking(body, model, effort, effortContext);
        expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort } });
      }
      for (const effort of ['minimal', 'ultra', ...(model.includes('preview') ? ['xhigh'] : [])]) {
        expect(filterEffortForModel({ model, effort, effortSource: 'user' }, { protocol: 'anthropic' })).toEqual({ model });
        const body = { max_tokens: 4096 };
        applyAnthropicThinking(body, model, effort, effortContext);
        expect(body).toEqual({ max_tokens: 4096 });
      }
      expect(captureEffortDecision({ model, protocol: 'anthropic' })).toMatchObject({
        effective: 'high', source: 'model-default', wireMode: 'omitted',
      });
      const body = { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort: 'max' } };
      expect(enforceSubAgentEffortPayload(body, { model, protocol: 'anthropic', effortContext,
        effortConstraint: { parentDecision: { effective: 'medium' } },
      })).toMatchObject({ effective: 'medium', wireMode: 'adaptive' });
      expect(body).toEqual({ max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    }
  });
});
