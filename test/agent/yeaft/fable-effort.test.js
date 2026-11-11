import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelEffortOptions, getThinkingCapability } from '../../../agent/yeaft/models.js';
import { buildModelSelectionRows, getSelectableModelEfforts } from '../../../web/utils/modelRefs.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getLlmConfig } from '../../../agent/yeaft/config-api.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Claude Fable effort', () => {
  it('infers adaptive thinking for Fable 5 variants without enabling unrelated or older models', () => {
    for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5.1', 'claude-fable-5-2', 'claude-fable-5.2', 'claude-fable-5-2-20261001', 'proxy/claude-fable-5.2', 'CLAUDE-FABLE-5.2']) {
      for (const context of [{}, { protocol: 'anthropic' }]) {
        expect(getThinkingCapability(model, context)).toMatchObject({
          supportsThinking: true, thinkingProtocol: 'anthropic-adaptive', defaultEffort: 'high',
        });
        expect(getModelEffortOptions(model, context)).toEqual(efforts);
      }
    }
    for (const model of ['claude-fable', 'claude-fable-3.5', 'claude-fable-50x', 'fable-5.2', 'claude-unknown-5.2']) {
      expect(getModelEffortOptions(model)).toEqual([]);
    }
    expect(getModelEffortOptions('claude-fable-5.2', { effortOptions: ['low', 'high'], thinkingProtocol: 'anthropic-adaptive' })).toEqual(['low', 'high']);
    expect(getModelEffortOptions('claude-opus-4.6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(getThinkingCapability('claude-sonnet-4-20250514').thinkingProtocol).toBe('anthropic');
  });

  it('exposes all tiers in the catalog, persists Session selection, and sends adaptive effort through call and stream', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-fable-effort-'));
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      providers: [{ name: 'proxy', apiKey: 'fixture', baseUrl: 'https://proxy.invalid', models: ['claude-fable-5.2'] }],
      primaryModel: 'proxy/claude-fable-5.2',
    }));
    const config = loadConfig({ dir: root });
    expect(config.availableModels).toEqual([expect.objectContaining({
      ref: 'proxy/claude-fable-5.2', supportsEffort: true, effortProtocol: 'anthropic-adaptive', effortOptions: efforts,
    })]);
    expect(getLlmConfig(root).availableModels[0].effortOptions).toEqual(efforts);
    expect(buildModelSelectionRows(config.availableModels)[0].efforts).toEqual(efforts);
    expect(getSelectableModelEfforts(['minimal', 'low', 'medium', 'low', 'unknown'])).toEqual(['minimal', 'low', 'medium']);
    mkdirSync(join(root, 'sessions', 'fable-session'), { recursive: true });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return body.stream ? new Response([
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
        '', 'event: message_stop', 'data: {"type":"message_stop"}', '', '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }) : new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const router = new AdapterRouter({ providers: config.providers });
    for (const effort of efforts) {
      saveSessionConfig(root, 'fable-session', { model: 'proxy/claude-fable-5.2', modelEffort: effort });
      const selected = resolveSessionConfig(config, loadSessionConfig(root, 'fable-session'));
      expect(selected.modelEffort).toBe(effort);
      const params = { model: selected.model, effort: selected.modelEffort, effortSource: 'user', system: '', messages: [{ role: 'user', content: 'hello' }] };
      await router.call(params);
      const events = [];
      for await (const event of router.stream(params)) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'ok' }));
      for (const body of requests.slice(-2)) {
        expect(body).toMatchObject({ model: 'claude-fable-5.2', thinking: { type: 'adaptive' }, output_config: { effort } });
        expect(body.thinking).not.toHaveProperty('budget_tokens');
      }
    }
    await router.call({ model: 'proxy/claude-fable-5.2', effort: 'ultra', effortSource: 'user', system: '', messages: [] });
    expect(requests.at(-1)).not.toHaveProperty('output_config');
    expect(requests.at(-1)).not.toHaveProperty('thinking');
  });
});
