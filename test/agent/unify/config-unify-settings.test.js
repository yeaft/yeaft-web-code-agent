/**
 * config-unify-settings.test.js — task-318.
 *
 * Covers getUnifySettings / updateUnifySettings round-trip, clamp
 * validation, and that writes preserve other config fields (LLM
 * providers, primaryModel, etc.) untouched.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getUnifySettings, updateUnifySettings } from '../../../agent/unify/config-api.js';
import { normaliseUnifySection } from '../../../agent/unify/config.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-unify-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('normaliseUnifySection', () => {
  it('returns defaults for null / undefined / malformed input', () => {
    expect(normaliseUnifySection(null)).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
    });
    expect(normaliseUnifySection(undefined)).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
    });
    expect(normaliseUnifySection('nope')).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
    });
  });

  it('clamps out-of-range numeric values (rather than reverting to default)', () => {
    expect(normaliseUnifySection({ maxConcurrentThreads: 0 }).maxConcurrentThreads).toBe(1);
    expect(normaliseUnifySection({ maxConcurrentThreads: 100 }).maxConcurrentThreads).toBe(50);
    expect(normaliseUnifySection({ autoArchiveIdleDays: 0 }).autoArchiveIdleDays).toBe(1);
    expect(normaliseUnifySection({ autoArchiveIdleDays: 5000 }).autoArchiveIdleDays).toBe(3650);
  });

  it('non-numeric values fall through to defaults (treated as "not set")', () => {
    expect(normaliseUnifySection({ maxConcurrentThreads: 'nope' }).maxConcurrentThreads).toBe(6);
    expect(normaliseUnifySection({ autoArchiveIdleDays: null }).autoArchiveIdleDays).toBe(30);
  });

  it('accepts valid values', () => {
    expect(normaliseUnifySection({ maxConcurrentThreads: 10, autoArchiveIdleDays: 7 })).toEqual({
      maxConcurrentThreads: 10,
      autoArchiveIdleDays: 7,
    });
  });
});

describe('getUnifySettings', () => {
  it('returns defaults when no config.json exists', () => {
    const settings = getUnifySettings(TEST_DIR);
    expect(settings).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
    });
  });

  it('reads nested unify section when present', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      unify: { maxConcurrentThreads: 12, autoArchiveIdleDays: 14 },
    }));
    const settings = getUnifySettings(TEST_DIR);
    expect(settings.maxConcurrentThreads).toBe(12);
    expect(settings.autoArchiveIdleDays).toBe(14);
  });

  it('falls back to defaults when unify section is missing', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'openai', baseUrl: 'x', apiKey: 'y', models: ['m'] }],
    }));
    const settings = getUnifySettings(TEST_DIR);
    expect(settings.maxConcurrentThreads).toBe(6);
    expect(settings.autoArchiveIdleDays).toBe(30);
  });
});

describe('updateUnifySettings', () => {
  it('rejects out-of-range maxConcurrentThreads', () => {
    const res = updateUnifySettings({ maxConcurrentThreads: 999 }, TEST_DIR);
    expect(res.error).toMatch(/maxConcurrentThreads/);
  });

  it('rejects out-of-range autoArchiveIdleDays', () => {
    const res = updateUnifySettings({ autoArchiveIdleDays: 99999 }, TEST_DIR);
    expect(res.error).toMatch(/autoArchiveIdleDays/);
  });

  it('writes valid values and round-trips through getUnifySettings', () => {
    const res = updateUnifySettings({ maxConcurrentThreads: 8, autoArchiveIdleDays: 14 }, TEST_DIR);
    expect(res.error).toBeUndefined();
    expect(res.maxConcurrentThreads).toBe(8);
    expect(res.autoArchiveIdleDays).toBe(14);

    const roundTrip = getUnifySettings(TEST_DIR);
    expect(roundTrip.maxConcurrentThreads).toBe(8);
    expect(roundTrip.autoArchiveIdleDays).toBe(14);
  });

  it('preserves other top-level config fields (providers, primaryModel)', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'openai', baseUrl: 'https://x', apiKey: 'sk', models: ['gpt-5'] }],
      primaryModel: 'openai/gpt-5',
      fastModel: 'openai/gpt-5',
      language: 'zh-CN',
    }));
    const res = updateUnifySettings({ maxConcurrentThreads: 10 }, TEST_DIR);
    expect(res.error).toBeUndefined();

    const disk = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(disk.providers).toHaveLength(1);
    expect(disk.providers[0].name).toBe('openai');
    expect(disk.primaryModel).toBe('openai/gpt-5');
    expect(disk.language).toBe('zh-CN');
    expect(disk.unify.maxConcurrentThreads).toBe(10);
    // Default applied for unspecified field
    expect(disk.unify.autoArchiveIdleDays).toBe(30);
  });

  it('partial update preserves prior unify field', () => {
    updateUnifySettings({ maxConcurrentThreads: 7, autoArchiveIdleDays: 60 }, TEST_DIR);
    const res2 = updateUnifySettings({ autoArchiveIdleDays: 90 }, TEST_DIR);
    expect(res2.maxConcurrentThreads).toBe(7);
    expect(res2.autoArchiveIdleDays).toBe(90);
  });

  it('rejects missing payload', () => {
    expect(updateUnifySettings(null, TEST_DIR).error).toBeTruthy();
    expect(updateUnifySettings(undefined, TEST_DIR).error).toBeTruthy();
  });
});
