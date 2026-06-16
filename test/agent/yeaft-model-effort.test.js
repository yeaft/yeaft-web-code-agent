import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { loadConfig } from '../../agent/yeaft/config.js';
import { getModelEffortOptions, getThinkingCapability } from '../../agent/yeaft/models.js';
import { OpenAIResponsesAdapter } from '../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../agent/yeaft/llm/anthropic.js';
import { AdapterRouter, filterEffortForModel } from '../../agent/yeaft/llm/router.js';
import { modelRefMatchesAvailable } from '../../agent/yeaft/web-bridge.js';
import {
  loadSessionConfig,
  resolveSessionConfig,
  saveSessionConfig,
  sessionConfigPath,
} from '../../agent/yeaft/sessions/session-config.js';

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('Yeaft model effort metadata and config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.YEAFT_THINKING_V1;
  });

  it('exposes effort options for OpenAI and Anthropic reasoning-capable models', () => {
    expect(getModelEffortOptions('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getModelEffortOptions('gpt-5.5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/gpt-5.4')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/gpt-5.5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/claude-opus-4.8')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('claude-opus-4-7')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getModelEffortOptions('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(getModelEffortOptions('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(getModelEffortOptions('claude-sonnet-4-20250514')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('gpt-4o')).toEqual([]);

    expect(getThinkingCapability('github-copilot/gpt-5.4').thinkingProtocol).toBe('openai-reasoning');
    expect(getThinkingCapability('github-copilot/gpt-5.5').thinkingProtocol).toBe('openai-reasoning');
    expect(getThinkingCapability('github-copilot/claude-opus-4.8').thinkingProtocol).toBe('anthropic-adaptive');
    expect(getThinkingCapability('claude-opus-4-6').thinkingProtocol).toBe('anthropic-adaptive');
    expect(getThinkingCapability('claude-sonnet-4-6').thinkingProtocol).toBe('anthropic-adaptive');
  });

  it('adds effort metadata to available models from configured providers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-effort-config-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-5.4', 'gpt-4o', 'claude-opus-4.8'] }],
      primaryModel: 'github-copilot/gpt-5.4',
    }));
    try {
      const config = loadConfig({ dir });
      const byId = Object.fromEntries(config.availableModels.map(m => [m.id, m]));
      expect(byId['gpt-5.4']).toMatchObject({
        ref: 'github-copilot/gpt-5.4',
        effortOptions: ['minimal', 'low', 'medium', 'high'],
      });
      expect(byId['claude-opus-4.8']).toMatchObject({
        ref: 'github-copilot/claude-opus-4.8',
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
        effortProtocol: 'anthropic-adaptive',
      });
      expect(modelRefMatchesAvailable(byId['gpt-5.4'], 'github-copilot/gpt-5.4')).toBe(true);
      expect(modelRefMatchesAvailable(byId['claude-opus-4.8'], 'github-copilot/claude-opus-4.8')).toBe(true);
      expect(byId['gpt-4o'].effortOptions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists session modelEffort and resolves it into runtime config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-effort-'));
    try {
      mkdirSync(dirname(sessionConfigPath(dir, 'sess_effort')), { recursive: true });
      const saved = saveSessionConfig(dir, 'sess_effort', { model: 'github-copilot/gpt-5.4', modelEffort: 'minimal' });
      expect(saved).toEqual({ model: 'github-copilot/gpt-5.4', modelEffort: 'minimal' });
      expect(loadSessionConfig(dir, 'sess_effort')).toEqual(saved);

      const resolved = resolveSessionConfig({ model: 'gpt-4o', primaryModel: 'gpt-4o' }, saved);
      expect(resolved.model).toBe('github-copilot/gpt-5.4');
      expect(resolved.primaryModel).toBe('github-copilot/gpt-5.4');
      expect(resolved.modelEffort).toBe('minimal');

      expect(saveSessionConfig(dir, 'sess_effort', { modelEffort: 'xhigh' })).toEqual({ model: 'github-copilot/gpt-5.4', modelEffort: 'xhigh' });
      expect(saveSessionConfig(dir, 'sess_effort', { modelEffort: null })).toEqual({ model: 'github-copilot/gpt-5.4' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Yeaft adapter effort request mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.YEAFT_THINKING_V1;
    delete process.env.COPILOT_GITHUB_TOKEN;
  });

  it('lets explicit user effort through the router even when auto thinking flag is off', () => {
    expect(filterEffortForModel({ model: 'github-copilot/gpt-5.4', effort: 'high', effortSource: 'user' }))
      .toMatchObject({ effort: 'high', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'github-copilot/gpt-5.5', effort: 'minimal', effortSource: 'user' }))
      .toMatchObject({ effort: 'minimal', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'github-copilot/gpt-5.4', effort: 'high', effortSource: 'auto' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'github-copilot/claude-opus-4.8', effort: 'minimal', effortSource: 'user' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'gpt-5', effort: 'max', effortSource: 'user' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'gpt-5', effort: 'xhigh', effortSource: 'user' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'github-copilot/claude-opus-4.8', effort: 'xhigh', effortSource: 'user' }))
      .toMatchObject({ effort: 'xhigh', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'claude-opus-4-6', effort: 'max', effortSource: 'user' }))
      .toMatchObject({ effort: 'max', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'claude-opus-4-6', effort: 'xhigh', effortSource: 'user' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'claude-sonnet-4-6', effort: 'xhigh', effortSource: 'user' }).effort)
      .toBeUndefined();
  });

  it('maps OpenAI effort to Responses reasoning.effort', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ output_text: 'ok', usage: {} }));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test', baseUrl: 'https://api.test/v1' });

    await adapter.call({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      effortSource: 'user',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('maps explicit gpt-5.5 effort through provider-qualified OpenAI Responses routing', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'gho_test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('copilot_internal')) {
        return jsonResponse({ token: 'copilot-api-token', expires_at: Math.floor(Date.now() / 1000) + 1800 });
      }
      return jsonResponse({ output_text: 'ok', usage: {} });
    });
    const router = new AdapterRouter({
      providers: [{
        name: 'github-copilot',
        baseUrl: 'https://copilot.yeaft.com',
        apiKey: 'test',
        protocol: 'openai-responses',
        models: ['gpt-5.5'],
      }],
    });

    await router.call({
      model: 'github-copilot/gpt-5.5',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'minimal',
      effortSource: 'user',
    });

    const requestCall = fetchMock.mock.calls.find(([, init]) => init && init.body);
    const body = JSON.parse(requestCall[1].body);
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning).toEqual({ effort: 'minimal' });
  });


  it('maps Anthropic adaptive effort to output_config.effort', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: {},
    }));
    const adapter = new AnthropicAdapter({ apiKey: 'test', baseUrl: 'https://api.test' });

    for (const model of ['claude-opus-4.8', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      await adapter.call({
        model,
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1000,
        effort: 'max',
        effortSource: 'user',
      });

      const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
      expect(body.thinking.budget_tokens).toBeUndefined();
      expect(body.max_tokens).toBe(1000);
    }
  });


  it('keeps manual Anthropic thinking budgets for older thinking models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      usage: {},
    }));
    const adapter = new AnthropicAdapter({ apiKey: 'test', baseUrl: 'https://api.test' });

    await adapter.call({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      effort: 'medium',
      effortSource: 'user',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(8192);
  });
});
