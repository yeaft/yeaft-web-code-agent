/**
 * test/agent/unify/model-context-config.test.js
 *
 * Tests for task-284 — model context configurability:
 *   (a) string model normalization → { id }
 *   (b) object model preserves contextWindow / maxOutput
 *   (c) provider override wins over MODEL_REGISTRY
 *   (d) getModelInfo returns undefined when neither has the info
 *   (e) persistence back-compat: id-only → string; with ctx/max → object
 *   (f) resolveModel via normalized models — label never `[object Object]`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../../agent/unify/config.js';
import { updateLlmConfig, getLlmConfig } from '../../../agent/unify/config-api.js';
import {
  getModelInfo,
  normalizeProviderModels,
  MODEL_REGISTRY,
} from '../../../agent/unify/models.js';

const TEST_DIR = join(tmpdir(), `yeaft-model-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeConfig(obj) {
  writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify(obj, null, 2));
}

// ──────────────────────────────────────────────────────────────────
// (a) string model normalization → { id }
// ──────────────────────────────────────────────────────────────────
describe('normalizeProviderModels — string → { id }', () => {
  it('maps a plain string to { id }', () => {
    const norm = normalizeProviderModels({ name: 'p', models: ['gpt-4'] });
    expect(norm).toEqual([{ id: 'gpt-4' }]);
  });

  it('skips empty strings', () => {
    const norm = normalizeProviderModels({ name: 'p', models: ['gpt-4', '', '   '] });
    expect(norm).toEqual([{ id: 'gpt-4' }]);
  });

  it('returns [] for missing / non-array models field', () => {
    expect(normalizeProviderModels({ name: 'p' })).toEqual([]);
    expect(normalizeProviderModels({ name: 'p', models: null })).toEqual([]);
    expect(normalizeProviderModels(null)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// (b) object model preserves contextWindow / maxOutput
// ──────────────────────────────────────────────────────────────────
describe('normalizeProviderModels — object preserves fields', () => {
  it('preserves id + contextWindow + maxOutput', () => {
    const norm = normalizeProviderModels({
      name: 'p',
      models: [{ id: 'gpt-5', contextWindow: 400000, maxOutput: 128000 }],
    });
    expect(norm).toEqual([{ id: 'gpt-5', contextWindow: 400000, maxOutput: 128000 }]);
  });

  it('drops invalid / empty / NaN values (treated as unset)', () => {
    const norm = normalizeProviderModels({
      name: 'p',
      models: [
        { id: 'a', contextWindow: 0, maxOutput: NaN },
        { id: 'b', contextWindow: '', maxOutput: null },
        { id: 'c', contextWindow: -5 },
      ],
    });
    expect(norm).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('skips object entries missing id', () => {
    const norm = normalizeProviderModels({
      name: 'p',
      models: [{ contextWindow: 1000 }, { id: 'ok' }],
    });
    expect(norm).toEqual([{ id: 'ok' }]);
  });

  it('coerces numeric strings', () => {
    const norm = normalizeProviderModels({
      name: 'p',
      models: [{ id: 'x', contextWindow: '8000', maxOutput: '2000' }],
    });
    expect(norm).toEqual([{ id: 'x', contextWindow: 8000, maxOutput: 2000 }]);
  });
});

// ──────────────────────────────────────────────────────────────────
// (c) provider override wins over MODEL_REGISTRY
// (d) undefined when both empty
// ──────────────────────────────────────────────────────────────────
describe('getModelInfo — override priority', () => {
  it('provider override wins over MODEL_REGISTRY', () => {
    const providerConfig = {
      id: 'gpt-5',
      contextWindow: 50000,
      maxOutput: 8000,
    };
    const info = getModelInfo('gpt-5', providerConfig);
    expect(info.contextWindow).toBe(50000);
    expect(info.maxOutput).toBe(8000);
  });

  it('falls back to MODEL_REGISTRY when no provider override', () => {
    const info = getModelInfo('gpt-5');
    // gpt-5 in registry has contextWindow 256000
    expect(info.contextWindow).toBe(256000);
  });

  it('uses registry for missing fields in providerConfig', () => {
    const info = getModelInfo('gpt-5', { id: 'gpt-5', contextWindow: 50000 });
    // maxOutput not overridden — comes from registry
    expect(info.contextWindow).toBe(50000);
    expect(info.maxOutput).toBe(16384); // gpt-5 registry maxOutputTokens
  });

  it('returns undefined when model unknown and no provider override has values', () => {
    expect(getModelInfo('totally-made-up-model')).toBeUndefined();
    expect(getModelInfo('totally-made-up-model', { id: 'totally-made-up-model' })).toBeUndefined();
  });

  it('returns info when model unknown but provider override supplies values', () => {
    const info = getModelInfo('custom-proxy-model', {
      id: 'custom-proxy-model',
      contextWindow: 32000,
      maxOutput: 4096,
    });
    expect(info).toBeTruthy();
    expect(info.contextWindow).toBe(32000);
    expect(info.maxOutput).toBe(4096);
  });

  it('returns undefined for null / empty model', () => {
    expect(getModelInfo(null)).toBeUndefined();
    expect(getModelInfo('')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// task-283 gpt-5 family registry — hardcoded limits removed
// ──────────────────────────────────────────────────────────────────
describe('MODEL_REGISTRY gpt-5 family — no hardcoded context/output', () => {
  it('gpt-5-mini has no contextWindow / maxOutputTokens', () => {
    const info = MODEL_REGISTRY.get('gpt-5-mini');
    expect(info).toBeTruthy();
    expect(info.contextWindow).toBeUndefined();
    expect(info.maxOutputTokens).toBeUndefined();
  });

  it('gpt-5-nano has no contextWindow / maxOutputTokens', () => {
    const info = MODEL_REGISTRY.get('gpt-5-nano');
    expect(info).toBeTruthy();
    expect(info.contextWindow).toBeUndefined();
    expect(info.maxOutputTokens).toBeUndefined();
  });

  it('gpt-5-pro has no contextWindow / maxOutputTokens', () => {
    const info = MODEL_REGISTRY.get('gpt-5-pro');
    expect(info).toBeTruthy();
    expect(info.contextWindow).toBeUndefined();
    expect(info.maxOutputTokens).toBeUndefined();
  });

  it('gpt-5 (base) still has hardcoded registry values', () => {
    // gpt-5 base entry has verified limits; only the unverified *-mini/-nano/-pro TODO entries were cleared
    const info = MODEL_REGISTRY.get('gpt-5');
    expect(info.contextWindow).toBe(256000);
  });
});

// ──────────────────────────────────────────────────────────────────
// loadConfig — availableModels composes from normalized providers
// ──────────────────────────────────────────────────────────────────
describe('loadConfig — availableModels normalization', () => {
  it('handles string model entries (back-compat)', () => {
    writeConfig({
      providers: [{ name: 'proxy', baseUrl: 'http://x/v1', apiKey: 'k', models: ['gpt-4'] }],
      primaryModel: 'proxy/gpt-4',
    });
    const cfg = loadConfig({ dir: TEST_DIR });
    expect(cfg.availableModels).toHaveLength(1);
    expect(cfg.availableModels[0].id).toBe('gpt-4');
    expect(cfg.availableModels[0].provider).toBe('proxy');
    // label must never be "[object Object]" — this is the bug that triggered (f) in the spec
    expect(cfg.availableModels[0].label).not.toBe('[object Object]');
    expect(cfg.availableModels[0].label).toBe('gpt-4');
  });

  it('handles object model entries with contextWindow + maxOutput', () => {
    writeConfig({
      providers: [{
        name: 'proxy',
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        models: [{ id: 'gpt-5', contextWindow: 400000, maxOutput: 128000 }],
      }],
      primaryModel: 'proxy/gpt-5',
    });
    const cfg = loadConfig({ dir: TEST_DIR });
    expect(cfg.availableModels).toHaveLength(1);
    expect(cfg.availableModels[0]).toMatchObject({
      id: 'gpt-5',
      provider: 'proxy',
      label: 'gpt-5',
      contextWindow: 400000,
      maxOutput: 128000,
    });
  });

  it('mixes string and object entries in one provider', () => {
    writeConfig({
      providers: [{
        name: 'proxy',
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        models: ['gpt-4', { id: 'gpt-5', contextWindow: 400000 }],
      }],
    });
    const cfg = loadConfig({ dir: TEST_DIR });
    expect(cfg.availableModels).toHaveLength(2);
    expect(cfg.availableModels[0]).toMatchObject({ id: 'gpt-4' });
    expect(cfg.availableModels[1]).toMatchObject({ id: 'gpt-5', contextWindow: 400000 });
    expect(cfg.availableModels[1].maxOutput).toBeUndefined();
  });

  it('dedupes models with the same id across providers (first wins)', () => {
    writeConfig({
      providers: [
        { name: 'a', baseUrl: 'http://a', apiKey: 'x', models: ['shared'] },
        { name: 'b', baseUrl: 'http://b', apiKey: 'y', models: ['shared'] },
      ],
    });
    const cfg = loadConfig({ dir: TEST_DIR });
    expect(cfg.availableModels).toHaveLength(1);
    expect(cfg.availableModels[0].provider).toBe('a');
  });
});

// ──────────────────────────────────────────────────────────────────
// (e) persistence back-compat
// ──────────────────────────────────────────────────────────────────
describe('updateLlmConfig — persistence back-compat', () => {
  it('writes id-only models as plain strings (back-compat)', () => {
    updateLlmConfig({
      providers: [{ name: 'p', baseUrl: 'http://x', apiKey: 'k', models: ['gpt-4', 'claude-3'] }],
    }, TEST_DIR);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.providers[0].models).toEqual(['gpt-4', 'claude-3']);
  });

  it('writes models with ctx/max as objects', () => {
    updateLlmConfig({
      providers: [{
        name: 'p', baseUrl: 'http://x', apiKey: 'k',
        models: [{ id: 'gpt-5', contextWindow: 400000, maxOutput: 128000 }],
      }],
    }, TEST_DIR);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.providers[0].models[0]).toEqual({
      id: 'gpt-5', contextWindow: 400000, maxOutput: 128000,
    });
  });

  it('downgrades object with only id to string', () => {
    updateLlmConfig({
      providers: [{
        name: 'p', baseUrl: 'http://x', apiKey: 'k',
        models: [{ id: 'plain-model' }],
      }],
    }, TEST_DIR);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.providers[0].models[0]).toBe('plain-model');
  });

  it('strips empty/0/NaN ctx or max when writing', () => {
    updateLlmConfig({
      providers: [{
        name: 'p', baseUrl: 'http://x', apiKey: 'k',
        models: [
          { id: 'a', contextWindow: 0, maxOutput: NaN },
          { id: 'b', contextWindow: '', maxOutput: null },
          { id: 'c', contextWindow: 400000, maxOutput: 0 },
        ],
      }],
    }, TEST_DIR);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(raw.providers[0].models[0]).toBe('a');          // all stripped → plain id
    expect(raw.providers[0].models[1]).toBe('b');
    expect(raw.providers[0].models[2]).toEqual({ id: 'c', contextWindow: 400000 }); // only ctx kept
  });

  it('round-trip preserves mixed string + object schemas', () => {
    const original = {
      providers: [{
        name: 'p', baseUrl: 'http://x', apiKey: 'k',
        models: ['gpt-4', { id: 'gpt-5', contextWindow: 400000 }],
      }],
    };
    updateLlmConfig(original, TEST_DIR);
    const fetched = getLlmConfig(TEST_DIR);
    expect(fetched.providers[0].models[0]).toBe('gpt-4');
    expect(fetched.providers[0].models[1]).toEqual({ id: 'gpt-5', contextWindow: 400000 });
  });
});

// ──────────────────────────────────────────────────────────────────
// (f) label regression: never `[object Object]`
// ──────────────────────────────────────────────────────────────────
describe('availableModels label — never [object Object]', () => {
  it('object entries produce proper id-based label', () => {
    writeConfig({
      providers: [{
        name: 'p', baseUrl: 'http://x', apiKey: 'k',
        models: [{ id: 'gpt-5', contextWindow: 400000 }],
      }],
    });
    const cfg = loadConfig({ dir: TEST_DIR });
    // The historical bug concatenated the object into a string.
    expect(String(cfg.availableModels[0].label)).not.toContain('[object Object]');
    expect(cfg.availableModels[0].label).toBe('gpt-5');
  });
});
