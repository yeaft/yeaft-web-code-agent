import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
  it('adds effort metadata to available models from configured providers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-effort-config-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-5.4', 'gpt-4o', 'claude-opus-4.8'] }],
import { getModelEffortOptions, getThinkingCapability } from '../../agent/yeaft/models.js';
import { OpenAIResponsesAdapter } from '../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../agent/yeaft/llm/anthropic.js';
import { filterEffortForModel } from '../../agent/yeaft/llm/router.js';
import { modelRefMatchesAvailable } from '../../agent/yeaft/web-bridge.js';
import {
  loadSessionConfig,
      expect(byId['gpt-5.4'].effortOptions).toEqual(['low', 'medium', 'high']);
      expect(byId['claude-opus-4.8'].effortOptions).toEqual(['low', 'medium', 'high']);
      expect(byId['gpt-4o'].effortOptions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

} from '../../agent/yeaft/sessions/session-config.js';
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-effort-'));
    try {
      mkdirSync(dirname(sessionConfigPath(dir, 'sess_effort')), { recursive: true });
      const saved = saveSessionConfig(dir, 'sess_effort', { model: 'github-copilot/gpt-5.4', modelEffort: 'high' });


  it('exposes effort options for OpenAI and Anthropic reasoning-capable models', () => {
    expect(getModelEffortOptions('gpt-5')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/gpt-5.4')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/claude-opus-4.8')).toEqual(['low', 'medium', 'high']);
  });

  it('exposes effort options for OpenAI and Anthropic reasoning-capable models', () => {
    expect(getModelEffortOptions('gpt-5')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('gpt-5.5')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/gpt-5.4')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/gpt-5.5')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('github-copilot/claude-opus-4.8')).toEqual(['low', 'medium', 'high']);
    expect(getModelEffortOptions('gpt-4o')).toEqual([]);
      effortSource: 'user',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });


  it('maps Anthropic effort to extended thinking budget', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      const byId = Object.fromEntries(config.availableModels.map(m => [m.id, m]));
      expect(byId['gpt-5.4']).toMatchObject({
        ref: 'github-copilot/gpt-5.4',
        effortOptions: ['low', 'medium', 'high'],
      });
      expect(byId['claude-opus-4.8']).toMatchObject({
        ref: 'github-copilot/claude-opus-4.8',
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-effort-'));
    try {
      mkdirSync(dirname(sessionConfigPath(dir, 'sess_effort')), { recursive: true });
      const saved = saveSessionConfig(dir, 'sess_effort', { model: 'github-copilot/gpt-5.4', modelEffort: 'high' });
      expect(saved).toEqual({ model: 'github-copilot/gpt-5.4', modelEffort: 'high' });
      expect(loadSessionConfig(dir, 'sess_effort')).toEqual(saved);

      const resolved = resolveSessionConfig({ model: 'gpt-4o', primaryModel: 'gpt-4o' }, saved);
      expect(resolved.model).toBe('github-copilot/gpt-5.4');
      expect(resolved.primaryModel).toBe('github-copilot/gpt-5.4');
      expect(resolved.modelEffort).toBe('high');
  it('lets explicit user effort through the router even when auto thinking flag is off', () => {
    expect(filterEffortForModel({ model: 'github-copilot/gpt-5.4', effort: 'high', effortSource: 'user' }))
      .toMatchObject({ effort: 'high', effortSource: 'user' });
    expect(filterEffortForModel({ model: 'github-copilot/gpt-5.4', effort: 'high', effortSource: 'auto' }).effort)
      .toBeUndefined();
    expect(filterEffortForModel({ model: 'gpt-4o', effort: 'high', effortSource: 'user' }).effort)
      .toBeUndefined();
  });
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'medium',
      effortSource: 'user',
    });
    const requestCall = fetchMock.mock.calls.find(([, init]) => init && init.body);
    const body = JSON.parse(requestCall[1].body);
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });