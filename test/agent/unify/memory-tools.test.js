/**
 * memory-tools.test.js — task-287 memory_search + memory_query tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import memorySearch from '../../../agent/unify/tools/memory-search.js';
import memoryQuery from '../../../agent/unify/tools/memory-query.js';
import { writeMemoryFile, ensureLayout } from '../../../agent/unify/memory/layout.js';
import { MemoryStore } from '../../../agent/unify/memory/store.js';

let TEST_DIR;

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `yeaft-mem-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_DIR, { recursive: true });
  ensureLayout(TEST_DIR);
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── memory_search (path-based file loader) ────────────────

describe('memory_search tool', () => {
  it('has correct name and required paths param', () => {
    expect(memorySearch.name).toBe('memory_search');
    expect(memorySearch.parameters.required).toContain('paths');
  });

  it('loads a classification file by path', async () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', '# User Preferences\n\n- Likes dark mode\n');
    const out = await memorySearch.execute(
      { paths: ['user-preferences.md'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].path).toBe('user-preferences.md');
    expect(parsed.results[0].content).toContain('dark mode');
  });

  it('loads multiple files', async () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', 'prefs');
    writeMemoryFile(TEST_DIR, 'by-project/foo.md', 'foo project');
    const out = await memorySearch.execute(
      { paths: ['user-preferences.md', 'by-project/foo.md'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toHaveLength(2);
  });

  it('rejects paths with ..', async () => {
    const out = await memorySearch.execute(
      { paths: ['../../../etc/passwd'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0].error).toMatch(/\.\./);
  });

  it('rejects absolute paths', async () => {
    const out = await memorySearch.execute(
      { paths: ['/etc/passwd'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('rejects non-md files', async () => {
    const out = await memorySearch.execute(
      { paths: ['something.json'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.errors[0].error).toMatch(/\.md/);
  });

  it('reports missing files as errors', async () => {
    const out = await memorySearch.execute(
      { paths: ['nonexistent.md'] },
      { yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.errors[0].error).toMatch(/not found/);
  });

  it('errors when yeaftDir missing', async () => {
    const out = await memorySearch.execute({ paths: ['x.md'] }, {});
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/not initialized/);
  });

  it('errors when paths empty and lists available paths', async () => {
    writeMemoryFile(TEST_DIR, 'user-preferences.md', 'prefs');
    const out = await memorySearch.execute({ paths: [] }, { yeaftDir: TEST_DIR });
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/required/);
    expect(parsed.availablePaths).toContain('user-preferences.md');
  });
});

// ─── memory_query (fuzzy atomic search) ───────────────────

describe('memory_query tool', () => {
  it('has correct name and required keywords param', () => {
    expect(memoryQuery.name).toBe('memory_query');
    expect(memoryQuery.parameters.required).toContain('keywords');
  });

  it('searches by keywords and returns matching entries', async () => {
    const store = new MemoryStore(TEST_DIR);
    store.writeEntry({
      name: 'prefers-typescript',
      kind: 'preference',
      scope: 'global',
      tags: ['typescript', 'lang'],
      content: 'User prefers TypeScript over plain JavaScript.',
      importance: 5,
    });
    store.writeEntry({
      name: 'unrelated',
      kind: 'fact',
      scope: 'global',
      tags: ['random'],
      content: 'The sky is blue.',
      importance: 2,
    });

    const out = await memoryQuery.execute(
      { keywords: ['typescript'] },
      { memoryStore: store, yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.totalResults).toBeGreaterThanOrEqual(1);
    expect(parsed.results.some(r => r.name === 'prefers-typescript')).toBe(true);
  });

  it('errors when memoryStore missing', async () => {
    const out = await memoryQuery.execute({ keywords: ['x'] }, {});
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/not initialized/);
  });

  it('errors when keywords empty', async () => {
    const store = new MemoryStore(TEST_DIR);
    const out = await memoryQuery.execute({ keywords: [] }, { memoryStore: store });
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/required/);
  });

  it('respects limit parameter', async () => {
    const store = new MemoryStore(TEST_DIR);
    for (let i = 0; i < 15; i++) {
      store.writeEntry({
        name: `entry-${i}`,
        kind: 'fact',
        scope: 'global',
        tags: ['common'],
        content: `Fact number ${i}`,
        importance: 3,
      });
    }
    const out = await memoryQuery.execute(
      { keywords: ['common'], limit: 5 },
      { memoryStore: store, yeaftDir: TEST_DIR },
    );
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeLessThanOrEqual(5);
  });
});
