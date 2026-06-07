/**
 * config-yeaft-settings.test.js — task-318.
 *
 * Covers getYeaftSettings / updateYeaftSettings round-trip, clamp
 * validation, and that writes preserve other config fields (LLM
 * providers, primaryModel, etc.) untouched.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getYeaftSettings, updateYeaftSettings } from '../../../agent/yeaft/config-api.js';
import { normaliseYeaftSection } from '../../../agent/yeaft/config.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-yeaft-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('normaliseYeaftSection', () => {
  it('returns defaults for null / undefined / malformed input', () => {
    expect(normaliseYeaftSection(null)).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
      recentTurnsLimit: 20,
    });
    expect(normaliseYeaftSection(undefined)).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
      recentTurnsLimit: 20,
    });
    expect(normaliseYeaftSection('nope')).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
      recentTurnsLimit: 20,
    });
  });

  it('clamps out-of-range numeric values (rather than reverting to default)', () => {
    expect(normaliseYeaftSection({ maxConcurrentThreads: 0 }).maxConcurrentThreads).toBe(1);
    expect(normaliseYeaftSection({ maxConcurrentThreads: 100 }).maxConcurrentThreads).toBe(50);
    expect(normaliseYeaftSection({ autoArchiveIdleDays: 0 }).autoArchiveIdleDays).toBe(1);
    expect(normaliseYeaftSection({ autoArchiveIdleDays: 5000 }).autoArchiveIdleDays).toBe(3650);
    // recentTurnsLimit clamps to [1, 500].
    expect(normaliseYeaftSection({ recentTurnsLimit: 0 }).recentTurnsLimit).toBe(1);
    expect(normaliseYeaftSection({ recentTurnsLimit: 9999 }).recentTurnsLimit).toBe(500);
  });

  it('non-numeric values fall through to defaults (treated as "not set")', () => {
    expect(normaliseYeaftSection({ maxConcurrentThreads: 'nope' }).maxConcurrentThreads).toBe(6);
    expect(normaliseYeaftSection({ autoArchiveIdleDays: null }).autoArchiveIdleDays).toBe(30);
    expect(normaliseYeaftSection({ recentTurnsLimit: 'nope' }).recentTurnsLimit).toBe(20);
  });

  it('accepts valid values', () => {
    expect(normaliseYeaftSection({
      maxConcurrentThreads: 10,
      autoArchiveIdleDays: 7,
      recentTurnsLimit: 50,
    })).toEqual({
      maxConcurrentThreads: 10,
      autoArchiveIdleDays: 7,
      recentTurnsLimit: 50,
    });
  });
});

describe('getYeaftSettings', () => {
  it('returns defaults when no config.json exists', () => {
    const settings = getYeaftSettings(TEST_DIR);
    expect(settings).toEqual({
      maxConcurrentThreads: 6,
      autoArchiveIdleDays: 30,
      recentTurnsLimit: 20,
    });
  });

  it('reads nested yeaft section when present', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      yeaft: { maxConcurrentThreads: 12, autoArchiveIdleDays: 14 },
    }));
    const settings = getYeaftSettings(TEST_DIR);
    expect(settings.maxConcurrentThreads).toBe(12);
    expect(settings.autoArchiveIdleDays).toBe(14);
  });

  it('falls back to defaults when yeaft section is missing', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'openai', baseUrl: 'x', apiKey: 'y', models: ['m'] }],
    }));
    const settings = getYeaftSettings(TEST_DIR);
    expect(settings.maxConcurrentThreads).toBe(6);
    expect(settings.autoArchiveIdleDays).toBe(30);
  });
});

describe('updateYeaftSettings', () => {
  it('rejects out-of-range maxConcurrentThreads', () => {
    const res = updateYeaftSettings({ maxConcurrentThreads: 999 }, TEST_DIR);
    expect(res.error).toMatch(/maxConcurrentThreads/);
  });

  it('rejects out-of-range autoArchiveIdleDays', () => {
    const res = updateYeaftSettings({ autoArchiveIdleDays: 99999 }, TEST_DIR);
    expect(res.error).toMatch(/autoArchiveIdleDays/);
  });

  it('writes valid values and round-trips through getYeaftSettings', () => {
    const res = updateYeaftSettings({ maxConcurrentThreads: 8, autoArchiveIdleDays: 14 }, TEST_DIR);
    expect(res.error).toBeUndefined();
    expect(res.maxConcurrentThreads).toBe(8);
    expect(res.autoArchiveIdleDays).toBe(14);

    const roundTrip = getYeaftSettings(TEST_DIR);
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
    const res = updateYeaftSettings({ maxConcurrentThreads: 10 }, TEST_DIR);
    expect(res.error).toBeUndefined();

    const disk = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(disk.providers).toHaveLength(1);
    expect(disk.providers[0].name).toBe('openai');
    expect(disk.primaryModel).toBe('openai/gpt-5');
    expect(disk.language).toBe('zh-CN');
    expect(disk.yeaft.maxConcurrentThreads).toBe(10);
    // Default applied for unspecified field
    expect(disk.yeaft.autoArchiveIdleDays).toBe(30);
  });

  it('partial update preserves prior yeaft field', () => {
    updateYeaftSettings({ maxConcurrentThreads: 7, autoArchiveIdleDays: 60 }, TEST_DIR);
    const res2 = updateYeaftSettings({ autoArchiveIdleDays: 90 }, TEST_DIR);
    expect(res2.maxConcurrentThreads).toBe(7);
    expect(res2.autoArchiveIdleDays).toBe(90);
  });

  it('rejects missing payload', () => {
    expect(updateYeaftSettings(null, TEST_DIR).error).toBeTruthy();
    expect(updateYeaftSettings(undefined, TEST_DIR).error).toBeTruthy();
  });
});
