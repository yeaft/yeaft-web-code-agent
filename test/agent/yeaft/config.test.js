import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, parseFrontmatter, loadMCPConfig, loadProjectMCPServers } from '../../../agent/yeaft/config.js';
import { resolveContextWindow, resolveMaxOutputTokens } from '../../../agent/yeaft/models.js';
import { _resetMemCache, _setMemCacheForTest } from '../../../agent/yeaft/llm/models-dev.js';

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
  _resetMemCache();
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

  it('defaults messageTokenBudget to 32K when config omits it', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [],
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.messageTokenBudget).toBe(32768);
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

  it('should strip stale global refs from runtime model selections', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [
        { name: 'local', baseUrl: 'http://localhost:6628/v1', apiKey: 'key', models: ['claude-sonnet-4-20250514', 'claude-haiku-3-20250414'] },
      ],
      primaryModel: 'global:old-proxy/claude-sonnet-4-20250514',
      fastModel: 'global:old-proxy/claude-haiku-3-20250414',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.primaryModel).toBe('claude-sonnet-4-20250514');
    expect(config.fastModel).toBe('claude-haiku-3-20250414');
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

  it('should set contextWindow and maxOutputTokens via the resolver ladder', () => {
    // Without a warmed models.dev cache, the resolver falls through to
    // DEFAULT_CONTEXT_WINDOW (200K) and DEFAULT_MAX_OUTPUT_TOKENS (16384).
    // The exact numbers depend on what (if anything) is primed; in this
    // test env nothing is primed, so we assert the DEFAULTS.
    const config = loadConfig({ dir: TEST_DIR, model: 'gpt-4.1' });
    expect(config.maxContextTokens).toBe(200_000);
    expect(config.maxOutputTokens).toBe(16_384);
  });

  it('should include modelInfo for known models', () => {
    const config = loadConfig({ dir: TEST_DIR, model: 'gpt-5' });
    expect(config.modelInfo).not.toBeNull();
    expect(config.modelInfo.displayName).toBe('GPT-5');
  });

  it('should include Anthropic metadata and limits for Claude Opus 4.8 ids', () => {
    _setMemCacheForTest({
      anthropic: {
        models: {
          'claude-opus-4-8': { limit: { context: 1_000_000, output: 128_000 } },
        },
      },
      'github-copilot': {
        models: {
          'claude-opus-4.8': { limit: { context: 200_000, output: 64_000 } },
        },
      },
    });

    const nativeConfig = loadConfig({ dir: TEST_DIR, model: 'claude-opus-4-8' });
    expect(nativeConfig.adapter).toBe('anthropic');
    expect(nativeConfig.baseUrl).toBe('https://api.anthropic.com');
    expect(nativeConfig.modelInfo.displayName).toBe('Claude Opus 4.8');
    expect(resolveContextWindow('claude-opus-4-8', nativeConfig)).toBe(1_000_000);
    expect(resolveMaxOutputTokens('claude-opus-4-8', nativeConfig)).toBe(128_000);

    const copilotAliasConfig = loadConfig({ dir: TEST_DIR, model: 'claude-opus-4.8' });
    expect(copilotAliasConfig.adapter).toBe('anthropic');
    expect(copilotAliasConfig.baseUrl).toBe('https://api.anthropic.com');
    expect(copilotAliasConfig.modelInfo.displayName).toBe('Claude Opus 4.8');
    expect(resolveContextWindow('claude-opus-4.8', copilotAliasConfig)).toBe(200_000);
    expect(resolveMaxOutputTokens('claude-opus-4.8', copilotAliasConfig)).toBe(64_000);
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

  it('always returns a skipped array (back-compat shape)', () => {
    const result = loadMCPConfig(TEST_DIR);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(result.skipped).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Project Claude Code MCP assets — <workDir>/.mcp.json
// ═══════════════════════════════════════════════════════════════

describe('loadProjectMCPServers', () => {
  const PROJECT_DIR = join(tmpdir(), `yeaft-test-mcp-project-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  function writeMcp(obj) {
    writeFileSync(join(PROJECT_DIR, '.mcp.json'), JSON.stringify(obj));
  }

  it('parses Claude Code mcpServers object into yeaft array shape', () => {
    writeMcp({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@mcp/github'], env: { TOKEN: 'x' } },
      },
    });

    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({
      name: 'github',
      command: 'npx',
      args: ['-y', '@mcp/github'],
      env: { TOKEN: 'x' },
    });
    expect(result.skipped).toEqual([]);
  });

  it('includes stdio servers and skips SSE/HTTP (url/type) servers as unsupported', () => {
    writeMcp({
      mcpServers: {
        local: { command: 'node', args: ['server.js'] },
        remote: { url: 'https://example.com/sse' },
        typed: { type: 'sse', url: 'https://example.com/x' },
      },
    });

    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result.servers.map(s => s.name)).toEqual(['local']);
    const skippedNames = result.skipped.map(s => s.name).sort();
    expect(skippedNames).toEqual(['remote', 'typed']);
    for (const s of result.skipped) {
      expect(s.reason).toBe('unsupported-transport');
      expect(s.source).toBe('.mcp.json');
    }
  });

  it('marks entries with neither command nor url/type as invalid-config', () => {
    writeMcp({ mcpServers: { broken: { foo: 'bar' } } });

    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'broken', reason: 'invalid-config', source: '.mcp.json' },
    ]);
  });

  it('omits optional args/env when absent', () => {
    writeMcp({ mcpServers: { bare: { command: 'run-it' } } });

    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result.servers[0]).toEqual({ name: 'bare', command: 'run-it' });
  });

  it('returns gracefully when .mcp.json is absent', () => {
    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result).toEqual({ servers: [], skipped: [] });
  });

  it('returns gracefully on malformed JSON', () => {
    writeFileSync(join(PROJECT_DIR, '.mcp.json'), '{ not valid json');
    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result).toEqual({ servers: [], skipped: [] });
  });

  it('returns gracefully when mcpServers is not an object', () => {
    writeMcp({ mcpServers: ['array', 'not', 'object'] });
    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result).toEqual({ servers: [], skipped: [] });
  });

  it('returns gracefully when mcpServers field is missing', () => {
    writeMcp({ somethingElse: true });
    const result = loadProjectMCPServers(PROJECT_DIR);
    expect(result).toEqual({ servers: [], skipped: [] });
  });

  it('returns gracefully on empty/invalid workDir', () => {
    expect(loadProjectMCPServers('')).toEqual({ servers: [], skipped: [] });
    expect(loadProjectMCPServers(undefined)).toEqual({ servers: [], skipped: [] });
  });
});

// ═══════════════════════════════════════════════════════════════
// loadMCPConfig — global + project tier merge
// ═══════════════════════════════════════════════════════════════

describe('loadMCPConfig — global/project merge', () => {
  const PROJECT_DIR = join(tmpdir(), `yeaft-test-mcp-merge-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  function writeProjectMcp(obj) {
    writeFileSync(join(PROJECT_DIR, '.mcp.json'), JSON.stringify(obj));
  }

  it('merges global config.json servers with project .mcp.json servers', () => {
    const jsonConfig = { mcpServers: [{ name: 'global-srv', command: 'g' }] };
    writeProjectMcp({ mcpServers: { 'project-srv': { command: 'p' } } });

    const result = loadMCPConfig(TEST_DIR, jsonConfig, PROJECT_DIR);
    expect(result.servers.map(s => s.name).sort()).toEqual(['global-srv', 'project-srv']);
  });

  it('global (~/.yeaft) server wins over a same-named project server', () => {
    const jsonConfig = { mcpServers: [{ name: 'dup', command: 'global-cmd' }] };
    writeProjectMcp({ mcpServers: { dup: { command: 'project-cmd' } } });

    const result = loadMCPConfig(TEST_DIR, jsonConfig, PROJECT_DIR);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].command).toBe('global-cmd');
  });

  it('surfaces project skipped servers through loadMCPConfig', () => {
    writeProjectMcp({
      mcpServers: {
        ok: { command: 'node' },
        remote: { url: 'https://example.com/sse' },
      },
    });

    const result = loadMCPConfig(TEST_DIR, undefined, PROJECT_DIR);
    expect(result.servers.map(s => s.name)).toEqual(['ok']);
    expect(result.skipped).toEqual([
      { name: 'remote', reason: 'unsupported-transport', source: '.mcp.json' },
    ]);
  });

  it('works with no workDir (global only, empty skipped)', () => {
    const jsonConfig = { mcpServers: [{ name: 'g', command: 'c' }] };
    const result = loadMCPConfig(TEST_DIR, jsonConfig);
    expect(result.servers.map(s => s.name)).toEqual(['g']);
    expect(result.skipped).toEqual([]);
  });

  it('a broken project .mcp.json never breaks global loading', () => {
    const jsonConfig = { mcpServers: [{ name: 'g', command: 'c' }] };
    writeFileSync(join(PROJECT_DIR, '.mcp.json'), '{ broken');

    const result = loadMCPConfig(TEST_DIR, jsonConfig, PROJECT_DIR);
    expect(result.servers.map(s => s.name)).toEqual(['g']);
    expect(result.skipped).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// memoryV2 — flag retired (task-710)
// The H2-AMS / dream wiring is now unconditional. We assert the
// field is absent so a regression that re-introduces the dead switch
// shows up in CI.
// ═══════════════════════════════════════════════════════════════

describe('loadConfig — memoryV2 flag retired', () => {
  it('does not expose memoryV2 (config.json without it)', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
    }));
    const config = loadConfig({ dir: TEST_DIR });
    expect(config).not.toHaveProperty('memoryV2');
  });

  it('ignores memoryV2 in config.json (no longer plumbed)', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'p', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      primaryModel: 'p/m',
      memoryV2: false,
    }));
    const config = loadConfig({ dir: TEST_DIR });
    expect(config).not.toHaveProperty('memoryV2');
  });
});

describe('managed GitHub Copilot provider config', () => {
  it('hydrates a minimal managed provider with fallback model catalog', () => {
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', managed: 'github-copilot' }],
      primaryModel: 'github-copilot/claude-opus-4.8',
    }));

    const config = loadConfig({ dir: TEST_DIR });
    expect(config.providers[0].models).toBeUndefined();
    expect(config.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-opus-4.8', provider: 'github-copilot' }),
      expect.objectContaining({ id: 'gpt-5-mini', provider: 'github-copilot' }),
    ]));
  });
});
