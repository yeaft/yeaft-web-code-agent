import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, parseFrontmatter, loadMCPConfig } from '../../../agent/unify/config.js';

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
  delete process.env.YEAFT_LANGUAGE;
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
  delete process.env.YEAFT_LANGUAGE;
});

// ═══════════════════════════════════════════════════════════════
// Legacy: parseFrontmatter
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// config.json — New Path
// ═══════════════════════════════════════════════════════════════

describe('loadConfig — config.json', () => {
  it('should read providers from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'my-proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['gpt-5', 'claude-sonnet-4-20250514'] },
      ],
      primaryModel: 'my-proxy/claude-sonnet-4-20250514',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe('my-proxy');
    expect(config.providers[0].models).toEqual(['gpt-5', 'claude-sonnet-4-20250514']);
  });

  it('should resolve primaryModel from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['claude-sonnet-4-20250514'] },
      ],
      primaryModel: 'proxy/claude-sonnet-4-20250514',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.primaryModel).toBe('proxy/claude-sonnet-4-20250514');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('should resolve fastModel from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['claude-sonnet-4-20250514', 'claude-haiku-3-20250414'] },
      ],
      primaryModel: 'proxy/claude-sonnet-4-20250514',
      fastModel: 'proxy/claude-haiku-3-20250414',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.fastModel).toBe('proxy/claude-haiku-3-20250414');
    expect(config.fastModelId).toBe('claude-haiku-3-20250414');
  });

  it('should use primaryModel as fastModel fallback', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['claude-sonnet-4-20250514'] },
      ],
      primaryModel: 'proxy/claude-sonnet-4-20250514',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.fastModel).toBe('proxy/claude-sonnet-4-20250514');
  });

  it('should read language from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      language: 'zh',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.language).toBe('zh');
  });

  it('should read debug from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      debug: true,
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.debug).toBe(true);
  });

  it('should apply overrides over config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      language: 'en',
      debug: false,
    }));

    const config = loadConfig({ dir: TEST_DIR, language: 'zh', debug: true });
    expect(config.language).toBe('zh');
    expect(config.debug).toBe(true);
  });

  it('should read maxContextTokens from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      maxContextTokens: 150000,
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.maxContextTokens).toBe(150000);
  });

  it('should read messageTokenBudget from config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
      messageTokenBudget: 16384,
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.messageTokenBudget).toBe(16384);
  });

  it('should set legacy fields to null when using config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.openaiApiKey).toBeNull();
    expect(config.proxyUrl).toBeNull();
    expect(config.baseUrl).toBeNull();
    expect(config.adapter).toBeNull();
  });

  it('should resolve modelInfo for known primaryModel', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'p', baseUrl: 'http://localhost/v1', apiKey: 'x', models: ['gpt-5'] },
      ],
      primaryModel: 'p/gpt-5',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.modelInfo).not.toBeNull();
    expect(config.modelInfo.displayName).toBe('GPT-5');
  });

  it('should handle malformed config.json gracefully', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), 'not valid json {{{');
    // Should fall back to legacy path
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.model).toBe('claude-sonnet-4-20250514'); // default
  });

  it('should handle empty config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), '{}');
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.providers).toBeNull();
    expect(config.model).toBe('claude-sonnet-4-20250514'); // default
    expect(config.language).toBe('en');
  });
});

// ═══════════════════════════════════════════════════════════════
// config.json takes priority over config.md
// ═══════════════════════════════════════════════════════════════

describe('loadConfig — config.json priority', () => {
  it('should prefer config.json over config.md', () => {
    // Both exist
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'p', baseUrl: 'http://x/v1', apiKey: 'y', models: ['gpt-5'] },
      ],
      primaryModel: 'p/gpt-5',
      language: 'zh',
    }));
    writeFileSync(join(TEST_DIR, 'config.md'), `---
model: deepseek-chat
language: en
---
`);

    const config = loadConfig({ dir: TEST_DIR });
    // config.json wins
    expect(config.model).toBe('gpt-5');
    expect(config.language).toBe('zh');
    expect(config.providers).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Legacy: loadConfig (config.md + .env)
// ═══════════════════════════════════════════════════════════════

describe('loadConfig — legacy (config.md)', () => {
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

  it('should auto-detect anthropic adapter from model registry', () => {
    const config = loadConfig({ dir: TEST_DIR, model: 'claude-sonnet-4-20250514' });
    expect(config.adapter).toBe('anthropic');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
  });

  it('should auto-detect openai adapter from model registry for gpt models', () => {
    const config = loadConfig({ dir: TEST_DIR, model: 'gpt-5' });
    expect(config.adapter).toBe('openai');
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('should set contextWindow and maxOutputTokens from model registry', () => {
    const config = loadConfig({ dir: TEST_DIR, model: 'gpt-4.1' });
    expect(config.maxContextTokens).toBe(1047576);
    expect(config.maxOutputTokens).toBe(32768);
  });

  it('should include modelInfo for known models', () => {
    const config = loadConfig({ dir: TEST_DIR, model: 'gpt-5' });
    expect(config.modelInfo).not.toBeNull();
    expect(config.modelInfo.displayName).toBe('GPT-5');
  });

  it('should default language to en', () => {
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.language).toBe('en');
  });

  it('should read language from YEAFT_LANGUAGE env var', () => {
    process.env.YEAFT_LANGUAGE = 'zh';
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.language).toBe('zh');
  });
});

// ═══════════════════════════════════════════════════════════════
// MCP Config
// ═══════════════════════════════════════════════════════════════

describe('loadMCPConfig', () => {
  it('should read mcpServers from config.json object', () => {
    const jsonConfig = {
      mcpServers: [
        { name: 'github', command: 'npx', args: ['@mcp/github'] },
      ],
    };

    const result = loadMCPConfig(TEST_DIR, jsonConfig);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('github');
  });

  it('should fall back to standalone mcp.json', () => {
    writeFileSync(join(TEST_DIR, 'mcp.json'), JSON.stringify({
      servers: [
        { name: 'fs', command: 'node', args: ['fs-server.js'] },
      ],
    }));

    const result = loadMCPConfig(TEST_DIR);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('fs');
  });

  it('should return empty when nothing configured', () => {
    const result = loadMCPConfig(TEST_DIR);
    expect(result.servers).toEqual([]);
  });

  it('should filter out servers without name or command', () => {
    const jsonConfig = {
      mcpServers: [
        { name: 'good', command: 'npx' },
        { name: 'missing-cmd' }, // no command
        { command: 'no-name' },  // no name
      ],
    };

    const result = loadMCPConfig(TEST_DIR, jsonConfig);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('good');
  });
});

// ═══════════════════════════════════════════════════════════════
// memoryV2 feature flag — DESIGN-v2 PR-E flipped the default to true
// ═══════════════════════════════════════════════════════════════

describe('loadConfig — memoryV2 flag', () => {
  it('defaults memoryV2 to true (config.json with no flag)', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
    }));
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.memoryV2).toBe(true);
  });

  it('honours explicit false in config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
      memoryV2: false,
    }));
    const config = loadConfig({ dir: TEST_DIR });
    expect(config.memoryV2).toBe(false);
  });

  it('override beats config.json', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
      memoryV2: false,
    }));
    const config = loadConfig({ dir: TEST_DIR, memoryV2: true });
    expect(config.memoryV2).toBe(true);
  });
});
