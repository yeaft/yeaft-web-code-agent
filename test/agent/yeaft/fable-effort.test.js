import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModelSelectionRows, getSelectableModelEfforts, resolveSessionModelEffort } from '../../../web/utils/modelRefs.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';

const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const options = {
  anthropic: ['medium', 'xhigh', 'max'],
  'openai-responses': ['medium', 'xhigh', 'max', 'ultra'],
};
function installFetch(requests) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const anthropic = url.endsWith('/messages');
    const reply = anthropic
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } };
    const events = anthropic ? [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ] : [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: reply }];
    return body.stream ? new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  }));
}
function assertWire(body, protocol, effort) {
  if (protocol === 'anthropic') {
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort } });
    expect(body).not.toHaveProperty('reasoning');
  } else {
    expect(body.reasoning).toEqual({ effort });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  }
}

describe('API effort catalog and dispatch', () => {
  it('uses the adapter API on direct call and stream even with missing or conflicting capability context', async () => {
    const requests = [];
    installFetch(requests);
    for (const [protocol, Adapter] of [['anthropic', AnthropicAdapter], ['openai-responses', OpenAIResponsesAdapter]]) {
      const adapter = new Adapter({ apiKey: 'fixture', baseUrl: 'https://proxy.invalid' });
      for (const effortContext of [undefined, { protocol: protocol === 'anthropic' ? 'openai-responses' : 'anthropic' }]) {
        const effort = options[protocol].at(-1);
        const params = { model: 'brand-new-alias', effort, effortSource: 'user', effortContext, system: '', messages: [] };
        await adapter.call(params);
        for await (const _event of adapter.stream(params)) { /* drain */ }
        for (const body of requests.slice(-2)) assertWire(body, protocol, effort);
      }
    }
  });

  it('exposes API tiers, persists Session selection and sends the selected effort through mixed-provider routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-api-effort-'));
    roots.push(root);
    const providers = [
      { name: 'proxy', apiKey: 'fixture', baseUrl: 'https://proxy.invalid', protocol: 'anthropic', models: [
        'opaque-new-model', 'claude-fable-5.2', 'gpt-4.1',
        { id: 'opaque-other-api', protocol: 'openai-responses' },
        { id: 'disabled', supportsEffort: false },
      ] },
      { name: 'responses', apiKey: 'fixture', baseUrl: 'https://proxy.invalid', protocol: 'openai-responses', models: [
        'opaque-new-model', 'gpt-new-alias', { id: 'opaque-anthropic', protocol: 'anthropic' },
      ] },
    ];
    writeFileSync(join(root, 'config.json'), JSON.stringify({ providers, primaryModel: 'proxy/opaque-new-model' }));
    const config = loadConfig({ dir: root });
    const apiCatalog = getLlmConfig(root).availableModels;
    expect(apiCatalog.map(m => [m.ref, m.effortOptions || []])).toEqual(config.availableModels.map(m => [m.ref, m.effortOptions || []]));
    expect(getSelectableModelEfforts(['minimal', 'low', 'medium', 'low', 'unknown'])).toEqual(['medium']);
    for (const [effortOptions, defaultEffort] of [
      [['medium', 'xhigh'], 'medium'], [['medium', 'max'], 'medium'],
      [['medium', 'xhigh', 'max'], 'xhigh'], [['max'], 'max'],
    ]) expect(buildModelSelectionRows([{ id: 'sparse', effortOptions }])[0]).toMatchObject({ efforts: effortOptions, defaultEffort });
    expect(buildModelSelectionRows([{ id: 'old', effortOptions: ['low', 'high'] }])[0]).toMatchObject({ efforts: [], defaultEffort: null });
    mkdirSync(join(root, 'sessions', 'api-session'), { recursive: true });
    for (const [legacy, current] of [['minimal', 'medium'], ['low', 'medium'], ['high', 'xhigh']]) {
      writeFileSync(join(root, 'sessions', 'api-session', 'config.json'), JSON.stringify({ modelEffort: legacy }));
      expect(loadSessionConfig(root, 'api-session').modelEffort).toBe(current);
      expect(resolveSessionConfig(config, { modelEffort: legacy }).modelEffort).toBe(current);
      expect(resolveSessionModelEffort({ config: { modelEffort: legacy } })).toBe(current);
      expect(saveSessionConfig(root, 'api-session', { modelEffort: legacy }).modelEffort).toBe(current);
    }
    const requests = [];
    installFetch(requests);
    const router = new AdapterRouter({ providers: config.providers });
    for (const model of config.availableModels.filter(model => model.id !== 'disabled')) {
      expect(model.effortOptions).toEqual(options[model.protocol]);
      expect(buildModelSelectionRows([model])[0].efforts).toEqual(options[model.protocol]);
      for (const effort of model.effortOptions) {
        saveSessionConfig(root, 'api-session', { model: model.ref, modelEffort: effort });
        const selected = resolveSessionConfig(config, loadSessionConfig(root, 'api-session'));
        const params = { model: selected.model, effort: selected.modelEffort, effortSource: 'user', system: '', messages: [{ role: 'user', content: 'hello' }] };
        await router.call(params);
        const events = [];
        for await (const event of router.stream(params)) events.push(event);
        expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'ok' }));
        for (const body of requests.slice(-2)) {
          expect(body.model).toBe(model.id);
          assertWire(body, model.protocol, effort);
        }
      }
    }
    expect(config.availableModels.find(model => model.id === 'disabled').effortOptions).toBeUndefined();
    await router.call({ model: 'proxy/disabled', effort: 'high', effortSource: 'user', system: '', messages: [] });
    expect(requests.at(-1)).not.toHaveProperty('thinking');
    await router.call({ model: 'proxy/opaque-new-model', effort: 'ultra', effortSource: 'user', system: '', messages: [] });
    expect(requests.at(-1)).not.toHaveProperty('output_config');
  });

  it('retains managed Copilot manual, restricted and disabled effort across save, reload and dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-managed-effort-'));
    roots.push(root);
    const managed = { name: 'github-copilot', models: [
      { id: 'claude-legacy', thinkingProtocol: 'anthropic', maxBudgetTokens: 6000 },
      { id: 'claude-restricted', effortOptions: ['low'] },
      { id: 'claude-disabled', supportsEffort: false },
    ] };
    const saved = updateLlmConfig({ providers: [managed] }, root);
    expect(saved.error).toBeUndefined();
    for (const [index, original] of managed.models.entries()) expect(saved.providers[0].models[index]).toMatchObject(index === 1 ? { ...original, effortOptions: ['medium'] } : original);
    const config = loadConfig({ dir: root });
    const [manual, restricted, disabled] = config.availableModels;
    expect(manual).toMatchObject({ effortProtocol: 'anthropic', maxBudgetTokens: 6000, effortOptions: ['medium', 'xhigh', 'max'] });
    expect(restricted.effortOptions).toEqual(['medium']);
    expect(disabled.supportsEffort).toBe(false);
    const requests = [];
    installFetch(requests);
    // Use the normalized managed models on a synthetic static-key gateway;
    // no live Copilot authentication, credentials or paid API are accessed.
    const router = new AdapterRouter({ providers: [{ name: 'fixture', apiKey: 'synthetic', baseUrl: 'https://proxy.invalid', models: config.providers[0].models }] });
    for (const [model, effort] of [[manual, 'max'], [restricted, 'low'], [disabled, 'high']]) {
      const params = { model: `fixture/${model.id}`, effort, effortSource: 'user', system: '', messages: [], maxTokens: 4096 };
      await router.call(params);
      for await (const _event of router.stream(params)) { /* drain */ }
      for (const body of requests.slice(-2)) {
        if (model === manual) expect(body).toMatchObject({ max_tokens: 7024, thinking: { type: 'enabled', budget_tokens: 6000 } });
        else if (model === restricted) assertWire(body, 'anthropic', 'medium');
        else expect(body).not.toHaveProperty('thinking');
      }
    }
  });
});
