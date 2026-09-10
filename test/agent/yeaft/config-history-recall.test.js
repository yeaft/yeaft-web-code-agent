import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { clampYeaftField, loadConfig, normaliseYeaftSection } from '../../../agent/yeaft/config.js';
import { getYeaftSettings, updateLlmConfig, updateTelemetrySettings, updateYeaftSettings } from '../../../agent/yeaft/config-api.js';
import { DEFAULT_LIMITS } from '../../../agent/yeaft/dream/limits.js';

const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-config-history-recall-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Yeaft history bucket settings', () => {
  it('defaults to 20 recent and 5 related turns for absent and legacy config', () => {
    const root = tempRoot();
    const expected = {
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
      recentTurnsLimit: 20,
      relatedTurnsLimit: 5,
      dream: { ...DEFAULT_LIMITS },
    };
    expect(normaliseYeaftSection(null)).toEqual(expected);
    expect(getYeaftSettings(root)).toEqual(expected);
    expect(loadConfig({ dir: root }).yeaft).toEqual(expected);
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ providers: [], yeaft: { recentTurnsLimit: 40 } }));
    expect(getYeaftSettings(root)).toEqual({ ...expected, recentTurnsLimit: 40 });
    expect(loadConfig({ dir: root }).yeaft).toEqual({ ...expected, recentTurnsLimit: 40 });
  });

  it('normalizes reads with clamped bounds, numeric strings and integer flooring', () => {
    const root = tempRoot();
    for (const [value, expected] of [[0, 0], [1, 1], [5, 5], [8, 5], [10, 5], [-3, 0], [90, 5], [4.9, 4], ['7', 5], ['0', 0]]) {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ providers: [], yeaft: { relatedTurnsLimit: value } }));
      expect(clampYeaftField(value, 'relatedTurnsLimit')).toBe(expected);
      expect(getYeaftSettings(root).relatedTurnsLimit).toBe(expected);
      expect(loadConfig({ dir: root }).yeaft.relatedTurnsLimit).toBe(expected);
    }
    for (const value of [undefined, null, NaN, Infinity, 'invalid', '', ' ', false, true, [], {}]) {
      expect(clampYeaftField(value, 'relatedTurnsLimit')).toBeNull();
      expect(normaliseYeaftSection({ relatedTurnsLimit: value }).relatedTurnsLimit).toBe(5);
    }
    expect(normaliseYeaftSection({ recentTurnsLimit: 0 }).recentTurnsLimit).toBe(1);
    expect(normaliseYeaftSection({ recentTurnsLimit: 999 }).recentTurnsLimit).toBe(500);
  });

  it('persists valid writes and preserves zero through legacy and unrelated updates', () => {
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    const dream = { MAX_DREAM_PROMPT_CHARS: 32_000 };
    writeFileSync(configPath, JSON.stringify({ primaryModel: 'proxy/model', yeaft: { dream } }));
    for (const [value, expected] of [[5, 5], [1, 1], [4.9, 4], ['4', 4], ['0', 0], [0, 0]]) {
      expect(updateYeaftSettings({ relatedTurnsLimit: value }, root)).toEqual({
        maxConcurrentThreads: 6, autoArchiveIdleDays: 30, recentTurnsLimit: 20, relatedTurnsLimit: expected, dream,
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')).yeaft.relatedTurnsLimit).toBe(expected);
      expect(getYeaftSettings(root).relatedTurnsLimit).toBe(expected);
      expect(loadConfig({ dir: root }).yeaft.relatedTurnsLimit).toBe(expected);
    }
    expect(updateYeaftSettings({ recentTurnsLimit: 25, maxConcurrentThreads: 3, autoArchiveIdleDays: 40 }, root)).toEqual({
      maxConcurrentThreads: 3, autoArchiveIdleDays: 40, recentTurnsLimit: 25, relatedTurnsLimit: 0, dream,
    });
    expect(updateYeaftSettings({}, root).relatedTurnsLimit).toBe(0);
    expect(updateLlmConfig({ debug: true }, root).error).toBeUndefined();
    expect(updateTelemetrySettings({ enabled: false }, root).error).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      primaryModel: 'proxy/model', debug: true,
      yeaft: { recentTurnsLimit: 25, relatedTurnsLimit: 0, dream },
    });
    expect(updateYeaftSettings({ relatedTurnsLimit: 4 }, root).relatedTurnsLimit).toBe(4);
    expect(updateYeaftSettings({ maxConcurrentThreads: 4 }, root).relatedTurnsLimit).toBe(4);
  });

  it('rejects invalid writes before creating or changing config.json', () => {
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    const invalid = [-1, 6, 8, 10, 5.1, NaN, Infinity, 'invalid', null, false, true, '', ' ', [], {}];
    for (const value of invalid) {
      expect(updateYeaftSettings({ relatedTurnsLimit: value }, root)).toEqual({ error: 'relatedTurnsLimit must be between 0 and 5' });
      expect(existsSync(configPath)).toBe(false);
    }
    const original = JSON.stringify({ yeaft: { recentTurnsLimit: 31, relatedTurnsLimit: 7 } });
    writeFileSync(configPath, original);
    for (const value of invalid) {
      expect(updateYeaftSettings({ recentTurnsLimit: 22, relatedTurnsLimit: value }, root).error).toBeDefined();
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    }
    for (const value of [0, 501, 'invalid']) {
      expect(updateYeaftSettings({ recentTurnsLimit: value }, root).error).toBeDefined();
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    }
  });

  it('persists the default related limit when an old client creates the settings section', () => {
    const root = tempRoot();
    expect(updateYeaftSettings({ maxConcurrentThreads: 2 }, root)).toEqual({
      maxConcurrentThreads: 2, autoArchiveIdleDays: 30, recentTurnsLimit: 20, relatedTurnsLimit: 5,
    });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).yeaft.relatedTurnsLimit).toBe(5);
  });
});
