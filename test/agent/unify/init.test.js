import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initYeaftDir } from '../../../agent/unify/init.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-init-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('initYeaftDir', () => {
  it('should create the root directory and all subdirectories', () => {
    const result = initYeaftDir(TEST_DIR);
    expect(result.dir).toBe(TEST_DIR);
    expect(result.created.length).toBeGreaterThan(0);
    expect(existsSync(TEST_DIR)).toBe(true);

    // Check all required subdirectories
    const expected = [
      'conversation/messages',
      'conversation/cold',
      'conversation/blobs',
      'memory/entries',
      'tasks',
      'dream',
      'skills',
    ];
    for (const sub of expected) {
      expect(existsSync(join(TEST_DIR, sub))).toBe(true);
    }
  });

  it('should create default config.md with YAML frontmatter', () => {
    initYeaftDir(TEST_DIR);
    const configPath = join(TEST_DIR, 'config.md');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('---');
    expect(content).toContain('model: claude-sonnet-4-20250514');
    expect(content).toContain('debug: false');
  });

  it('should create default MEMORY.md', () => {
    initYeaftDir(TEST_DIR);
    const memoryPath = join(TEST_DIR, 'memory', 'MEMORY.md');
    expect(existsSync(memoryPath)).toBe(true);

    const content = readFileSync(memoryPath, 'utf8');
    expect(content).toContain('# Yeaft Memory');
  });

  it('should create default conversation/index.md', () => {
    initYeaftDir(TEST_DIR);
    const indexPath = join(TEST_DIR, 'conversation', 'index.md');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf8');
    expect(content).toContain('# Conversation Index');
  });

  it('should be idempotent — second call does not overwrite files', () => {
    initYeaftDir(TEST_DIR);
    const result2 = initYeaftDir(TEST_DIR);
    // Second call creates nothing (all already exists)
    expect(result2.created).toEqual([]);
  });
});
