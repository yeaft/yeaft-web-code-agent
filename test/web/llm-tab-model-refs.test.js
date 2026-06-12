import { describe, expect, it } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';

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
});
