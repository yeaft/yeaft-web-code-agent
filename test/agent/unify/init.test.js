import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

  it('should create config.json with provider template', () => {
    initYeaftDir(TEST_DIR);
    const configPath = join(TEST_DIR, 'config.json');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.providers).toBeDefined();
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(parsed.providers[0].name).toBeDefined();
    expect(parsed.providers[0].baseUrl).toBeDefined();
    expect(parsed.providers[0].apiKey).toBeDefined();
    expect(parsed.providers[0].models).toBeDefined();
    expect(parsed.primaryModel).toBeDefined();
    expect(parsed.fastModel).toBeDefined();
    expect(parsed.language).toBe('en');
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

  it('should create mcp.json.example with server template', () => {
    initYeaftDir(TEST_DIR);
    const mcpExamplePath = join(TEST_DIR, 'mcp.json.example');
    expect(existsSync(mcpExamplePath)).toBe(true);

    const content = readFileSync(mcpExamplePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.servers).toBeDefined();
    expect(Array.isArray(parsed.servers)).toBe(true);
    expect(parsed.servers[0].name).toBe('example-github');
    expect(parsed.servers[0].command).toBe('npx');
  });

  it('should NOT create config.md (legacy)', () => {
    initYeaftDir(TEST_DIR);
    expect(existsSync(join(TEST_DIR, 'config.md'))).toBe(false);
  });

  it('should NOT create .env.example (legacy)', () => {
    initYeaftDir(TEST_DIR);
    expect(existsSync(join(TEST_DIR, '.env.example'))).toBe(false);
  });

  it('should not overwrite existing config.json', () => {
    // User has a custom config.json
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ language: 'zh' }));

    initYeaftDir(TEST_DIR);

    // Should NOT overwrite
    const content = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf8'));
    expect(content.language).toBe('zh');
    expect(content.providers).toBeUndefined(); // user's custom, not the default
  });

  it('should be idempotent — second call does not overwrite files', () => {
    initYeaftDir(TEST_DIR);
    const result2 = initYeaftDir(TEST_DIR);
    // Second call creates nothing (all already exists)
    expect(result2.created).toEqual([]);
  });
});
