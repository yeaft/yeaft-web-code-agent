import { describe, it, expect } from 'vitest';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';

describe('LLM provider/model routing refs', () => {
  it('lets provider/model refs disambiguate duplicate model ids', () => {
    const router = new AdapterRouter({ providers: [
      { name: 'p1', baseUrl: 'http://one/v1', apiKey: 'one', models: ['same-model'] },
      { name: 'p2', baseUrl: 'http://two/v1', apiKey: 'two', models: ['same-model'] },
    ] });

    expect(router.getProviderForModel('p1/same-model').baseUrl).toBe('http://one/v1');
    expect(router.getProviderForModel('p2/same-model').baseUrl).toBe('http://two/v1');
    expect(router.getProviderForModel('same-model').baseUrl).toBe('http://one/v1');
  });
});
