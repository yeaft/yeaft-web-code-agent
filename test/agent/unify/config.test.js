import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, parseFrontmatter } from '../../../agent/unify/config.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-config-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear relevant env vars
  delete process.env.YEAFT_MODEL;
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
  delete process.env.YEAFT_ADAPTER;
  delete process.env.YEAFT_DEBUG;
  delete process.env.YEAFT_DIR;
  delete process.env.YEAFT_BASE_URL;
  delete process.env.YEAFT_FALLBACK_MODEL;
  delete process.env.YEAFT_MAX_CONTEXT;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  // Re-clear env vars
  delete process.env.YEAFT_MODEL;
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
  delete process.env.YEAFT_ADAPTER;
  delete process.env.YEAFT_DEBUG;
  delete process.env.YEAFT_DIR;
  delete process.env.YEAFT_BASE_URL;
  delete process.env.YEAFT_FALLBACK_MODEL;
  delete process.env.YEAFT_MAX_CONTEXT;
});

describe('parseFrontmatter', () => {
  it('should parse YAML frontmatter', () => {
    const content = `---
model: gpt-5
debug: true
maxContextTokens: 100000
---

# Some markdown`;
    const result = parseFrontmatter(content);
    expect(result.model).toBe('gpt-5');
    expect(result.debug).toBe(true);
    expect(result.maxContextTokens).toBe(100000);
  });

  it('should return empty object if no frontmatter', () => {
    const result = parseFrontmatter('# Just markdown');
    expect(result).toEqual({});
  });

  it('should handle null values', () => {
    const content = `---
apiKey: null
---`;
    const result = parseFrontmatter(content);
    expect(result.apiKey).toBe(null);
  });
});

describe('loadConfig', () => {
  it('should return defaults when no config file or env vars', () => {
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.debug).toBe(false);
    expect(config.maxContextTokens).toBe(200000);
    expect(config.dir).toBe(TEST_DIR);
  });

  it('should read config from config.md', () => {
    writeFileSync(join(TEST_DIR, 'config.md'), `---
model: gpt-5
debug: true
---
`);
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.model).toBe('gpt-5');
    expect(config.debug).toBe(true);
  });

  it('should override config.md with env vars', () => {
    writeFileSync(join(TEST_DIR, 'config.md'), `---
model: gpt-5
---
`);
    process.env.YEAFT_MODEL = 'claude-opus-4';
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.model).toBe('claude-opus-4');
  });

  it('should override env vars with CLI overrides', () => {
    process.env.YEAFT_MODEL = 'gpt-5';
    const config = loadConfig({ dir: TEST_DIR, model: 'deepseek-chat' });
    expect(config.model).toBe('deepseek-chat');
  });

  it('should auto-detect anthropic adapter when apiKey is set', () => {
    const config = loadConfig({ dir: TEST_DIR, apiKey: 'sk-ant-test' });
    expect(config.adapter).toBe('anthropic');
  });

  it('should auto-detect openai adapter when openaiApiKey is set', () => {
    const config = loadConfig({ dir: TEST_DIR, openaiApiKey: 'sk-test' });
    expect(config.adapter).toBe('openai');
  });

  it('should auto-detect proxy adapter when proxyUrl is set', () => {
    const config = loadConfig({ dir: TEST_DIR });
    // Default proxyUrl is http://localhost:6628, so adapter should be 'proxy'
    expect(config.adapter).toBe('proxy');
  });

  it('should parse YEAFT_DEBUG env var', () => {
    process.env.YEAFT_DEBUG = '1';
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.debug).toBe(true);
  });

  it('should include fallbackModel', () => {
    process.env.YEAFT_FALLBACK_MODEL = 'gpt-5';
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.fallbackModel).toBe('gpt-5');
  });

  it('should include maxContextTokens from env', () => {
    process.env.YEAFT_MAX_CONTEXT = '150000';
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.maxContextTokens).toBe(150000);
  });
});
