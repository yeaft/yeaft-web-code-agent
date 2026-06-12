import { describe, it, expect } from 'vitest';
import { mergeLlmConfigs } from '../../../agent/yeaft/llm/provider-merge.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';

describe('LLM provider merge and routing refs', () => {
  it('merges global providers before local providers with scope metadata', () => {
    const merged = mergeLlmConfigs(
      { providers: [{ name: 'global', baseUrl: 'http://g/v1', apiKey: 'g', models: ['m'] }] },
      { providers: [{ name: 'local', baseUrl: 'http://l/v1', apiKey: 'l', models: ['m'] }], primaryModel: 'local/m' }
    );

    expect(merged.providers.map(p => [p.name, p.scope])).toEqual([
      ['global', 'global'],
      ['local', 'agent'],
    ]);
    expect(merged.primaryModel).toBe('local/m');
  });

  it('lets provider/model refs disambiguate duplicate model ids', () => {
    const router = new AdapterRouter({ providers: [
      { name: 'global:p', baseUrl: 'http://g/v1', apiKey: 'g', models: ['same-model'] },
      { name: 'p', baseUrl: 'http://l/v1', apiKey: 'l', models: ['same-model'] },
    ] });

    expect(router.getProviderForModel('global:p/same-model').baseUrl).toBe('http://g/v1');
    expect(router.getProviderForModel('p/same-model').baseUrl).toBe('http://l/v1');
    expect(router.getProviderForModel('same-model').baseUrl).toBe('http://g/v1');
  });
});
