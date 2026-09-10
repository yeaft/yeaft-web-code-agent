import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';

const roots = [];
const providers = [{ name: 'p', baseUrl: 'https://example.test', models: [
  { id: 'gpt-5', maxOutput: 2048, effortOptions: ['low', 'high'] },
  { id: 'simple', supportsEffort: false, maxOutput: 1000 },
] }];
const preset = (overrides = {}) => ({ id: 'fast', name: 'Fast', model: 'p/gpt-5', effort: null, maxOutputTokens: null, ...overrides });
function root(config = { providers, debug: true, custom: { keep: true } }) {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-quick-send-'));
  roots.push(dir);
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Agent quick-send config', () => {
  it('defaults empty without creating config or samples', () => {
    const dir = root(null);
    expect(getLlmConfig(dir)).toMatchObject({ agentConfig: { quickSends: [] }, effectiveConfig: { quickSends: [] } });
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });
  it('round-trips 0–5 entries, normalizes bare refs and preserves unrelated config', () => {
    const dir = root();
    const quickSends = Array.from({ length: 5 }, (_, i) => preset({ id: `q${i}`, name: `Button ${i}`, model: 'gpt-5', effort: 'high', maxOutputTokens: 2048 }));
    const result = updateLlmConfig({ quickSends }, dir);
    expect(result.error).toBeUndefined();
    expect(result.agentConfig.quickSends).toHaveLength(5);
    expect(result.effectiveConfig.quickSends[0].model).toBe('p/gpt-5');
    expect(result.agentConfig.availableModels[0]).toMatchObject({ ref: 'p/gpt-5', maxOutput: 2048, effortOptions: ['low', 'high'] });
    expect(JSON.parse(readFileSync(join(dir, 'config.json')))).toMatchObject({ debug: true, custom: { keep: true } });
    updateLlmConfig({ language: 'zh-CN' }, dir);
    expect(getLlmConfig(dir).agentConfig.quickSends).toEqual(result.agentConfig.quickSends);
    expect(updateLlmConfig({ quickSends: [] }, dir).agentConfig.quickSends).toEqual([]);
  });
  it.each([
    ['not array', null],
    ['too many', Array.from({ length: 6 }, (_, i) => preset({ id: String(i) }))],
    ['duplicate ids', [preset(), preset()]],
    ['blank name', [preset({ name: ' ' })]],
    ['blank id', [preset({ id: '' })]],
    ['unknown model', [preset({ model: 'p/missing' })]],
    ['unknown provider', [preset({ model: 'missing/gpt-5' })]],
    ['model default not allowed', [preset({ model: null })]],
    ['invalid effort', [preset({ effort: 'turbo' })]],
    ['unsupported effort', [preset({ effort: 'medium' })]],
    ['effort on non-reasoner', [preset({ model: 'p/simple', effort: 'high' })]],
    ['zero', [preset({ maxOutputTokens: 0 })]],
    ['negative', [preset({ maxOutputTokens: -1 })]],
    ['fraction', [preset({ maxOutputTokens: 1.5 })]],
    ['string', [preset({ maxOutputTokens: '100' })]],
    ['over cap', [preset({ maxOutputTokens: 2049 })]],
  ])('rejects %s atomically', (_, quickSends) => {
    const dir = root();
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(updateLlmConfig({ quickSends, debug: false }, dir).error).toBeTruthy();
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
  });
  it('validates against providers in the same atomic update and rejects ambiguous bare ids', () => {
    const dir = root();
    const duplicate = [...providers, { ...providers[0], name: 'other' }];
    expect(updateLlmConfig({ providers: duplicate, quickSends: [preset({ model: 'gpt-5' })] }, dir).error).toMatch(/unambiguous/);
    expect(updateLlmConfig({ providers: duplicate, quickSends: [preset()] }, dir).error).toBeUndefined();
    expect(updateLlmConfig({ providers: [], quickSends: [preset()] }, dir).error).toMatch(/model must exist/);
  });
  it('keeps Agent roots isolated and drops shortcut/unknown fields', () => {
    const a = root(); const b = root();
    const result = updateLlmConfig({ quickSends: [preset({ shortcut: 'Ctrl+1' })] }, a);
    expect(result.agentConfig.quickSends[0]).toEqual(preset());
    expect(getLlmConfig(b).agentConfig.quickSends).toEqual([]);
  });
});
