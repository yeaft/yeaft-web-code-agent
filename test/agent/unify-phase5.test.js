import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── memory/types.js tests ──────────────────────────────────

describe('memory/types.js', () => {
  let types;

  beforeEach(async () => {
    types = await import('../../agent/unify/memory/types.js');
  });

  describe('KINDS', () => {
    it('should have 6 kinds', () => {
      expect(types.KINDS).toHaveLength(6);
      expect(types.KINDS).toContain('fact');
      expect(types.KINDS).toContain('preference');
      expect(types.KINDS).toContain('skill');
      expect(types.KINDS).toContain('lesson');
      expect(types.KINDS).toContain('context');
      expect(types.KINDS).toContain('relation');
    });
  });

  describe('parseScopePath', () => {
    it('should parse scope path into segments', () => {
      expect(types.parseScopePath('work/project/auth')).toEqual(['work', 'project', 'auth']);
    });

    it('should return ["global"] for empty/null scope', () => {
      expect(types.parseScopePath('')).toEqual(['global']);
      expect(types.parseScopePath(null)).toEqual(['global']);
      expect(types.parseScopePath(undefined)).toEqual(['global']);
    });

    it('should handle single segment', () => {
      expect(types.parseScopePath('global')).toEqual(['global']);
    });
  });

  describe('getAncestorScopes', () => {
    it('should return all ancestor scopes including global', () => {
      const ancestors = types.getAncestorScopes('work/project/auth');
      expect(ancestors).toEqual(['global', 'work', 'work/project', 'work/project/auth']);
    });

    it('should return ["global"] for global scope', () => {
      expect(types.getAncestorScopes('global')).toEqual(['global']);
      expect(types.getAncestorScopes('')).toEqual(['global']);
      expect(types.getAncestorScopes(null)).toEqual(['global']);
    });
  });

  describe('areScopesRelated', () => {
    it('should recognize parent-child relationship', () => {
      expect(types.areScopesRelated('work', 'work/project')).toBe(true);
      expect(types.areScopesRelated('work/project', 'work')).toBe(true);
    });

    it('should recognize exact match', () => {
      expect(types.areScopesRelated('work/project', 'work/project')).toBe(true);
    });

    it('should consider global related to everything', () => {
      expect(types.areScopesRelated('global', 'work/project')).toBe(true);
      expect(types.areScopesRelated('work/project', 'global')).toBe(true);
    });

    it('should not relate unrelated scopes', () => {
      expect(types.areScopesRelated('work/project-a', 'tech/typescript')).toBe(false);
    });
  });

  describe('validateEntry', () => {
    it('should accept valid entry', () => {
      const result = types.validateEntry({
        name: 'test-entry',
        kind: 'fact',
        content: 'Some content',
        tags: ['a', 'b'],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing name', () => {
      const result = types.validateEntry({ content: 'test' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('should reject missing content', () => {
      const result = types.validateEntry({ name: 'test' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('content'))).toBe(true);
    });

    it('should reject invalid kind', () => {
      const result = types.validateEntry({ name: 'test', kind: 'invalid', content: 'c' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('kind'))).toBe(true);
    });

    it('should reject non-object', () => {
      const result = types.validateEntry(null);
      expect(result.valid).toBe(false);
    });
  });
});

// ─── memory/scan.js tests ───────────────────────────────────

describe('memory/scan.js', () => {
  let scan;
  let MemoryStore;
  let tmpDir;

  beforeEach(async () => {
    scan = await import('../../agent/unify/memory/scan.js');
    const store = await import('../../agent/unify/memory/store.js');
    MemoryStore = store.MemoryStore;

    tmpDir = mkdtempSync(join(tmpdir(), 'yeaft-test-'));
    mkdirSync(join(tmpDir, 'memory', 'entries'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should scan empty store', () => {
    const memoryStore = new MemoryStore(tmpDir);
    const result = scan.scanEntries(memoryStore);
    expect(result.totalEntries).toBe(0);
    expect(result.scopeCount.size).toBe(0);
  });

  it('should scan entries and build indexes', () => {
    const memoryStore = new MemoryStore(tmpDir);

    memoryStore.writeEntry({
      name: 'entry-a',
      kind: 'fact',
      scope: 'tech/typescript',
      tags: ['typescript', 'generics'],
      content: 'TypeScript generics patterns',
    });

    memoryStore.writeEntry({
      name: 'entry-b',
      kind: 'preference',
      scope: 'global',
      tags: ['typescript', 'style'],
      content: 'Prefer 2-space indent',
    });

    const result = scan.scanEntries(memoryStore);
    expect(result.totalEntries).toBe(2);
    expect(result.scopeCount.get('tech/typescript')).toBe(1);
    expect(result.scopeCount.get('global')).toBe(1);
    expect(result.kindCount.get('fact')).toBe(1);
    expect(result.kindCount.get('preference')).toBe(1);
    expect(result.tagIndex.get('typescript').size).toBe(2);
  });

  describe('scoreEntry', () => {
    it('should score exact scope match higher', () => {
      const entry = { scope: 'tech/typescript', tags: ['ts'], kind: 'fact', importance: 'normal', frequency: 1 };
      const scoreExact = scan.scoreEntry(entry, { scope: 'tech/typescript', tags: [] });
      const scoreDiff = scan.scoreEntry(entry, { scope: 'work/project', tags: [] });
      expect(scoreExact).toBeGreaterThan(scoreDiff);
    });

    it('should score tag overlap', () => {
      const entry = { scope: 'global', tags: ['typescript', 'generics'], kind: 'fact', importance: 'normal', frequency: 1 };
      const withTag = scan.scoreEntry(entry, { tags: ['typescript'] });
      const noTag = scan.scoreEntry(entry, { tags: ['python'] });
      expect(withTag).toBeGreaterThan(noTag);
    });
  });

  describe('findStaleEntries', () => {
    it('should find stale context entries (>30 days)', () => {
      const entries = [{
        name: 'stale',
        kind: 'context',
        frequency: 1,
        updated_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
      }];
      const stale = scan.findStaleEntries(entries);
      expect(stale).toHaveLength(1);
      expect(stale[0].name).toBe('stale');
    });

    it('should not flag recent entries', () => {
      const entries = [{
        name: 'fresh',
        kind: 'fact',
        frequency: 5,
        updated_at: new Date().toISOString(),
      }];
      const stale = scan.findStaleEntries(entries);
      expect(stale).toHaveLength(0);
    });
  });

  describe('findDuplicateGroups', () => {
    it('should find entries sharing ≥2 tags with same kind', () => {
      const entries = [
        { name: 'a', kind: 'fact', tags: ['ts', 'generics', 'types'] },
        { name: 'b', kind: 'fact', tags: ['ts', 'generics', 'patterns'] },
        { name: 'c', kind: 'preference', tags: ['ts', 'generics'] }, // different kind
      ];
      const groups = scan.findDuplicateGroups(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(2);
      expect(groups[0].map(e => e.name).sort()).toEqual(['a', 'b']);
    });

    it('should not group entries with <2 shared tags', () => {
      const entries = [
        { name: 'a', kind: 'fact', tags: ['ts'] },
        { name: 'b', kind: 'fact', tags: ['python'] },
      ];
      const groups = scan.findDuplicateGroups(entries);
      expect(groups).toHaveLength(0);
    });
  });

  describe('summarizeScan', () => {
    it('should produce a non-empty summary', () => {
      const memoryStore = new MemoryStore(tmpDir);
      memoryStore.writeEntry({ name: 'test', kind: 'fact', scope: 'global', tags: ['a'], content: 'test' });
      const result = scan.scanEntries(memoryStore);
      const summary = scan.summarizeScan(result);
      expect(summary).toContain('Total entries: 1');
      expect(summary).toContain('fact: 1');
    });
  });
});

// ─── memory/dream.js tests ──────────────────────────────────

describe('memory/dream.js', () => {
  let dreamModule;
  let tmpDir;

  beforeEach(async () => {
    dreamModule = await import('../../agent/unify/memory/dream.js');
    tmpDir = mkdtempSync(join(tmpdir(), 'yeaft-test-'));
    mkdirSync(join(tmpDir, 'dream'), { recursive: true });
    mkdirSync(join(tmpDir, 'memory', 'entries'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readDreamState / writeDreamState', () => {
    it('should return defaults for missing state', () => {
      const state = dreamModule.readDreamState(tmpDir);
      expect(state.lastDreamAt).toBeNull();
      expect(state.queriesSinceDream).toBe(0);
      expect(state.dreamCount).toBe(0);
    });

    it('should round-trip state', () => {
      const state = {
        lastDreamAt: '2026-04-09T08:00:00Z',
        queriesSinceDream: 3,
        dreamCount: 5,
      };
      dreamModule.writeDreamState(tmpDir, state);
      const read = dreamModule.readDreamState(tmpDir);
      expect(read.lastDreamAt).toBe('2026-04-09T08:00:00Z');
      expect(read.queriesSinceDream).toBe(3);
      expect(read.dreamCount).toBe(5);
    });
  });

  describe('incrementQueryCount', () => {
    it('should increment the counter', () => {
      dreamModule.incrementQueryCount(tmpDir);
      dreamModule.incrementQueryCount(tmpDir);
      dreamModule.incrementQueryCount(tmpDir);
      const state = dreamModule.readDreamState(tmpDir);
      expect(state.queriesSinceDream).toBe(3);
    });
  });

  describe('checkDreamGate', () => {
    it('should reject when not enough queries', () => {
      const result = dreamModule.checkDreamGate(tmpDir);
      expect(result.shouldDream).toBe(false);
      expect(result.reason).toContain('queries');
    });

    it('should reject when too recent', () => {
      dreamModule.writeDreamState(tmpDir, {
        lastDreamAt: new Date().toISOString(),
        queriesSinceDream: 10,
        dreamCount: 1,
      });
      const result = dreamModule.checkDreamGate(tmpDir);
      expect(result.shouldDream).toBe(false);
      expect(result.reason).toContain('since last dream');
    });

    it('should pass when all gates met', () => {
      dreamModule.writeDreamState(tmpDir, {
        lastDreamAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
        queriesSinceDream: 10,
        dreamCount: 0,
      });
      const result = dreamModule.checkDreamGate(tmpDir);
      expect(result.shouldDream).toBe(true);
    });

    it('should pass when no previous dream', () => {
      dreamModule.writeDreamState(tmpDir, {
        lastDreamAt: null,
        queriesSinceDream: 10,
        dreamCount: 0,
      });
      const result = dreamModule.checkDreamGate(tmpDir);
      expect(result.shouldDream).toBe(true);
    });
  });
});

// ─── memory/dream-prompt.js tests ──────────────────────────

describe('memory/dream-prompt.js', () => {
  let prompts;

  beforeEach(async () => {
    prompts = await import('../../agent/unify/memory/dream-prompt.js');
  });

  it('buildOrientPrompt should include memory summary', () => {
    const result = prompts.buildOrientPrompt({
      memorySummary: 'Total entries: 42',
      profileContent: '# User Profile',
      entryCount: 42,
    });
    expect(result).toContain('Phase 1: Orient');
    expect(result).toContain('Total entries: 42');
    expect(result).toContain('# User Profile');
  });

  it('buildGatherPrompt should include tasks and orient result', () => {
    const result = prompts.buildGatherPrompt({
      recentCompact: 'Some recent summary',
      completedTasks: [{ id: 'task-1', description: 'Fix bug', summary: 'Fixed auth null pointer' }],
      orientResult: { overallHealth: 'good' },
    });
    expect(result).toContain('Phase 2: Gather');
    expect(result).toContain('Fix bug');
  });

  it('buildPrunePrompt should show stale entries', () => {
    const result = prompts.buildPrunePrompt({
      staleEntries: [{ name: 'old-entry', kind: 'context', frequency: 1, _daysSinceUpdate: 45, content: 'old stuff' }],
      entryCount: 150,
      maxEntries: 200,
    });
    expect(result).toContain('Phase 4: Prune');
    expect(result).toContain('old-entry');
    expect(result).toContain('Within capacity');
  });

  it('buildPrunePrompt should warn about over-capacity', () => {
    const result = prompts.buildPrunePrompt({
      staleEntries: [],
      entryCount: 250,
      maxEntries: 200,
    });
    expect(result).toContain('OVER CAPACITY');
  });

  it('buildPromotePrompt should include high-frequency entries', () => {
    const result = prompts.buildPromotePrompt({
      entries: [
        { name: 'frequent', kind: 'fact', frequency: 5, scope: 'global', content: 'Important fact' },
      ],
      profileContent: '# Profile',
      scopesSummary: 'global: 10',
    });
    expect(result).toContain('Phase 5: Promote');
    expect(result).toContain('frequent');
  });
});

// ─── stop-hooks.js tests ────────────────────────────────────

describe('stop-hooks.js', () => {
  let stopHooks;

  beforeEach(async () => {
    stopHooks = await import('../../agent/unify/stop-hooks.js');
  });

  it('should skip hooks for worker mode', async () => {
    const result = await stopHooks.runStopHooks({
      yeaftDir: '/tmp/test',
      mode: 'worker',
    });
    expect(result.messagesPersisted).toBe(0);
    expect(result.consolidated).toBe(false);
    expect(result.dreamTriggered).toBe(false);
  });

  it('should handle missing stores gracefully', async () => {
    const result = await stopHooks.runStopHooks({
      yeaftDir: '/tmp/nonexistent',
      mode: 'chat',
      config: {},
    });
    expect(result.errors.length).toBe(0);
    expect(result.messagesPersisted).toBe(0);
  });
});

// ─── skills.js tests ────────────────────────────────────────

describe('skills.js', () => {
  let skillsModule;
  let tmpDir;

  beforeEach(async () => {
    skillsModule = await import('../../agent/unify/skills.js');
    tmpDir = mkdtempSync(join(tmpdir(), 'yeaft-test-'));
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseSkill', () => {
    it('should parse a skill file', () => {
      const raw = `---
name: test-skill
description: A test skill
trigger: when user asks about testing
mode: both
---
# Test Skill
Do the testing.`;
      const skill = skillsModule.parseSkill(raw, 'test-skill.md');
      expect(skill.name).toBe('test-skill');
      expect(skill.description).toBe('A test skill');
      expect(skill.trigger).toBe('when user asks about testing');
      expect(skill.mode).toBe('both');
      expect(skill.content).toContain('Do the testing');
    });

    it('should return null for invalid content', () => {
      expect(skillsModule.parseSkill('')).toBeNull();
      expect(skillsModule.parseSkill('no frontmatter')).toBeNull();
    });

    it('should use filename as name fallback', () => {
      const raw = `---
description: A skill
---
Content`;
      const skill = skillsModule.parseSkill(raw, 'my-skill.md');
      expect(skill.name).toBe('my-skill');
    });
  });

  describe('serializeSkill', () => {
    it('should round-trip a skill', () => {
      const skill = {
        name: 'test',
        description: 'Test skill',
        trigger: 'when testing',
        mode: 'chat',
        content: '# Instructions\nDo stuff.',
      };
      const serialized = skillsModule.serializeSkill(skill);
      const parsed = skillsModule.parseSkill(serialized);
      expect(parsed.name).toBe('test');
      expect(parsed.description).toBe('Test skill');
      expect(parsed.content).toContain('Do stuff');
    });
  });

  describe('SkillManager', () => {
    it('should load skills from directory', () => {
      writeFileSync(join(tmpDir, 'skills', 'sk1.md'), `---
name: skill-one
description: First skill
trigger: testing
mode: chat
---
Skill one content`);

      writeFileSync(join(tmpDir, 'skills', 'sk2.md'), `---
name: skill-two
description: Second skill
trigger: building
mode: work
---
Skill two content`);

      const manager = new skillsModule.SkillManager(tmpDir);
      const { loaded } = manager.load();
      expect(loaded).toBe(2);
      expect(manager.size).toBe(2);
    });

    it('should filter by mode', () => {
      writeFileSync(join(tmpDir, 'skills', 'chat-only.md'), `---
name: chat-only
mode: chat
---
Chat content`);

      writeFileSync(join(tmpDir, 'skills', 'work-only.md'), `---
name: work-only
mode: work
---
Work content`);

      const manager = new skillsModule.SkillManager(tmpDir);
      manager.load();

      expect(manager.list('chat')).toHaveLength(1);
      expect(manager.list('work')).toHaveLength(1);
      expect(manager.list()).toHaveLength(2);
    });

    it('should find relevant skills by trigger', () => {
      writeFileSync(join(tmpDir, 'skills', 'testing.md'), `---
name: testing
trigger: when user asks about testing or tests
mode: both
---
Testing instructions`);

      const manager = new skillsModule.SkillManager(tmpDir);
      manager.load();

      const results = manager.findRelevant('How do I write tests?');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('testing');
    });

    it('should get prompt content', () => {
      writeFileSync(join(tmpDir, 'skills', 'my-skill.md'), `---
name: my-skill
---
# My Skill Instructions
Step 1. Do this.`);

      const manager = new skillsModule.SkillManager(tmpDir);
      manager.load();

      const content = manager.getPromptContent('my-skill');
      expect(content).toContain('## Skill: my-skill');
      expect(content).toContain('Step 1. Do this.');
    });

    it('should save and retrieve skills', () => {
      const manager = new skillsModule.SkillManager(tmpDir);
      manager.load();

      manager.save({
        name: 'new-skill',
        description: 'A new skill',
        content: 'New instructions',
      });

      expect(manager.has('new-skill')).toBe(true);
      expect(manager.get('new-skill').content).toBe('New instructions');
      expect(existsSync(join(tmpDir, 'skills', 'new-skill.md'))).toBe(true);
    });

    it('should handle empty skills directory', () => {
      const manager = new skillsModule.SkillManager(tmpDir);
      const { loaded } = manager.load();
      expect(loaded).toBe(0);
    });
  });
});

// ─── tools/types.js tests ──────────────────────────────────

describe('tools/types.js', () => {
  let defineTool;

  beforeEach(async () => {
    const types = await import('../../agent/unify/tools/types.js');
    defineTool = types.defineTool;
  });

  it('should create a tool with defaults', () => {
    const tool = defineTool({
      name: 'TestTool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'result',
    });

    expect(tool.name).toBe('TestTool');
    expect(tool.modes).toEqual(['chat', 'work']);
    expect(tool.isConcurrencySafe()).toBe(false);
    expect(tool.isReadOnly()).toBe(false);
    expect(tool.isDestructive()).toBe(false);
  });

  it('should throw on missing name', () => {
    expect(() => defineTool({ execute: async () => '' })).toThrow('name');
  });

  it('should throw on missing execute', () => {
    expect(() => defineTool({ name: 'test' })).toThrow('execute');
  });

  it('should accept custom modes', () => {
    const tool = defineTool({
      name: 'WorkOnly',
      execute: async () => '',
      modes: ['work'],
    });
    expect(tool.modes).toEqual(['work']);
  });
});

// ─── tools/registry.js tests ───────────────────────────────

describe('tools/registry.js', () => {
  let ToolRegistry;
  let defineTool;

  beforeEach(async () => {
    const reg = await import('../../agent/unify/tools/registry.js');
    ToolRegistry = reg.ToolRegistry;
    const types = await import('../../agent/unify/tools/types.js');
    defineTool = types.defineTool;
  });

  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool = defineTool({ name: 'A', execute: async () => '', modes: ['chat'] });
    registry.register(tool);

    expect(registry.has('A')).toBe(true);
    expect(registry.get('A')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('should filter by mode', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: 'ChatTool', execute: async () => '', modes: ['chat'] }));
    registry.register(defineTool({ name: 'WorkTool', execute: async () => '', modes: ['work'] }));
    registry.register(defineTool({ name: 'BothTool', execute: async () => '', modes: ['chat', 'work'] }));

    expect(registry.getToolNames('chat')).toEqual(['ChatTool', 'BothTool']);
    expect(registry.getToolNames('work')).toEqual(['WorkTool', 'BothTool']);
  });

  it('should resolve coordinator/worker to work mode', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: 'WorkTool', execute: async () => '', modes: ['work'] }));

    expect(registry.getToolNames('coordinator')).toEqual(['WorkTool']);
    expect(registry.getToolNames('worker')).toEqual(['WorkTool']);
  });

  it('should return empty for dream mode', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: 'WorkTool', execute: async () => '', modes: ['work'] }));
    registry.register(defineTool({ name: 'ChatTool', execute: async () => '', modes: ['chat'] }));

    expect(registry.getToolNames('dream')).toEqual([]);
  });

  it('should unregister tools', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: 'A', execute: async () => '' }));
    expect(registry.has('A')).toBe(true);
    registry.unregister('A');
    expect(registry.has('A')).toBe(false);
  });

  it('should get tool defs in API format', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'TestTool',
      description: 'Test description',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async () => '',
      modes: ['chat'],
    }));

    const defs = registry.getToolDefs('chat');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      name: 'TestTool',
      description: 'Test description',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    });
  });

  it('should execute tools', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'EchoTool',
      execute: async (input) => `echo: ${input.message}`,
    }));

    const result = await registry.execute('EchoTool', { message: 'hello' });
    expect(result).toBe('echo: hello');
  });

  it('should throw on unknown tool execution', async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute('NonExistent', {})).rejects.toThrow('Unknown tool');
  });
});

