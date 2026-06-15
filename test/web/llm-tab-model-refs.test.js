import { describe, expect, it } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';
import { PROTOCOL_PRESET_MODELS } from '../../web/utils/protocolPresets.js';

describe('LlmTab editable model refs', () => {
  it('uses unsaved local providers so discovered models appear before save', () => {
    const computed = LlmTab.computed.allModelRefs;
    const ctx = {
      currentConfig: {
        effectiveConfig: {
          providers: [{ name: 'old', models: ['old-model'] }],
        },
      },
      localProviders: [{
        name: 'github-copilot',
        models: [{ id: 'claude-sonnet-4.5', protocol: 'anthropic' }, 'gpt-5'],
      }],
      parseModelsFromProvider: LlmTab.methods.parseModelsFromProvider,
      _modelId: LlmTab.methods._modelId,
    };

    expect(computed.call(ctx)).toEqual([
      'github-copilot/claude-sonnet-4.5',
      'github-copilot/gpt-5',
    ]);
  });

  it('offers Claude Opus 4.8 in Anthropic presets', () => {
    expect(PROTOCOL_PRESET_MODELS.anthropic).toContain('claude-opus-4-8');
    expect(PROTOCOL_PRESET_MODELS.anthropic).toContain('claude-opus-4.8');
  });
});
