/**
 * Tests for agent/yeaft/llm/models-dev.js — layered cache fetcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { fetchModelsDev, listProviders, listProviderModels, _resetMemCache, _setMemCacheForTest, lookupModelLimitSync } from '../../agent/yeaft/llm/models-dev.js';

const SAMPLE = {
  anthropic: { name: 'Anthropic', api: 'https://api.anthropic.com', models: { 'claude-sonnet': {}, 'claude-haiku': {} } },
  openai: { name: 'OpenAI', api: 'https://api.openai.com/v1', models: { 'gpt-5': {} } },
};

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'models-dev-test-'));
  _resetMemCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  _resetMemCache();
});

describe('fetchModelsDev', () => {
  it('serves from a fresh disk cache without hitting the network', async () => {
    writeFileSync(join(tmpDir, 'models_dev_cache.json'), JSON.stringify(SAMPLE));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const data = await fetchModelsDev({ yeaftDir: tmpDir });
    expect(data).toEqual(SAMPLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to stale disk cache when network fails', async () => {
    writeFileSync(join(tmpDir, 'models_dev_cache.json'), JSON.stringify(SAMPLE));
    // Age the disk cache past TTL so stage 2 (fresh disk) is skipped.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(tmpDir, 'models_dev_cache.json'), past, past);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const data = await fetchModelsDev({ yeaftDir: tmpDir });
    expect(data).toEqual(SAMPLE);
  });

  it('hits the network and persists to disk on a cold cache', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE,
    });

    const data = await fetchModelsDev({ yeaftDir: tmpDir, forceRefresh: true });
    expect(data).toEqual(SAMPLE);
    expect(fetchMock).toHaveBeenCalledWith('https://models.dev/api.json', expect.any(Object));
    // Persisted to disk
    expect(existsSync(join(tmpDir, 'models_dev_cache.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(tmpDir, 'models_dev_cache.json'), 'utf8'))).toEqual(SAMPLE);
  });

  it('does not reuse the in-memory cache across yeaftDir overrides', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'models-dev-test-other-'));
    try {
      writeFileSync(join(tmpDir, 'models_dev_cache.json'), JSON.stringify(SAMPLE));
      writeFileSync(join(otherDir, 'models_dev_cache.json'), JSON.stringify({ local: { models: { 'local-model': {} } } }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      expect(await listProviders({ yeaftDir: tmpDir })).toEqual(['anthropic', 'openai']);
      expect(await listProviders({ yeaftDir: otherDir })).toEqual(['local']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('listProviders and listProviderModels read from the cache', async () => {
    writeFileSync(join(tmpDir, 'models_dev_cache.json'), JSON.stringify(SAMPLE));
    // Belt-and-suspenders: if stage-2 (fresh disk cache) ever short-circuits
    // for an unexpected reason on CI (clock skew, FS oddity), the mock
    // guarantees we don't hit the real models.dev and pull in 140 providers.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked in test'));

    expect(await listProviders({ yeaftDir: tmpDir })).toEqual(['anthropic', 'openai']);
    expect(await listProviderModels('anthropic', { yeaftDir: tmpDir })).toEqual(['claude-sonnet', 'claude-haiku']);
    expect(await listProviderModels('missing', { yeaftDir: tmpDir })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Snapshot with collisions: `qwen3-32b` appears under three providers with
// different context windows. This mirrors the real models.dev behavior (520+
// collisions in the live data) and exercises the MIN policy in
// `lookupModelLimitSync`.
const COLLISION_SNAPSHOT = {
  anthropic: {
    models: {
      'claude-sonnet': { limit: { context: 200_000, output: 64_000 } },
    },
  },
  openai: {
    models: {
      'gpt-5': { limit: { context: 400_000, output: 128_000 } },
    },
  },
  cerebras: {
    models: {
      'qwen3-32b': { limit: { context: 32_000, output: 16_000 } },
    },
  },
  groq: {
    models: {
      'qwen3-32b': { limit: { context: 64_000, output: 8_000 } },
    },
  },
  fireworks: {
    models: {
      'qwen3-32b': { limit: { context: 131_072, output: 4_096 } },
    },
  },
};

describe('lookupModelLimitSync', () => {
  beforeEach(() => {
    _setMemCacheForTest(COLLISION_SNAPSHOT);
  });

  it('returns the exact provider entry when a matching hint is given', () => {
    const limit = lookupModelLimitSync('claude-sonnet', 'anthropic');
    expect(limit).toEqual({ context: 200_000, output: 64_000 });
  });

  it('returns the MIN across all providers when no hint is given', () => {
    // 32K / 64K / 131K → MIN = 32K; 16K / 8K / 4K → MIN = 4K. The two axes
    // are computed independently and the MIN winner can differ between them.
    const limit = lookupModelLimitSync('qwen3-32b');
    expect(limit).toEqual({ context: 32_000, output: 4_096 });
  });

  it('falls through to MIN scan when the hint misses but the model lives elsewhere', () => {
    // Hint says 'anthropic' which doesn't list qwen3-32b. We do NOT return
    // null — we scan every provider and use MIN like the no-hint case.
    const limit = lookupModelLimitSync('qwen3-32b', 'anthropic');
    expect(limit).toEqual({ context: 32_000, output: 4_096 });
  });

  it('returns null when the model is absent from every provider', () => {
    expect(lookupModelLimitSync('totally-unknown-model')).toBeNull();
    expect(lookupModelLimitSync('totally-unknown-model', 'openai')).toBeNull();
  });

  it('returns null when the cache is empty', () => {
    _resetMemCache();
    expect(lookupModelLimitSync('gpt-5', 'openai')).toBeNull();
  });

  it('returns null for falsy model id even with a populated cache', () => {
    expect(lookupModelLimitSync('', 'openai')).toBeNull();
    expect(lookupModelLimitSync(null, 'openai')).toBeNull();
  });
});
