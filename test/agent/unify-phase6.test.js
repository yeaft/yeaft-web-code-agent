import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Module imports ──────────────────────────────────────────

import { loadMCPConfig } from '../../agent/unify/config.js';
import { buildSystemPrompt } from '../../agent/unify/prompts.js';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';
import { SkillManager, createSkillManager } from '../../agent/unify/skills.js';
import { MCPManager } from '../../agent/unify/mcp.js';
import { createEmptyRegistry } from '../../agent/unify/tools/registry.js';
import { defineTool } from '../../agent/unify/tools/types.js';
import { ConversationStore } from '../../agent/unify/conversation/persist.js';
import { MemoryStore } from '../../agent/unify/memory/store.js';
import { initYeaftDir } from '../../agent/unify/init.js';

// ─── Mock Adapter ────────────────────────────────────────────

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callLog = [];
  }
  pushResponse(events) {
    this.responses.push(events);
  }
  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) throw new Error('MockAdapter: no more responses queued');
    for (const event of events) yield event;
  }
  async call(params) {
    this.callLog.push(params);
    return { text: '{}', usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

// ─── Test Helpers ────────────────────────────────────────────

let testDir;
let trace;
let mockAdapter;

beforeEach(() => {
  testDir = join(tmpdir(), `yeaft-phase6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
// loadMCPConfig
// ═══════════════════════════════════════════════════════════════

describe('loadMCPConfig', () => {
  it('should return empty servers for missing file', () => {
    const result = loadMCPConfig(testDir);
    expect(result).toEqual({ servers: [] });
  });

  it('should parse valid mcp.json', () => {
    writeFileSync(join(testDir, 'mcp.json'), JSON.stringify({
      servers: [
        { name: 'github', command: 'npx', args: ['@mcp/github'] },
        { name: 'slack', command: 'node', args: ['slack-server.js'], env: { TOKEN: 'abc' } },
      ],
    }));

    const result = loadMCPConfig(testDir);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe('github');
    expect(result.servers[1].env).toEqual({ TOKEN: 'abc' });
  });

  it('should return empty for malformed JSON', () => {
    writeFileSync(join(testDir, 'mcp.json'), '{ broken json !!!');
    const result = loadMCPConfig(testDir);
    expect(result).toEqual({ servers: [] });
  });

  it('should skip entries without name or command', () => {
    writeFileSync(join(testDir, 'mcp.json'), JSON.stringify({
      servers: [
        { name: 'valid', command: 'echo' },
        { name: 'no-cmd' },
        { command: 'no-name' },
        {},
      ],
    }));

    const result = loadMCPConfig(testDir);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('valid');
  });

  it('should return empty when servers key is not an array', () => {
    writeFileSync(join(testDir, 'mcp.json'), JSON.stringify({ servers: 'not-array' }));
    const result = loadMCPConfig(testDir);
    expect(result).toEqual({ servers: [] });
  });
});

// ═══════════════════════════════════════════════════════════════
// buildSystemPrompt with skillContent
// ═══════════════════════════════════════════════════════════════

describe('buildSystemPrompt — skillContent', () => {
  it('should include skill content when provided', () => {
    const result = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      skillContent: '## Skill: test-skill\n\nDo something useful.',
    });
    expect(result).toContain('## Skill: test-skill');
    expect(result).toContain('Do something useful.');
  });

  it('should not change output when skillContent is omitted', () => {
    const withoutSkill = buildSystemPrompt({ language: 'en', mode: 'chat' });
    const withEmptySkill = buildSystemPrompt({ language: 'en', mode: 'chat', skillContent: '' });
    // Both should be identical (falsy skillContent is skipped)
    expect(withoutSkill).toBe(withEmptySkill);
  });

  it('should place skill content after tools and before memory', () => {
    const result = buildSystemPrompt({
      language: 'en',
      mode: 'chat',
      toolNames: ['search'],
      skillContent: '## Skill: my-skill\n\nInstructions here.',
      memory: { profile: 'User likes TypeScript' },
    });

    const toolsIdx = result.indexOf('Available tools: search');
    const skillIdx = result.indexOf('## Skill: my-skill');
    const memIdx = result.indexOf('## User Memory');

    expect(toolsIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(memIdx);
  });
});

// ═══════════════════════════════════════════════════════════════
// Engine — ToolRegistry integration
// ═══════════════════════════════════════════════════════════════

describe('Engine — ToolRegistry integration', () => {
  it('should use ToolRegistry for tool defs when provided', async () => {
    const registry = createEmptyRegistry();
    registry.register(defineTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      modes: ['chat', 'work'],
      execute: async () => 'ok',
    }));

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });

    for await (const _ of engine.query({ prompt: 'test' })) { /* consume */ }

    const call = mockAdapter.callLog[0];
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('test_tool');
  });

  it('should pass full ToolContext to tool.execute via registry', async () => {
    let receivedCtx = null;

    const registry = createEmptyRegistry();
    registry.register(defineTool({
      name: 'ctx_tool',
      description: 'Captures context',
      parameters: { type: 'object', properties: {} },
      modes: ['chat'],
      execute: async (input, ctx) => {
        receivedCtx = ctx;
        return 'done';
      },
    }));

    mockAdapter.pushResponse([
      { type: 'tool_call', id: 'tc1', name: 'ctx_tool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      yeaftDir: testDir,
    });

    for await (const _ of engine.query({ prompt: 'use tool' })) { /* consume */ }

    expect(receivedCtx).toBeTruthy();
    expect(receivedCtx.yeaftDir).toBe(testDir);
    expect(receivedCtx.config).toBeTruthy();
    expect(receivedCtx.mode).toBe('chat');
    expect(typeof receivedCtx.cwd).toBe('string');
  });

  it('should filter tools by mode when using registry', async () => {
    const registry = createEmptyRegistry();
    registry.register(defineTool({
      name: 'chat_only',
      description: 'Chat only',
      parameters: { type: 'object', properties: {} },
      modes: ['chat'],
      execute: async () => 'ok',
    }));
    registry.register(defineTool({
      name: 'work_only',
      description: 'Work only',
      parameters: { type: 'object', properties: {} },
      modes: ['work'],
      execute: async () => 'ok',
    }));

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });

    // Query in work mode — should only see work_only
    for await (const _ of engine.query({ prompt: 'test', mode: 'work' })) { /* consume */ }

    const call = mockAdapter.callLog[0];
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('work_only');
  });

  it('should fall back to legacy #tools Map when no registry', async () => {
    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      // No toolRegistry
    });

    engine.registerTool({
      name: 'legacy_tool',
      description: 'Legacy',
      parameters: {},
      execute: async () => 'ok',
    });

    for await (const _ of engine.query({ prompt: 'test' })) { /* consume */ }

    const call = mockAdapter.callLog[0];
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('legacy_tool');
  });

  it('should report registry tool names via toolNames getter', () => {
    const registry = createEmptyRegistry();
    registry.register(defineTool({
      name: 'alpha',
      description: 'A',
      parameters: {},
      modes: ['chat'],
      execute: async () => '',
    }));
    registry.register(defineTool({
      name: 'beta',
      description: 'B',
      parameters: {},
      modes: ['work'],
      execute: async () => '',
    }));

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model' },
      toolRegistry: registry,
    });

    expect(engine.toolNames).toEqual(['alpha', 'beta']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Engine — SkillManager integration
// ═══════════════════════════════════════════════════════════════

describe('Engine — SkillManager integration', () => {
  it('should inject relevant skill content into system prompt', async () => {
    // Create a skill
    const skillsDir = join(testDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill.md'), [
      '---',
      'name: test-skill',
      'description: A test skill',
      'trigger: when user asks about testing',
      'mode: both',
      '---',
      '',
      'Follow these testing guidelines...',
    ].join('\n'));

    const skillManager = createSkillManager(testDir);
    expect(skillManager.size).toBe(1);

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      skillManager,
    });

    for await (const _ of engine.query({ prompt: 'user asks about testing guidelines' })) { /* consume */ }

    const call = mockAdapter.callLog[0];
    expect(call.system).toContain('## Skill: test-skill');
    expect(call.system).toContain('Follow these testing guidelines');
  });

  it('should not inject skills when prompt does not match triggers', async () => {
    const skillsDir = join(testDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'deploy.md'), [
      '---',
      'name: deploy',
      'description: Deployment guide',
      'trigger: when deploying to production',
      'mode: work',
      '---',
      '',
      'Always check staging first.',
    ].join('\n'));

    const skillManager = createSkillManager(testDir);

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      skillManager,
    });

    for await (const _ of engine.query({ prompt: 'what is 2+2?' })) { /* consume */ }

    const call = mockAdapter.callLog[0];
    expect(call.system).not.toContain('## Skill: deploy');
  });
});

// ═══════════════════════════════════════════════════════════════
// Engine — StopHooks integration
// ═══════════════════════════════════════════════════════════════

describe('Engine — StopHooks integration', () => {
  it('should use runStopHooks when yeaftDir is provided', async () => {
    initYeaftDir(testDir);

    const conversationStore = new ConversationStore(testDir);
    const memoryStore = new MemoryStore(testDir);

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'Hello!' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      conversationStore,
      memoryStore,
      yeaftDir: testDir,
    });

    const events = [];
    for await (const event of engine.query({ prompt: 'hi' })) {
      events.push(event);
    }

    // StopHooks should have persisted messages
    const count = conversationStore.countHot();
    expect(count).toBeGreaterThanOrEqual(1);

    // Should have normal completion
    const turnEnd = events.find(e => e.type === 'turn_end');
    expect(turnEnd.stopReason).toBe('end_turn');
  });

  it('should fall back to legacy persist when yeaftDir is not set', async () => {
    initYeaftDir(testDir);

    const conversationStore = new ConversationStore(testDir);
    const memoryStore = new MemoryStore(testDir);

    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'Hello!' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      conversationStore,
      memoryStore,
      // No yeaftDir → legacy path
    });

    for await (const _ of engine.query({ prompt: 'hi' })) { /* consume */ }

    // Legacy path should also persist
    const count = conversationStore.countHot();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Engine — public accessors
// ═══════════════════════════════════════════════════════════════

describe('Engine — public accessors', () => {
  it('should expose new managers via getters', () => {
    const registry = createEmptyRegistry();
    const skillManager = new SkillManager(testDir);
    const mcpManager = new MCPManager();

    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model' },
      toolRegistry: registry,
      skillManager,
      mcpManager,
      yeaftDir: testDir,
    });

    expect(engine.toolRegistry).toBe(registry);
    expect(engine.skillManager).toBe(skillManager);
    expect(engine.mcpManager).toBe(mcpManager);
    expect(engine.yeaftDir).toBe(testDir);
  });

  it('should return null for unset managers', () => {
    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model' },
    });

    expect(engine.toolRegistry).toBeNull();
    expect(engine.skillManager).toBeNull();
    expect(engine.mcpManager).toBeNull();
    expect(engine.yeaftDir).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// loadSession (bootstrap)
// ═══════════════════════════════════════════════════════════════

describe('loadSession', () => {
  // Import dynamically to avoid side effects at module load time
  let loadSession;

  beforeEach(async () => {
    const mod = await import('../../agent/unify/session.js');
    loadSession = mod.loadSession;
  });

  it('should return a valid session object', async () => {
    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      // Verify all session properties exist
      expect(session.engine).toBeTruthy();
      expect(session.config).toBeTruthy();
      expect(session.conversationStore).toBeTruthy();
      expect(session.memoryStore).toBeTruthy();
      expect(session.skillManager).toBeTruthy();
      expect(session.mcpManager).toBeTruthy();
      expect(session.toolRegistry).toBeTruthy();
      expect(session.trace).toBeTruthy();
      expect(session.yeaftDir).toBe(testDir);
      expect(typeof session.shutdown).toBe('function');
      expect(session.status).toBeTruthy();
    } finally {
      await session.shutdown();
    }
  });

  it('should register built-in tools in registry', async () => {
    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      // 39 built-in tools (5 original + 34 newly implemented)
      expect(session.toolRegistry.has('mcp_list_tools')).toBe(true);
      expect(session.toolRegistry.has('mcp_call_tool')).toBe(true);
      expect(session.toolRegistry.has('Skill')).toBe(true);
      expect(session.toolRegistry.has('EnterWorktree')).toBe(true);
      expect(session.toolRegistry.has('ExitWorktree')).toBe(true);
      expect(session.status.tools).toBe(41);
    } finally {
      await session.shutdown();
    }
  });

  it('should register extra tools', async () => {
    const extraTool = defineTool({
      name: 'custom_tool',
      description: 'Custom',
      parameters: { type: 'object', properties: {} },
      modes: ['chat'],
      execute: async () => 'custom',
    });

    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      extraTools: [extraTool],
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      expect(session.toolRegistry.has('custom_tool')).toBe(true);
      expect(session.status.tools).toBe(42); // 41 built-in + 1 extra
    } finally {
      await session.shutdown();
    }
  });

  it('should load skills from skills directory', async () => {
    // Create a skill file before loading session
    initYeaftDir(testDir);
    const skillsDir = join(testDir, 'skills');
    writeFileSync(join(skillsDir, 'greeting.md'), [
      '---',
      'name: greeting',
      'description: Greeting skill',
      'trigger: hello hi',
      'mode: chat',
      '---',
      '',
      'Always greet warmly.',
    ].join('\n'));

    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      expect(session.status.skills).toBe(1);
      expect(session.skillManager.has('greeting')).toBe(true);
    } finally {
      await session.shutdown();
    }
  });

  it('should skip skills when skipSkills is true', async () => {
    initYeaftDir(testDir);
    const skillsDir = join(testDir, 'skills');
    writeFileSync(join(skillsDir, 'ignored.md'), [
      '---',
      'name: ignored',
      'description: Should be skipped',
      '---',
      'Content.',
    ].join('\n'));

    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      skipSkills: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      expect(session.status.skills).toBe(0);
      expect(session.skillManager.has('ignored')).toBe(false);
    } finally {
      await session.shutdown();
    }
  });

  it('should skip MCP when skipMCP is true', async () => {
    // Write an mcp.json that would fail if actually connected
    initYeaftDir(testDir);
    writeFileSync(join(testDir, 'mcp.json'), JSON.stringify({
      servers: [{ name: 'fake', command: 'nonexistent-binary-xyz' }],
    }));

    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      expect(session.status.mcpServers).toEqual([]);
      expect(session.mcpManager.hasServers).toBe(false);
    } finally {
      await session.shutdown();
    }
  });

  it('should wire engine with all managers', async () => {
    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      const { engine } = session;
      expect(engine.toolRegistry).toBe(session.toolRegistry);
      expect(engine.skillManager).toBe(session.skillManager);
      expect(engine.mcpManager).toBe(session.mcpManager);
      expect(engine.yeaftDir).toBe(testDir);
      expect(engine.conversationStore).toBe(session.conversationStore);
      expect(engine.memoryStore).toBe(session.memoryStore);
    } finally {
      await session.shutdown();
    }
  });

  it('should create directory structure on first load', async () => {
    const freshDir = join(testDir, 'fresh-yeaft');

    const session = await loadSession({
      dir: freshDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    try {
      // Directory structure should have been created
      expect(existsSync(join(freshDir, 'memory', 'entries'))).toBe(true);
      expect(existsSync(join(freshDir, 'conversation', 'messages'))).toBe(true);
      expect(existsSync(join(freshDir, 'skills'))).toBe(true);
      expect(existsSync(join(freshDir, 'dream'))).toBe(true);
      expect(existsSync(join(freshDir, 'config.json'))).toBe(true);
    } finally {
      await session.shutdown();
    }
  });

  it('should shutdown gracefully', async () => {
    const session = await loadSession({
      dir: testDir,
      skipMCP: true,
      configOverrides: {
        apiKey: 'test-key',
        adapter: 'anthropic',
      },
    });

    // Should not throw
    await session.shutdown();
    // Should be safe to call twice
    await session.shutdown();
  });
});