// ─── tools/mcp-tools.js tests ──────────────────────────────

describe('tools/mcp-tools.js', () => {
  let mcpTools;

  beforeEach(async () => {
    mcpTools = await import('../../agent/unify/tools/mcp-tools.js');
  });

  it('should export two tools as default array', () => {
    expect(mcpTools.default).toHaveLength(2);
    expect(mcpTools.mcpListTools.name).toBe('mcp_list_tools');
    expect(mcpTools.mcpCallTool.name).toBe('mcp_call_tool');
  });

  it('mcp_list_tools should handle no manager', async () => {
    const result = await mcpTools.mcpListTools.execute({}, {});
    const parsed = JSON.parse(result);
    expect(parsed.tools).toEqual([]);
    expect(parsed.message).toContain('No MCP servers');
  });

  it('mcp_list_tools should list tools from manager', async () => {
    const mockManager = {
      hasServers: true,
      listTools: () => [{ name: 'test__tool1', server: 'test', description: 'Tool 1', inputSchema: {} }],
      status: () => [{ name: 'test', ready: true, toolCount: 1 }],
    };

    const result = await mcpTools.mcpListTools.execute({}, { mcpManager: mockManager });
    const parsed = JSON.parse(result);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('test__tool1');
  });

  it('mcp_call_tool should handle no manager', async () => {
    const result = await mcpTools.mcpCallTool.execute({ tool_name: 'test' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('No MCP servers');
  });

  it('mcp_call_tool should handle missing tool_name', async () => {
    const mockManager = { hasServers: true };
    const result = await mcpTools.mcpCallTool.execute({}, { mcpManager: mockManager });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('tool_name is required');
  });
});

// ─── tools/enter-worktree.js tests ─────────────────────────

describe('tools/enter-worktree.js', () => {
  let enterWorktree;

  beforeEach(async () => {
    const mod = await import('../../agent/unify/tools/enter-worktree.js');
    enterWorktree = mod.default;
  });

  it('should have correct tool definition', () => {
    expect(enterWorktree.name).toBe('EnterWorktree');
    expect(enterWorktree.modes).toEqual(['work']);
    expect(enterWorktree.isDestructive()).toBe(false);
  });

  it('should fail outside a git repo', async () => {
    const result = await enterWorktree.execute({}, { cwd: '/tmp' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Not in a git repository');
  });
});

// ─── tools/exit-worktree.js tests ──────────────────────────

describe('tools/exit-worktree.js', () => {
  let exitWorktree;

  beforeEach(async () => {
    const mod = await import('../../agent/unify/tools/exit-worktree.js');
    exitWorktree = mod.default;
  });

  it('should have correct tool definition', () => {
    expect(exitWorktree.name).toBe('ExitWorktree');
    expect(exitWorktree.modes).toEqual(['work']);
  });

  it('should report error for non-existent path', async () => {
    const result = await exitWorktree.execute({ path: '/tmp/nonexistent-worktree', action: 'remove' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('does not exist');
  });

  it('should handle "keep" action', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'yeaft-wt-'));
    try {
      const result = await exitWorktree.execute({ path: tmpDir, action: 'keep' }, {});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('keep');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── tools/skill.js tests ──────────────────────────────────

describe('tools/skill.js', () => {
  let skillTool;

  beforeEach(async () => {
    const mod = await import('../../agent/unify/tools/skill.js');
    skillTool = mod.default;
  });

  it('should have correct tool definition', () => {
    expect(skillTool.name).toBe('Skill');
    expect(skillTool.modes).toEqual(['chat', 'work']);
    expect(skillTool.isReadOnly()).toBe(true);
  });

  it('should handle missing skill manager', async () => {
    const result = await skillTool.execute({ action: 'list' }, {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('not initialized');
  });

  it('should list skills from manager', async () => {
    const mockManager = {
      list: () => [{ name: 'sk1', description: 'Skill 1', trigger: 'trigger', mode: 'both' }],
    };

    const result = await skillTool.execute({ action: 'list' }, { skillManager: mockManager });
    const parsed = JSON.parse(result);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].name).toBe('sk1');
  });

  it('should load a specific skill', async () => {
    const mockManager = {
      getPromptContent: (name) => name === 'test' ? '## Skill: test\nContent' : '',
    };

    const result = await skillTool.execute({ action: 'load', name: 'test' }, { skillManager: mockManager });
    expect(result).toContain('## Skill: test');
  });

  it('should search skills', async () => {
    const mockManager = {
      findRelevant: () => [{ name: 'found', description: 'Found skill', trigger: 'testing' }],
    };

    const result = await skillTool.execute({ action: 'search', query: 'testing' }, { skillManager: mockManager });
    const parsed = JSON.parse(result);
    expect(parsed.results).toHaveLength(1);
  });
});

// ─── mcp.js tests ──────────────────────────────────────────

describe('mcp.js', () => {
  let MCPManager;

  beforeEach(async () => {
    const mod = await import('../../agent/unify/mcp.js');
    MCPManager = mod.MCPManager;
  });

  it('should create empty manager', () => {
    const manager = new MCPManager();
    expect(manager.hasServers).toBe(false);
    expect(manager.toolCount).toBe(0);
    expect(manager.status()).toEqual([]);
    expect(manager.listTools()).toEqual([]);
  });

  it('should throw on unknown tool call', async () => {
    const manager = new MCPManager();
    await expect(manager.callTool('nonexistent')).rejects.toThrow('not found');
  });
});
