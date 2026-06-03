/**
 * Tests for agent/yeaft/llm/models-dev.js — layered cache fetcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { fetchModelsDev, listProviders, listProviderModels, _resetMemCache } from '../../agent/yeaft/llm/models-dev.js';

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
