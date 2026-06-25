import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import ctx from '../../../agent/context.js';
import { buildMergedSkillSlashCommands, buildSkillSlashCommands, __testGetOrCreateVpEngine, __testResetVpState, __testHooks } from '../../../agent/yeaft/web-bridge.js';

class RecordingAdapter {
  constructor() {
    this.calls = [];
  }

  async *stream(params) {
    this.calls.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
}

function makeMcpManager(toolName, calls = []) {
  let disconnected = false;
  return {
    listTools() {
      return disconnected ? [] : [{
        name: `${toolName}Server__${toolName}`,
        server: `${toolName}Server`,
        description: `${toolName} project tool`,
        inputSchema: { type: 'object', properties: {} },
      }];
    },
    async callTool(fullName, input) {
      calls.push({ fullName, input });
      return { content: [{ type: 'text', text: `${toolName} ok` }] };
    },
    async disconnectAll() {
      disconnected = true;
    },
  };
}

describe('Yeaft skill slash commands', () => {
  afterEach(async () => {
    await __testResetVpState();
    __testHooks.setSessionForTest(null);
    ctx.slashCommands = [];
    ctx.slashCommandDescriptions = {};
    ctx.messageBuffer = [];
    ctx.AGENT_ID = undefined;
    ctx.agentId = undefined;
  });

  it('builds slash commands from loaded skill metadata', () => {
    const { commands, descriptions } = buildSkillSlashCommands({
      list: () => [
        { name: 'review-code', description: 'Review code' },
        { name: 'sprint', trigger: 'plan work' },
        { name: '', description: 'bad' },
      ],
    });

    expect(commands).toEqual(['yeaft-skills:review-code', 'yeaft-skills:sprint']);
    expect(descriptions).toEqual({
      'yeaft-skills:review-code': 'Review code',
      'skill:review-code': 'Review code',
      'yeaft-skills:sprint': 'plan work',
      'skill:sprint': 'plan work',
    });
  });

  it('merges global and project skill commands without duplicates', () => {
    const { commands, descriptions } = buildMergedSkillSlashCommands([
      { list: () => [{ name: 'review-code', description: 'Global review' }, { name: 'plan', description: 'Plan' }] },
      { list: () => [{ name: 'review-code', description: 'Project review' }, { name: 'ship', description: 'Ship' }, { name: '', description: 'bad' }] },
    ]);

    expect(commands).toEqual(['yeaft-skills:plan', 'yeaft-skills:review-code', 'yeaft-skills:ship']);
    expect(descriptions['yeaft-skills:review-code']).toBe('Project review');
    expect(descriptions['skill:review-code']).toBe('Project review');
  });


  it('shows project-tier skills as bare slash commands and globals as yeaft-skills commands', () => {
    const { commands, descriptions } = buildMergedSkillSlashCommands([
      { list: () => [{ name: 'global-review', description: 'Global review', tier: 'user' }] },
      { list: () => [{ name: 'project-review', description: 'Project review', tier: 'project' }] },
    ]);

    expect(commands).toEqual(['project-review', 'yeaft-skills:global-review']);
    expect(descriptions['project-review']).toBe('Project review');
    expect(descriptions['yeaft-skills:project-review']).toBe('Project review');
    expect(descriptions['skill:project-review']).toBe('Project review');
    expect(descriptions['yeaft-skills:global-review']).toBe('Global review');
  });

  it('lets a project-tier override replace a global skill command shape', () => {
    const { commands, descriptions } = buildMergedSkillSlashCommands([
      { list: () => [{ name: 'review-code', description: 'Global review', tier: 'user' }] },
      { list: () => [{ name: 'review-code', description: 'Project review', tier: 'project-claude' }] },
    ]);

    expect(commands).toEqual(['review-code']);
    expect(descriptions['review-code']).toBe('Project review');
    expect(descriptions['yeaft-skills:review-code']).toBe('Project review');
  });

  it.each(['/yeaft-skills:review-code please review this', '/skill:review-code please review this', '/review-code please review this'])('injects an explicitly selected skill and strips %s before streaming', async (prompt) => {
    const adapter = new RecordingAdapter();
    const skillManager = {
      has(name) {
        return name === 'review-code';
      },
      getPromptContent(name) {
        return name === 'review-code' ? '## Skill: review-code\n\nReview instructions' : '';
      },
      getRelevantPromptContent() {
        throw new Error('explicit skill command must not use relevance matching');
      },
    };
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      skillManager,
    });

    const events = [];
    for await (const event of engine.query({ prompt })) {
      events.push(event);
    }

    expect(events.some(event => event.type === 'turn_end')).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].system).toContain('## Skill: review-code');
    expect(adapter.calls[0].system).toContain('Review instructions');
    expect(adapter.calls[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'please review this',
    });
  });

  it('reactivates cached project MCP tools on A-B-A workDir switches', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    const sessionLike = {
      toolRegistry: registry,
      skillManager: { list: () => [] },
      yeaftDir: '/tmp/yeaft-test',
    };
    __testHooks.setSessionForTest(sessionLike);
    __testHooks.seedProjectRuntime('/tmp/project-a', {
      skillManager: { list: () => [] },
      mcpManager: makeMcpManager('a', calls),
    });
    __testHooks.seedProjectRuntime('/tmp/project-b', {
      skillManager: { list: () => [] },
      mcpManager: makeMcpManager('b', calls),
    });

    await __testHooks.loadProjectRuntime('/tmp/project-a');
    expect(registry.names.filter(name => name.startsWith('mcp__'))).toEqual(['mcp__aServer__a']);

    await __testHooks.loadProjectRuntime('/tmp/project-b');
    expect(registry.names.filter(name => name.startsWith('mcp__'))).toEqual(['mcp__bServer__b']);

    await __testHooks.loadProjectRuntime('/tmp/project-a');
    expect(registry.names.filter(name => name.startsWith('mcp__'))).toEqual(['mcp__aServer__a']);

    await registry.execute('mcp__aServer__a', { value: 1 }, {});
    expect(calls).toEqual([{ fullName: 'aServer__a', input: { value: 1 } }]);
  });

  it('reactivates base MCP tools and engine managers when switching from project to no-workDir', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    const baseSkillManager = { list: () => [{ name: 'base-skill', description: 'Base skill' }] };
    const projectSkillManager = { list: () => [{ name: 'project-skill', description: 'Project skill' }] };
    const sessionLike = {
      adapter: new RecordingAdapter(),
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      conversationStore: { loadRecentBySession: () => [], readCompactSummary: () => '' },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: registry,
      skillManager: baseSkillManager,
      mcpManager: makeMcpManager('base', calls),
      yeaftDir: '/tmp/yeaft-test',
      taskManager: { renderActiveTasksForPrompt: () => '' },
      toolStats: null,
    };
    __testHooks.setSessionForTest(sessionLike);
    __testHooks.seedProjectRuntime('/tmp/project-a', {
      skillManager: projectSkillManager,
      mcpManager: makeMcpManager('project', calls),
    });

    const engine = __testGetOrCreateVpEngine('session-a', 'vp-a', 'main');
    await __testHooks.loadProjectRuntime('/tmp/project-a');
    expect(registry.names.filter(name => name.startsWith('mcp__'))).toEqual(['mcp__projectServer__project']);
    expect(engine.skillManager).toBe(projectSkillManager);
    expect(engine.mcpManager).not.toBe(sessionLike.mcpManager);

    await __testHooks.loadProjectRuntime('');
    expect(registry.names.filter(name => name.startsWith('mcp__'))).toEqual(['mcp__baseServer__base']);
    expect(engine.skillManager).toBe(baseSkillManager);
    expect(engine.mcpManager).toBe(sessionLike.mcpManager);

    await registry.execute('mcp__baseServer__base', { value: 2 }, {});
    expect(calls).toEqual([{ fullName: 'baseServer__base', input: { value: 2 } }]);
    expect(ctx.slashCommands).toContain('yeaft-skills:base-skill');
    expect(ctx.slashCommands).not.toContain('yeaft-skills:project-skill');
    expect(ctx.slashCommands).not.toContain('skill:base-skill');
  });

  it('does not block a VP turn on slow project MCP startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-slow-mcp-'));
    const yeaftDir = join(root, 'yeaft');
    const workDir = join(root, 'project');
    mkdirSync(join(yeaftDir, 'sessions', 'sess_slow'), { recursive: true });
    writeFileSync(join(yeaftDir, 'sessions', 'sess_slow', 'session.json'), JSON.stringify({
      id: 'sess_slow',
      name: 'Slow MCP',
      roster: ['dev'],
      defaultVpId: 'dev',
      workDir,
      createdAt: new Date().toISOString(),
    }));
    mkdirSync(join(yeaftDir, 'virtual-persons', 'dev'), { recursive: true });
    writeFileSync(join(yeaftDir, 'virtual-persons', 'dev', 'role.md'), '---\nid: dev\nname: Dev\nrole: Developer\n---\nDeveloper persona\n');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        slow: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
        },
      },
    }));

    const adapter = new RecordingAdapter();
    ctx.CONFIG = {
      yeaftDir,
      model: 'test-model',
      primaryModel: 'test-model',
      maxOutputTokens: 1024,
      language: 'en',
      providers: [],
      availableModels: [],
    };
    const sessionLike = {
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', primaryModel: 'test-model', maxOutputTokens: 1024, language: 'en', providers: [], availableModels: [] },
      conversationStore: { loadRecentBySession: () => [], readCompactSummary: () => '', append: () => ({}) },
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: new ToolRegistry(),
      skillManager: { list: () => [], getRelevantPromptContent: () => '' },
      mcpManager: makeMcpManager('base'),
      yeaftDir,
      taskManager: { renderActiveTasksForPrompt: () => '', listActiveTasks: () => [] },
      toolStats: null,
      compactor: { awaitInFlight: async () => {}, scheduleAfterTurn: () => {} },
      status: { skills: 0, mcpServers: [], tools: 0 },
    };
    __testHooks.setSessionForTest(sessionLike);
    const meta = { id: 'sess_slow', name: 'Slow MCP', roster: ['dev'], defaultVpId: 'dev', workDir };
    __testHooks.seedSessionContext('sess_slow', meta);

    const started = __testHooks.runYeaftSessionSendForTest({ sessionId: 'sess_slow', text: 'hello', id: 'msg-slow' });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(adapter.calls).toHaveLength(1);
    await started;
  });

  it('stamps the registered agent id on preloaded skill commands', async () => {
    ctx.AGENT_ID = 'agent-123';
    ctx.CONFIG = { yeaftDir: '/tmp/yeaft-test', workDir: '/tmp/project-a' };
    const sessionLike = {
      toolRegistry: new ToolRegistry(),
      skillManager: { list: () => [{ name: 'user-skill', description: 'User skill from ~/.yeaft' }] },
      mcpManager: makeMcpManager('base'),
      yeaftDir: '/tmp/yeaft-test',
    };
    __testHooks.setSessionForTest(sessionLike);

    __testHooks.preloadYeaftSkillSlashCommandsForTest();
    expect(ctx.messageBuffer.at(-1)).toMatchObject({
      type: 'slash_commands_update',
      agentId: 'agent-123',
      conversationId: '__preload__',
      slashCommands: ['yeaft-skills:user-skill'],
    });
  });

  it('replays cached Yeaft skill commands after the virtual conversation id is created', async () => {
    const sessionLike = {
      toolRegistry: new ToolRegistry(),
      skillManager: { list: () => [{ name: 'user-skill', description: 'User skill from ~/.yeaft' }] },
      mcpManager: makeMcpManager('base'),
      yeaftDir: '/tmp/yeaft-test',
    };
    __testHooks.setSessionForTest(sessionLike);

    __testHooks.preloadYeaftSkillSlashCommandsForTest();
    const preload = ctx.messageBuffer.at(-1);
    expect(preload).toMatchObject({
      type: 'slash_commands_update',
      conversationId: '__preload__',
      slashCommands: ['yeaft-skills:user-skill'],
    });

    const conversationId = __testHooks.ensureYeaftConversationIdForTest();
    expect(conversationId).toMatch(/^yeaft-/);
    const replay = ctx.messageBuffer.at(-1);
    expect(replay).toMatchObject({
      type: 'slash_commands_update',
      conversationId,
      slashCommands: ['yeaft-skills:user-skill'],
    });
  });

  it('disconnects cached project MCP managers when project runtimes shut down', async () => {
    const disconnected = [];
    __testHooks.seedProjectRuntime('/tmp/project-a', {
      skillManager: { list: () => [] },
      mcpManager: {
        listTools: () => [],
        async disconnectAll() { disconnected.push('a'); },
      },
    });
    __testHooks.seedProjectRuntime('/tmp/project-b', {
      skillManager: { list: () => [] },
      mcpManager: {
        listTools: () => [],
        async disconnectAll() { disconnected.push('b'); },
      },
    });

    expect(__testHooks.projectRuntimeCount()).toBe(2);
    await __testHooks.shutdownProjectRuntimes();

    expect(disconnected.sort()).toEqual(['a', 'b']);
    expect(__testHooks.projectRuntimeCount()).toBe(0);
  });

  it.each(['/yeaft-skills:missing do work', '/skill:missing do work'])('reports unknown explicit skill command %s in the system prompt', async (prompt) => {
    const adapter = new RecordingAdapter();
    const skillManager = {
      getPromptContent() { return ''; },
      getRelevantPromptContent() { return ''; },
    };
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      skillManager,
    });

    for await (const _event of engine.query({ prompt })) {
      // Drain stream.
    }

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].system).toContain('Requested skill "missing" was not found');
    expect(adapter.calls[0].messages[0].content).toBe('do work');
  });
});
