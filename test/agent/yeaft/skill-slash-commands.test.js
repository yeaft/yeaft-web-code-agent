import { describe, it, expect, afterEach } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { buildMergedSkillSlashCommands, buildSkillSlashCommands, __testHooks } from '../../../agent/yeaft/web-bridge.js';

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
    __testHooks.setSessionForTest(null);
    await __testHooks.shutdownProjectRuntimes();
  });

  it('builds slash commands from loaded skill metadata', () => {
    const { commands, descriptions } = buildSkillSlashCommands({
      list: () => [
        { name: 'review-code', description: 'Review code' },
        { name: 'sprint', trigger: 'plan work' },
        { name: '', description: 'bad' },
      ],
    });

    expect(commands).toEqual(['skill:review-code', 'skill:sprint']);
    expect(descriptions).toEqual({
      'skill:review-code': 'Review code',
      'skill:sprint': 'plan work',
    });
  });

  it('merges global and project skill commands without duplicates', () => {
    const { commands, descriptions } = buildMergedSkillSlashCommands([
      { list: () => [{ name: 'review-code', description: 'Global review' }, { name: 'plan', description: 'Plan' }] },
      { list: () => [{ name: 'review-code', description: 'Project review' }, { name: 'ship', description: 'Ship' }, { name: '', description: 'bad' }] },
    ]);

    expect(commands).toEqual(['skill:plan', 'skill:review-code', 'skill:ship']);
    expect(descriptions['skill:review-code']).toBe('Project review');
  });

  it('injects an explicitly selected skill and strips the command before streaming', async () => {
    const adapter = new RecordingAdapter();
    const skillManager = {
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
    for await (const event of engine.query({ prompt: '/skill:review-code please review this' })) {
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

  it('reports unknown explicit skill commands in the system prompt', async () => {
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

    for await (const _event of engine.query({ prompt: '/skill:missing do work' })) {
      // Drain stream.
    }

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].system).toContain('Requested skill "missing" was not found');
    expect(adapter.calls[0].messages[0].content).toBe('do work');
  });
});
