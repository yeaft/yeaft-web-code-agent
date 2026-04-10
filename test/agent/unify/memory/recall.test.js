import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractKeywords, computeFingerprint, recall, clearRecallCache } from '../../../../agent/unify/memory/recall.js';
import { MemoryStore } from '../../../../agent/unify/memory/store.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-recall-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  clearRecallCache();
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── extractKeywords ────────────────────────────────────────────

describe('extractKeywords', () => {
  it('should extract keywords from English text', () => {
    const keywords = extractKeywords('How do I use TypeScript generics with React components?');
    expect(keywords).toContain('typescript');
    expect(keywords).toContain('generics');
    expect(keywords).toContain('react');
    expect(keywords).toContain('components');
    // Should not contain stop words
    expect(keywords).not.toContain('how');
    expect(keywords).not.toContain('do');
    expect(keywords).not.toContain('with');
  });

  it('should extract keywords from Chinese text', () => {
    const keywords = extractKeywords('帮我修一下 auth 模块的 null check');
    expect(keywords).toContain('auth');
    expect(keywords).toContain('null');
    expect(keywords).toContain('check');
    // Stop words filtered
    expect(keywords).not.toContain('帮');
    expect(keywords).not.toContain('帮我');
  });

  it('should sort by frequency', () => {
    const keywords = extractKeywords('typescript typescript typescript react');
    expect(keywords[0]).toBe('typescript');
  });

  it('should return empty for empty input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('should handle single word (too short)', () => {
    // Single-char words are filtered (length > 1)
    expect(extractKeywords('a b c')).toEqual([]);
  });
});

// ─── computeFingerprint ────────────────────────────────────────

describe('computeFingerprint', () => {
  it('should produce a hex string', () => {
    const fp = computeFingerprint({ keywords: ['typescript', 'generics'] });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should produce same fingerprint for same input', () => {
    const fp1 = computeFingerprint({ scope: 'tech/ts', keywords: ['a', 'b'] });
    const fp2 = computeFingerprint({ scope: 'tech/ts', keywords: ['a', 'b'] });
    expect(fp1).toBe(fp2);
  });

  it('should produce different fingerprint for different input', () => {
    const fp1 = computeFingerprint({ keywords: ['a', 'b'] });
    const fp2 = computeFingerprint({ keywords: ['c', 'd'] });
    expect(fp1).not.toBe(fp2);
  });

  it('should only use top 5 keywords', () => {
    const fp1 = computeFingerprint({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const fp2 = computeFingerprint({ keywords: ['a', 'b', 'c', 'd', 'e', 'g'] });
    // Same top 5 → same fingerprint
    expect(fp1).toBe(fp2);
  });
});

// ─── recall (Steps 1-2, no LLM) ────────────────────────────────

describe('recall', () => {
  let memoryStore;

  // Mock adapter that never gets called (we stay under MAX_RECALL_RESULTS)
  const mockAdapter = {
    call: async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } }),
  };
  const mockConfig = { model: 'test-model' };

  beforeEach(() => {
    memoryStore = new MemoryStore(TEST_DIR);
    // Seed some entries
    memoryStore.writeEntry({ name: 'TS Generics', kind: 'skill', scope: 'tech/typescript', tags: ['typescript', 'generics'], content: 'TS generics patterns' });
    memoryStore.writeEntry({ name: 'Auth Bug Fix', kind: 'lesson', scope: 'work/project/auth', tags: ['auth', 'bugfix', 'typescript'], content: 'Auth null check fix' });
    memoryStore.writeEntry({ name: 'Dark Mode Pref', kind: 'preference', scope: 'global', tags: ['ui', 'dark-mode'], content: 'User prefers dark mode' });
  });

  it('should recall relevant entries for a TypeScript query', async () => {
    const result = await recall({
      prompt: 'How do TypeScript generics work?',
      adapter: mockAdapter,
      config: mockConfig,
      memoryStore,
    });

    expect(result.keywords).toContain('typescript');
    expect(result.keywords).toContain('generics');
    expect(result.entries.length).toBeGreaterThan(0);
    // TS Generics should be the top match
    expect(result.entries.some(e => e.name === 'TS Generics')).toBe(true);
  });

  it('should return empty for irrelevant query', async () => {
    const result = await recall({
      prompt: 'What is the weather today?',
      adapter: mockAdapter,
      config: mockConfig,
      memoryStore,
    });

    // 'weather' and 'today' won't match any tags
    expect(result.entries).toHaveLength(0);
  });

  it('should cache results with same fingerprint', async () => {
    const r1 = await recall({ prompt: 'typescript generics', adapter: mockAdapter, config: mockConfig, memoryStore });
    const r2 = await recall({ prompt: 'typescript generics', adapter: mockAdapter, config: mockConfig, memoryStore });

    expect(r2.cached).toBe(true);
    expect(r2.fingerprint).toBe(r1.fingerprint);
  });

  it('should return different results for different queries', async () => {
    const r1 = await recall({ prompt: 'typescript generics', adapter: mockAdapter, config: mockConfig, memoryStore });
    const r2 = await recall({ prompt: 'auth bugfix null', adapter: mockAdapter, config: mockConfig, memoryStore });

    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('should return empty for empty prompt', async () => {
    const result = await recall({ prompt: '', adapter: mockAdapter, config: mockConfig, memoryStore });
    expect(result.entries).toHaveLength(0);
    expect(result.keywords).toHaveLength(0);
  });
});
