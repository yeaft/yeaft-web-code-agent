import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, mkdtempSync, writeFileSync, readFileSync,
  appendFileSync, readdirSync, symlinkSync, utimesSync,
} from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'node:zlib';
import { lstat as lstatAsync, readdir as readdirAsync, stat as statAsync } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ActiveMemorySet } from '../../../agent/yeaft/memory/ams.js';
import { backfillCanonicalContent } from '../../../agent/yeaft/memory/content-backfill.js';
import { openSegmentIndex } from '../../../agent/yeaft/memory/index-db.js';
import { runPreflow } from '../../../agent/yeaft/memory/preflow.js';
import { cleanMemoryPromptText, filterMemoryPromptTextForPrompt, filterRelatedSessionPromptText } from '../../../agent/yeaft/memory/prompt-cleanup.js';
import { makeSegment, serializeSegments } from '../../../agent/yeaft/memory/segment.js';
import { readCanonicalContentRecord, readScope } from '../../../agent/yeaft/memory/segment-store.js';
import { syncAll, syncScope } from '../../../agent/yeaft/memory/segment-sync.js';
import { Engine, buildResidentEntries, selectCanonicalMemoryScopes, selectResidentTopicScopes, selectRelatedSessionIds } from '../../../agent/yeaft/engine.js';
import { flushAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { withUsageAccounting } from '../../../agent/yeaft/llm/usage-accounting.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { AmsRegistry } from '../../../agent/yeaft/memory/ams-registry.js';
import { writeContent, writeSummary } from '../../../agent/yeaft/memory/store.js';
import { NullTrace, DebugTrace, projectDebugDetailForWire } from '../../../agent/yeaft/debug-trace.js';
import { consolidateSessionTopics } from '../../../agent/yeaft/dream/topic-consolidation.js';
import { resolveTopicRedirect } from '../../../agent/yeaft/memory/topic-redirect.js';
import { runDream } from '../../../agent/yeaft/dream/runner.js';
import { classifySoft } from '../../../agent/yeaft/dream/triage.js';
import { readSessionState, writeSessionState } from '../../../agent/yeaft/dream/state.js';
import { extractAndWriteMemorySegments } from '../../../agent/yeaft/dream/segment-extract.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { buildSystemPrompt } from '../../../agent/yeaft/prompts.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import {
  CONDITIONAL_BUILTIN_TOOL_NAMES,
  resolveActiveToolNames,
} from '../../../agent/yeaft/tools/activation.js';
import discoverToolsTool, {
  TOOL_DISCOVERY_MAX_OUTPUT_BYTES,
  discoverToolCapabilities,
} from '../../../agent/yeaft/tools/discover-tools.js';
import {
  inferProjectDocScopes,
  projectDocWriteScopesNeedingReload,
  selectProjectDocContext,
} from '../../../agent/yeaft/sessions/project-doc.js';
import todoWriteTool from '../../../agent/yeaft/tools/todo-write.js';
import startPlanTool from '../../../agent/yeaft/tools/start-plan.js';
import {
  cleanupManagedCliRuntimePaths,
  ensureManagedCliTools,
  extractManagedCliBinary,
  managedCliBinDir,
  managedCliToolSpecs,
  prepareManagedCliToolEnvironment,
  prependManagedCliBinToPath,
  resolveManagedCliCommand,
  runAfterManagedCliRuntimeCleanup,
} from '../../../agent/yeaft/managed-cli.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { ToolRegistry, TOOL_RESULT_MAX_BYTES } from '../../../agent/yeaft/tools/registry.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import {
  createOutputCollector,
  listRipgrepCandidatePaths,
  nodeGrep,
  runRipgrep,
} from '../../../agent/yeaft/tools/grep.js';
import { nodeDiskUsage, runDust } from '../../../agent/yeaft/tools/disk-usage.js';
import { listFilesWithFd } from '../../../agent/yeaft/tools/glob.js';
import { runProcess } from '../../../agent/yeaft/tools/process-runner.js';
import bashTool, { createBashTool } from '../../../agent/yeaft/tools/bash.js';
import agentTool, { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import fileReadTool from '../../../agent/yeaft/tools/file-read.js';
import fileWriteTool from '../../../agent/yeaft/tools/file-write.js';
import {
  SearchBackendLimitError,
  SEARCH_SKIP_DIRS,
} from '../../../agent/yeaft/tools/search-paths.js';
import { __testSetWorkCenterService } from '../../../agent/yeaft/work-center/bridge.js';
import { WorkCenterService } from '../../../agent/yeaft/work-center/service.js';

// ─── Mock Adapter ─────────────────────────────────────────────

/**
 * MockAdapter — emits pre-configured events for testing.
 * Each call to stream() pops the next response from the queue.
 */
class MockAdapter {
  constructor() {
    this.responses = []; // Array of arrays of StreamEvent
    this.callLog = [];   // Records what was passed to stream()
  }

  /** Push a pre-configured response (array of StreamEvent). */
  pushResponse(events) {
    this.responses.push(events);
  }

  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) {
      throw new Error('MockAdapter: no more responses queued');
    }
    for (const event of events) {
      yield event;
    }
  }

  async call(params) {
    this.callLog.push(params);
    return { text: 'mock call response', usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

// ─── Test Setup ───────────────────────────────────────────────

const TEST_DB = join(tmpdir(), `yeaft-test-engine-${Date.now()}.db`);
let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

afterEach(() => {
  // Clean up any DB files
  for (const suffix of ['', '-wal', '-shm']) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) rmSync(path);
  }
});

// ─── Tests ────────────────────────────────────────────────────

describe('active tool exposure and scoped prompts', () => {
  it('keeps the user-required tools visible and activates other built-ins by condition', () => {
    const registry = createFullRegistry();
    const toolNames = registry.getToolNames();
    const baseline = resolveActiveToolNames({ toolNames, prompt: 'Explain this code.' });

    expect(toolNames).toContain('StartPlan');
    expect([...baseline]).toEqual(expect.arrayContaining([
      'WebSearch',
      'WebFetch',
      'ViewImage',
      'EnterWorktree',
      'ExitWorktree',
      'TodoWrite',
      'FileRead',
      'FileEdit',
      'Bash',
    ]));
    expect([...baseline]).not.toEqual(expect.arrayContaining([
      'StartPlan',
      'HistorySearch',
      'DiskUsage',
      'SpawnAgent',
      'ListAgents',
      'CreateWorkItem',
      'NotebookEdit',
      'ImageGeneration',
      'JsReplReset',
    ]));

    const contextual = resolveActiveToolNames({
      toolNames,
      prompt: 'Search the previous conversation, inspect disk usage, delegate an independent review, edit analysis.ipynb, and create a durable Work Item.',
      collabToolPolicy: 'multi-vp',
      activeTasks: [{ id: 'task_1', kind: 'shell' }],
      imageGenerationConfigured: true,
    });
    expect([...contextual]).toEqual(expect.arrayContaining([
      'HistorySearch',
      'DiskUsage',
      'SpawnAgent',
      'ListAgents',
      'ListTasks',
      'ReadTaskLog',
      'CancelTask',
      'RouteForward',
      'CreateWorkItem',
      'NotebookEdit',
    ]));
    expect(contextual.has('ListAgents')).toBe(true);
    expect(resolveActiveToolNames({
      toolNames,
      prompt: 'Run the task.',
    }).has('SpawnAgent')).toBe(true);

    const ordinaryLanguageCases = [
      ['What did we decide about authentication?', 'HistorySearch', {}],
      ['Please have another worker inspect this independently.', 'SpawnAgent', {}],
      ['Make me a logo for this project.', 'ImageGeneration', { imageGenerationConfigured: true }],
      ['Track this until it is finished across multiple sessions.', 'CreateWorkItem', {}],
      ['The server says ENOSPC. Investigate the cause.', 'DiskUsage', {}],
    ];
    for (const [request, expectedTool, extra] of ordinaryLanguageCases) {
      expect(resolveActiveToolNames({
        toolNames,
        prompt: request,
        ...extra,
      }).has(expectedTool), `${expectedTool} should activate for: ${request}`).toBe(true);
    }

    const withSubAgent = resolveActiveToolNames({
      toolNames,
      prompt: 'continue',
      subAgentToolsActivated: true,
    });
    expect([...withSubAgent]).toEqual(expect.arrayContaining([
      'SpawnAgent',
      'PromptAgent',
      'WaitAgent',
      'CloseAgent',
      'ListAgents',
    ]));
  });

  it('discovers conditional and flattened MCP capabilities without lexical reachability gaps', async () => {
    const registry = createFullRegistry();
    const mcpManager = {
      listTools: () => [{
        name: 'tracker__enumerate_open_defects',
        server: 'tracker',
        description: 'Enumerate open defect records from the project tracker.',
        inputSchema: {
          type: 'object',
          properties: { owner: { type: 'string' } },
        },
      }],
      callTool: async () => ({ content: [{ type: 'text', text: '[]' }] }),
    };
    registry.registerAll(buildMcpFlattenedTools(mcpManager));
    const toolNames = registry.getToolNames();
    const candidates = registry.getAllTools()
      .filter(tool => CONDITIONAL_BUILTIN_TOOL_NAMES.has(tool.name) || tool.name.startsWith('mcp__'))
      .map(tool => ({
        name: tool.name,
        description: typeof tool.description === 'object' ? tool.description.en : tool.description,
        parameters: tool.parameters,
      }));
    const paraphrases = [
      ['Bring back the approach we used for login.', 'HistorySearch'],
      ['Ask a separate specialist to examine this.', 'SpawnAgent'],
      ['I need artwork for the launch header.', 'ImageGeneration'],
      ['Make sure this objective keeps progressing after this chat.', 'CreateWorkItem'],
      ['Tell me what is consuming the drive.', 'DiskUsage'],
      ['显示分配给我的工单。', 'mcp__tracker__enumerate_open_defects'],
    ];
    for (const [prompt, expectedTool] of paraphrases) {
      const active = resolveActiveToolNames({
        toolNames,
        prompt,
        imageGenerationConfigured: true,
      });
      expect(active.has(expectedTool), `${expectedTool} starts hidden for: ${prompt}`).toBe(false);
      expect(active.has('DiscoverTools')).toBe(true);
      const directory = discoverToolCapabilities({ query: prompt, candidates });
      expect(directory.tools.map(tool => tool.name), `discovery directory for: ${prompt}`).toContain(expectedTool);
    }
    for (const query of ['Show me tickets I own.', 'List my unresolved work.', '列出我尚未解决的工作。']) {
      const directory = discoverToolCapabilities({ query, candidates });
      expect(directory.tools.map(tool => tool.name), `semantic MCP directory for: ${query}`)
        .toContain('mcp__tracker__enumerate_open_defects');
    }

    mockAdapter.pushResponse([
      {
        type: 'tool_call',
        id: 'discover_tracker',
        name: 'DiscoverTools',
        input: { query: 'Show me tickets I own.' },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    mockAdapter.pushResponse([
      {
        type: 'tool_call',
        id: 'call_tracker',
        name: 'mcp__tracker__enumerate_open_defects',
        input: { owner: '@me' },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'No matching defects.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      mcpManager,
    });
    const events = [];
    for await (const event of engine.query({
      prompt: 'Show me tickets I own.',
    })) events.push(event);

    expect(mockAdapter.callLog[0].tools.map(tool => tool.name)).toContain('DiscoverTools');
    expect(mockAdapter.callLog[0].tools.map(tool => tool.name)).not.toContain('mcp__tracker__enumerate_open_defects');
    const discoveryEvent = events.find(event => event.type === 'tool_end' && event.name === 'DiscoverTools');
    expect(discoveryEvent).toMatchObject({ isError: false });
    const discoveryResult = JSON.parse(discoveryEvent.output);
    expect(discoveryResult.tools.map(tool => tool.name)).toContain('mcp__tracker__enumerate_open_defects');
    expect(discoveryResult.tools.length).toBeLessThanOrEqual(24);
    expect(discoveryResult.tools.every(tool => !Object.hasOwn(tool, 'parameters'))).toBe(true);
    expect(Buffer.byteLength(discoveryEvent.output, 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);
    expect(mockAdapter.callLog[1].tools.map(tool => tool.name)).toContain('mcp__tracker__enumerate_open_defects');
    expect(events.find(event => event.type === 'tool_end' && event.name === 'mcp__tracker__enumerate_open_defects')).toMatchObject({
      output: '[]',
      isError: false,
    });
  });

  it('keeps real Engine discovery pagination stable and restarts after dynamic MCP changes', async () => {
    const toolRecords = Array.from({ length: 53 }, (_, index) => ({
      name: `catalog__capability_${String(index).padStart(2, '0')}`,
      server: 'catalog',
      description: `Capability ${index}`,
      inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
    }));
    const calls = [];
    const mcpManager = {
      listTools: () => toolRecords,
      callTool: async (name, input) => {
        calls.push({ name, input });
        return { content: [{ type: 'text', text: `called ${name}` }] };
      },
    };
    const registry = createFullRegistry();
    registry.registerAll(buildMcpFlattenedTools(mcpManager));
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'tool_call', id: 'page-1', name: 'DiscoverTools', input: { query: '没有词法匹配' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'tool_call', id: 'page-2', name: 'DiscoverTools', input: { query: '没有词法匹配', cursor: 24 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'tool_call', id: 'call-middle', name: 'mcp__catalog__capability_30', input: { value: 30 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'tool_call', id: 'page-3', name: 'DiscoverTools', input: { query: '没有词法匹配', cursor: 48 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'tool_call', id: 'stale-sequence', name: 'DiscoverTools', input: { query: '没有词法匹配', cursor: 48 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'All discovery pages were reachable.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      mcpManager,
    });
    const events = [];
    for await (const event of engine.query({ prompt: 'Inspect the complete hidden catalogue.' })) events.push(event);

    const staleSequence = JSON.parse(events.find(event => event.id === 'stale-sequence' && event.type === 'tool_end').output);
    expect(staleSequence).toMatchObject({ tools: [], next_cursor: null, restart_required: true });
    const pages = events
      .filter(event => event.type === 'tool_end' && event.name === 'DiscoverTools' && event.id !== 'stale-sequence')
      .map(event => JSON.parse(event.output));
    const expectedDirectoryNames = registry.getAllTools()
      .filter(tool => CONDITIONAL_BUILTIN_TOOL_NAMES.has(tool.name) || tool.name.startsWith('mcp__'))
      .map(tool => tool.name);
    expect(pages.map(page => ({ count: page.tools.length, next: page.next_cursor, total: page.total, restart: page.restart_required })))
      .toEqual([
        { count: 24, next: 24, total: expectedDirectoryNames.length, restart: undefined },
        { count: 24, next: 48, total: expectedDirectoryNames.length, restart: undefined },
        { count: expectedDirectoryNames.length - 48, next: null, total: expectedDirectoryNames.length, restart: undefined },
      ]);
    expect(pages.map(page => page.next_cursor)).toEqual([24, 48, null]);
    expect(pages.map(page => page.total)).toEqual([
      expectedDirectoryNames.length,
      expectedDirectoryNames.length,
      expectedDirectoryNames.length,
    ]);
    const pageNames = pages.flatMap(page => page.tools.map(tool => tool.name));
    expect(pageNames).toHaveLength(expectedDirectoryNames.length);
    expect(new Set(pageNames)).toEqual(new Set(expectedDirectoryNames));
    expect(pageNames.filter(name => name === 'mcp__catalog__capability_30')).toHaveLength(1);
    expect(adapter.callLog[2].tools.map(tool => tool.name)).toContain('mcp__catalog__capability_30');
    expect(adapter.callLog[3].tools.map(tool => tool.name)).toContain('mcp__catalog__capability_30');
    expect(events.find(event => event.id === 'call-middle' && event.type === 'tool_end')).toMatchObject({
      isError: false,
      output: 'called catalog__capability_30',
    });
    expect(calls).toEqual([{ name: 'catalog__capability_30', input: { value: 30 } }]);

    const schemaChangedRecords = toolRecords.map((tool, index) => index === 0
      ? { ...tool, description: 'Capability zero changed during traversal' }
      : tool);
    mcpManager.listTools = () => schemaChangedRecords;
    registry.replaceMcpTools(mcpManager, buildMcpFlattenedTools);
    const schemaChangedAdapter = new MockAdapter();
    schemaChangedAdapter.pushResponse([
      { type: 'tool_call', id: 'schema-start', name: 'DiscoverTools', input: { query: 'schema-changing catalogue' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    schemaChangedAdapter.pushResponse([
      { type: 'tool_call', id: 'schema-stale', name: 'DiscoverTools', input: { query: 'schema-changing catalogue', cursor: 24 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    schemaChangedAdapter.pushResponse([
      { type: 'text_delta', text: 'The schema change required a restart.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const schemaChangedEngine = new Engine({
      adapter: schemaChangedAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      mcpManager,
    });
    const schemaEvents = [];
    const schemaQuery = schemaChangedEngine.query({ prompt: 'Inspect a schema-changing catalogue.' });
    const originalStream = schemaChangedAdapter.stream.bind(schemaChangedAdapter);
    let streamCalls = 0;
    schemaChangedAdapter.stream = async function* (params) {
      streamCalls += 1;
      if (streamCalls === 2) {
        const mutated = schemaChangedRecords.map((tool, index) => index === 0
          ? { ...tool, description: 'Capability zero changed again', inputSchema: { type: 'object', properties: { changed: { type: 'boolean' } } } }
          : tool);
        mcpManager.listTools = () => mutated;
        registry.replaceMcpTools(mcpManager, buildMcpFlattenedTools);
      }
      yield* originalStream(params);
    };
    for await (const event of schemaQuery) schemaEvents.push(event);
    const schemaStale = JSON.parse(schemaEvents.find(event => event.id === 'schema-stale' && event.type === 'tool_end').output);
    expect(schemaStale).toMatchObject({ tools: [], next_cursor: null, restart_required: true });

    const changedRecords = [
      toolRecords[0],
      { name: 'catalog__replacement', server: 'catalog', description: 'Replacement capability', inputSchema: { type: 'object', properties: {} } },
    ];
    const boundedRestart = await discoverToolsTool.execute(
      { query: 'changed catalogue', cursor: 24 },
      {
        discoverTools: () => ({
          tools: [],
          next_cursor: null,
          total: 2,
          omitted_invalid: 0,
          restart_required: true,
          message: 'Restart discovery without a cursor.',
        }),
      },
    );
    expect(Buffer.byteLength(boundedRestart, 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);
    expect(JSON.parse(boundedRestart)).toMatchObject({ restart_required: true, next_cursor: null });
    mcpManager.listTools = () => changedRecords;
    registry.replaceMcpTools(mcpManager, buildMcpFlattenedTools);
    const changedAdapter = new MockAdapter();
    changedAdapter.pushResponse([
      { type: 'tool_call', id: 'stale-page', name: 'DiscoverTools', input: { query: '没有词法匹配', cursor: 24 } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    changedAdapter.pushResponse([
      { type: 'tool_call', id: 'restart-page', name: 'DiscoverTools', input: { query: '没有词法匹配' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    changedAdapter.pushResponse([
      { type: 'text_delta', text: 'Restarted against the changed directory.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const changedEngine = new Engine({
      adapter: changedAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      mcpManager,
    });
    const changedEvents = [];
    for await (const event of changedEngine.query({ prompt: 'Inspect the changed hidden catalogue.' })) changedEvents.push(event);
    const stale = JSON.parse(changedEvents.find(event => event.id === 'stale-page' && event.type === 'tool_end').output);
    expect(stale).toMatchObject({ tools: [], next_cursor: null, restart_required: true });
    const restarted = JSON.parse(changedEvents.find(event => event.id === 'restart-page' && event.type === 'tool_end').output);
    const restartedNames = restarted.tools.map(tool => tool.name);
    expect(restarted.next_cursor).toBeNull();
    expect(restarted.restart_required).not.toBe(true);
    expect(restartedNames).toContain('mcp__catalog__capability_00');
    expect(restartedNames).toContain('mcp__catalog__replacement');
    expect(restartedNames.some(name => name.startsWith('mcp__catalog__capability_01'))).toBe(false);
  });

  it('pages the complete hidden directory and bounds hostile metadata before serialization', () => {
    const candidates = Array.from({ length: 53 }, (_, index) => ({
      name: `mcp__catalog__capability_${String(index).padStart(2, '0')}`,
      description: `Capability ${index}`,
      parameters: { type: 'object', properties: {} },
    }));
    const seen = new Set();
    let cursor = 0;
    do {
      const result = discoverToolCapabilities({ query: '没有词法匹配', candidates, cursor });
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);
      for (const tool of result.tools) seen.add(tool.name);
      cursor = result.next_cursor;
    } while (cursor != null);
    expect(seen).toEqual(new Set(candidates.map(tool => tool.name)));

    const hostile = Array.from({ length: 24 }, (_, index) => ({
      name: `mcp__hostile__${index}_${'x'.repeat(10_000)}`,
      description: 'y'.repeat(10_000),
      parameters: { type: 'object', properties: {} },
    }));
    const bounded = discoverToolCapabilities({ query: 'anything', candidates: hostile });
    expect(bounded.tools).toEqual([]);
    expect(bounded.next_cursor).toBeNull();
    expect(bounded.omitted_invalid).toBe(24);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);

    const metadataBounded = discoverToolCapabilities({
      query: 'anything',
      candidates: [{ name: `mcp__near_limit__${'n'.repeat(200)}`, description: 'z'.repeat(10_000) }],
    });
    expect(metadataBounded.tools).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(metadataBounded), 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);

    const invalidCursor = discoverToolCapabilities({ query: 'anything', candidates, cursor: 54 });
    expect(invalidCursor).toMatchObject({
      tools: [],
      next_cursor: null,
      total: 53,
      restart_required: true,
    });
    expect(Buffer.byteLength(JSON.stringify(invalidCursor), 'utf8')).toBeLessThanOrEqual(TOOL_DISCOVERY_MAX_OUTPUT_BYTES);
  });

  it('filters provider schemas and fences execution with canonical alias activation', async () => {
    const registry = createFullRegistry();
    const baseline = resolveActiveToolNames({
      toolNames: registry.getToolNames(),
      prompt: 'Explain this code.',
    });
    const defs = registry.getToolDefs('en', { activeToolNames: baseline });
    const names = defs.map(def => def.name);
    const hiddenDirectory = discoverToolCapabilities({
      query: 'reset the JavaScript scratchpad',
      candidates: registry.getAllTools()
        .filter(tool => CONDITIONAL_BUILTIN_TOOL_NAMES.has(tool.name))
        .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    });

    expect(names).toContain('WebSearch');
    expect(names).toContain('EnterWorktree');
    expect(names).not.toContain('SpawnAgent');
    expect(hiddenDirectory.tools.map(tool => tool.name)).not.toContain('JsReplReset');
    expect(registry.isAllowed('Agent', { activeToolNames: baseline })).toBe(false);
    expect(registry.has('Agent')).toBe(true);
    expect(registry.isAllowed('Agent', {
      activeToolNames: new Set([...baseline, 'SpawnAgent']),
    })).toBe(true);
  });

  it('keeps custom tools visible and blocks a hidden built-in hallucination in the Engine', async () => {
    const registry = new ToolRegistry();
    let hiddenExecutions = 0;
    registry.register({
      name: 'DiskUsage',
      description: 'Conditionally active disk tool',
      parameters: { type: 'object', properties: {} },
      isReadOnly: () => true,
      execute: async () => {
        hiddenExecutions += 1;
        return 'should not run';
      },
    });
    registry.register({
      name: 'CustomHostTool',
      description: 'Embedding-defined tool',
      parameters: { type: 'object', properties: {} },
      isReadOnly: () => true,
      execute: async () => 'custom',
    });

    mockAdapter.pushResponse([
      { type: 'tool_call', id: 'hidden', name: 'DiskUsage', input: { path: '.' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'The tool was inactive.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });
    const events = [];
    for await (const event of engine.query({ prompt: 'Explain this code.' })) events.push(event);

    const firstNames = mockAdapter.callLog[0].tools.map(tool => tool.name);
    expect(firstNames).toContain('CustomHostTool');
    expect(firstNames).not.toContain('DiskUsage');
    expect(hiddenExecutions).toBe(0);
    expect(events.find(event => event.type === 'tool_end')).toMatchObject({ isError: true });
    expect(events.find(event => event.type === 'tool_end').output).toContain('not active');
  });

  it('selects project core and task-scoped sections while preserving a directory', () => {
    const padding = 'core rule '.repeat(900);
    const projectDoc = [
      '# Example Project',
      '',
      'Project overview.',
      '',
      '## Product Model and Terminology',
      padding,
      '',
      '## Agent Runtime',
      'AGENT_RUNTIME_RULE',
      '',
      '## Web and Server',
      'WEB_SERVER_RULE',
      '',
      '## UI Rules',
      'UI_RULE',
      '',
      '## Worktree Review and Release',
      'RELEASE_RULE',
      '',
      '## Operations and Security',
      'SECURITY_RULE',
    ].join('\n');

    const selected = selectProjectDocContext(projectDoc, {
      prompt: 'Change agent/yeaft/engine.js prompt assembly.',
      language: 'en',
    });
    expect(selected.scoped).toBe(true);
    expect(selected.text).toContain('AGENT_RUNTIME_RULE');
    expect(selected.text).toContain('SECURITY_RULE');
    expect(selected.text).not.toContain('\nWEB_SERVER_RULE\n');
    expect(selected.text).toContain('Project Rules Available On Demand');
    expect(selected.text).toContain('- Web and Server');

    const missingWebRules = projectDocWriteScopesNeedingReload(selected, ['web/stores/chat.js']);
    expect([...missingWebRules]).toContain('web');
    const reloaded = selectProjectDocContext(projectDoc, {
      prompt: 'Change agent/yeaft/engine.js prompt assembly.',
      pathHints: ['web/stores/chat.js'],
      forcedScopes: missingWebRules,
      language: 'en',
    });
    expect(reloaded.text).toContain('WEB_SERVER_RULE');
    expect(projectDocWriteScopesNeedingReload(reloaded, ['web/stores/chat.js']).size).toBe(0);
    expect([...inferProjectDocScopes({ pathHints: ['web/stores/chat.js'] })]).toContain('web');
  });

  it('uses stable core plus active guidance without repeating the tool catalogue', () => {
    const concise = buildSystemPrompt({ language: 'en', toolNames: ['WebSearch', 'FileRead'] });
    const planned = buildSystemPrompt({ language: 'en', toolNames: ['FileRead', 'StartPlan', 'TodoWrite'] });

    expect(concise).toContain('Session Participant');
    expect(concise).toContain('Active Tool Guidance');
    expect(concise).toContain('Read existing files before editing');
    expect(concise).toContain('do not revert changes you did not make');
    expect(concise).toContain('Do not amend commits unless the user explicitly asks');
    expect(concise).toContain('Do not use `git reset --hard` or `git clean -f` without user approval');
    expect(concise).not.toContain('Available tools:');
    expect(concise).not.toContain('For non-trivial multi-step work');
    expect(planned).toContain('For non-trivial multi-step work');
    expect(planned).not.toContain('Available tools: FileRead');
  });

  it('preserves image generation configuration through the authoritative loader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-image-config-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        primaryModel: 'test-model',
        imageApiUrl: 'https://images.example.test/generate',
      }));
      expect(loadConfig({ dir }).imageApiUrl).toBe('https://images.example.test/generate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes task-management schemas after a current-turn background task starts', async () => {
    const registry = new ToolRegistry();
    const activeTasks = [];
    registry.register({
      name: 'Bash',
      description: 'Start a shell command.',
      parameters: { type: 'object', properties: {} },
      isReadOnly: () => false,
      execute: async () => {
        activeTasks.push({ id: 'task_live', kind: 'shell', status: 'running' });
        return 'Started background task task_live.';
      },
    });
    for (const name of ['ListTasks', 'ReadTaskLog', 'CancelTask']) {
      registry.register({
        name,
        description: `${name} description`,
        parameters: { type: 'object', properties: {} },
        isReadOnly: () => true,
        execute: async () => 'ok',
      });
    }
    const taskManager = {
      listActiveTasks: () => [...activeTasks],
      renderActiveTasksForPrompt: () => activeTasks.length > 0 ? 'task_live is running' : '',
    };
    mockAdapter.pushResponse([
      { type: 'tool_call', id: 'start_bg', name: 'Bash', input: { command: 'npm start', background: true } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    mockAdapter.pushResponse([
      { type: 'text_delta', text: 'The server is running in the background.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const engine = new Engine({
      adapter: mockAdapter,
      trace,
      config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
      taskManager,
    });
    for await (const _event of engine.query({ prompt: 'Start the dev server and leave it running.' })) { /* drain */ }

    expect(mockAdapter.callLog[0].tools.map(tool => tool.name)).not.toContain('ListTasks');
    expect(mockAdapter.callLog[1].tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'ListTasks',
      'ReadTaskLog',
      'CancelTask',
    ]));
    expect(mockAdapter.callLog[1].system).toContain('task_live is running');
  });

  it('reloads unclassified and Bash write rules before executing against a large project doc', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-project-doc-reload-'));
    const projectDoc = [
      '# Example Project',
      'Project preamble.',
      '## Product Model and Terminology',
      'CORE_RULE '.repeat(900),
      '## Naming and Compatibility Rules',
      'PARENT_CORE_RULE',
      '### No Version-Suffix Filenames',
      'CORE_CHILD_RULE',
      '## Database Migrations',
      'DATABASE_MIGRATION_RULE',
      '## Web and Server',
      'WEB_RULE',
    ].join('\n');
    writeFileSync(join(workDir, 'CLAUDE.md'), projectDoc);
    try {
      for (const toolCall of [
        { name: 'FileWrite', input: { file_path: 'db/migrations/002.sql', content: 'ALTER TABLE example;' } },
        { name: 'Bash', input: { command: 'node scripts/migrate.js' } },
      ]) {
        const adapter = new MockAdapter();
        let executions = 0;
        const registry = new ToolRegistry();
        registry.register({
          name: toolCall.name,
          description: `${toolCall.name} test tool`,
          parameters: { type: 'object', properties: {} },
          isReadOnly: () => false,
          execute: async () => {
            executions += 1;
            return 'executed';
          },
        });
        adapter.pushResponse([
          { type: 'tool_call', id: `write_${toolCall.name}`, ...toolCall },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'Reviewed the newly loaded rules.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, projectDocMaxBytes: 64 * 1024 },
          toolRegistry: registry,
        });
        const events = [];
        for await (const event of engine.query({
          prompt: 'Update the deployment state.',
          workDir,
        })) events.push(event);

        expect(executions).toBe(0);
        expect(events.find(event => event.type === 'tool_end')).toMatchObject({
          isError: true,
          skipped: true,
        });
        expect(adapter.callLog[1].system).toContain('DATABASE_MIGRATION_RULE');
        expect(adapter.callLog[1].system).toContain('CORE_CHILD_RULE');
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('Engine memory prompt hygiene', () => {
  it('normalizes current and related Session summaries into separate resident sources', () => {
    const currentEntries = buildResidentEntries({
      sessionId: 's1',
      ownVpId: 'linus',
      summaries: {
        session: 'Useful session fact.\n\n<!-- dream-state -->\nlastDreamAt: 2026-07-17T00:00:00.000Z\n<!-- /dream-state -->',
        topics: [{
          scope: 'sessions/s1/topic/dream/recall',
          summary: 'Topic detail stays.\n<!-- dream-state -->\nlastDreamAt: old\n<!-- /dream-state -->',
        }],
      },
    });

    expect(currentEntries).toEqual([
      { scope: 'sessions/s1', summary: 'Useful session fact.' },
      { scope: 'sessions/s1/topic/dream/recall', summary: 'Topic detail stays.' },
    ]);

    const relatedEntries = buildResidentEntries({
      sessionId: 's1',
      ownVpId: 'linus',
      summaries: {
        session: 'Current Session memory.',
        relatedSessions: [
          { sessionId: 's2', summary: 'Past Session experience: verify the remote tag target.' },
          { sessionId: 's1', summary: 'Duplicate current Session summary must not be re-added.' },
          { sessionId: 's3', summary: '<!-- dream-state -->\nold metadata\n<!-- /dream-state -->\nKeep this sibling lesson.' },
        ],
      },
    });

    expect(relatedEntries).toEqual([
      { scope: 'sessions/s1', summary: 'Current Session memory.' },
      { scope: 'sessions/s2', summary: 'Past Session experience: verify the remote tag target.' },
      { scope: 'sessions/s3', summary: 'Keep this sibling lesson.' },
    ]);
  });

  it('drops unrelated sibling chunks even when the query repeats their generic headings', () => {
    const sibling = [
      '# Yeaft settings tabs',
      '',
      '## 需求与设计决策',
      '',
      '- 用户要求把 VP 库、搜索和 MCP 改为扁平下划线标签。',
      '- PR #1542 已合并，dev tag 为 v1.0.364。',
    ].join('\n');
    const unrelatedQuery = '和当前 session 无关的内容不应该添加，比如每个 PR 明细和需求与设计决策。';

    expect(filterRelatedSessionPromptText(sibling, unrelatedQuery)).toBe('');
    expect(filterRelatedSessionPromptText(
      sibling,
      '设置页的 VP 库、MCP 下划线标签在窄屏应该怎么处理？',
    )).toContain('VP 库、搜索和 MCP');
    expect(filterRelatedSessionPromptText(
      '# Yeaft 设置页\n\n- VP/MCP 下划线标签在窄屏使用横向滚动。\n\n- PR #1542 已合并。',
      'Yeaft 设置页',
    )).toBe('# Yeaft 设置页\n\n- VP/MCP 下划线标签在窄屏使用横向滚动。');
  });

  it('preserves compound CJK terms in current Session recall with a real FTS index', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-current-session-cjk-recall-'));
    const index = openSegmentIndex(join(root, 'index.db'));
    try {
      const fixtures = [
        ['design-pattern', '设计模式', '设计模式用于组织可维护的领域代码。'],
        ['user-auth', '用户认证', '用户认证必须检查会话所有权。'],
        ['requirements-analysis', '需求分析', '需求分析应保留明确的验收条件。'],
        ['content-safety', '内容安全', '内容安全规则不能泄露敏感工具载荷。'],
      ];
      for (const [id, query, body] of fixtures) {
        index.upsert(makeSegment({
          id,
          scope: 'sessions/current-session',
          kind: 'context',
          tags: ['canonical-content'],
          body,
          sourceMessages: [],
          createdAt: '2026-08-07T00:00:00.000Z',
          updatedAt: '2026-08-07T00:00:00.000Z',
        }));
        const recall = runPreflow(index, {
          userMsg: query,
          relevantScopes: ['sessions/current-session'],
          canonicalOnly: true,
        });
        expect(recall.picked, query).toEqual([
          expect.objectContaining({ id, scope: 'sessions/current-session' }),
        ]);
      }
    } finally {
      index.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates AMS layers without dropping needed on-demand memory', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 400, recent: 300, onDemand: 300 },
    });
    const repeated = 'Dream topic recall should load topic memory through AMS without repeating the same storage path details in every injected line.';
    ams.setResident([{ scope: 'sessions/s1', summary: repeated }]);
    ams.touchRecent({ id: 'recent-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] });
    ams.setOnDemand([
      { id: 'od-1', scope: 'sessions/s1/topic/dream', body: repeated, kind: 'context', tags: [], sourceMessages: [] },
      { id: 'od-2', scope: 'sessions/s1/topic/dream', body: 'A distinct implementation detail remains available.', kind: 'context', tags: [], sourceMessages: [] },
    ]);

    const snap = ams.snapshot();

    expect(snap.resident.map(entry => entry.summary)).toEqual([repeated]);
    expect(snap.recent).toEqual([]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual(['A distinct implementation detail remains available.']);

    const overBudget = new ActiveMemorySet({
      budget: { total: 100, resident: 1, recent: 1, onDemand: 80 },
    });
    const overBudgetRepeated = 'Budget-sensitive Dream memory detail should remain available from onDemand when the resident copy is too large for the resident budget.';
    overBudget.setResident([{ scope: 'sessions/s1', summary: overBudgetRepeated }]);
    overBudget.setOnDemand([
      { id: 'od-1', scope: 'sessions/s1/topic/dream', body: overBudgetRepeated, kind: 'context', tags: [], sourceMessages: [] },
    ]);
    const overBudgetSnap = overBudget.snapshot();
    expect(overBudgetSnap.resident).toEqual([]);
    expect(overBudgetSnap.onDemand.map(seg => seg.body)).toEqual([overBudgetRepeated]);

    const prefixAms = new ActiveMemorySet({
      budget: { total: 1000, resident: 300, recent: 100, onDemand: 600 },
    });
    const summary = 'Dream recall should include topic memory generated by Dream and avoid noisy repeated scope path labels in prompts.';
    const detail = `${summary} Critical extra detail: FTS fallback must use topic-prioritized round-robin so user/session oversized segments cannot starve topic memory.`;
    prefixAms.setResident([{ scope: 'sessions/s1', summary }]);
    prefixAms.setOnDemand([
      { id: 'od-detail', scope: 'sessions/s1/topic/dream', body: detail, kind: 'context', tags: [], sourceMessages: [] },
    ]);

    const prefixSnap = prefixAms.snapshot();

    expect(prefixSnap.resident.map(entry => entry.summary)).toEqual([summary]);
    expect(prefixSnap.onDemand.map(seg => seg.body)).toEqual([detail]);
  });

  it('filters transient WorkItem state by query relevance', () => {
    const ams = new ActiveMemorySet({
      budget: { total: 1000, resident: 500, recent: 200, onDemand: 300 },
    });
    ams.setResident([
      {
        scope: 'sessions/s1',
        summary: [
          'Reusable Dream memory rule: topic recall must stay precise.',
          '',
          'Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
        ].join('\n'),
      },
    ]);
    ams.setOnDemand([
      {
        id: 'billing-work-item',
        scope: 'sessions/s1/topic/billing',
        body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
      {
        id: 'dream-rule',
        scope: 'sessions/s1/topic/dream',
        body: 'Dream memory relevance should keep stable topic recall facts available.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
    ]);

    const snap = ams.snapshot({ userMsg: '优化 Dream memory relevance，减少无关状态' });

    expect(snap.resident.map(entry => entry.summary)).toEqual([
      'Reusable Dream memory rule: topic recall must stay precise.',
    ]);
    expect(snap.onDemand.map(seg => seg.body)).toEqual([
      'Dream memory relevance should keep stable topic recall facts available.',
    ]);

    const relatedAms = new ActiveMemorySet({
      budget: { total: 1000, resident: 500, recent: 200, onDemand: 300 },
    });
    relatedAms.setOnDemand([
      {
        id: 'billing-work-item',
        scope: 'sessions/s1/topic/billing',
        body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
        kind: 'context',
        tags: [],
        sourceMessages: [],
      },
    ]);

    const relatedSnap = relatedAms.snapshot({ userMsg: '继续 billing dashboard export 的 work item' });

    expect(relatedSnap.onDemand.map(seg => seg.body)).toEqual([
      'Work Item #884: billing dashboard export is in progress and awaiting review.',
    ]);
  });

  it('keeps stable markdown bullets when a sibling transient bullet is unrelated', () => {
    const filtered = filterMemoryPromptTextForPrompt(
      [
        '- Stable preference: user wants Dream memory topic labels compact.',
        '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
      ].join('\n'),
      '优化 Dream memory relevance，减少无关状态',
    );

    expect(filtered).toBe('- Stable preference: user wants Dream memory topic labels compact.');

    const related = filterMemoryPromptTextForPrompt(
      [
        '- Stable preference: user wants Dream memory topic labels compact.',
        '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
      ].join('\n'),
      '继续 billing dashboard export 的 work item',
    );
    expect(related).toBe([
      '- Stable preference: user wants Dream memory topic labels compact.',
      '- Current Work Item #884: build billing dashboard export. Next step: merge PR #884.',
    ].join('\n'));
  });

  it('migrates, selects, and consolidates canonical topic content without the old 24-topic cutoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-canonical-topic-'));
    const topics = Array.from({ length: 30 }, (_, index) => `sessions/s1/topic/catalog/topic-${index}`);
    let index;
    try {
      for (const [position, scope] of topics.entries()) {
        mkdirSync(join(root, scope), { recursive: true });
        const body = position === 29
          ? 'Attachment input identity must be isolated by occurrence and never injected twice.'
          : `Unrelated catalog record ${position}.`;
        writeFileSync(join(root, scope, 'memory.md'), serializeSegments([
          makeSegment({ scope, body, sourceMessages: [`m${position}`] }),
        ]));
      }

      const legacyPlainScope = 'sessions/s1/topic/catalog/legacy-plain';
      mkdirSync(join(root, legacyPlainScope), { recursive: true });
      writeFileSync(
        join(root, legacyPlainScope, 'memory.md'),
        '# Before\n\nalpha\n\n---\n\nTHIS MUST SURVIVE\n\n---\n\nomega\n',
      );
      const metadataLikeFixtures = [
        [
          'legacy-kind-prose',
          '# Before\n\n---\nkind: important\nTHIS PROSE MUST SURVIVE\n---\n\nafter',
        ],
        [
          'legacy-id-prose',
          'Intro\n\n---\nid: human-readable-section\nThis line is prose, not metadata.\n---\n\nTail',
        ],
        [
          'legacy-leading-kind-prose',
          '---\nkind: important\nTHIS LEADING PROSE MUST SURVIVE\n---\n\nafter',
        ],
        [
          'legacy-leading-id-prose',
          '---\nid: human-readable-section\nThis leading line is prose, not metadata.\n---\n\nTail',
        ],
        [
          'legacy-full-looking-invalid-schema',
          [
            '---',
            'id: seg_deadbeef',
            'scope: user',
            'kind: important',
            'tags: [human-note]',
            'sourceMessages: []',
            'createdAt: someday',
            'updatedAt: later',
            '---',
            'THIS FULL-LOOKING PROSE MUST SURVIVE',
          ].join('\n'),
        ],
      ];
      for (const [name, body] of metadataLikeFixtures) {
        const scope = `sessions/s1/topic/catalog/${name}`;
        mkdirSync(join(root, scope), { recursive: true });
        writeFileSync(join(root, scope, 'memory.md'), `${body}\n`);
      }

      expect(backfillCanonicalContent(root)).toEqual({ created: 36 });
      const legacyContent = readFileSync(join(root, legacyPlainScope, 'content.md'), 'utf8');
      expect(existsSync(join(root, legacyPlainScope, 'memory.md'))).toBe(false);
      expect(readFileSync(
        join(root, '.legacy', 'plain-memory', legacyPlainScope, 'memory.md'),
        'utf8',
      )).toContain('THIS MUST SURVIVE');
      expect(legacyContent).toContain('# Before');
      expect(legacyContent).toContain('THIS MUST SURVIVE');
      expect(legacyContent).toContain('omega');
      for (const [name, body] of metadataLikeFixtures) {
        const contentPath = join(root, 'sessions/s1/topic/catalog', name, 'content.md');
        expect(readFileSync(contentPath, 'utf8')).toBe(`${body}\n`);
        expect(existsSync(join(root, 'sessions/s1/topic/catalog', name, 'memory.md'))).toBe(false);
        expect(readFileSync(
          join(root, '.legacy', 'plain-memory', 'sessions/s1/topic/catalog', name, 'memory.md'),
          'utf8',
        )).toBe(`${body}\n`);
      }
      expect(backfillCanonicalContent(root)).toEqual({ created: 0 });
      expect(readFileSync(join(root, legacyPlainScope, 'content.md'), 'utf8')).toBe(legacyContent);
      for (const [name, body] of metadataLikeFixtures) {
        const contentPath = join(root, 'sessions/s1/topic/catalog', name, 'content.md');
        expect(readFileSync(contentPath, 'utf8')).toBe(`${body}\n`);
      }
      index = openSegmentIndex(join(root, 'index.db'));
      expect(syncAll(root, index)).toMatchObject({ scopes: 36 });
      expect(index.listByScope(legacyPlainScope)).toEqual([
        expect.objectContaining({
          tags: expect.arrayContaining(['canonical-content']),
          sourceMessages: [],
          body: expect.stringContaining('THIS MUST SURVIVE'),
        }),
      ]);
      index.upsert({
        id: 'near-match-tag',
        scope: topics[0],
        kind: 'context',
        tags: ['not-canonical-content'],
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        body: 'Attachment input identity duplicate occurrence.',
      });

      const recall = runPreflow(index, {
        userMsg: 'prevent duplicate attachment input identity injection by occurrence',
        relevantScopes: [...topics, legacyPlainScope],
        pickLimit: 8,
        uniqueScopes: true,
        canonicalOnly: true,
        topK: 500,
      });
      expect(recall.picked[0]?.scope).toBe(topics[29]);
      expect(recall.hits.some(hit => hit.id === 'near-match-tag')).toBe(false);
      expect(selectCanonicalMemoryScopes(recall.picked)).toEqual(new Set([topics[29]]));
      expect(selectResidentTopicScopes(topics, recall.picked)).toEqual([topics[29]]);

      const broadUserScope = 'user';
      index.upsert(makeSegment({
        id: 'strict-user',
        scope: broadUserScope,
        kind: 'context',
        tags: ['canonical-content'],
        body: 'Server cleanup failures require explicit disk investigation and container verification.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      const weakUser = runPreflow(index, {
        userMsg: 'Dream failure',
        relevantScopes: [broadUserScope],
        strictScopes: [broadUserScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(weakUser.picked).toEqual([]);
      expect(weakUser.droppedByRelevance).toBe(1);
      const strongUser = runPreflow(index, {
        userMsg: 'server cleanup failure disk',
        relevantScopes: [broadUserScope],
        strictScopes: [broadUserScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(strongUser.picked).toEqual([
        expect.objectContaining({ id: 'strict-user', scope: broadUserScope }),
      ]);

      const strictScope = 'sessions/sibling-session';
      index.upsert(makeSegment({
        id: 'strict-sibling',
        scope: strictScope,
        kind: 'context',
        tags: ['canonical-content', 'timeout'],
        body: '# timeout\n\nTimeout cleanup failures must return a tool result so Engine continuation stays reliable.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      const weakSibling = runPreflow(index, {
        userMsg: 'check timeout behavior',
        relevantScopes: [strictScope],
        strictScopes: [strictScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(weakSibling.picked).toEqual([]);
      expect(weakSibling.droppedByRelevance).toBe(1);
      const strongSibling = runPreflow(index, {
        userMsg: 'check timeout cleanup failure',
        relevantScopes: [strictScope],
        strictScopes: [strictScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(strongSibling.picked).toEqual([
        expect.objectContaining({ id: 'strict-sibling', scope: strictScope }),
      ]);
      expect(strongSibling.droppedByRelevance).toBe(0);
      const preciseTimeout = runPreflow(index, {
        userMsg: 'timeout',
        relevantScopes: [strictScope],
        strictScopes: [strictScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(preciseTimeout.picked).toEqual([
        expect.objectContaining({ id: 'strict-sibling', scope: strictScope }),
      ]);
      expect(runPreflow(index, {
        userMsg: 'check timeout behavior',
        relevantScopes: [strictScope],
        strictScopes: [strictScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([]);

      const postgresUser = 'user-postgresql';
      index.upsert(makeSegment({
        id: postgresUser,
        scope: broadUserScope,
        kind: 'context',
        tags: ['canonical-content', 'postgresql'],
        body: '# PostgreSQL\n\nPostgreSQL stores the workspace metadata for this project.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      expect(runPreflow(index, {
        userMsg: 'PostgreSQL',
        relevantScopes: [broadUserScope],
        strictScopes: [broadUserScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([
        expect.objectContaining({ id: postgresUser, scope: broadUserScope }),
      ]);

      const authSiblingScope = 'sessions/auth-sibling';
      index.upsert(makeSegment({
        id: 'auth-sibling',
        scope: authSiblingScope,
        kind: 'context',
        tags: ['canonical-content', '用户认证'],
        body: '# 用户认证\n\n认证流程必须检查 Agent 和 Session 所有权。',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      expect(runPreflow(index, {
        userMsg: '用户认证',
        relevantScopes: [authSiblingScope],
        strictScopes: [authSiblingScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([
        expect.objectContaining({ id: 'auth-sibling', scope: authSiblingScope }),
      ]);

      const mcpSiblingScope = 'sessions/mcp-sibling';
      index.upsert(makeSegment({
        id: 'mcp-sibling',
        scope: mcpSiblingScope,
        kind: 'context',
        tags: ['canonical-content', 'mcp'],
        body: '# MCP\n\nMCP tools must preserve project ownership boundaries.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      expect(runPreflow(index, {
        userMsg: 'MCP',
        relevantScopes: [mcpSiblingScope],
        strictScopes: [mcpSiblingScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([
        expect.objectContaining({ id: 'mcp-sibling', scope: mcpSiblingScope }),
      ]);

      const bodyOnlyScope = 'sessions/body-only-sibling';
      index.upsert(makeSegment({
        id: 'body-only-postgresql',
        scope: bodyOnlyScope,
        kind: 'context',
        tags: ['canonical-content', 'postgresql'],
        body: 'The current deployment happens to use PostgreSQL for unrelated storage.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      expect(runPreflow(index, {
        userMsg: 'PostgreSQL',
        relevantScopes: [bodyOnlyScope],
        strictScopes: [bodyOnlyScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([]);

      const codeHeadingCases = [
        {
          id: 'fenced-backtick-heading',
          scope: 'sessions/fenced-backtick-sibling',
          body: 'Historical shell example:\n\n````sh\n# MCP\necho disabled\n````',
        },
        {
          id: 'fenced-tilde-heading',
          scope: 'sessions/fenced-tilde-sibling',
          body: 'Historical shell example:\n\n~~~~sh\n# MCP\necho disabled\n~~~~',
        },
        {
          id: 'indented-code-heading',
          scope: 'sessions/indented-code-sibling',
          body: 'Historical shell example:\n\n    # MCP\n    echo disabled',
        },
      ];
      for (const codeCase of codeHeadingCases) {
        index.upsert(makeSegment({
          ...codeCase,
          kind: 'context',
          tags: ['canonical-content', 'mcp'],
          sourceMessages: [],
          createdAt: '2026-08-04T00:00:00.000Z',
          updatedAt: '2026-08-04T00:00:00.000Z',
        }));
        const codeResult = runPreflow(index, {
          userMsg: 'MCP',
          relevantScopes: [codeCase.scope],
          strictScopes: [codeCase.scope],
          uniqueScopes: true,
          canonicalOnly: true,
        });
        expect(codeResult.picked, codeCase.id).toEqual([]);
        expect(codeResult.droppedByRelevance, codeCase.id).toBe(1);
      }

      for (const [label, codeBody] of [
        ['leading-spaces', '    # MCP\n    echo disabled'],
        ['leading-tabs', '\t# MCP\n\techo disabled'],
      ]) {
        await writeContent(
          { kind: 'session', id: `leading-code-${label}` },
          codeBody,
          { root, language: 'zh' },
        );
        const scope = `sessions/leading-code-${label}`;
        const record = readCanonicalContentRecord(root, scope);
        expect(record?.body, label).toBe(codeBody);
        expect(syncScope(root, index, scope), label).toMatchObject({ upserted: 1 });
        const codeResult = runPreflow(index, {
          userMsg: 'MCP',
          relevantScopes: [scope],
          strictScopes: [scope],
          uniqueScopes: true,
          canonicalOnly: true,
        });
        expect(codeResult.picked, label).toEqual([]);
        expect(codeResult.droppedByRelevance, label).toBe(1);
      }

      const operationalHeadingScope = 'sessions/operational-heading-sibling';
      index.upsert(makeSegment({
        id: 'operational-heading',
        scope: operationalHeadingScope,
        kind: 'context',
        tags: ['canonical-content', 'dream', 'failure'],
        body: '# Dream failure\n\nA historical provider attempt failed during unrelated cleanup.',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      expect(runPreflow(index, {
        userMsg: 'Dream failure',
        relevantScopes: [operationalHeadingScope],
        strictScopes: [operationalHeadingScope],
        uniqueScopes: true,
        canonicalOnly: true,
      }).picked).toEqual([]);

      const uiSiblingScope = 'sessions/ui-sibling';
      index.upsert(makeSegment({
        id: 'ui-sibling',
        scope: uiSiblingScope,
        kind: 'context',
        tags: ['canonical-content'],
        body: 'Yeaft 设置页的 VP 库、搜索和 MCP 应使用扁平下划线标签，并在窄屏横向滚动。',
        sourceMessages: [],
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      }));
      const reportedUnrelatedQuery = runPreflow(index, {
        userMsg: '和当前 session 无关的内容不应该添加，比如每个 PR 明细和需求与设计决策。',
        relevantScopes: [uiSiblingScope],
        strictScopes: [uiSiblingScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(reportedUnrelatedQuery.picked).toEqual([]);
      const relevantUiQuery = runPreflow(index, {
        userMsg: '设置页的 VP 库、MCP 下划线标签在窄屏应该怎么处理？',
        relevantScopes: [uiSiblingScope],
        strictScopes: [uiSiblingScope],
        uniqueScopes: true,
        canonicalOnly: true,
      });
      expect(relevantUiQuery.picked).toEqual([
        expect.objectContaining({ id: 'ui-sibling', scope: uiSiblingScope }),
      ]);

      const duplicateScope = 'sessions/s1/topic/catalog/topic-duplicate';
      mkdirSync(join(root, duplicateScope), { recursive: true });
      writeFileSync(join(root, duplicateScope, 'memory.md'), serializeSegments([
        makeSegment({
          scope: duplicateScope,
          body: 'Attachment input identity must be isolated by occurrence and never injected twice.',
          sourceMessages: ['m-duplicate'],
        }),
      ]));
      writeFileSync(join(root, duplicateScope, 'content.md'), 'Duplicate attachment identity rule.\n');
      writeFileSync(join(root, duplicateScope, 'summary.md'), 'Duplicate attachment identity rule.\n');
      writeFileSync(join(root, topics[29], 'summary.md'), 'Attachment identity rule.\n');
      syncAll(root, index);

      const result = await consolidateSessionTopics({
        root,
        sessionId: 's1',
        segmentIndex: index,
        ts: '2026-08-04T00-00-00-000Z',
        topics: [
          ...topics.map((scope, position) => ({
            path: scope.split('/topic/')[1],
            summary: position === 29 ? 'Attachment identity rule.' : `Record ${position}.`,
          })),
          { path: 'catalog/topic-duplicate', summary: 'Duplicate attachment identity rule.' },
        ],
        llm: async ({ pass }) => pass === 'topic-consolidation'
          ? JSON.stringify({ groups: [{ canonical: 'catalog/topic-29', merge: ['catalog/topic-duplicate'] }] })
          : JSON.stringify({ content_md: 'Merged attachment identity rule.', summary_md: 'Attachment identity rule.' }),
      });

      expect(result.merged).toBe(1);
      expect(existsSync(join(root, duplicateScope, 'content.md'))).toBe(false);
      expect(JSON.parse(readFileSync(join(root, duplicateScope, 'redirect.json'), 'utf8'))).toEqual({
        version: 1,
        canonical: 'catalog/topic-29',
      });
      expect(readFileSync(join(root, topics[29], 'content.md'), 'utf8')).toContain('Merged attachment');
      expect(index.listByScope(duplicateScope)).toEqual([]);
      expect(index.search({
        query: 'duplicate',
        scopeFilter: [duplicateScope],
        limit: 10,
        requiredTag: 'canonical-content',
      })).toEqual([]);
      expect(index.listByScope(topics[29]).some(segment => (
        segment.sourceMessages.includes('m29') && segment.sourceMessages.includes('m-duplicate')
      ))).toBe(true);

      const recalled = [
        ...recall.picked,
        { scope: 'sessions/sibling/topic/release', body: 'Sibling release evidence.' },
      ];
      expect(selectRelatedSessionIds(['sibling', 'other'], recalled)).toEqual(['sibling']);
    } finally {
      if (index) index.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps transcript-shaped Dream details out of prompt-facing memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-segment-transcript-'));
    try {
      await extractAndWriteMemorySegments({
        root,
        sessionId: 's1',
        messages: [
          { id: 'm101', role: 'assistant', vpId: 'linus', body: 'I will inspect the repository.' },
          { id: 'm102', role: 'tool', body: '{"command":"git status --short"}' },
        ],
        nowIso: () => '2026-08-07T00:00:00.000Z',
        llm: async () => '[]',
      });

      expect(readScope(root, 'sessions/s1')).toEqual([]);
      expect(cleanMemoryPromptText([
        '# Session experience',
        '',
        'Keep this durable lesson.',
        '- m900 tool: This authored example is not part of the generated transcript block.',
        '',
        'Recent session details from the latest Dream pass:',
        '- m101 assistant/linus: I will inspect the repository.',
        '- m102 tool: {"command":"git status --short"}',
      ].join('\n'))).toBe([
        '# Session experience',
        '',
        'Keep this durable lesson.',
        '- m900 tool: This authored example is not part of the generated transcript block.',
      ].join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects Dream evidence without an authorized source message id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-segment-source-'));
    const target = 'sessions/s1/topic/source-backed';
    try {
      const result = await extractAndWriteMemorySegments({
        root,
        sessionId: 's1',
        messages: [{ id: 'm-real', role: 'user', body: 'Authoritative source fact.' }],
        targets: [target],
        nowIso: () => '2026-08-04T00:00:00.000Z',
        llm: async () => JSON.stringify([
          { kind: 'fact', body: 'EMPTY_SOURCE_ACCEPTED', tags: [], sourceMessages: [] },
          { kind: 'fact', body: 'UNKNOWN_SOURCE_ACCEPTED', tags: [], sourceMessages: ['m-does-not-exist'] },
          { kind: 'fact', body: 'AUTHORIZED_SOURCE_ACCEPTED', tags: [], sourceMessages: ['m-real'] },
        ]),
      });
      expect(result.errors).toEqual([]);
      expect(readScope(root, target)).toEqual([
        expect.objectContaining({
          body: 'AUTHORIZED_SOURCE_ACCEPTED',
          sourceMessages: ['m-real'],
        }),
      ]);
      expect(readFileSync(join(root, target, 'memory.md'), 'utf8')).not.toContain('EMPTY_SOURCE_ACCEPTED');
      expect(readFileSync(join(root, target, 'memory.md'), 'utf8')).not.toContain('UNKNOWN_SOURCE_ACCEPTED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves Dream soft-triage topic redirects without losing the memory root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-triage-redirect-'));
    const redirectDir = join(root, 'sessions', 's1', 'topic', 'old-topic');
    mkdirSync(redirectDir, { recursive: true });
    writeFileSync(join(redirectDir, 'redirect.json'), JSON.stringify({ version: 1, canonical: 'canonical-topic' }));
    try {
      const actions = await classifySoft({
        root,
        sessionId: 's1',
        messages: [{ id: 'm1', role: 'user', body: 'Keep the canonical topic current.' }],
        topicSummaries: [{ path: 'old-topic', summary: 'Historical alias.' }],
        llm: async ({ pass }) => pass === 'triage-pass1'
          ? JSON.stringify({ user_profile_signals: false, topics: ['Canonical topic update'] })
          : JSON.stringify({ decision: 'match', path: 'old-topic' }),
      });

      expect(actions).toEqual([
        { kind: 'update', scope: 'sessions/s1/topic/canonical-topic' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes a Dream triage pass that produces a topic action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-triage-runner-'));
    const sessionId = 'triage-session';
    const message = { id: 'm1', role: 'user', body: 'Dream topic routing must keep redirects valid.' };
    try {
      const report = await runDream({
        root,
        manual: true,
        llm: async ({ pass }) => {
          if (pass === 'triage-pass1') {
            return JSON.stringify({ user_profile_signals: false, topics: ['Dream topic routing'] });
          }
          if (pass === 'triage-pass2') return JSON.stringify({ decision: 'new', path: 'dream-routing' });
          if (pass === 'extract-segments') return '[]';
          if (pass === 'topic-consolidation') return JSON.stringify({ groups: [] });
          return JSON.stringify({ content_md: 'Dream topic routing remains valid.', summary_md: 'Dream routing.' });
        },
        listSessions: async () => [sessionId],
        countMessages: async () => 1,
        loadSessionDiff: async () => [message],
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T08:00:00.000Z',
      });

      expect(report.sessions).toEqual([
        expect.objectContaining({ sessionId, status: 'triaged', actions: 4 }),
      ]);
      expect(report.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: `sessions/${sessionId}/topic/dream-routing`, status: 'done' }),
      ]));
      expect(await readSessionState(root, sessionId)).toEqual({
        lastDreamMessageId: 'm1',
        lastDreamAt: '2026-08-07T08:00:00.000Z',
        messageCount: 1,
      });
      expect(existsSync(join(root, 'sessions', sessionId, '.dream-last-error.json'))).toBe(false);

      const secondPass = await runDream({
        root,
        manual: false,
        llm: async () => { throw new Error('Dream must not reprocess the same cursor'); },
        listSessions: async () => [sessionId],
        countMessages: async () => 1,
        loadSessionDiff: async () => { throw new Error('Dream must not load an already processed diff'); },
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T09:00:00.000Z',
      });
      expect(secondPass.sessions).toEqual([
        expect.objectContaining({ sessionId, status: 'skipped', reason: 'no-new-messages' }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps overlap context out of Apply sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-overlap-apply-'));
    const calls = [];
    try {
      await writeSessionState(root, 'overlap-session', {
        lastDreamMessageId: 'm1',
        messageCount: 1,
      });
      const report = await runDream({
        root,
        manual: true,
        llm: async ({ pass, prompt }) => {
          calls.push({ pass, prompt });
          if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
          if (pass === 'update') return JSON.stringify({ content_md: 'updated', summary_md: 'summary' });
          if (pass === 'extract-segments') return '[]';
          return JSON.stringify({ groups: [] });
        },
        listSessions: async () => ['overlap-session'],
        countMessages: async () => 2,
        loadSessionDiff: async () => [{ id: 'm2', role: 'user', body: 'new durable message' }],
        loadOverlapPreamble: async () => [{ id: 'm1', role: 'user', body: 'already Dreamed message' }],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T09:00:00.000Z',
      });
      expect(report.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: 'sessions/overlap-session', status: 'done' }),
      ]));
      const update = calls.find(call => call.pass === 'update');
      expect(update.prompt).toContain('new durable message');
      expect(update.prompt).not.toContain('already Dreamed message');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a Session cursor when one of its selected Apply targets fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-partial-target-'));
    const sessionId = 'partial-target-session';
    try {
      const report = await runDream({
        root,
        manual: true,
        scopeFilter: ['user', `sessions/${sessionId}`],
        llm: async ({ pass, prompt }) => {
          if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
          if (pass === 'update') {
            if (prompt.includes('Scope: user')) throw new Error('synthetic user target failure');
            return JSON.stringify({ content_md: 'session content', summary_md: 'session summary' });
          }
          if (pass === 'extract-segments') return '[]';
          return JSON.stringify({ groups: [] });
        },
        listSessions: async () => [sessionId],
        countMessages: async () => 1,
        loadSessionDiff: async () => [{ id: 'm1', role: 'user', body: 'Keep the selected target retryable.' }],
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T09:30:00.000Z',
      });

      expect(report.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: `sessions/${sessionId}`, status: 'done' }),
        expect.objectContaining({ target: 'user', status: 'error' }),
      ]));
      expect(await readSessionState(root, sessionId)).toEqual({
        lastDreamMessageId: null,
        lastDreamAt: null,
        messageCount: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a Session cursor when the only Apply target fails mid-batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-partial-batch-'));
    const sessionId = 'partial-batch-session';
    const messages = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index + 1}`,
      role: 'user',
      body: `durable batch message ${index + 1} ` + 'durable '.repeat(180),
    }));
    let updateCalls = 0;
    try {
      const report = await runDream({
        root,
        manual: true,
        scopeFilter: ['user'],
        limits: {
          MAX_APPLY_TOKENS: 4_000,
          MAX_DIFF_TOKENS_PER_TRIAGE: 16_000,
          MAX_DREAM_PROMPT_CHARS: 32_000,
        },
        llm: async ({ pass }) => {
          if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
          if (pass === 'update') {
            updateCalls += 1;
            if (updateCalls === 2) throw new Error('synthetic middle batch failure');
            return JSON.stringify({ content_md: `batch ${updateCalls} content`, summary_md: `batch ${updateCalls} summary` });
          }
          if (pass === 'extract-segments') return '[]';
          return JSON.stringify({ groups: [] });
        },
        listSessions: async () => [sessionId],
        countMessages: async () => messages.length,
        loadSessionDiff: async () => messages,
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T09:45:00.000Z',
      });

      expect(updateCalls).toBeGreaterThanOrEqual(2);
      expect(report.targets).toEqual([
        expect.objectContaining({ target: 'user', status: 'error' }),
      ]);
      expect(await readSessionState(root, sessionId)).toEqual({
        lastDreamMessageId: null,
        lastDreamAt: null,
        messageCount: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('advances a Session cursor only after all selected Apply targets succeed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-all-targets-'));
    const sessionId = 'all-target-session';
    try {
      const report = await runDream({
        root,
        manual: true,
        scopeFilter: ['user', `sessions/${sessionId}`],
        llm: async ({ pass }) => {
          if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
          if (pass === 'update') return JSON.stringify({ content_md: 'all targets content', summary_md: 'all targets summary' });
          if (pass === 'extract-segments') return '[]';
          return JSON.stringify({ groups: [] });
        },
        listSessions: async () => [sessionId],
        countMessages: async () => 1,
        loadSessionDiff: async () => [{ id: 'm1', role: 'user', body: 'All selected targets must complete.' }],
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T10:00:00.000Z',
      });

      expect(report.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: `sessions/${sessionId}`, status: 'done' }),
        expect.objectContaining({ target: 'user', status: 'done' }),
      ]));
      expect(await readSessionState(root, sessionId)).toEqual({
        lastDreamMessageId: 'm1',
        lastDreamAt: '2026-08-07T10:00:00.000Z',
        messageCount: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds Dream request payloads and never replays tool history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-request-boundary-'));
    const toolPayload = 'TOOL_HISTORY_MUST_NOT_REACH_DREAM_' + 'x'.repeat(200_000);
    const messages = [
      ...Array.from({ length: 80 }, (_, index) => ({
        id: `m${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        body: `durable message ${index + 1} ` + 'durable '.repeat(500),
      })),
      { id: 'm81', role: 'tool', body: toolPayload },
    ];
    const calls = [];
    try {
      const report = await runDream({
        root,
        manual: true,
        limits: { MAX_DIFF_TOKENS_PER_TRIAGE: 12_000, MAX_APPLY_TOKENS: 12_000 },
        llm: async ({ pass, prompt }) => {
          calls.push({ pass, prompt });
          if (pass === 'triage-pass1') return JSON.stringify({ user_profile_signals: false, topics: [] });
          if (pass === 'extract-segments') return '[]';
          return JSON.stringify({ content_md: 'compressed durable memory', summary_md: 'compressed summary' });
        },
        listSessions: async () => ['large-session'],
        countMessages: async () => messages.length,
        loadSessionDiff: async () => messages,
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T10:00:00.000Z',
      });

      expect(report.sessions).toEqual([
        expect.objectContaining({ sessionId: 'large-session', status: 'triaged' }),
      ]);
      expect(calls.length).toBeGreaterThan(10);
      expect(calls.every(call => call.prompt.length < 100_000)).toBe(true);
      expect(calls.every(call => !call.prompt.includes('TOOL_HISTORY_MUST_NOT_REACH_DREAM'))).toBe(true);
      expect(await readSessionState(root, 'large-session')).toMatchObject({
        lastDreamMessageId: 'm81',
        messageCount: messages.length,
      });

      const callCount = calls.length;
      const second = await runDream({
        root,
        manual: true,
        llm: async () => { throw new Error('Dream must not reprocess the same cursor'); },
        listSessions: async () => ['large-session'],
        countMessages: async () => messages.length,
        loadSessionDiff: async () => { throw new Error('Dream must not load an already processed diff'); },
        loadOverlapPreamble: async () => [],
        listTopicSummaries: async () => [],
        nowIso: () => '2026-08-07T11:00:00.000Z',
      });
      expect(calls).toHaveLength(callCount);
      expect(second.sessions).toEqual([
        expect.objectContaining({ sessionId: 'large-session', status: 'skipped', reason: 'no-new-messages' }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs low-cardinality consolidation during a manual no-new-message Dream pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-manual-topic-consolidation-'));
    const sessionId = 'manual-session';
    for (const topic of ['alpha', 'beta']) {
      const dir = join(root, 'sessions', sessionId, 'topic', topic);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'content.md'), `${topic.toUpperCase()}_CONTENT\n`);
      writeFileSync(join(dir, 'summary.md'), 'Same durable subject.\n');
    }
    let calls = 0;
    const report = await runDream({
      root,
      manual: true,
      llm: async ({ pass }) => {
        calls += 1;
        return pass === 'topic-consolidation'
          ? JSON.stringify({ groups: [{ canonical: 'alpha', merge: ['beta'] }] })
          : JSON.stringify({ content_md: 'MERGED_MANUAL_CONTENT', summary_md: 'Merged subject.' });
      },
      listSessions: async () => [sessionId],
      countMessages: async () => 0,
      loadOverlapPreamble: async () => [],
      listTopicSummaries: async () => [
        { path: 'alpha', summary: 'Same durable subject.' },
        { path: 'beta', summary: 'Same durable subject.' },
      ],
    });
    expect(calls).toBe(2);
    expect(report.sessions[0]).toMatchObject({ sessionId, status: 'consolidated', merged: 1 });
    expect(readFileSync(join(root, 'sessions', sessionId, 'topic', 'alpha', 'content.md'), 'utf8'))
      .toContain('MERGED_MANUAL_CONTENT');
    rmSync(root, { recursive: true, force: true });
  });

  it('restores every live topic file when staged activation rename fails', async () => {
    const failureTargets = [
      ['canonical-content', 'a/content.md'],
      ['canonical-summary', 'a/summary.md'],
      ['canonical-memory', 'a/memory.md'],
      ['duplicate-redirect', 'b/redirect.json'],
    ];
    for (const [name, suffix] of failureTargets) {
      const root = mkdtempSync(join(tmpdir(), `yeaft-topic-rename-${name}-`));
      const canonicalDir = join(root, 'sessions', 's1', 'topic', 'a');
      const duplicateDir = join(root, 'sessions', 's1', 'topic', 'b');
      mkdirSync(canonicalDir, { recursive: true });
      mkdirSync(duplicateDir, { recursive: true });
      const original = new Map([
        [join(canonicalDir, 'content.md'), 'A_CONTENT\n'],
        [join(canonicalDir, 'summary.md'), 'A_SUMMARY\n'],
        [join(canonicalDir, 'memory.md'), serializeSegments([
          makeSegment({ scope: 'sessions/s1/topic/a', body: 'A_EVIDENCE', sourceMessages: ['m-a'] }),
        ])],
        [join(duplicateDir, 'content.md'), 'B_CONTENT\n'],
        [join(duplicateDir, 'summary.md'), 'B_SUMMARY\n'],
        [join(duplicateDir, 'memory.md'), serializeSegments([
          makeSegment({ scope: 'sessions/s1/topic/b', body: 'B_EVIDENCE', sourceMessages: ['m-b'] }),
        ])],
      ]);
      for (const [path, body] of original) writeFileSync(path, body);
      let failed = false;
      const fileOps = {
        renameSync(from, to) {
          const normalized = String(to).split('\\').join('/');
          if (!failed && String(from).includes('/staged/') && normalized.endsWith(`/topic/${suffix}`)) {
            failed = true;
            const error = new Error(`synthetic ${name} staged rename failure`);
            error.code = 'EIO';
            throw error;
          }
          renameSync(from, to);
        },
      };
      try {
        await expect(consolidateSessionTopics({
          root,
          sessionId: 's1',
          topics: [{ path: 'a', summary: 'Same.' }, { path: 'b', summary: 'Same.' }],
          llm: async ({ pass }) => pass === 'topic-consolidation'
            ? JSON.stringify({ groups: [{ canonical: 'a', merge: ['b'] }] })
            : JSON.stringify({ content_md: 'MERGED', summary_md: 'Merged.' }),
          fileOps,
          ts: `2026-08-04T03-00-00-${name}`,
        })).rejects.toThrow(`synthetic ${name} staged rename failure`);
        expect(failed).toBe(true);
        for (const [path, body] of original) expect(readFileSync(path, 'utf8')).toBe(body);
        expect(existsSync(join(duplicateDir, 'redirect.json'))).toBe(false);
        expect(existsSync(join(root, '.topic-consolidation'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('consolidates two topics, preserves nested canonical paths, and rolls back index failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-topic-consolidation-'));
    const sessionId = 'nested-session';
    const canonicalDir = join(root, 'sessions', sessionId, 'topic', 'parent', 'child');
    const duplicateDir = join(root, 'sessions', sessionId, 'topic', 'parent');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'content.md'), 'CHILD_CANONICAL\n');
    writeFileSync(join(canonicalDir, 'summary.md'), 'Child canonical.\n');
    writeFileSync(join(duplicateDir, 'content.md'), 'PARENT_DUPLICATE\n');
    writeFileSync(join(duplicateDir, 'summary.md'), 'Parent duplicate.\n');

    let calls = 0;
    const llm = async ({ pass }) => {
      calls += 1;
      return pass === 'topic-consolidation'
        ? JSON.stringify({ groups: [{ canonical: 'parent/child', merge: ['parent'] }] })
        : JSON.stringify({ content_md: 'MERGED_NESTED_CONTENT', summary_md: 'Merged nested topic.' });
    };
    const failingIndex = {
      listByScope() { return []; },
      upsert() { throw new Error('synthetic index failure'); },
      deleteMany() {},
      deleteScope() {},
    };

    await expect(consolidateSessionTopics({
      root,
      sessionId,
      topics: [
        { path: 'parent/child', summary: 'Child canonical.' },
        { path: 'parent', summary: 'Parent duplicate.' },
      ],
      segmentIndex: failingIndex,
      llm,
      ts: '2026-08-04T01-00-00-000Z',
    })).rejects.toThrow('synthetic index failure');
    expect(calls).toBe(2);
    expect(readFileSync(join(canonicalDir, 'content.md'), 'utf8')).toContain('CHILD_CANONICAL');
    expect(readFileSync(join(duplicateDir, 'content.md'), 'utf8')).toContain('PARENT_DUPLICATE');
    expect(existsSync(join(duplicateDir, 'redirect.json'))).toBe(false);

    const result = await consolidateSessionTopics({
      root,
      sessionId,
      topics: [
        { path: 'parent/child', summary: 'Child canonical.' },
        { path: 'parent', summary: 'Parent duplicate.' },
      ],
      llm,
      ts: '2026-08-04T02-00-00-000Z',
    });
    expect(result.merged).toBe(1);
    expect(readFileSync(join(canonicalDir, 'content.md'), 'utf8')).toContain('MERGED_NESTED_CONTENT');
    expect(existsSync(join(duplicateDir, 'content.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(duplicateDir, 'redirect.json'), 'utf8'))).toEqual({
      version: 1,
      canonical: 'parent/child',
    });
    expect(resolveTopicRedirect(root, sessionId, 'parent')).toBe('parent/child');
    await writeContent(
      { kind: 'session-topic', sessionId, path: ['parent'] },
      'FUTURE_UPDATE_FOLLOWS_REDIRECT',
      { root },
    );
    expect(readFileSync(join(canonicalDir, 'content.md'), 'utf8')).toContain('FUTURE_UPDATE_FOLLOWS_REDIRECT');
    expect(existsSync(join(duplicateDir, 'content.md'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('Engine', () => {
  describe('constructor', () => {
    it('bounds signed thinking and object tool output in the actual Engine adapter request', async () => {
      const adapter = new MockAdapter();
      adapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const engine = new Engine({
        adapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, messageTokenBudget: 100 },
      });
      const priorMessages = [
        { role: 'user', content: 'prior' },
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
          toolCalls: [{ id: 'call-object-output', name: 'Inspect', input: {} }],
        },
        { role: 'tool', toolCallId: 'call-object-output', content: { payload: 'z'.repeat(100_000) } },
      ];

      for await (const _event of engine.query({ prompt: 'next', messages: priorMessages })) { /* drain */ }

      const request = adapter.callLog[0];
      expect(JSON.stringify(request.messages)).not.toContain('opaque-signature');
      expect(JSON.stringify(request.messages)).not.toContain('x'.repeat(1_000));
      expect(JSON.stringify(request.messages)).not.toContain('z'.repeat(1_000));
      expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: 'next' });
    });

    it('should create an engine with trace ID', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      expect(engine.traceId).toBeTruthy();
      expect(typeof engine.traceId).toBe('string');
    });

    it('refreshes Engine config and preserves captured request snapshots', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'old-primary', maxOutputTokens: 1024 },
      });

      engine.refreshConfig({ model: 'new-primary', maxOutputTokens: 2048 });

      const adapter = new MockAdapter();
      adapter.pushResponse([
        { type: 'tool_call', id: 'call_refresh', name: 'refresh_config', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      adapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const refreshedEngine = new Engine({
        adapter,
        trace,
        config: { model: 'provider/old', maxOutputTokens: 111 },
      });
      refreshedEngine.registerTool({
        name: 'refresh_config',
        description: 'publish a later runtime config',
        parameters: {},
        execute: async () => {
          refreshedEngine.refreshConfig({ model: 'provider/new', maxOutputTokens: 222 });
          return 'published';
        },
      });

      for await (const _event of refreshedEngine.query({ prompt: 'update after tool use' })) {
        // Consume the complete query.
      }

      expect(adapter.callLog).toHaveLength(2);
      expect(adapter.callLog[0]).toMatchObject({ model: 'provider/old', maxTokens: 111 });
      expect(adapter.callLog[1]).toMatchObject({ model: 'provider/new', maxTokens: 222 });

      const oldFetch = globalThis.fetch;
      let dispatches = 0;
      globalThis.fetch = async () => {
        dispatches += 1;
        return new Response(
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };

      try {
        const router = new AdapterRouter({
          providers: [{
            name: 'capture',
            baseUrl: 'https://capture.example/v1',
            apiKey: 'capture-key',
            protocol: 'openai-responses',
            models: ['capture-model'],
          }],
        });
        const engine = new Engine({
          adapter: withUsageAccounting(router, () => {}),
          trace,
          config: { model: 'capture/capture-model', maxOutputTokens: 111 },
        });
        const iterator = engine.query({ prompt: 'capture without dispatch' })[Symbol.asyncIterator]();
        let sawTurnStart = false;
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          if (step.value.type === 'turn_start') {
            sawTurnStart = true;
            break;
          }
        }
        expect(sawTurnStart).toBe(true);
        expect(dispatches).toBe(0);
        await iterator.return();
        expect(dispatches).toBe(0);
      } finally {
        globalThis.fetch = oldFetch;
      }

      const snapshotFetch = globalThis.fetch;
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };

      try {
        const router = new AdapterRouter({
          providers: [{
            name: 'old',
            baseUrl: 'https://old.example/v1',
            apiKey: 'old-key',
            protocol: 'openai-responses',
            models: ['old-model'],
          }],
        });
        const adapter = withUsageAccounting(router, () => {});
        let refreshDelivered = false;
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'old/old-model', modelEffort: 'low', maxOutputTokens: 111 },
        });
        const iterator = engine.query({ prompt: 'freeze this request', userEffort: 'low' });
        let sawTurnStart = false;
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          if (step.value.type === 'turn_start') {
            sawTurnStart = true;
            router.refreshProviders([{
              name: 'new',
              baseUrl: 'https://new.example/v1',
              apiKey: 'new-key',
              protocol: 'openai-responses',
              models: ['new-model'],
            }]);
            engine.refreshConfig({ model: 'new/new-model', modelEffort: 'high', maxOutputTokens: 222 });
            refreshDelivered = true;
            break;
          }
        }
        expect(sawTurnStart).toBe(true);
        expect(refreshDelivered).toBe(true);
        for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
          // Consume the frozen first request.
        }

        expect(requests).toEqual([
          expect.objectContaining({
            url: 'https://old.example/v1/responses',
            body: expect.objectContaining({ model: 'old-model', max_output_tokens: 111 }),
          }),
        ]);
      } finally {
        globalThis.fetch = snapshotFetch;
      }

      const preflightFetch = globalThis.fetch;
      const preflightRequests = [];
      globalThis.fetch = async (url, init) => {
        preflightRequests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };

      try {
        const router = new AdapterRouter({
          providers: [{
            name: 'old',
            baseUrl: 'https://old.example/v1',
            apiKey: 'old-key',
            protocol: 'openai-responses',
            models: ['old-model'],
          }],
        });
        const adapter = withUsageAccounting(router, () => {});
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'old/old-model', maxOutputTokens: 111 },
        });
        let refreshed = false;
        const events = [];
        for await (const event of engine.query({
          prompt: 'keep one config revision',
          drainPendingUserMessages: () => {
            if (refreshed) return [];
            refreshed = true;
            router.refreshProviders([{
              name: 'new',
              baseUrl: 'https://new.example/v1',
              apiKey: 'new-key',
              protocol: 'openai-responses',
              models: ['new-model'],
            }]);
            engine.refreshConfig({ model: 'new/new-model', maxOutputTokens: 222 });
            return [{ content: 'refresh raced preflight', preview: 'refresh raced preflight' }];
          },
        })) {
          events.push(event);
        }

        expect(events.some(event => event.type === 'error')).toBe(false);
        expect(preflightRequests).toEqual([
          expect.objectContaining({
            url: 'https://old.example/v1/responses',
            body: expect.objectContaining({ model: 'old-model', max_output_tokens: 111 }),
          }),
        ]);
      } finally {
        globalThis.fetch = preflightFetch;
      }
    });

    it('refreshes configured effort at tool and retry request boundaries while preserving an explicit override', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      let engine;
      let calls = 0;
      const adapter = {
        callLog: [],
        async *stream(params) {
          this.callLog.push(params);
          calls += 1;
          if (calls === 1) {
            yield { type: 'tool_call', id: 'call_refresh_effort', name: 'refresh_effort', input: {} };
            yield { type: 'stop', stopReason: 'tool_use' };
            return;
          }
          if (calls === 2) {
            engine.refreshConfig({
              model: 'provider/current',
              modelEffort: 'ultra',
              maxOutputTokens: 222,
              llmRetry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
            });
            throw new LLMServerError('retry after config save', 503);
          }
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };
      engine = new Engine({
        adapter,
        trace,
        config: {
          model: 'provider/current',
          modelEffort: 'low',
          maxOutputTokens: 111,
          llmRetry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        },
      });
      engine.registerTool({
        name: 'refresh_effort',
        description: 'publish a later Session effort',
        parameters: {},
        execute: async () => {
          engine.refreshConfig({
            model: 'provider/current',
            modelEffort: 'high',
            maxOutputTokens: 222,
            llmRetry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
          });
          return 'published';
        },
      });

      for await (const _event of engine.query({ prompt: 'refresh effort while running' })) {
        // Consume the complete query.
      }

      expect(adapter.callLog).toHaveLength(3);
      expect(adapter.callLog.map(call => [call.maxTokens, call.effort])).toEqual([
        [111, 'low'],
        [222, 'high'],
        [222, 'ultra'],
      ]);

      const overrideAdapter = new MockAdapter();
      overrideAdapter.pushResponse([
        { type: 'tool_call', id: 'call_explicit_effort', name: 'refresh_effort', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      overrideAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const overrideEngine = new Engine({
        adapter: overrideAdapter,
        trace,
        config: { model: 'provider/current', modelEffort: 'low', maxOutputTokens: 111 },
      });
      overrideEngine.registerTool({
        name: 'refresh_effort',
        description: 'publish a later Session effort',
        parameters: {},
        execute: async () => {
          overrideEngine.refreshConfig({ model: 'provider/current', modelEffort: 'max', maxOutputTokens: 222 });
          return 'published';
        },
      });

      for await (const _event of overrideEngine.query({
        prompt: 'explicit effort must stay fixed',
        userEffort: 'medium',
      })) {
        // Consume the complete query.
      }

      expect(overrideAdapter.callLog.map(call => [call.maxTokens, call.effort])).toEqual([
        [111, 'medium'],
        [222, 'medium'],
      ]);
    });

  });

  describe('perf trace', () => {
    it('bounds provider raw request and response previews through Engine capture', async () => {
      const limit = 64 * 1024;
      const mixedPayload = `${'😀'.repeat(8_000)}${'x'.repeat(320 * 1024)}`;
      const adapter = {
        async *stream(params) {
          params.onRawExchange({
            rawRequest: { body: mixedPayload },
            rawResponse: { status: 200, body: mixedPayload },
          });
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };
      const engine = new Engine({
        adapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          telemetry: { rawExchangeMaxBytes: limit },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'capture raw exchange' })) events.push(event);

      const loop = events.find(event => event.type === 'loop');
      for (const exchange of [loop.rawRequest, loop.rawResponse]) {
        expect(exchange).toMatchObject({ __truncated: true, maxBytes: limit });
        expect(exchange.preview.isWellFormed()).toBe(true);
        expect(Buffer.byteLength(exchange.preview, 'utf8')).toBeLessThanOrEqual(limit);
      }
    });

    it('records LLM request lifecycle events when an inbound perf trace id is present', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-perf-'));
      try {
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, yeaftDir },
          yeaftDir,
          sessionId: 'sess-1',
          vpId: 'vp-1',
        });

        for await (const _event of engine.query({
          prompt: 'hello',
          inboundEnvelope: { _perfTraceId: 'pt-engine-1' },
          sessionId: 'sess-1',
          threadId: 'thr-1',
          vpTurnId: 'turn-1',
        })) {
          // consume
        }

        flushAgentPerfTrace({ yeaftDir });
        const day = new Date().toISOString().slice(0, 10);
        const rows = readFileSync(join(yeaftDir, 'perf-traces', `${day}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line));
        expect(rows.map(row => row.phase)).toEqual(expect.arrayContaining([
          'llm.request_start',
          'llm.first_event',
          'llm.request_complete',
        ]));
        expect(rows.every(row => row.traceId === 'pt-engine-1')).toBe(true);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool registration', () => {
    it('registers, lists, and unregisters tools', () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model' },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Results for: ${input.q}`,
      });

      expect(engine.toolNames).toEqual(['search']);
      engine.unregisterTool('search');
      expect(engine.toolNames).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('should yield terminal errors and return a failed one-shot CLI status', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '' })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('error');
      expect(events[0].error.message).toContain('prompt is required');
      expect(events[1]).toMatchObject({
        type: 'turn_end',
        turnNumber: 0,
        stopReason: 'error',
        terminal: true,
      });
      // Should NOT have called adapter
      expect(mockAdapter.callLog).toHaveLength(0);

      const cliDir = mkdtempSync(join(tmpdir(), 'yeaft-cli-error-'));
      const serverScript = join(cliDir, 'server.mjs');
      const portPath = join(cliDir, 'port');
      const requestLogPath = join(cliDir, 'provider-requests.jsonl');
      writeFileSync(requestLogPath, '');
      writeFileSync(serverScript, [
        "import { createServer } from 'node:http';",
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "const server = createServer((req, res) => {",
        "  let body = '';",
        "  req.on('data', chunk => { body += chunk; });",
        "  req.on('end', () => {",
        "    let latestUser = '';",
        "    try {",
        "      const parsed = JSON.parse(body);",
        "      const users = (parsed.messages || []).filter(message => message.role === 'user');",
        "      latestUser = JSON.stringify(users.at(-1)?.content || '');",
        "    } catch {}",
        "    appendFileSync(process.argv[3], `${latestUser}\\n`);",
        "    const delayMs = latestUser.includes('delayed') ? 1000 : 0;",
        "    setTimeout(() => {",
        "      if (latestUser.includes('must-write')) {",
        "        const marker = latestUser.match(/marker=([^\\\"\\s]+)/)?.[1] || '';",
        "        const toolInput = JSON.stringify({ file_path: marker, content: 'unexpected write' });",
        "        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "        res.end([",
        "          'event: message_start',",
        "          'data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}',",
        "          '',",
        "          'event: content_block_start',",
        "          'data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"write-after-exit\",\"name\":\"FileWrite\"}}',",
        "          '',",
        "          'event: content_block_delta',",
        "          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolInput } })}` ,",
        "          '',",
        "          'event: content_block_stop',",
        "          'data: {\"type\":\"content_block_stop\",\"index\":0}',",
        "          '',",
        "          'event: message_delta',",
        "          'data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":1}}',",
        "          '',",
        "          'event: message_stop',",
        "          'data: {\"type\":\"message_stop\"}',",
        "          '',",
        "        ].join('\\n'));",
        "        return;",
        "      }",
        "      if (!latestUser.includes('succeed')) {",
        "        res.writeHead(401, { 'content-type': 'application/json' });",
        "        res.end(JSON.stringify({ error: { message: 'forced cli auth failure' } }));",
        "        return;",
        "      }",
        "      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
        "      res.end([",
        "      'event: message_start',",
        "      'data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}',",
        "      '',",
        "      'event: content_block_start',",
        "      'data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}',",
        "      '',",
        "      'event: content_block_delta',",
        "      'data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"success\"}}',",
        "      '',",
        "      'event: content_block_stop',",
        "      'data: {\"type\":\"content_block_stop\",\"index\":0}',",
        "      '',",
        "      'event: message_delta',",
        "      'data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}',",
        "      '',",
        "      'event: message_stop',",
        "      'data: {\"type\":\"message_stop\"}',",
        "      '',",
        "    ].join('\\n'));",
        "    }, delayMs);",
        "  });",
        "});",
        "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ].join('\n'));
      const cliServer = spawn(process.execPath, [serverScript, portPath, requestLogPath], { stdio: 'ignore' });
      let cliResult = null;
      try {
        for (let i = 0; i < 200 && !existsSync(portPath); i += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(existsSync(portPath)).toBe(true);
        const cliPort = readFileSync(portPath, 'utf8').trim();
        writeFileSync(join(cliDir, 'config.json'), JSON.stringify({
          providers: [{
            name: 'mock',
            baseUrl: `http://127.0.0.1:${cliPort}`,
            apiKey: 'test',
            protocol: 'anthropic',
            models: ['claude-test'],
          }],
          primaryModel: 'mock/claude-test',
          llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
        }));
        writeFileSync(join(cliDir, 'models_dev_cache.json'), '{}');
        cliResult = spawn(process.execPath, [
          join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
          '--skip-mcp',
          '--skip-skills',
          'trigger auth failure',
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            YEAFT_DIR: cliDir,
            YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
          },
        });
        let cliStdout = '';
        let cliStderr = '';
        cliResult.stdout.on('data', chunk => { cliStdout += chunk; });
        cliResult.stderr.on('data', chunk => { cliStderr += chunk; });
        const cliExit = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cliResult.kill('SIGKILL');
            reject(new Error(`CLI timed out; stdout=${cliStdout}; stderr=${cliStderr}`));
          }, 30_000);
          cliResult.once('error', reject);
          cliResult.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        expect(cliExit).toEqual({ code: 1, signal: null });
        expect(cliStderr).toContain('Error: LLM provider returned HTTP 401');

        const providerRequests = () => readFileSync(requestLogPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
        const runCli = (args, input) => {
          const child = spawn(process.execPath, [
            join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
            '--skip-mcp',
            '--skip-skills',
            ...args,
          ], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              YEAFT_DIR: cliDir,
              YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
            },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk; });
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.stdin.end(input);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`CLI timed out; stdout=${stdout}; stderr=${stderr}`));
            }, 30_000);
            child.once('error', reject);
            child.once('close', (code, signal) => {
              clearTimeout(timer);
              resolve({ code, signal, stdout, stderr });
            });
          });
        };
        const streamResult = await runCli([
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
        ], [
          JSON.stringify({ type: 'prompt', prompt: 'fail first' }),
          JSON.stringify({ type: 'prompt', prompt: 'succeed second' }),
          '',
        ].join('\n'));
        const streamEvents = streamResult.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(streamEvents.filter(event => event.type === 'result').map(event => event.is_error))
          .toEqual([true, false]);
        expect(streamResult).toMatchObject({ code: 1, signal: null });

        const defaultExitMarker = join(cliDir, 'default-exit-marker');
        const requestsBeforeImmediateExit = providerRequests().length;
        const immediateExit = await runCli(
          ['-i'],
          `/exit\nmust-write marker=${defaultExitMarker}\n`,
        );
        expect(immediateExit).toMatchObject({ code: 0, signal: null });
        expect(immediateExit.stdout).toContain('Bye!');
        expect(existsSync(defaultExitMarker)).toBe(false);
        expect(providerRequests()).toHaveLength(requestsBeforeImmediateExit);

        const delayedExitMarker = join(cliDir, 'default-delayed-exit-marker');
        const requestsBeforeDefaultSuccess = providerRequests().length;
        const defaultSuccessStartedAt = Date.now();
        const defaultSuccess = await runCli(
          ['-i'],
          `delayed succeed\n/exit\nmust-write marker=${delayedExitMarker}\n`,
        );
        expect(Date.now() - defaultSuccessStartedAt).toBeGreaterThanOrEqual(900);
        expect(defaultSuccess.stdout).toContain('success');
        expect(defaultSuccess.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(defaultSuccess).toMatchObject({ code: 0, signal: null });
        expect(existsSync(delayedExitMarker)).toBe(false);
        const defaultSuccessRequests = providerRequests().slice(requestsBeforeDefaultSuccess);
        expect(defaultSuccessRequests.some(request => request.includes('delayed succeed'))).toBe(true);
        expect(defaultSuccessRequests.some(request => request.includes('must-write'))).toBe(false);

        const defaultFailureStartedAt = Date.now();
        const defaultFailure = await runCli(['-i'], 'delayed fail\n/exit\n');
        expect(Date.now() - defaultFailureStartedAt).toBeGreaterThanOrEqual(900);
        expect(defaultFailure.stderr).toContain('Error:');
        expect(defaultFailure.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(defaultFailure).toMatchObject({ code: 1, signal: null });

        const sessionId = 'session_cli_exit_status';
        const sessionDir = join(cliDir, 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
          id: sessionId,
          name: 'CLI exit status',
          roster: ['linus'],
          defaultVpId: 'linus',
          announcement: '',
          workDir: '',
          createdAt: new Date().toISOString(),
        }));
        const sessionExitMarker = join(cliDir, 'session-delayed-exit-marker');
        const requestsBeforeSessionSuccess = providerRequests().length;
        const sessionSuccessStartedAt = Date.now();
        const sessionSuccess = await runCli(
          ['-i', '--session-id', sessionId],
          `delayed succeed\n/exit\nmust-write marker=${sessionExitMarker}\n`,
        );
        expect(Date.now() - sessionSuccessStartedAt).toBeGreaterThanOrEqual(900);
        expect(sessionSuccess.stdout).toContain('success');
        expect(sessionSuccess.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(sessionSuccess).toMatchObject({ code: 0, signal: null });
        expect(existsSync(sessionExitMarker)).toBe(false);
        const sessionSuccessRequests = providerRequests().slice(requestsBeforeSessionSuccess);
        expect(sessionSuccessRequests.some(request => request.includes('delayed succeed'))).toBe(true);
        expect(sessionSuccessRequests.some(request => request.includes('must-write'))).toBe(false);

        const sessionFailureStartedAt = Date.now();
        const sessionFailure = await runCli(['-i', '--session-id', sessionId], 'delayed fail\n/exit\n');
        expect(Date.now() - sessionFailureStartedAt).toBeGreaterThanOrEqual(900);
        expect(sessionFailure.stderr).toContain('Error:');
        expect(sessionFailure.stderr).not.toContain('ERR_USE_AFTER_CLOSE');
        expect(sessionFailure).toMatchObject({ code: 1, signal: null });
      } finally {
        cliServer.kill('SIGTERM');
        await new Promise(resolve => cliServer.once('close', resolve));
        rmSync(cliDir, { recursive: true, force: true });
      }
    }, 30_000);

    it('should yield error for whitespace-only prompt', async () => {
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: '   ' })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('error');
      expect(events[1]).toMatchObject({ type: 'turn_end', stopReason: 'error', terminal: true });
    });
  });

  describe('simple query (no tools)', () => {
    it('should yield text events and complete', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'usage', inputTokens: 50, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // Should have: turn_start, text_delta, text_delta, usage, stop, turn_end
      const types = events.map(e => e.type);
      expect(types).toContain('turn_start');
      expect(types).toContain('text_delta');
      expect(types).toContain('usage');
      expect(types).toContain('stop');
      expect(types).toContain('turn_end');

      // Check text content
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe('Hello');
      expect(textEvents[1].text).toBe(' world');

      // Check turn_end
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toMatchObject({
        stopReason: 'end_turn',
        turnNumber: 1,
        terminal: true,
      });

      const continuityAdapter = new MockAdapter();
      continuityAdapter.pushResponse([
        { type: 'text_delta', text: 'Current answer' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const continuityEngine = new Engine({
        adapter: continuityAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      for await (const _event of continuityEngine.query({
        prompt: 'Continue',
        messages: [
          { role: 'user', content: 'Original question' },
          { role: 'assistant', content: 'I found the relevant state boundary.', responseKind: 'progress' },
          {
            role: 'assistant',
            content: 'The previous turn completed.',
            responseKind: 'result',
            executionOrigin: 'route_forward',
          },
        ],
      })) {
        // consume
      }
      expect(continuityAdapter.callLog[0].messages).toEqual([
        { role: 'user', content: 'Original question' },
        { role: 'assistant', content: 'I found the relevant state boundary.', responseKind: 'progress' },
        { role: 'assistant', content: 'The previous turn completed.', responseKind: 'result' },
        { role: 'user', content: 'Continue' },
      ]);
    });

    it('persists the user row before starting the LLM request', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-user-prewrite-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = {
          async *stream() {
            const persisted = conversationStore.loadRecentBySession('session-prewrite', 10);
            expect(persisted).toHaveLength(1);
            expect(persisted[0]).toMatchObject({
              role: 'user',
              content: 'persist before request',
              sessionId: 'session-prewrite',
              threadId: 'main',
              userAuthored: true,
            });
            throw new Error('provider failed before replying');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'persist before request',
          sessionId: 'session-prewrite',
        })) events.push(event);

        expect(events.find(event => event.type === 'error')).toBeTruthy();
        expect(conversationStore.loadRecentBySession('session-prewrite', 10)).toHaveLength(1);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists RouteForward execution origin on assistant and tool rows', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-route-origin-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = new MockAdapter();
        adapter.pushResponse([
          { type: 'text_delta', text: 'handoff work' },
          { type: 'tool_call', id: 'call_route_origin', name: 'route_origin_tool', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'handoff complete' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-martin',
        });
        engine.registerTool({
          name: 'route_origin_tool',
          description: 'returns a durable result',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'tool result',
        });

        for await (const _event of engine.query({
          prompt: 'Continue the review',
          sessionId: 'session-route-origin',
          vpTurnId: 'vp-turn-route-origin',
          inboundEnvelope: { msg: { meta: { injectedBy: 'route_forward' } } },
        })) {
          // consume
        }

        const rows = conversationStore.loadRecentBySession('session-route-origin', 10)
          .filter(message => message.role === 'assistant' || message.role === 'tool');
        expect(rows).toHaveLength(3);
        expect(rows).toEqual(rows.map(row => expect.objectContaining({
          turnId: 'vp-turn-route-origin',
          speakerVpId: 'vp-martin',
          executionOrigin: 'route_forward',
        })));
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists partial assistant text when the provider fails mid-stream', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-partial-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = {
          async *stream() {
            yield { type: 'text_delta', text: 'partial reply' };
            throw new Error('stream disconnected');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        for await (const _event of engine.query({
          prompt: 'hello',
          sessionId: 'session-partial',
          vpTurnId: 'vp-turn-partial',
        })) {
          // consume
        }

        const persisted = conversationStore.loadRecentBySession('session-partial', 10);
        expect(persisted).toEqual([
          expect.objectContaining({ role: 'user', content: 'hello' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'partial reply',
            turnId: 'vp-turn-partial',
            speakerVpId: 'vp-linus',
            incomplete: true,
            stopReason: 'error',
            responseKind: 'progress',
          }),
        ]);
        expect(persisted[1]).not.toHaveProperty('executionOrigin');
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists partial assistant text when the user aborts mid-stream', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-partial-abort-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const controller = new AbortController();
        const adapter = {
          async *stream() {
            yield { type: 'text_delta', text: 'partial before stop' };
            controller.abort('user');
          },
        };
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'stop this',
          signal: controller.signal,
          sessionId: 'session-partial-abort',
          vpTurnId: 'vp-turn-abort',
        })) events.push(event);

        expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
        expect(conversationStore.loadRecentBySession('session-partial-abort', 10)).toEqual([
          expect.objectContaining({ role: 'user', content: 'stop this' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'partial before stop',
            turnId: 'vp-turn-abort',
            speakerVpId: 'vp-linus',
            incomplete: true,
            stopReason: 'aborted',
            responseKind: 'progress',
          }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists completed assistant and tool records before a later LLM loop fails', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-tool-incremental-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'call_incremental', name: 'durable_tool', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'error', error: new Error('second request failed'), retryable: false },
        ]);
        const rawToolOutput = 'tool output that must survive';
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });
        engine.registerTool({
          name: 'durable_tool',
          description: 'returns durable output',
          parameters: { type: 'object', properties: {} },
          execute: async () => rawToolOutput,
        });

        for await (const _event of engine.query({
          prompt: 'use the tool',
          sessionId: 'session-tool-incremental',
          vpTurnId: 'vp-turn-tool',
        })) {
          // consume
        }

        const persisted = conversationStore.loadRecentBySession('session-tool-incremental', 10);
        expect(persisted.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(persisted[1]).toMatchObject({
          toolCalls: [expect.objectContaining({ id: 'call_incremental', name: 'durable_tool' })],
          turnId: 'vp-turn-tool',
          responseKind: 'progress',
        });
        expect(persisted[2]).toMatchObject({
          toolCallId: 'call_incremental',
          content: rawToolOutput,
          turnId: 'vp-turn-tool',
          speakerVpId: 'vp-linus',
        });

        const emptyFinalAdapter = new MockAdapter();
        emptyFinalAdapter.pushResponse([
          { type: 'text_delta', text: 'Completed via tool.' },
          { type: 'tool_call', id: 'call_empty_final', name: 'durable_tool', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        emptyFinalAdapter.pushResponse([
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const emptyFinalEngine = new Engine({
          adapter: emptyFinalAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });
        emptyFinalEngine.registerTool({
          name: 'durable_tool',
          description: 'returns durable output',
          parameters: { type: 'object', properties: {} },
          execute: async () => rawToolOutput,
        });

        for await (const _event of emptyFinalEngine.query({
          prompt: 'use the tool, then finish silently',
          sessionId: 'session-tool-empty-final',
          vpTurnId: 'vp-turn-empty-final',
        })) {
          // consume
        }

        const emptyFinalRows = conversationStore.loadRecentBySession('session-tool-empty-final', 10);
        expect(emptyFinalRows.find(message => message.content === 'Completed via tool.')).toMatchObject({
          responseKind: 'result',
          stopReason: 'end_turn',
          turnId: 'vp-turn-empty-final',
        });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a T1 folding reflection and hides the original tool arc after restart', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-t1-fold-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = new MockAdapter();
        adapter.call = async () => ({
          text: 'durable reflection summary',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
        adapter.pushResponse([
          ...Array.from({ length: 30 }, (_, index) => ({
            type: 'tool_call',
            id: `call_fold_${index}`,
            name: 'fold_tool',
            input: { index },
          })),
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'finished after fold' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 400 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'fold_tool',
          description: 'returns one result',
          parameters: { type: 'object', properties: { index: { type: 'number' } } },
          execute: async ({ index }) => `result ${index}`,
        });

        for await (const _event of engine.query({
          prompt: 'run thirty tools',
          sessionId: 'session-t1-fold',
          causalRootId: 'root-t1-fold',
        })) {
          // consume
        }

        const restarted = new ConversationStore(yeaftDir);
        const durable = restarted.loadRecentBySession(
          'session-t1-fold',
          Infinity,
          { includeReflections: true },
        );
        expect(durable.filter(message => message._reflection)).toEqual([
          expect.objectContaining({
            content: expect.stringContaining('durable reflection summary'),
            causalRootId: 'root-t1-fold',
          }),
        ]);
        expect(durable.some(message => message.role === 'tool')).toBe(false);
        expect(durable.some(message => Array.isArray(message.toolCalls) && message.toolCalls.length > 0)).toBe(false);
        expect(durable.at(-1)).toMatchObject({ role: 'assistant', content: 'finished after fold' });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a T2 carry-forward reflection and hides the original tool arc after restart', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-t2-fold-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const adapter = new MockAdapter();
        adapter.call = async () => ({
          text: 'durable t2 reflection summary',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
        adapter.pushResponse([
          ...Array.from({ length: 9 }, (_, index) => ({
            type: 'tool_call',
            id: `call_t2_fold_${index}`,
            name: 't2_fold_tool',
            input: { index },
          })),
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'first turn finished' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'second turn finished' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 400 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 't2_fold_tool',
          description: 'returns one result',
          parameters: { type: 'object', properties: { index: { type: 'number' } } },
          execute: async ({ index }) => `result ${index}`,
        });

        for await (const _event of engine.query({
          prompt: 'run nine tools',
          sessionId: 'session-t2-fold',
          causalRootId: 'root-t2-origin',
        })) {
          // consume
        }
        await Promise.resolve();
        const firstTurn = conversationStore.loadRecentBySession('session-t2-fold', Infinity);
        for await (const _event of engine.query({
          prompt: 'continue after t2',
          messages: firstTurn,
          sessionId: 'session-t2-fold',
          causalRootId: 'root-t2-current',
        })) {
          // consume
        }

        const restarted = new ConversationStore(yeaftDir);
        const durable = restarted.loadRecentBySession(
          'session-t2-fold',
          Infinity,
          { includeReflections: true },
        );
        expect(durable.filter(message => message._reflection)).toEqual([
          expect.objectContaining({
            content: expect.stringContaining('durable t2 reflection summary'),
            causalRootId: 'root-t2-origin',
          }),
        ]);
        expect(durable.some(message => message.role === 'tool')).toBe(false);
        expect(durable.some(message => Array.isArray(message.toolCalls) && message.toolCalls.length > 0)).toBe(false);
        expect(durable.at(-1)).toMatchObject({ role: 'assistant', content: 'second turn finished' });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists a normal turn once without end-of-turn duplicates', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-no-persist-duplicates-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'one reply' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        for await (const _event of engine.query({
          prompt: 'one prompt',
          sessionId: 'session-no-duplicates',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-no-duplicates', 10).map(message => ({
          role: message.role,
          content: message.content,
        }))).toEqual([
          { role: 'user', content: 'one prompt' },
          { role: 'assistant', content: 'one reply' },
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists the max-token continuation boundary before the next request fails', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-continue-persist-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'first part' },
          { type: 'stop', stopReason: 'max_tokens' },
        ]);
        mockAdapter.pushResponse([
          { type: 'error', error: new Error('continuation request failed'), retryable: false },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });

        for await (const _event of engine.query({
          prompt: 'write a long answer',
          sessionId: 'session-continue-persist',
          causalRootId: 'root-max-token',
        })) {
          // consume
        }

        expect(conversationStore.loadRecentBySession('session-continue-persist', 10).map(message => ({
          role: message.role,
          content: message.content,
          userAuthored: message.userAuthored,
          causalRootId: message.causalRootId,
        }))).toEqual([
          { role: 'user', content: 'write a long answer', userAuthored: true, causalRootId: 'root-max-token' },
          { role: 'assistant', content: 'first part', userAuthored: undefined, causalRootId: 'root-max-token' },
          { role: 'user', content: 'Continue', userAuthored: false, causalRootId: 'root-max-token' },
        ]);
        expect(conversationStore.loadVisibleBySession('session-continue-persist', null, 10).messages).toEqual([
          expect.objectContaining({ role: 'user', content: 'write a long answer', userAuthored: true }),
          expect.objectContaining({ role: 'assistant', content: 'first part' }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('persists assistant rows and debug trace with the caller-provided VP turn id', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-vp-turn-id-'));
      try {
        const conversationStore = new ConversationStore(join(yeaftDir, 'conversation'));
        const debugTrace = new DebugTrace(join(yeaftDir, 'debug-trace.db'));
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'persisted reply' },
          { type: 'usage', inputTokens: 8, outputTokens: 3 },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace: debugTrace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
          vpId: 'vp-linus',
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'hello',
          sessionId: 'session-turn-id',
          threadId: 'main',
          vpTurnId: 'vp-turn-ui-1',
          userAlreadyPersisted: true,
        })) {
          events.push(event);
        }
        await debugTrace.flush();

        expect(events).toContainEqual(expect.objectContaining({
          type: 'turn_open',
          turnId: 'vp-turn-ui-1',
        }));
        expect(events.map(e => e.type)).toContain('turn_end');
        const loaded = conversationStore.loadRecentBySession('session-turn-id', 10);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatchObject({
          role: 'assistant',
          content: 'persisted reply',
          threadId: 'main',
          turnId: 'vp-turn-ui-1',
          speakerVpId: 'vp-linus',
          responseKind: 'result',
          stopReason: 'end_turn',
        });
        const requestRoot = join(`${join(yeaftDir, 'debug-trace.db')}.files`, 'sessions', 'session-turn-id', 'debug', 'requests');
        const [requestDir] = readdirSync(requestRoot);
        const meta = JSON.parse(readFileSync(join(requestRoot, requestDir, 'meta.json'), 'utf8'));
        expect(meta).toMatchObject({
          requestId: 'vp-turn-ui-1',
          active: false,
          finalStopReason: 'end_turn',
        });
        const debug = await debugTrace.fetchTurnDebug({
          sessionId: 'session-turn-id',
          turnId: loaded[0].turnId,
        });
        expect(debug.turns).toEqual([
          expect.objectContaining({ turnId: 'vp-turn-ui-1', loopCount: 1 }),
        ]);
        expect(debug.loops).toEqual([
          expect.objectContaining({ turnId: 'vp-turn-ui-1', loopNumber: 1, response: 'persisted reply' }),
        ]);
        await debugTrace.close();
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('loads query-selected canonical content into the system prompt and debug event', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-dream-load-'));
      await writeContent(
        { kind: 'session', id: 'g1' },
        'The user prefers concrete execution notes and wants Dream memory loaded into the prompt.\n<!-- dream-state -->\nlastDreamAt: 2026-07-17T00:00:00.000Z\n<!-- /dream-state -->',
        { root: join(yeaftDir, 'memory') },
      );
      await writeContent(
        { kind: 'user' },
        'User-level canonical content should enter the prompt but not the dream_memory_loaded browser payload.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeContent(
        { kind: 'session-vp', sessionId: 'g1', id: 'vp1' },
        'VP canonical content should enter the prompt but not the session prompt-load payload.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeSummary(
        { kind: 'session-topic', sessionId: 'g1', path: ['dream', 'recall'] },
        'Catalog-only topic summary must not enter the prompt.',
        { root: join(yeaftDir, 'memory') },
      );
      await writeContent(
        { kind: 'session-topic', sessionId: 'g1', path: ['dream', 'recall'] },
        `Canonical Dream content should enter the prompt. ${'完整正文细节'.repeat(800)}`,
        { root: join(yeaftDir, 'memory') },
      );
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        yeaftDir,
        sessionId: 'g1',
        config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
        memoryIndex: {
          search({ scopeFilter, requiredTag }) {
            if (requiredTag !== 'canonical-content') return [];
            const scopes = [
              'user',
              'sessions/g1',
              'sessions/g1/vp/vp1',
              'sessions/g1/vp/vp2',
              'sessions/g1/topic/dream/recall',
            ].filter(scope => scopeFilter.includes(scope));
            return scopes.map((scope, index) => ({
              id: `content-${index}`, scope, kind: 'context', tags: ['canonical-content'],
              sourceMessages: [], body: 'Dream recall test canonical evidence selector.', rank: -1 - index,
              createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
            }));
          },
        },
        amsRegistry: new AmsRegistry({ yeaftDir, config: {} }),
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'dream recall test',
        sessionId: 'g1',
        vpPersona: { vpId: 'vp1', name: 'VP One' },
      })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const system = mockAdapter.callLog[0].system;
      expect(system).toContain('## Relevant Context');
      expect(system).toContain('### Relevant Memory');
      expect(system).toContain('Dream memory loaded into the prompt');
      expect(system).not.toContain('User-level canonical content should enter the prompt');
      expect(system).toContain('VP canonical content should enter the prompt');
      expect(system).toContain('**session**: The user prefers concrete execution notes and wants Dream memory loaded into the prompt.');
      expect(system).not.toContain('dream-state');
      expect(system).not.toContain('lastDreamAt:');
      expect(system).toContain('**topic: dream/recall**: Canonical Dream content should enter the prompt.');
      expect(system).not.toContain('**sessions/g1/topic/dream/recall**');
      expect(system).not.toContain('**sessions/g1**');
      expect(system).not.toContain('Catalog-only topic summary');
      expect(system).not.toContain('Dream recall test canonical evidence selector.');

      await writeContent(
        { kind: 'session-vp', sessionId: 'g1', id: 'vp2' },
        'SECOND_VP_CANONICAL must remain visible after vp1 populated the shared registry.',
        { root: join(yeaftDir, 'memory') },
      );
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      for await (const _event of engine.query({
        prompt: 'dream recall test',
        sessionId: 'g1',
        vpPersona: { vpId: 'vp2', name: 'VP Two' },
      })) { /* exhaust */ }
      const secondVpSystem = mockAdapter.callLog.at(-1).system;
      expect(secondVpSystem).toContain('SECOND_VP_CANONICAL');
      expect(secondVpSystem).not.toContain('VP canonical content should enter the prompt');

      const loaded = events.find(e => e.type === 'dream_memory_loaded');
      expect(loaded).toBeTruthy();
      expect(loaded.loadedInto).toBe('system_prompt.memory');
      expect(loaded.resident).toHaveLength(2);
      expect(loaded.resident).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scope: 'sessions/g1',
          source: 'resident-summary',
          summary: 'The user prefers concrete execution notes and wants Dream memory loaded into the prompt.',
          truncated: false,
        }),
        expect.objectContaining({
          scope: 'sessions/g1/topic/dream/recall',
          source: 'canonical-topic-content',
          truncated: false,
        }),
      ]));
      const topicLoaded = loaded.resident.find(entry => entry.scope === 'sessions/g1/topic/dream/recall');
      expect(topicLoaded.summary).toContain('完整正文细节');
      expect(topicLoaded.summary).toContain('Additional canonical topic content omitted by prompt budget.');

      const legacyDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-legacy-group-'));
      const legacyMemoryRoot = join(legacyDir, 'memory');
      await writeContent(
        { kind: 'group', id: 'legacy-session' },
        'LEGACY_ROOT uniquely selected from the group alias.',
        { root: legacyMemoryRoot },
      );
      await writeContent(
        { kind: 'group-vp', sessionId: 'legacy-session', id: 'vp1' },
        'LEGACY_VP uniquely selected from the group alias.',
        { root: legacyMemoryRoot },
      );
      await writeContent(
        { kind: 'group-topic', sessionId: 'legacy-session', path: ['coexist'] },
        'LEGACY_TOPIC uniquely selected from the group alias.',
        { root: legacyMemoryRoot },
      );
      await writeContent(
        { kind: 'session', id: 'legacy-session' },
        'CURRENT_ROOT must not replace the selected legacy root.',
        { root: legacyMemoryRoot },
      );
      await writeContent(
        { kind: 'session-vp', sessionId: 'legacy-session', id: 'vp1' },
        'CURRENT_VP must not replace the selected legacy VP.',
        { root: legacyMemoryRoot },
      );
      await writeContent(
        { kind: 'session-topic', sessionId: 'legacy-session', path: ['coexist'] },
        'CURRENT_TOPIC must not replace the selected legacy topic.',
        { root: legacyMemoryRoot },
      );
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const legacyEngine = new Engine({
        adapter: mockAdapter,
        trace,
        yeaftDir: legacyDir,
        sessionId: 'legacy-session',
        config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
        memoryIndex: {
          search({ scopeFilter, requiredTag }) {
            if (requiredTag !== 'canonical-content') return [];
            return [
              'group/legacy-session',
              'group/legacy-session/vp/vp1',
              'group/legacy-session/topic/coexist',
            ].filter(scope => scopeFilter.includes(scope)).map((scope, index) => ({
              id: `legacy-content-${index}`, scope, kind: 'context',
              tags: ['canonical-content'], sourceMessages: [], body: 'selector only', rank: -3 + index,
              createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
            }));
          },
        },
        amsRegistry: new AmsRegistry({ yeaftDir: legacyDir, config: {} }),
      });
      for await (const _event of legacyEngine.query({
        prompt: 'legacy recall',
        sessionId: 'legacy-session',
        vpPersona: { vpId: 'vp1', name: 'VP One' },
      })) { /* exhaust */ }
      const legacySystem = mockAdapter.callLog.at(-1).system;
      expect(legacySystem).toContain('LEGACY_ROOT');
      expect(legacySystem).toContain('LEGACY_VP');
      expect(legacySystem).toContain('LEGACY_TOPIC');
      expect(legacySystem).not.toContain('CURRENT_ROOT');
      expect(legacySystem).not.toContain('CURRENT_VP');
      expect(legacySystem).not.toContain('CURRENT_TOPIC');
      rmSync(legacyDir, { recursive: true, force: true });

      const debugYeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-memory-debug-'));
      try {
        const memoryRows = [
          {
            id: 'billing-work-item',
            scope: 'sessions/g1',
            kind: 'context',
            tags: ['billing'],
            body: 'Work Item #884: billing dashboard export is in progress and awaiting review.',
            rank: 0,
          },
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `dream-relevance-${index + 1}`,
            scope: 'sessions/g1',
            kind: 'context',
            tags: ['dream', 'memory'],
            body: `Dream relevance loaded memory item ${index + 1}.`,
            rank: index + 1,
          })),
        ];
        const memoryIndex = {
          search({ scopeFilter }) {
            return memoryRows
              .filter(row => scopeFilter.includes(row.scope))
              .map(row => ({
                ...row,
                sourceMessages: [],
                createdAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-07-01T00:00:00.000Z',
              }));
          },
        };
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const debugEngine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir: debugYeaftDir,
          sessionId: 'g1',
          config: { model: 'claude-test', maxOutputTokens: 2048, language: 'en' },
          memoryIndex,
          amsRegistry: new AmsRegistry({ yeaftDir: debugYeaftDir, config: {} }),
        });

        const debugEvents = [];
        for await (const event of debugEngine.query({
          prompt: 'optimize Dream memory relevance',
          sessionId: 'g1',
          vpPersona: { vpId: 'vp1', name: 'VP One' },
        })) {
          debugEvents.push(event);
        }

        const debugSystem = mockAdapter.callLog.at(-1).system;
        expect(debugSystem).not.toContain('Dream relevance loaded memory item 1.');
        expect(debugSystem).not.toContain('billing dashboard export');

        expect(debugEvents.find(e => e.type === 'memory_used')).toBeUndefined();
      } finally {
        rmSync(debugYeaftDir, { recursive: true, force: true });
      }

      mockAdapter.callLog.length = 0;
      await verifyReadableContextWithoutPersistentAms();
    });

    async function verifyReadableContextWithoutPersistentAms() {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-readable-context-'));
      try {
        await writeContent(
          { kind: 'session', id: 'sibling-session' },
          [
            'Reusable release experience: verify origin/main and the remote tag target before publishing.',
            '',
            'Timeout cleanup failures must return a tool result so the Engine can continue.',
            '',
            'Recent session details from the latest Dream pass:',
            '- m174797 assistant/linus: closing report',
            '- m174798 tool: {"ok":true,"dispatched":["martin"]}',
          ].join('\n'),
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        await writeContent(
          { kind: 'session', id: 'ui-sibling-session' },
          '# Yeaft 设置页\n\n- VP/MCP 下划线标签在窄屏使用横向滚动。',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        await writeContent(
          { kind: 'session', id: 'mcp-sibling-session' },
          '# MCP\n\nMCP tools must preserve project ownership boundaries.',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        await writeContent(
          { kind: 'user' },
          '# PostgreSQL\n\nPostgreSQL stores the workspace metadata for this project.',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        await writeContent(
          { kind: 'session', id: 'fenced-mcp-sibling' },
          'Historical shell example:\n\n````sh\n# MCP\necho disabled\n````',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        const memoryIndex = {
          search({ scopeFilter, requiredTag }) {
            if (requiredTag !== 'canonical-content' || !scopeFilter.includes('sessions/sibling-session')) return [];
            return [{
              id: 'timeout-memory',
              scope: 'sessions/sibling-session',
              kind: 'context',
              tags: ['timeout', 'cleanup', 'failure'],
              sourceMessages: [],
              body: 'Timeout cleanup failures must return a tool result so the Engine can continue.',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          },
        };
        const taskManager = new TaskManager({ yeaftDir });
        const task = taskManager.startTask({
          sessionId: 'current-session',
          ownerVpId: 'linus',
          kind: 'sub_agent',
          title: 'Review timeout recovery and verify Engine continuation',
          runtime: { name: 'timeout-reviewer' },
          logPath: '/private/sub-agent/events.jsonl',
        });
        taskManager.store.appendLog('current-session', task.id, '{"type":"sub_agent_status","status":"running"}\n');
        taskManager.refreshTaskLog('current-session', task.id);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir,
          sessionId: 'current-session',
          config: { model: 'claude-test', maxOutputTokens: 2048, language: 'zh' },
          memoryIndex,
          taskManager,
        });

        const events = [];
        for await (const event of engine.query({
          prompt: '检查 timeout cleanup failure',
          sessionId: 'current-session',
          projectSessionIds: ['sibling-session'],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) {
          events.push(event);
        }

        const system = mockAdapter.callLog.at(-1).system;
        expect(system).toContain('### 过去 Session 的经验总结');
        expect(system).toContain('Timeout cleanup failures must return a tool result');
        expect(system).not.toContain('Reusable release experience');
        expect(system).not.toContain('Recent session details from the latest Dream pass');
        expect(system).not.toContain('m174797 assistant/linus');
        expect(system).not.toContain('m174798 tool:');
        expect(system).not.toContain('### 相关记忆');
        expect(system).toContain('## 可能相关的任务');
        expect(system).toContain('- 子 Agent timeout-reviewer (子 Agent，运行中)');
        expect(system).not.toContain('Review timeout recovery and verify Engine continuation');
        expect(system).not.toContain('<active_tasks>');
        expect(system).not.toContain('/private/sub-agent/events.jsonl');
        expect(system).not.toContain('sub_agent_status');
        expect(events.find(event => event.type === 'memory_used')?.loaded).toEqual(expect.arrayContaining([
          expect.objectContaining({
            category: 'experience',
            scope: 'sessions/sibling-session',
            body: expect.stringContaining('Timeout cleanup failures must return a tool result'),
          }),
        ]));
        expect(mockAdapter.callLog).toHaveLength(1);
        expect(existsSync(join(yeaftDir, 'memory', 'sessions', 'current-session', 'ams.json'))).toBe(false);

        memoryIndex.search = ({ scopeFilter, requiredTag }) => {
          if (requiredTag !== 'canonical-content' || !scopeFilter.includes('sessions/ui-sibling-session')) return [];
          return [{
            id: 'ui-heading-memory',
            scope: 'sessions/ui-sibling-session',
            kind: 'context',
            tags: ['yeaft', '设置页'],
            sourceMessages: [],
            body: '# Yeaft 设置页\n\n- VP/MCP 下划线标签在窄屏使用横向滚动。',
            rank: -1,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          }];
        };
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        for await (const _event of engine.query({
          prompt: 'Yeaft 设置页',
          sessionId: 'current-session',
          projectSessionIds: ['ui-sibling-session'],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) { /* exhaust */ }
        const headingSystem = mockAdapter.callLog.at(-1).system;
        expect(headingSystem).toContain('### 过去 Session 的经验总结');
        expect(headingSystem).toContain('# Yeaft 设置页');
        expect(headingSystem).toContain('VP/MCP 下划线标签在窄屏使用横向滚动');

        memoryIndex.search = ({ scopeFilter, requiredTag }) => {
          if (requiredTag !== 'canonical-content') return [];
          if (scopeFilter.includes('sessions/mcp-sibling-session')) {
            return [{
              id: 'mcp-entity-memory',
              scope: 'sessions/mcp-sibling-session',
              kind: 'context',
              tags: ['canonical-content', 'mcp'],
              sourceMessages: [],
              body: '# MCP\n\nMCP tools must preserve project ownership boundaries.',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          }
          if (scopeFilter.includes('user')) {
            return [{
              id: 'postgresql-entity-memory',
              scope: 'user',
              kind: 'context',
              tags: ['canonical-content', 'postgresql'],
              sourceMessages: [],
              body: '# PostgreSQL\n\nPostgreSQL stores the workspace metadata for this project.',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          }
          return [];
        };
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        for await (const _event of engine.query({
          prompt: 'MCP',
          sessionId: 'current-session',
          projectSessionIds: ['mcp-sibling-session'],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) { /* exhaust */ }
        const mcpSystem = mockAdapter.callLog.at(-1).system;
        expect(mcpSystem).toContain('### 过去 Session 的经验总结');
        expect(mcpSystem).toContain('**mcp-sibling-session**: # MCP');
        expect(mcpSystem).toContain('MCP tools must preserve project ownership boundaries');

        memoryIndex.search = ({ scopeFilter, requiredTag }) => {
          if (requiredTag !== 'canonical-content') return [];
          if (scopeFilter.includes('sessions/fenced-mcp-sibling')) {
            return [{
              id: 'fenced-mcp-memory',
              scope: 'sessions/fenced-mcp-sibling',
              kind: 'context',
              tags: ['canonical-content', 'mcp'],
              sourceMessages: [],
              body: 'Historical shell example:\n\n````sh\n# MCP\necho disabled\n````',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          }
          if (scopeFilter.includes('user')) {
            return [{
              id: 'indented-user-mcp-memory',
              scope: 'user',
              kind: 'context',
              tags: ['canonical-content', 'mcp'],
              sourceMessages: [],
              body: 'Historical shell example:\n\n    # MCP\n    echo disabled',
              rank: -1,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            }];
          }
          return [];
        };
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const fencedEvents = [];
        for await (const event of engine.query({
          prompt: 'MCP',
          sessionId: 'current-session',
          projectSessionIds: ['fenced-mcp-sibling'],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) {
          fencedEvents.push(event);
        }
        const fencedSystem = mockAdapter.callLog.at(-1).system;
        expect(fencedSystem).not.toContain('fenced-mcp-sibling');
        expect(fencedSystem).not.toContain('echo disabled');
        expect(fencedEvents.find(event => event.type === 'memory_used')).toBeUndefined();

        await writeContent(
          { kind: 'user' },
          'Historical shell example:\n\n    # MCP\n    echo disabled',
          { root: join(yeaftDir, 'memory'), language: 'zh' },
        );
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const indentedUserEvents = [];
        for await (const event of engine.query({
          prompt: 'MCP',
          sessionId: 'current-session',
          projectSessionIds: [],
          vpPersona: { vpId: 'linus', name: 'Linus' },
        })) {
          indentedUserEvents.push(event);
        }
        const indentedUserSystem = mockAdapter.callLog.at(-1).system;
        expect(indentedUserSystem).not.toContain('### 相关记忆');
        expect(indentedUserSystem).not.toContain('echo disabled');
        expect(indentedUserEvents.find(event => event.type === 'memory_used')).toBeUndefined();

        const productionMemoryIndex = openSegmentIndex(join(yeaftDir, 'memory', 'index.db'));
        try {
          for (const [label, codeBody] of [
            ['spaces', '    # MCP\n    echo disabled'],
            ['tabs', '\t# MCP\n\techo disabled'],
          ]) {
            await writeContent(
              { kind: 'user' },
              codeBody,
              { root: join(yeaftDir, 'memory'), language: 'zh' },
            );
            expect(syncScope(join(yeaftDir, 'memory'), productionMemoryIndex, 'user'), label)
              .toMatchObject({ upserted: 1 });
            mockAdapter.pushResponse([
              { type: 'text_delta', text: 'ok' },
              { type: 'stop', stopReason: 'end_turn' },
            ]);
            const productionCodeEvents = [];
            const productionCodeEngine = new Engine({
              adapter: mockAdapter,
              trace,
              yeaftDir,
              sessionId: 'current-session',
              config: { model: 'claude-test', maxOutputTokens: 2048, language: 'zh' },
              memoryIndex: productionMemoryIndex,
              taskManager,
            });
            for await (const event of productionCodeEngine.query({
              prompt: 'MCP',
              sessionId: 'current-session',
              projectSessionIds: [],
              vpPersona: { vpId: 'linus', name: 'Linus' },
            })) {
              productionCodeEvents.push(event);
            }
            const productionCodeSystem = mockAdapter.callLog.at(-1).system;
            expect(productionCodeSystem, label).not.toContain('### 相关记忆');
            expect(productionCodeSystem, label).not.toContain('echo disabled');
            expect(productionCodeEvents.find(event => event.type === 'memory_used'), label).toBeUndefined();
          }

          await writeContent(
            { kind: 'user' },
            '# PostgreSQL\n\nPostgreSQL stores the workspace metadata for this project.',
            { root: join(yeaftDir, 'memory'), language: 'zh' },
          );
          expect(syncScope(join(yeaftDir, 'memory'), productionMemoryIndex, 'user'))
            .toMatchObject({ upserted: 1 });
          mockAdapter.pushResponse([
            { type: 'text_delta', text: 'ok' },
            { type: 'stop', stopReason: 'end_turn' },
          ]);
          const productionPostgresEngine = new Engine({
            adapter: mockAdapter,
            trace,
            yeaftDir,
            sessionId: 'current-session',
            config: { model: 'claude-test', maxOutputTokens: 2048, language: 'zh' },
            memoryIndex: productionMemoryIndex,
            taskManager,
          });
          for await (const _event of productionPostgresEngine.query({
            prompt: 'PostgreSQL',
            sessionId: 'current-session',
            projectSessionIds: [],
            vpPersona: { vpId: 'linus', name: 'Linus' },
          })) { /* exhaust */ }
        } finally {
          productionMemoryIndex.close();
        }
        const postgresSystem = mockAdapter.callLog.at(-1).system;
        expect(postgresSystem).toContain('### 相关记忆');
        expect(postgresSystem).toContain('**user**: # PostgreSQL');
        expect(postgresSystem).toContain('PostgreSQL stores the workspace metadata for this project');
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    }

    it('should pass model and system prompt to adapter', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Hi' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'claude-test', maxOutputTokens: 2048 },
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'test',
        projectLabel: 'Yeaft (project-123)',
        projectInstruction: 'Run the shared Project verification before release.',
      })) {
        events.push(event);
      }

      expect(mockAdapter.callLog).toHaveLength(1);
      const call = mockAdapter.callLog[0];
      expect(call.model).toBe('claude-test');
      expect(call.system).toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).toContain('work');
      expect(call.system).toContain('[Project Instruction]');
      expect(call.system).toContain('The current Session belongs to Project Yeaft (project-123). The unified instruction for this Project is:');
      expect(call.system).toContain('Run the shared Project verification before release.');
      expect(call.maxTokens).toBe(2048);
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].role).toBe('user');
      expect(call.messages[0].content).toBe('test');
    });
  });

  describe('tool execution loop', () => {
    it('should execute tools and loop until end_turn', async () => {
      // First response: model wants to use a tool
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test query' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      // Second response: model has the answer
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found results for test query.' },
        { type: 'usage', inputTokens: 80, outputTokens: 15 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (input) => `Search results for: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'search for test query' })) {
        events.push(event);
      }

      // Check we got 2 turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts).toHaveLength(2);

      // Check tool execution events
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].name).toBe('search');
      expect(toolStarts[0].input).toEqual({ q: 'test query' });

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].output).toBe('Search results for: test query');
      expect(toolEnds[0].isError).toBe(false);

      // Check second adapter call has tool results in messages
      expect(mockAdapter.callLog).toHaveLength(2);
      const secondCall = mockAdapter.callLog[1];
      // Messages: user, assistant (with toolCalls), tool result
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0].role).toBe('user');
      expect(secondCall.messages[1].role).toBe('assistant');
      expect(secondCall.messages[1].toolCalls).toHaveLength(1);
      expect(secondCall.messages[2].role).toBe('tool');
      expect(secondCall.messages[2].toolCallId).toBe('call_1');

      // A result-producing task can outlive the visible turn. If its terminal
      // event is lost, the parent must eventually release same-turn ownership
      // and finish; the task keeps running and its later completion can use the
      // bridge's existing rescue-turn path.
      const stalledTaskAdapter = new MockAdapter();
      stalledTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_stalled_task', name: 'launch_stalled_task', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      stalledTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The delegated task is still running.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const stalledTaskEngine = new Engine({
        adapter: stalledTaskAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          asyncTaskWaitTimeoutMs: 20,
        },
      });
      const deferredTasks = [];
      stalledTaskEngine.setAsyncTaskCoordinator({
        onDeferred(taskId) { deferredTasks.push(taskId); },
      });
      stalledTaskEngine.registerTool({
        name: 'launch_stalled_task',
        description: 'launch a task whose terminal event never arrives',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_stalled');
          return 'task started';
        },
      });

      const stalledEvents = [];
      await Promise.race([
        (async () => {
          for await (const event of stalledTaskEngine.query({ prompt: 'delegate this work' })) {
            stalledEvents.push(event);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('async task wait stayed pinned')), 500)),
      ]);

      expect(stalledEvents).toContainEqual(expect.objectContaining({
        type: 'async_task_wait_end',
        timedOut: true,
        deferredTaskIds: ['task_stalled'],
      }));
      expect(stalledEvents).toContainEqual(expect.objectContaining({
        type: 'turn_end',
        stopReason: 'end_turn',
        terminal: true,
      }));
      expect(stalledEvents.at(-1)).toMatchObject({ type: 'turn_close' });
      expect(stalledTaskEngine.hasPendingAsyncTasks()).toBe(false);
      expect(stalledTaskEngine.notifyAsyncTaskCompleted('task_stalled', 'late result')).toBe(false);
      expect(deferredTasks).toEqual(['task_stalled']);

      // Long-running child work is not itself a stall. TaskManager activity
      // refreshes the silence deadline; a completion after the first timeout
      // window must still resume in the same turn.
      const activeTaskAdapter = new MockAdapter();
      activeTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_active_task', name: 'launch_active_task', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      activeTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The delegated result was consumed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const activeTaskEngine = new Engine({
        adapter: activeTaskAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 20 },
        taskManager: {
          getTask() {
            return { status: 'running', updatedAt: new Date().toISOString() };
          },
          renderActiveTasksForPrompt() { return ''; },
        },
        sessionId: 'session-active-task',
      });
      activeTaskEngine.registerTool({
        name: 'launch_active_task',
        description: 'launch a task that keeps reporting activity',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_active');
          return 'task started';
        },
      });

      const activeEvents = [];
      let activeCompletionAccepted = null;
      for await (const event of activeTaskEngine.query({ prompt: 'delegate active work' })) {
        activeEvents.push(event);
        if (event.type === 'async_task_wait_start') {
          setTimeout(() => {
            activeCompletionAccepted = activeTaskEngine.notifyAsyncTaskCompleted(
              'task_active',
              '<task-result id="task_active">done</task-result>',
            );
          }, 45);
        }
      }

      expect(activeCompletionAccepted).toBe(true);
      expect(activeEvents.find(event => event.type === 'async_task_wait_end')).toMatchObject({
        timedOut: false,
        deferredTaskIds: [],
      });
      expect(activeTaskAdapter.callLog).toHaveLength(3);

      // Multiple owned tasks use independent silence leases. Expiring one stale
      // child must not evict an active sibling; the active result remains in the
      // same parent turn while only the stale task is deferred.
      const mixedTaskAdapter = new MockAdapter();
      mixedTaskAdapter.pushResponse([
        { type: 'tool_call', id: 'call_mixed_tasks', name: 'launch_mixed_tasks', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mixedTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'Waiting for the active task.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      mixedTaskAdapter.pushResponse([
        { type: 'text_delta', text: 'The active task result was consumed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const mixedTaskEngine = new Engine({
        adapter: mixedTaskAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 20 },
        taskManager: {
          getTask(_sessionId, taskId) {
            return taskId === 'task_stale_sibling'
              ? { status: 'running', updatedAt: new Date(0).toISOString() }
              : { status: 'running', updatedAt: new Date().toISOString() };
          },
          renderActiveTasksForPrompt() { return ''; },
        },
        sessionId: 'session-mixed-tasks',
      });
      const mixedDeferredTasks = [];
      mixedTaskEngine.setAsyncTaskCoordinator({
        onDeferred(taskId) { mixedDeferredTasks.push(taskId); },
      });
      mixedTaskEngine.registerTool({
        name: 'launch_mixed_tasks',
        description: 'launch one stale task and one active task',
        parameters: { type: 'object', properties: {} },
        execute: async (_input, ctx) => {
          ctx.registerAsyncTask('task_stale_sibling');
          ctx.registerAsyncTask('task_active_sibling');
          return 'tasks started';
        },
      });

      const mixedEvents = [];
      let mixedActiveAccepted = null;
      for await (const event of mixedTaskEngine.query({ prompt: 'delegate mixed work' })) {
        mixedEvents.push(event);
        if (event.type === 'async_task_wait_start') {
          setTimeout(() => {
            mixedActiveAccepted = mixedTaskEngine.notifyAsyncTaskCompleted(
              'task_active_sibling',
              '<task-result id="task_active_sibling">done</task-result>',
            );
          }, 45);
        }
      }

      expect(mixedDeferredTasks).toEqual(['task_stale_sibling']);
      expect(mixedActiveAccepted).toBe(true);
      expect(mixedTaskEngine.notifyAsyncTaskCompleted('task_stale_sibling', 'late')).toBe(false);
      expect(mixedEvents.find(event => event.type === 'async_task_wait_end')).toMatchObject({
        timedOut: true,
        deferredTaskIds: ['task_stale_sibling'],
        remainingTaskIds: [],
      });
      expect(mixedTaskAdapter.callLog).toHaveLength(3);
    });

    it('passes the active tool call identity to interactive AskUser hosts', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_ask', name: 'ask_test', input: { question: 'Continue?' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Continuing.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const askUser = async (_input, toolCall) => JSON.stringify(toolCall);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'ask_test',
        description: 'Ask through the host',
        parameters: {},
        execute: async (input, ctx) => ctx.askUser(input),
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'ask me', askUser })) events.push(event);

      const toolEnd = events.find(event => event.type === 'tool_end');
      expect(JSON.parse(toolEnd.output)).toMatchObject({
        id: 'call_ask',
        name: 'ask_test',
      });
    });

    it('feeds the accepted AskUser answer into the next provider loop and durable history', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-ask-user-loop-'));
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'call_ask_loop', name: 'ask_test', input: { question: 'Continue?' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Continuing with the answer.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const conversationStore = new ConversationStore(yeaftDir);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'ask_test',
          description: 'Ask through the host',
          parameters: { type: 'object' },
          execute: async (input, ctx) => ctx.askUser(input),
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'ask me',
          sessionId: 'session-ask-loop',
          vpTurnId: 'turn-ask-loop',
          askUser: async (_input, toolCall) => {
            expect(toolCall).toMatchObject({ id: 'call_ask_loop', name: 'ask_test' });
            return { Continue: 'Yes' };
          },
        })) events.push(event);

        expect(events.find(event => event.type === 'tool_end')).toMatchObject({
          id: 'call_ask_loop',
          output: '{"Continue":"Yes"}',
          isError: false,
        });
        expect(mockAdapter.callLog).toHaveLength(2);
        expect(mockAdapter.callLog[1].messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_ask_loop',
            content: '{"Continue":"Yes"}',
          }),
        ]));
        expect(conversationStore.loadRecentBySession('session-ask-loop', 20)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_ask_loop',
            content: '{"Continue":"Yes"}',
            sessionId: 'session-ask-loop',
            turnId: 'turn-ask-loop',
          }),
        ]));
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('marks structured tool error envelopes as failed executions', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_structured_error', name: 'structured_error_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The tool returned an error.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const records = [];
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolStats: { record: entry => records.push(entry) },
      });
      engine.registerTool({
        name: 'structured_error_tool',
        description: 'Returns a structured failure',
        parameters: {},
        errorOutput: 'json-error-envelope',
        execute: async () => JSON.stringify({ error: 'Path not found' }),
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use the tool' })) events.push(event);

      expect(events.find(event => event.type === 'tool_end')).toMatchObject({ isError: true });
      expect(events.find(event => event.type === 'tool_exec')).toMatchObject({ isError: true });
      expect(mockAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({ isError: true });
      expect(records).toEqual([
        expect.objectContaining({ name: 'structured_error_tool', isError: true, errorMessage: '{"error":"Path not found"}' }),
      ]);
    });

    it('propagates resolved MCP isError results through events, model messages, and stats', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_mcp_error', name: 'mcp__secure__read', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The MCP tool failed.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const records = [];
      const mcpManager = {
        listTools: () => [{
          name: 'secure__read',
          server: 'secure',
          description: 'Read protected data',
          inputSchema: { type: 'object', properties: {} },
        }],
        callTool: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'permission denied' }],
        }),
      };
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolStats: { record: entry => records.push(entry) },
      });
      for (const tool of buildMcpFlattenedTools(mcpManager)) engine.registerTool(tool);

      const events = [];
      for await (const event of engine.query({ prompt: 'read protected data' })) events.push(event);

      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        output: 'Error: permission denied',
        isError: true,
      });
      expect(events.find(event => event.type === 'tool_exec')).toMatchObject({ isError: true });
      expect(mockAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({
        content: 'Error: permission denied',
        isError: true,
      });
      expect(records).toEqual([
        expect.objectContaining({
          name: 'mcp__secure__read',
          isError: true,
          errorMessage: 'Error: permission denied',
        }),
      ]);
    });

    it('should handle tool execution errors gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'failing_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'The tool failed, sorry.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'failing_tool',
        description: 'A tool that fails',
        parameters: {},
        execute: async () => { throw new Error('Tool crashed'); },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use the tool' })) {
        events.push(event);
      }

      // Tool should have reported error
      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('Tool crashed');

      // Engine should still complete
      const lastTurnEnd = events.filter(e => e.type === 'turn_end').pop();
      expect(lastTurnEnd).toMatchObject({ stopReason: 'end_turn', terminal: true });

      // A timed-out side-effecting tool cannot be replayed safely because its
      // underlying promise may still be running. It must nevertheless produce
      // a diagnostic terminal boundary instead of escaping query() after the
      // tool_end event and leaving the VP half-open.
      const timeoutAdapter = new MockAdapter();
      timeoutAdapter.pushResponse([
        { type: 'tool_call', id: 'call_timeout', name: 'slow_side_effect', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      const timeoutRegistry = new ToolRegistry();
      timeoutRegistry.register({
        name: 'slow_side_effect',
        description: 'Never settles',
        parameters: {},
        timeoutMs: 5,
        sideEffectScope: 'external',
        isReadOnly: () => false,
        execute: async () => new Promise(() => {}),
      });
      const timeoutEngine = new Engine({
        adapter: timeoutAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: timeoutRegistry,
      });
      const timeoutEvents = [];
      for await (const event of timeoutEngine.query({ prompt: 'run the slow tool' })) {
        timeoutEvents.push(event);
      }
      expect(timeoutEvents.find(event => event.type === 'tool_end')).toMatchObject({
        id: 'call_timeout',
        isError: true,
      });
      expect(timeoutEvents.find(event => event.type === 'error')).toMatchObject({
        retryable: false,
        error: expect.objectContaining({ name: 'ToolExecutionTimeoutError' }),
      });
      expect(timeoutEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        turnNumber: 1,
        stopReason: 'error',
        terminal: true,
        detail: expect.objectContaining({ errorName: 'ToolExecutionTimeoutError' }),
      });

      expect(bashTool.timeoutMs).toBe(0);

      const systemdChild = new EventEmitter();
      systemdChild.pid = 4344;
      systemdChild.stdout = new PassThrough();
      systemdChild.stderr = new PassThrough();
      systemdChild.kill = () => true;
      const systemdCalls = [];
      const slowSystemctl = (_command, args) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        systemdCalls.push(args.includes('kill')
          ? args.find(arg => arg.startsWith('--signal='))
          : 'show');
        return args.includes('show')
          ? { status: 0, stdout: 'active\n' }
          : { status: 0 };
      };
      const ownedTimeoutBash = createBashTool({
        runProcessImpl: (_command, _args, options) => {
          expect(options.timeoutMs).toBe(600_000);
          return runProcess('systemd-run', [], {
            ...options,
            timeoutMs: 1,
            killGraceMs: 1,
            forceSettleMs: 5,
            platform: 'linux',
            systemdScope: {
              unit: 'yeaft-test.scope',
              systemctlPath: '/usr/bin/systemctl',
              env: {},
            },
            spawnProcess: () => systemdChild,
            spawnProcessSync: slowSystemctl,
          });
        },
      });
      const ownedTimeoutRegistry = new ToolRegistry();
      ownedTimeoutRegistry.register(ownedTimeoutBash);
      const ownedTimeoutResult = await ownedTimeoutRegistry.execute('Bash', {
        command: 'sleep 600',
        timeout_ms: 600_000,
      }, {
        cwd: process.cwd(),
        runtimePlatform: {
          platform: 'linux',
          isLinux: true,
          isWindows: false,
          shellFamily: 'posix',
          defaultShell: '/bin/sh',
        },
      });
      expect(ownedTimeoutResult).toContain('Exit code: 124');
      expect(ownedTimeoutResult).toContain('Process tree did not exit within 5ms after SIGKILL: systemd-run');
      expect(systemdCalls).toContain('--signal=SIGTERM');
      expect(systemdCalls).toContain('--signal=SIGKILL');
      expect(systemdCalls).toContain('show');
      expect(systemdChild.listenerCount('close')).toBe(0);
      expect(systemdChild.listenerCount('error')).toBe(0);
      expect(systemdChild.stdout.listenerCount('data')).toBe(0);
      expect(systemdChild.stderr.listenerCount('data')).toBe(0);

      const barrierRequests = [];
      const confirmedTimeoutOutput = await createBashTool({
        runProcessImpl: async () => ({
          stdout: '', stderr: '', code: 124, timedOut: true, terminationError: null,
        }),
      }).execute({ command: 'sleep 600', timeout_ms: 1000 }, {
        cwd: process.cwd(),
        requestToolBatchBarrier: reason => barrierRequests.push(reason),
      });
      const ordinaryFailureOutput = await createBashTool({
        runProcessImpl: async () => ({
          stdout: '', stderr: 'failed', code: 2, timedOut: false, terminationError: null,
        }),
      }).execute({ command: 'exit 2' }, {
        cwd: process.cwd(),
        requestToolBatchBarrier: reason => barrierRequests.push(reason),
      });
      expect(confirmedTimeoutOutput).toContain('Exit code: 124');
      expect(ordinaryFailureOutput).toContain('Exit code: 2');
      expect(barrierRequests).toEqual([
        expect.objectContaining({ kind: 'owned_timeout' }),
      ]);

      const terminationChild = new EventEmitter();
      terminationChild.pid = 4444;
      terminationChild.stdout = new PassThrough();
      terminationChild.stderr = new PassThrough();
      terminationChild.kill = () => true;
      const terminationCalls = [];
      const recoveringBash = createBashTool({
        runProcessImpl: (_command, _args, options) => {
          terminationCalls.push({ signal: options.signal, timeoutMs: options.timeoutMs });
          return runProcess('powershell.exe', [], {
            ...options,
            timeoutMs: 1,
            forceSettleMs: 5,
            platform: 'win32',
            systemdScope: null,
            spawnProcess: () => terminationChild,
            spawnProcessSync: () => ({ status: 0 }),
          });
        },
      });
      const startedTasks = [];
      const bashTaskManager = {
        renderActiveTasksForPrompt: () => '',
        startShellTask: input => {
          startedTasks.push(input);
          return { id: 'task_after_timeout', status: 'running', log: { path: '/tmp/task.log' } };
        },
      };
      const recoveryAdapter = new MockAdapter();
      recoveryAdapter.pushResponse([
        {
          type: 'tool_call',
          id: 'call_unconfirmed_timeout',
          name: 'Bash',
          input: { command: 'Start-Sleep -Seconds 30', timeout_ms: 1000 },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      recoveryAdapter.pushResponse([
        {
          type: 'tool_call',
          id: 'call_background_after_timeout',
          name: 'Bash',
          input: {
            command: 'Start-Sleep -Seconds 30',
            timeout_ms: 1000,
            background: true,
            taskTitle: 'continue in background',
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      recoveryAdapter.pushResponse([
        { type: 'text_delta', text: 'The foreground command timed out, so I moved it to a background task.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const recoveryRegistry = new ToolRegistry();
      recoveryRegistry.register(recoveringBash);
      const recoveryEngine = new Engine({
        adapter: recoveryAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: recoveryRegistry,
        taskManager: bashTaskManager,
      });
      const recoveryEvents = [];
      for await (const event of recoveryEngine.query({ prompt: 'run the long command' })) {
        recoveryEvents.push(event);
      }
      expect(terminationCalls).toHaveLength(1);
      expect(terminationCalls[0]).toMatchObject({ timeoutMs: 1000 });
      expect(startedTasks).toHaveLength(1);
      expect(startedTasks[0]).toMatchObject({
        command: 'Start-Sleep -Seconds 30',
        title: 'continue in background',
      });
      expect(recoveryAdapter.callLog).toHaveLength(3);
      const timeoutToolMessage = recoveryAdapter.callLog[1].messages
        .find(message => message.toolCallId === 'call_unconfirmed_timeout');
      expect(timeoutToolMessage).toMatchObject({ isError: false });
      expect(timeoutToolMessage.content).toContain('Exit code: 124');
      expect(timeoutToolMessage.content).toContain('Process tree did not exit within 5ms after SIGKILL: powershell.exe');
      expect(timeoutToolMessage.content).toContain('The command may still be running.');
      expect(timeoutToolMessage.content).toContain('use background=true');
      expect(recoveryAdapter.callLog[2].messages
        .find(message => message.toolCallId === 'call_background_after_timeout')).toMatchObject({
          isError: false,
          content: expect.stringContaining('Started background task task_after_timeout'),
        });
      expect(recoveryEvents.filter(event => event.type === 'tool_end')).toHaveLength(2);
      expect(recoveryEvents.find(event => event.type === 'error')).toBeUndefined();
      expect(recoveryEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'end_turn',
        terminal: true,
      });

      const batchBarrierRoot = mkdtempSync(join(tmpdir(), 'yeaft-bash-batch-barrier-'));
      const batchBarrierMarker = join(batchBarrierRoot, 'must-not-write.txt');
      try {
        const batchBarrierChild = new EventEmitter();
        batchBarrierChild.pid = 4544;
        batchBarrierChild.stdout = new PassThrough();
        batchBarrierChild.stderr = new PassThrough();
        batchBarrierChild.kill = () => true;
        const batchBarrierBash = createBashTool({
          runProcessImpl: (_command, _args, options) => runProcess('powershell.exe', [], {
            ...options,
            timeoutMs: 1,
            forceSettleMs: 5,
            platform: 'win32',
            systemdScope: null,
            spawnProcess: () => batchBarrierChild,
            spawnProcessSync: () => ({ status: 0 }),
          }),
        });
        const batchBarrierAdapter = new MockAdapter();
        batchBarrierAdapter.pushResponse([
          {
            type: 'tool_call',
            id: 'call_batch_timeout',
            name: 'Bash',
            input: { command: 'Start-Sleep -Seconds 30', timeout_ms: 1000 },
          },
          {
            type: 'tool_call',
            id: 'call_write_after_timeout',
            name: 'FileWrite',
            input: { file_path: batchBarrierMarker, content: 'must not be written' },
          },
          {
            type: 'tool_call',
            id: 'call_second_write_after_timeout',
            name: 'FileWrite',
            input: { file_path: `${batchBarrierMarker}.second`, content: 'must not be written either' },
          },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        batchBarrierAdapter.pushResponse([
          { type: 'text_delta', text: 'The write was skipped, so I will inspect the timed-out command first.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const batchBarrierRegistry = new ToolRegistry();
        batchBarrierRegistry.register(batchBarrierBash);
        batchBarrierRegistry.register(fileWriteTool);
        const batchBarrierEngine = new Engine({
          adapter: batchBarrierAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: batchBarrierRegistry,
        });
        const batchBarrierEvents = [];
        for await (const event of batchBarrierEngine.query({ prompt: 'run then write' })) {
          batchBarrierEvents.push(event);
        }

        expect(existsSync(batchBarrierMarker)).toBe(false);
        expect(existsSync(`${batchBarrierMarker}.second`)).toBe(false);
        expect(batchBarrierAdapter.callLog).toHaveLength(2);
        const barrierProviderMessages = batchBarrierAdapter.callLog[1].messages;
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_batch_timeout')).toMatchObject({
            isError: false,
            content: expect.stringContaining('The command may still be running.'),
          });
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_write_after_timeout')).toMatchObject({
            isError: true,
            content: expect.stringContaining('This tool was not executed.'),
          });
        expect(barrierProviderMessages
          .find(message => message.toolCallId === 'call_second_write_after_timeout')).toMatchObject({
            isError: true,
            content: expect.stringContaining('This tool was not executed.'),
          });
        expect(barrierProviderMessages.filter(message => message.toolCallId).map(message => message.toolCallId))
          .toEqual([
            'call_batch_timeout',
            'call_write_after_timeout',
            'call_second_write_after_timeout',
          ]);
        expect(batchBarrierEvents.filter(event => event.type === 'tool_start').map(event => event.name))
          .toEqual(['Bash']);
        expect(batchBarrierEvents.filter(event => event.type === 'tool_end')).toEqual([
          expect.objectContaining({ id: 'call_batch_timeout', name: 'Bash', isError: false }),
          expect.objectContaining({
            id: 'call_write_after_timeout',
            name: 'FileWrite',
            isError: true,
            skipped: true,
          }),
          expect.objectContaining({
            id: 'call_second_write_after_timeout',
            name: 'FileWrite',
            isError: true,
            skipped: true,
          }),
        ]);
        expect(batchBarrierEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
          stopReason: 'end_turn',
          terminal: true,
        });
      } finally {
        rmSync(batchBarrierRoot, { recursive: true, force: true });
      }

      if (process.platform === 'linux') {
        const canary = `pr1483-${Date.now()}-${process.pid}`;
        const probeRoot = mkdtempSync(join(tmpdir(), 'yeaft-systemd-payload-'));
        const bashModuleUrl = new URL('../../../agent/yeaft/tools/bash.js', import.meta.url).href;
        const probe = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          `import bashTool from ${JSON.stringify(bashModuleUrl)}; await bashTool.execute({ command: 'sleep 3' }, { cwd: ${JSON.stringify(probeRoot)} });`,
        ], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            YEAFT_DISABLE_SYSTEMD_SCOPE: '1',
            PR1483_CANARY: canary,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let probeStderr = '';
        probe.stderr.on('data', chunk => { probeStderr += chunk; });
        try {
          let systemdRunCmdline = '';
          const deadline = Date.now() + 2000;
          while (!systemdRunCmdline && Date.now() < deadline) {
            let childPids = [];
            try {
              const children = readFileSync(`/proc/${probe.pid}/task/${probe.pid}/children`, 'utf8').trim();
              childPids = children ? children.split(/\s+/).map(Number) : [];
            } catch {}
            for (const childPid of childPids) {
              try {
                const cmdline = readFileSync(`/proc/${childPid}/cmdline`).toString('utf8').replace(/\0/g, ' ');
                if (cmdline.includes('systemd-run')) systemdRunCmdline = cmdline;
              } catch {}
            }
            if (!systemdRunCmdline) await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect(systemdRunCmdline).toContain('systemd-run');
          expect(systemdRunCmdline).not.toContain(canary);
          expect(systemdRunCmdline).not.toContain('--setenv=PR1483_CANARY');
          const probeExit = await new Promise(resolve => probe.once('close', (code, signal) => resolve({ code, signal })));
          expect(probeExit, probeStderr).toEqual({ code: 0, signal: null });
        } finally {
          if (probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL');
          rmSync(probeRoot, { recursive: true, force: true });
        }

        const priorDisableScope = process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
        try {
          for (const disableSystemdScope of [true, false]) {
            if (disableSystemdScope) process.env.YEAFT_DISABLE_SYSTEMD_SCOPE = '1';
            else delete process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
            const bashRoot = mkdtempSync(join(tmpdir(), 'yeaft-bash-timeout-'));
            const markerPath = join(bashRoot, 'survived');
            const pidPath = join(bashRoot, 'pid');
            const escapedMarker = JSON.stringify(markerPath);
            const escapedPid = JSON.stringify(pidPath);
            const bashAdapter = new MockAdapter();
            bashAdapter.pushResponse([
              {
                type: 'tool_call',
                id: 'call_bash_timeout',
                name: 'Bash',
                input: {
                  command: `setsid env -i PATH="$PATH" sh -c 'trap "" TERM; sleep 3; printf survived > "$1"' sh ${escapedMarker} >/dev/null 2>&1 & echo $! > ${escapedPid}; wait`,
                  timeout_ms: 1000,
                },
              },
              { type: 'stop', stopReason: 'tool_use' },
            ]);
            bashAdapter.pushResponse([
              { type: 'text_delta', text: 'The command timed out; use a background task for long-running work.' },
              { type: 'stop', stopReason: 'end_turn' },
            ]);
            const bashRegistry = new ToolRegistry();
            bashRegistry.register(bashTool);
            const bashEngine = new Engine({
              adapter: bashAdapter,
              trace,
              config: { model: 'test-model', maxOutputTokens: 1024 },
              toolRegistry: bashRegistry,
            });
            const bashEvents = [];
            try {
              for await (const event of bashEngine.query({ prompt: 'run the command', workDir: bashRoot })) {
                bashEvents.push(event);
              }
              expect(existsSync(markerPath)).toBe(false);
              expect(bashEvents.find(event => event.type === 'tool_end')?.output)
                .toContain('Exit code: 124');
              const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
              expect(() => process.kill(pid, 0)).toThrow();
              await new Promise(resolve => setTimeout(resolve, 2250));
              expect(existsSync(markerPath)).toBe(false);
              expect(bashAdapter.callLog).toHaveLength(2);
              expect(bashAdapter.callLog[1].messages.find(message => message.role === 'tool')).toMatchObject({
                toolCallId: 'call_bash_timeout',
                isError: false,
              });
              expect(bashAdapter.callLog[1].messages.find(message => message.role === 'tool').content)
                .toContain('Exit code: 124');
              expect(bashEvents.find(event => event.type === 'tool_end')).toMatchObject({
                id: 'call_bash_timeout',
                isError: false,
              });
              expect(bashEvents.find(event => event.type === 'error')).toBeUndefined();
              expect(bashEvents.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
                stopReason: 'end_turn',
                terminal: true,
              });
            } finally {
              rmSync(bashRoot, { recursive: true, force: true });
            }
          }
        } finally {
          if (priorDisableScope === undefined) delete process.env.YEAFT_DISABLE_SYSTEMD_SCOPE;
          else process.env.YEAFT_DISABLE_SYSTEMD_SCOPE = priorDisableScope;
        }
      }
    }, 30_000);

    it('should handle unknown tool gracefully', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'nonexistent', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I see the tool was not found.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'use nonexistent' })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].isError).toBe(true);
      expect(toolEnds[0].output).toContain('unknown tool');
    });
  });

  describe('multiple tool calls in one turn', () => {
    it('runs explicitly safe read-only tools with a bounded parallel lane and commits in call order', async () => {
      const calls = Array.from({ length: 5 }, (_, index) => ({
        type: 'tool_call',
        id: `parallel-read-${index + 1}`,
        name: 'parallel_read',
        input: { index },
      }));
      mockAdapter.pushResponse([
        ...calls,
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      let active = 0;
      let maxActive = 0;
      let releaseFirstWave;
      const firstWave = new Promise(resolve => { releaseFirstWave = resolve; });
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'parallel_read',
        description: 'Read independently.',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async execute({ index }) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (active === 4) releaseFirstWave();
          if (index < 4) await firstWave;
          active -= 1;
          return `result-${index + 1}`;
        },
      }));
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: registry,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'read five independent inputs' })) events.push(event);

      expect(maxActive).toBe(4);
      expect(events
        .filter(event => event.type === 'tool_start' || event.type === 'tool_end')
        .map(event => `${event.type}:${event.id}`)).toEqual([
        'tool_start:parallel-read-1',
        'tool_start:parallel-read-2',
        'tool_start:parallel-read-3',
        'tool_start:parallel-read-4',
        'tool_end:parallel-read-1',
        'tool_end:parallel-read-2',
        'tool_end:parallel-read-3',
        'tool_end:parallel-read-4',
        'tool_start:parallel-read-5',
        'tool_end:parallel-read-5',
      ]);
      expect(mockAdapter.callLog[1].messages
        .filter(message => message.role === 'tool')
        .map(message => [message.toolCallId, message.content])).toEqual(calls.map((call, index) => [
        call.id,
        `result-${index + 1}`,
      ]));
    });

    it('does not dispatch later parallel reads after abort during segment startup', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'abort-read-1', name: 'parallel_read', input: { index: 1 } },
        { type: 'tool_call', id: 'abort-read-2', name: 'parallel_read', input: { index: 2 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      const controller = new AbortController();
      const executions = [];
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'parallel_read',
        description: 'Read independently.',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async execute({ index }, { signal }) {
          executions.push({ index, aborted: signal.aborted });
          return `result-${index}`;
        },
      }));
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: registry,
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'read two independent inputs',
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'tool_start' && event.id === 'abort-read-1') controller.abort('user');
      }

      expect(executions).toEqual([]);
      expect(events.filter(event => event.type === 'tool_start').map(event => event.id))
        .toEqual(['abort-read-1']);
      expect(events.filter(event => event.type === 'tool_end').map(event => ({
        id: event.id,
        skipped: event.skipped,
        aborted: event.aborted,
      }))).toEqual([
        { id: 'abort-read-1', skipped: true, aborted: true },
        { id: 'abort-read-2', skipped: true, aborted: true },
      ]);
      expect(events.filter(event => event.type === 'aborted')).toHaveLength(1);
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'aborted',
        terminal: true,
      });
    });

    it('keeps read-only tools serial unless concurrency metadata explicitly opts in', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'serial-read-1', name: 'serial_read', input: { index: 1 } },
        { type: 'tool_call', id: 'serial-read-2', name: 'serial_read', input: { index: 2 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const executionOrder = [];
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'serial_read',
        description: 'Read with ordering constraints.',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        async execute({ index }) {
          executionOrder.push(`start-${index}`);
          await Promise.resolve();
          executionOrder.push(`end-${index}`);
          return `result-${index}`;
        },
      }));
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: registry,
      });

      for await (const _event of engine.query({ prompt: 'run constrained reads' })) { /* drain */ }

      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });

    it('uses unsafe tools as serial barriers between safe read-only segments', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'read-a', name: 'parallel_read', input: { id: 'a' } },
        { type: 'tool_call', id: 'read-b', name: 'parallel_read', input: { id: 'b' } },
        { type: 'tool_call', id: 'write', name: 'serial_write', input: {} },
        { type: 'tool_call', id: 'read-c', name: 'parallel_read', input: { id: 'c' } },
        { type: 'tool_call', id: 'read-d', name: 'parallel_read', input: { id: 'd' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const executionOrder = [];
      let releaseFirstPair;
      let releaseSecondPair;
      let firstPairActive = 0;
      let secondPairActive = 0;
      const firstPair = new Promise(resolve => { releaseFirstPair = resolve; });
      const secondPair = new Promise(resolve => { releaseSecondPair = resolve; });
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'parallel_read',
        description: 'Read independently.',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async execute({ id }) {
          executionOrder.push(`start-${id}`);
          if (id === 'a' || id === 'b') {
            firstPairActive += 1;
            if (firstPairActive === 2) releaseFirstPair();
            await firstPair;
          } else {
            secondPairActive += 1;
            if (secondPairActive === 2) releaseSecondPair();
            await secondPair;
          }
          executionOrder.push(`end-${id}`);
          return id;
        },
      }));
      registry.register(defineTool({
        name: 'serial_write',
        description: 'Mutate shared state.',
        parameters: { type: 'object' },
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        async execute() {
          executionOrder.push('write');
          return 'written';
        },
      }));
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        toolRegistry: registry,
      });

      for await (const _event of engine.query({ prompt: 'read, write, and reread' })) { /* drain */ }

      const writeIndex = executionOrder.indexOf('write');
      expect(writeIndex).toBeGreaterThan(executionOrder.indexOf('end-a'));
      expect(writeIndex).toBeGreaterThan(executionOrder.indexOf('end-b'));
      expect(writeIndex).toBeLessThan(executionOrder.indexOf('start-c'));
      expect(writeIndex).toBeLessThan(executionOrder.indexOf('start-d'));
    });

    async function verifyIdenticalReadReuse() {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'read-1', name: 'read', input: { path: 'same.txt' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'read-2', name: 'read', input: { path: 'same.txt' } },
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
      });
      let executions = 0;
      engine.registerTool({
        name: 'read',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        isReadOnly: () => true,
        cacheWithinQuery: () => true,
        execute: async () => { executions += 1; return 'file contents'; },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'read it' })) events.push(event);

      expect(executions).toBe(1);
      expect(events.filter(event => event.type === 'tool_exec').map(event => event.reused)).toEqual([undefined, true]);
      expect(mockAdapter.callLog).toHaveLength(3);
      expect(mockAdapter.callLog[2].messages.at(-1).content).toContain('file contents');
    }

    it('reuses identical deterministic reads and ends a plan-only control batch', async () => {
      await verifyIdenticalReadReuse();
      mockAdapter = new MockAdapter();
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'plan-1', name: 'StartPlan', input: { topic: 'inspect the issue' } },
        { type: 'tool_call', id: 'todo-1', name: 'TodoWrite', input: {
          todos: [{ content: 'Inspect the issue', status: 'in_progress', activeForm: 'Inspecting the issue' }],
        } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'StartPlan',
        description: 'Start plan',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        execute: async () => 'plan instruction',
      });
      engine.registerTool({
        name: 'TodoWrite',
        description: 'Write todos',
        parameters: { type: 'object' },
        isReadOnly: () => true,
        execute: async () => '{"success":true}',
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'inspect the issue' })) events.push(event);

      expect(mockAdapter.callLog).toHaveLength(1);
      expect(events.find(event => event.type === 'turn_end' && event.stopReason === 'plan_recorded')).toMatchObject({ terminal: true });
    });

    it('invalidates cached reads before successful and failed workspace mutations', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-mutation-'));
      const filePath = join(workDir, 'state.txt');
      writeFileSync(filePath, 'before');
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'tool_call', id: 'write', name: 'FileWrite', input: { file_path: 'state.txt', content: 'after' } },
          { type: 'tool_call', id: 'read-after', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const registry = new ToolRegistry();
        registry.register(fileReadTool).register(fileWriteTool);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: registry,
        });

        const events = [];
        for await (const event of engine.query({ prompt: 'update and reread the file', workDir })) events.push(event);

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        expect(toolStarts.find(event => event.id === 'read-after')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-before')?.output).toContain('before');
        expect(toolEnds.find(event => event.id === 'read-after')?.output).toContain('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');

        let contents = 'before';
        mockAdapter = new MockAdapter();
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-failure', name: 'read', input: { path: 'state.txt' } },
          { type: 'tool_call', id: 'write-and-fail', name: 'write', input: { path: 'state.txt' } },
          { type: 'tool_call', id: 'read-after-failure', name: 'read', input: { path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const failingEngine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
        });
        failingEngine.registerTool({
          name: 'read',
          description: 'Read state',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          isReadOnly: () => true,
          cacheWithinQuery: true,
          execute: async () => contents,
        });
        failingEngine.registerTool({
          name: 'write',
          description: 'Write state',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          isReadOnly: () => false,
          execute: async () => {
            contents = 'after';
            throw new Error('write failed after changing state');
          },
        });

        const failingEvents = [];
        for await (const event of failingEngine.query({ prompt: 'update and reread the state' })) failingEvents.push(event);

        const failingToolStarts = failingEvents.filter(event => event.type === 'tool_start');
        const failingToolEnds = failingEvents.filter(event => event.type === 'tool_end');
        expect(failingToolStarts.find(event => event.id === 'read-after-failure')?.reused).not.toBe(true);
        expect(failingToolEnds.find(event => event.id === 'write-and-fail')).toMatchObject({
          isError: true,
          output: 'Error: write failed after changing state',
        });
        expect(failingToolEnds.find(event => event.id === 'read-after-failure')?.output).toBe('after');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('invalidates cached reads when a task result arrives during async wait', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-async-result-'));
      const filePath = join(workDir, 'state.txt');
      const taskId = 'task-read-cache-boundary';
      writeFileSync(filePath, 'before');
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-async-result', name: 'read_state', input: {} },
          { type: 'tool_call', id: 'wait-for-task-result', name: 'wait_for_state', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Waiting for the state update.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-after-async-result', name: 'read_state', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'The state is current.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 1_000 },
        });
        let readExecutions = 0;
        engine.registerTool({
          name: 'read_state',
          description: 'Read state',
          parameters: { type: 'object' },
          isReadOnly: () => true,
          cacheWithinQuery: true,
          execute: async () => {
            readExecutions += 1;
            return readFileSync(filePath, 'utf8');
          },
        });
        engine.registerTool({
          name: 'wait_for_state',
          description: 'Wait for a task result',
          parameters: { type: 'object' },
          // This tool only starts observation. It does not synchronously
          // mutate the workspace, so the task-result synchronization boundary
          // must invalidate a read cached before the async wait.
          isReadOnly: () => true,
          execute: async (_input, ctx) => {
            ctx.registerAsyncTask(taskId);
            return 'waiting';
          },
        });

        const events = [];
        let completionAccepted = false;
        for await (const event of engine.query({ prompt: 'wait for the state update', workDir })) {
          events.push(event);
          if (event.type === 'async_task_wait_start') {
            writeFileSync(filePath, 'after');
            completionAccepted = engine.notifyAsyncTaskCompleted(taskId, 'state updated');
          }
        }

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        expect(completionAccepted).toBe(true);
        expect(readExecutions).toBe(2);
        expect(toolEnds.find(event => event.id === 'read-before-async-result')?.output).toBe('before');
        expect(toolStarts.find(event => event.id === 'read-after-async-result')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-after-async-result')?.output).toBe('after');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('invalidates cached reads when completion arrives after the next provider stream starts', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-post-stream-completion-'));
      const filePath = join(workDir, 'state.txt');
      const taskId = 'task-read-cache-post-stream';
      writeFileSync(filePath, 'before');
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-post-stream-completion', name: 'ReadState', input: {} },
          { type: 'tool_call', id: 'start-async-state-update', name: 'StartAsync', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-after-post-stream-completion', name: 'ReadState', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'The updated state was read.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 1_000 },
        });
        let readExecutions = 0;
        engine.registerTool({
          name: 'ReadState',
          description: 'Read workspace state.',
          parameters: { type: 'object' },
          isReadOnly: () => true,
          cacheWithinQuery: true,
          execute: async () => {
            readExecutions += 1;
            return readFileSync(filePath, 'utf8');
          },
        });
        engine.registerTool({
          name: 'StartAsync',
          description: 'Start an asynchronous state update.',
          parameters: { type: 'object' },
          // This only registers the detached task; its completion is the
          // workspace mutation boundary under test.
          isReadOnly: () => true,
          execute: async (_input, ctx) => {
            ctx.registerAsyncTask(taskId);
            return 'state update started';
          },
        });

        const baseStream = mockAdapter.stream.bind(mockAdapter);
        let streamCalls = 0;
        let completionAccepted = false;
        mockAdapter.stream = async function* streamWithCompletionAfterStart(params) {
          streamCalls += 1;
          if (streamCalls === 2) {
            // The Engine already completed its pre-stream task-result drain.
            // Deliver the completion before this stream yields ReadState so
            // the tool execution path must observe immediate invalidation.
            writeFileSync(filePath, 'after');
            completionAccepted = engine.notifyAsyncTaskCompleted(taskId, 'state updated');
          }
          yield* baseStream(params);
        };

        const events = [];
        for await (const event of engine.query({ prompt: 'read then refresh state', workDir })) events.push(event);

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        expect(completionAccepted).toBe(true);
        expect(streamCalls).toBe(3);
        expect(readExecutions).toBe(2);
        expect(toolEnds.find(event => event.id === 'read-before-post-stream-completion')?.output).toBe('before');
        expect(toolStarts.find(event => event.id === 'read-after-post-stream-completion')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-after-post-stream-completion')?.output).toBe('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('persists a late completion after T1 folding without restoring a raw tool arc', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-folded-async-completion-'));
      const sessionId = 'session-folded-async-completion';
      const vpTurnId = 'vp-turn-folded-async-completion';
      const taskId = 'task-folded-async-completion';
      const toolCallId = 'call-folded-async-completion';
      const completion = 'late task output after the tool arc was folded';
      const conversationStore = new ConversationStore(yeaftDir);
      let completionAccepted = false;
      try {
        const makeToolCall = index => ({
          type: 'tool_call',
          id: index === 0 ? toolCallId : `call-fold-helper-${index}`,
          name: 'FoldHelper',
          input: { index },
        });
        mockAdapter.pushResponse([
          ...Array.from({ length: 31 }, (_, index) => makeToolCall(index)),
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        // T1 reflection uses adapter.call(), which is recorded between the
        // initial tool stream and the continuation stream.
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Waiting for the late task result.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Late result consumed.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            asyncTaskWaitTimeoutMs: 1_000,
            // Session reflection is pressure-gated. Make the 31-call batch
            // exceed the threshold so this covers the durable T1 path.
            maxContextTokens: 1,
          },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'FoldHelper',
          description: 'Produce a foldable tool result.',
          parameters: { type: 'object' },
          execute: async (input, ctx) => {
            if (input.index === 0) ctx.registerAsyncTask(taskId);
            return `tool output ${input.index}`;
          },
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'run enough tools to fold then wait for completion',
          sessionId,
          vpTurnId,
        })) {
          events.push(event);
          if (event.type === 'async_task_wait_start') {
            completionAccepted = engine.notifyAsyncTaskCompleted(taskId, completion);
          }
        }

        expect(completionAccepted).toBe(true);
        // stream #1, the synchronous T1 reflector call, stream #2 (which
        // waits), then stream #3 carrying the continuation note.
        expect(mockAdapter.callLog).toHaveLength(4);
        const continuationMessages = mockAdapter.callLog[3].messages;
        // The provider transcript retains the original folded tool result as
        // historical context, but the late completion itself must be injected
        // only as a continuation note rather than a reconstructed raw arc.
        const lateCompletionTool = continuationMessages.find(message => (
          message.role === 'tool'
            && message.toolCallId === toolCallId
            && String(message.content).includes(completion)
        ));
        expect(lateCompletionTool).toBeUndefined();
        expect(continuationMessages.some(message => (
          message.role === 'user'
            && message._asyncTaskCompletion === true
            && String(message.content).includes(completion)
        ))).toBe(true);
        expect(events.find(event => event.type === 'tool_result_update')).toMatchObject({
          taskId,
          toolCallId,
          content: completion,
        });

        // Completion notes are internal control rows rather than reflections.
        // Inspect the durable transcript directly; normal history deliberately
        // hides engine-private control context from user-visible replay.
        const storedAll = conversationStore.loadAll();
        const storedCompletion = storedAll.find(message => message.role === 'user'
            && message.internal === true
            && message._asyncTaskCompletion === true
            && String(message.content).includes(completion));
        expect(storedCompletion).toMatchObject({
          sessionId,
          turnId: vpTurnId,
          userAuthored: false,
          internal: true,
        });
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('bounds same-turn async completion content for the model while preserving durable output', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-async-completion-budget-'));
      const sessionId = 'session-async-completion-budget';
      const taskId = 'task-async-completion-budget';
      const initialOutput = 'The task is running.';
      const completion = `completed:\n${'界'.repeat(TOOL_RESULT_MAX_BYTES)}`;
      const conversationStore = new ConversationStore(yeaftDir);
      let completionAccepted = false;
      try {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'call_async_completion', name: 'WaitForCompletion', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Waiting for completion.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Completion consumed.' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024, asyncTaskWaitTimeoutMs: 1_000 },
          conversationStore,
          yeaftDir,
        });
        engine.registerTool({
          name: 'WaitForCompletion',
          description: 'Wait for an asynchronous completion.',
          parameters: { type: 'object' },
          execute: async (_input, ctx) => {
            ctx.registerAsyncTask(taskId);
            return initialOutput;
          },
        });

        const events = [];
        for await (const event of engine.query({ prompt: 'wait for the task', sessionId })) {
          events.push(event);
          if (event.type === 'async_task_wait_start') {
            completionAccepted = engine.notifyAsyncTaskCompleted(taskId, completion);
          }
        }

        expect(completionAccepted).toBe(true);
        expect(mockAdapter.callLog).toHaveLength(3);
        const modelToolResult = mockAdapter.callLog[2].messages
          .find(message => message.role === 'tool' && message.toolCallId === 'call_async_completion');
        expect(modelToolResult.content).toContain('[truncated: WaitForCompletion returned');
        expect(Buffer.byteLength(modelToolResult.content, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
        expect(modelToolResult.content).toContain('completed:');

        const durableToolResult = conversationStore.loadRecentBySession(sessionId, 10)
          .find(message => message.role === 'tool' && message.toolCallId === 'call_async_completion');
        expect(durableToolResult.content).toBe(`${initialOutput}\n\n${completion}`);
        expect(Buffer.byteLength(durableToolResult.content, 'utf8')).toBeGreaterThan(TOOL_RESULT_MAX_BYTES);
        expect(events.find(event => event.type === 'tool_result_update')?.content).toBe(completion);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('does not reuse reads after a background Bash task mutates the workspace', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-background-'));
      const yeaftDir = join(workDir, '.yeaft');
      const sessionId = 'session-background-read-cache';
      const filePath = join(workDir, 'state.txt');
      const releasePath = join(workDir, 'release');
      const taskManager = new TaskManager({ yeaftDir });
      let backgroundTaskId = null;
      writeFileSync(filePath, 'before');
      try {
        const waitForReleaseScript = [
          "const fs = require('fs');",
          'const [releasePath, filePath] = process.argv.slice(1);',
          'const timer = setInterval(() => {',
          '  if (!fs.existsSync(releasePath)) return;',
          '  clearInterval(timer);',
          "  fs.writeFileSync(filePath, 'after');",
          '}, 5);',
        ].join(' ');
        const backgroundCommand = process.platform === 'win32'
          ? `& ${JSON.stringify(process.execPath)} -e ${JSON.stringify(waitForReleaseScript)} ${JSON.stringify(releasePath)} ${JSON.stringify(filePath)}`
          : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(waitForReleaseScript)} ${JSON.stringify(releasePath)} ${JSON.stringify(filePath)}`;
        const baseStream = mockAdapter.stream.bind(mockAdapter);
        let streamCalls = 0;
        mockAdapter.stream = async function* streamAfterBackgroundWrite(params) {
          streamCalls += 1;
          if (streamCalls === 2) {
            const task = taskManager.listActiveTasks(sessionId).find(item => item.kind === 'shell');
            if (!task) throw new Error('background shell task did not start');
            backgroundTaskId = task.id;
            writeFileSync(releasePath, 'go');
            const deadline = Date.now() + 2_000;
            while (taskManager.getTask(sessionId, backgroundTaskId)?.status === 'running' && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            const completed = taskManager.getTask(sessionId, backgroundTaskId);
            if (completed?.status !== 'succeeded') {
              throw new Error(`background shell task did not complete successfully: ${completed?.status || 'missing'}`);
            }
          }
          yield* baseStream(params);
        };

        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'start-background-write', name: 'Bash', input: {
            command: backgroundCommand,
            background: true,
            taskTitle: 'Write state after release',
          } },
          { type: 'tool_call', id: 'read-before-release', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-after-background-write', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const registry = new ToolRegistry();
        registry.register(bashTool).register(fileReadTool).register(fileWriteTool);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: registry,
          taskManager,
          sessionId,
        });

        const events = [];
        for await (const event of engine.query({ prompt: 'update and reread the file', workDir })) events.push(event);

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        expect(backgroundTaskId).toBeTruthy();
        expect(toolEnds.find(event => event.id === 'read-before-release')?.output).toContain('before');
        expect(toolStarts.find(event => event.id === 'read-after-background-write')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-after-background-write')?.output).toContain('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');
        expect(taskManager.getTask(sessionId, backgroundTaskId)?.status).toBe('succeeded');
      } finally {
        if (!existsSync(releasePath)) writeFileSync(releasePath, 'go');
        const task = backgroundTaskId
          ? taskManager.getTask(sessionId, backgroundTaskId)
          : taskManager.listActiveTasks(sessionId).find(item => item.kind === 'shell');
        if (task?.status === 'running') taskManager.cancelTask(sessionId, task.id);
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not reuse reads after a SpawnAgent writes the workspace', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-sub-agent-'));
      const yeaftDir = join(workDir, '.yeaft');
      const sessionId = 'session-sub-agent-read-cache';
      const filePath = join(workDir, 'state.txt');
      const taskManager = new TaskManager({ yeaftDir });
      let childToolStarts = 0;
      let spawnedAgentId = null;
      writeFileSync(filePath, 'before');
      try {
        const childAdapter = {
          async *stream() {
            childToolStarts += 1;
            if (childToolStarts === 1) {
              yield { type: 'tool_call', id: 'child-write', name: 'FileWrite', input: {
                file_path: 'state.txt',
                content: 'after',
              } };
              yield { type: 'stop', stopReason: 'tool_use' };
              return;
            }
            yield { type: 'text_delta', text: 'child wrote the state' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
          async call() { return { text: 'ok', usage: {} }; },
        };
        const baseStream = mockAdapter.stream.bind(mockAdapter);
        mockAdapter.stream = async function* streamAfterChildWrite(params) {
          if (params.messages?.some(message => message.role === 'tool' && message.toolCallId === 'spawn-child-write')) {
            const agent = spawnedAgentId ? getAgentRegistry().get(spawnedAgentId) : null;
            if (!agent?.taskId) throw new Error('sub-agent task did not start');
            const deadline = Date.now() + 2_000;
            while (taskManager.getTask(sessionId, agent.taskId)?.status === 'running' && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            const completed = taskManager.getTask(sessionId, agent.taskId);
            if (completed?.status !== 'succeeded') {
              throw new Error(`sub-agent task did not complete successfully: ${completed?.status || 'missing'}`);
            }
          }
          yield* baseStream(params);
        };

        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-child-write', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'tool_call', id: 'spawn-child-write', name: 'SpawnAgent', input: {
            name: 'cache-write-child',
            mission: 'Write state.txt after the release file appears.',
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-after-child-write', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const registry = new ToolRegistry();
        registry.register(fileReadTool).register(fileWriteTool).register({
          ...agentTool,
          execute: (input, toolCtx) => agentTool.execute(input, {
            ...toolCtx,
            parentEngineDeps: {
              ...toolCtx.parentEngineDeps,
              adapter: childAdapter,
              parentToolRegistry: registry,
              subAgentLogDir: join(yeaftDir, 'sub-agent-logs'),
            },
          }),
        });
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: registry,
          taskManager,
          yeaftDir,
          sessionId,
          vpId: 'vp-owner',
        });

        const events = [];
        const query = engine.query({
          prompt: 'delegate the write and reread the file',
          workDir,
          sessionId,
          senderVpId: 'vp-owner',
          threadId: 'main',
        });
        for await (const event of query) {
          events.push(event);
          if (event.type === 'tool_end' && event.id === 'spawn-child-write') {
            spawnedAgentId = JSON.parse(event.output).agentId;
          }
        }

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        const agent = getAgentRegistry().get(spawnedAgentId);
        expect(spawnedAgentId).toBeTruthy();
        expect(agent?.taskId).toBeTruthy();
        expect(childToolStarts).toBe(2);
        expect(toolEnds.find(event => event.id === 'read-before-child-write')?.output).toContain('before');
        expect(toolStarts.find(event => event.id === 'read-after-child-write')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-after-child-write')?.output).toContain('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');
        expect(taskManager.getTask(sessionId, agent.taskId)?.status).toBe('succeeded');
      } finally {
        for (const agent of getAgentRegistry().values()) {
          if (agent.parentSessionId !== sessionId || agent.status === 'completed') continue;
          agent.abortController?.abort('test cleanup');
          agent.status = 'closed';
        }
        _resetAgentRegistry();
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not reuse reads after a started Work Item writes the workspace', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-read-cache-work-item-'));
      const sessionId = 'session-work-item-read-cache';
      const filePath = join(workDir, 'state.txt');
      const criterion = 'state.txt contains after';
      let workCenter = null;
      let releaseWorkItemWrite = null;
      let resolveRunnerStarted = null;
      let resolveWriteCompleted = null;
      const runnerStarted = new Promise(resolve => { resolveRunnerStarted = resolve; });
      const writeReleased = new Promise(resolve => { releaseWorkItemWrite = resolve; });
      const writeCompleted = new Promise(resolve => { resolveWriteCompleted = resolve; });
      writeFileSync(filePath, 'before');
      try {
        const runner = {
          async run() {
            resolveRunnerStarted();
            await writeReleased;
            writeFileSync(filePath, 'after');
            resolveWriteCompleted();
            return {
              outcome: 'completed',
              response: 'Action wrote the state.',
              summary: 'State written.',
              evidence: ['state.txt updated by the Work Item runner'],
              acceptanceChecks: [{ criterion, status: 'passed', evidence: 'state.txt contains after' }],
            };
          },
        };
        let initialActionCreated = false;
        const coordinator = {
          ownerBootId: 'coordinator-owner',
          advance(mailboxId, options = {}) {
            if (initialActionCreated) return null;
            initialActionCreated = true;
            const claim = workCenter.store.claimCoordinatorMailbox(
              options.workItemId, this.ownerBootId, 60_000,
            );
            if (!claim || claim.id !== mailboxId) return null;
            const started = workCenter.store.beginDynamicCoordinatorTurn(mailboxId, {
              ownerBootId: this.ownerBootId,
              claimEpoch: claim.claim_epoch,
            });
            if (!started) return null;
            const actionId = `cache-write-${started.turnId}`;
            // This harness supplies the durable authority that a real browser
            // confirmation would establish. The model tool itself must not be
            // able to grant delivery scope through its input.
            workCenter.store.db.prepare('UPDATE work_items SET delivery_target = ? WHERE id = ?')
              .run('workspace_files', options.workItemId);
            const detail = workCenter.store.completeCoordinatorTurn(started.turnId, {
              reply: 'Starting the state update Action.',
              decision: {
                kind: 'create_actions', reason: 'The Work Item is actionable.',
                contractPatch: null, guidance: [], actions: [],
              },
              mutation: {
                createdActions: [{
                  id: actionId,
                  type: 'implement',
                  stageId: actionId,
                  assignmentPolicy: {
                    mode: 'planned', capability: 'implement', candidateVpIds: ['omni'],
                    fixedVpId: null, assignmentReason: 'Test executor', separateFromStageTypes: [],
                  },
                  modelPolicy: null,
                  dependsOnStageIds: [],
                  sourceActionIds: [],
                  workspaceMode: 'shared',
                  changesRequestedStageId: null,
                  requiredRole: '',
                  brief: {
                    objective: 'Update state.txt for the cache invalidation test.',
                    approach: 'Write the requested state after the Coordinator starts this Action.',
                    expectedOutcome: 'state.txt contains after.',
                  },
                  context: [],
                  maxAttempts: 2,
                  instruction: 'Update state.txt to after.',
                }],
                supersedeActionIds: [],
                contractPatch: null,
                workItemType: 'state-write',
              },
            }, started.fence);
            options.onUpdate?.('coordinator.advance_completed', detail);
            return { detail, task: Promise.resolve(detail) };
          },
          shutdown: async () => {},
        };
        workCenter = new WorkCenterService({
          yeaftDir: join(workDir, '.yeaft-work-center'),
          runner,
          coordinator,
          pollIntervalMs: 5,
          watcherOptions: { concurrencyProvider: () => 1 },
          settingsReader: () => ({}),
          listAvailableVpIds: () => ['omni'],
        });
        workCenter.start();
        __testSetWorkCenterService(workCenter);
        const baseStream = mockAdapter.stream.bind(mockAdapter);
        mockAdapter.stream = async function* streamAfterWorkItemWrite(params) {
          const hasStartedWorkItem = params.messages?.some(message => (
            message.role === 'tool' && message.toolCallId === 'start-work-item'
          ));
          if (hasStartedWorkItem) {
            let timer = null;
            try {
              await Promise.race([
                runnerStarted,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Work Item runner did not start')), 2_000); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            releaseWorkItemWrite();
            await writeCompleted;
          }
          yield* baseStream(params);
        };
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-before-work-item', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'tool_call', id: 'start-work-item', name: 'CreateWorkItem', input: {
            title: 'Write state',
            goal: 'Update state.txt',
            acceptanceCriteria: [criterion],
            workDir,
            start: true,
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'tool_call', id: 'read-after-work-item', name: 'FileRead', input: { file_path: 'state.txt' } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'done' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const { default: createWorkItemTool } = await import('../../../agent/yeaft/tools/create-work-item.js');
        const bridge = await import('../../../agent/yeaft/web-bridge.js');
        bridge.__testSetSession({
          conversationStore: { loadRecentBySession: () => [] },
        });
        const registry = new ToolRegistry();
        registry.register(fileReadTool).register(createWorkItemTool);
        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          toolRegistry: registry,
          sessionId,
        });

        const events = [];
        for await (const event of engine.query({ prompt: 'start the work item and reread the state', workDir, sessionId })) {
          events.push(event);
        }

        const toolStarts = events.filter(event => event.type === 'tool_start');
        const toolEnds = events.filter(event => event.type === 'tool_end');
        const created = JSON.parse(toolEnds.find(event => event.id === 'start-work-item')?.output || '{}');
        expect(created.workItemId).toBeTruthy();
        expect(toolEnds.find(event => event.id === 'read-before-work-item')?.output).toContain('before');
        expect(toolStarts.find(event => event.id === 'read-after-work-item')?.reused).not.toBe(true);
        expect(toolEnds.find(event => event.id === 'read-after-work-item')?.output).toContain('after');
        expect(readFileSync(filePath, 'utf8')).toBe('after');
        const deadline = Date.now() + 2_000;
        while (!workCenter.store.getWorkItemDetail(created.workItemId)?.runs.some(run => (
          run.response === 'Action wrote the state.' && run.status === 'completed'
        )) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(workCenter.store.getWorkItemDetail(created.workItemId)?.runs).toEqual(expect.arrayContaining([
          expect.objectContaining({ response: 'Action wrote the state.', status: 'completed' }),
        ]));
      } finally {
        releaseWorkItemWrite?.();
        await workCenter?.shutdown();
        __testSetWorkCenterService(null);
        const bridge = await import('../../../agent/yeaft/web-bridge.js');
        bridge.__testSetSession(null);
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('executes the complete tool batch before appending live user input', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Searching both...' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'foo' } },
        { type: 'tool_call', id: 'call_2', name: 'search', input: { q: 'bar' } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Found both results and handled the update.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const pendingUserMessages = [];
      const baseStream = mockAdapter.stream.bind(mockAdapter);
      let appendedDuringStream = false;
      mockAdapter.stream = async function* streamWithUserAppend(params) {
        for await (const event of baseStream(params)) {
          yield event;
          if (!appendedDuringStream && event.type === 'tool_call' && event.id === 'call_2') {
            appendedDuringStream = true;
            pendingUserMessages.push({
              content: 'Include the new requirement after both searches.',
              preview: 'Include the new requirement after both searches.',
            });
          }
        }
      };

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async (input) => `Results: ${input.q}`,
      });

      const events = [];
      for await (const event of engine.query({
        prompt: 'search foo and bar',
        drainPendingUserMessages: () => pendingUserMessages.splice(0),
      })) {
        events.push(event);
      }

      const toolEnds = events.filter(e => e.type === 'tool_end');
      expect(toolEnds).toHaveLength(2);
      expect(toolEnds[0].output).toBe('Results: foo');
      expect(toolEnds[1].output).toBe('Results: bar');

      expect(mockAdapter.callLog).toHaveLength(2);
      const secondCall = mockAdapter.callLog[1];
      expect(secondCall.messages.map(message => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
      ]);
      expect(secondCall.messages[1].toolCalls.map(call => call.id)).toEqual(['call_1', 'call_2']);
      expect(secondCall.messages.slice(2, 4).map(message => message.toolCallId)).toEqual(['call_1', 'call_2']);
      expect(secondCall.messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'Include the new requirement after both searches.',
      });

      const appendEventIndex = events.findIndex(event => event.type === 'user_append');
      const lastToolEndIndex = events.reduce(
        (last, event, index) => event.type === 'tool_end' ? index : last,
        -1,
      );
      expect(appendEventIndex).toBeGreaterThan(lastToolEndIndex);
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'end_turn',
        terminal: true,
      });
    });
  });

  describe('no max turns cap (task-324)', () => {
    it('should run past the old MAX_TURNS=25 cap when tool loop continues', async () => {
      // Push 30 tool_use responses, then a final end_turn — old behavior
      // would error at turn 26, new behavior runs all 30 tool turns + 1
      // final response turn.
      for (let i = 0; i < 30; i++) {
        mockAdapter.pushResponse([
          { type: 'tool_call', id: `call_${i}`, name: 'echo', input: { msg: `${i}` } },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
      }
      // Final turn: end_turn (no tool calls) to let the loop exit cleanly.
      mockAdapter.pushResponse([
        { type: 'text_delta', delta: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async (input) => input.msg,
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'loop past old cap' })) {
        events.push(event);
      }

      // No "Max turns" error event should be emitted.
      const errorEvents = events.filter(e => e.type === 'error');
      const maxTurnsErrors = errorEvents.filter(e =>
        e.error && /Max turns/.test(e.error.message || '')
      );
      expect(maxTurnsErrors).toHaveLength(0);

      // Turns executed should exceed the old cap of 25.
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThan(25);
      // And should include the final end_turn turn (31 total).
      expect(turnStarts.length).toBe(31);
    });
  });

  describe('adapter errors', () => {
    it('should handle adapter throw gracefully', async () => {
      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new Error('Network error');
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('Network error');
      expect(errorEvents[0].retryable).toBe(false);

      // Should still emit turn_end
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0].stopReason).toBe('error');
    });

    it('surfaces context overflow without a summary call or retry loop', async () => {
      const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
      let streamCalls = 0;
      let summaryCalls = 0;
      const adapter = {
        async *stream() {
          streamCalls += 1;
          throw new LLMContextError('context window exceeded');
        },
        async call() {
          summaryCalls += 1;
          throw new Error('summary call must not happen');
        },
      };
      const engine = new Engine({
        adapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        conversationStore: {
          append() { return null; },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(streamCalls).toBe(1);
      expect(summaryCalls).toBe(0);
      expect(events.some(event => event.type === 'consolidate')).toBe(false);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
    });

    it('marks rate-limit and server errors retryable without retries', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');

      const engine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMRateLimitError('Too fast', 429);
          },
        },
        trace,
        // Disable backoff retry so the test surfaces the legacy error
        // shape directly. The new retry policy is covered separately.
        config: { model: 'test-model', maxOutputTokens: 1024, llmRetry: { maxRetries: 0 } },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);

      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');

      const serverEngine = new Engine({
        adapter: {
          async *stream() {
            throw new LLMServerError('Internal error', 500);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, llmRetry: { maxRetries: 0 } },
      });

      const serverEvents = [];
      for await (const event of serverEngine.query({ prompt: 'hello' })) {
        serverEvents.push(event);
      }

      const serverErrorEvents = serverEvents.filter(e => e.type === 'error');
      expect(serverErrorEvents).toHaveLength(1);
      expect(serverErrorEvents[0].retryable).toBe(true);
    });
  });

  describe('LLM retry policy', () => {
    it('honours server Retry-After on LLMRateLimitError and recovers', async () => {
      const { LLMRateLimitError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            if (attempts === 1) {
              throw new LLMRateLimitError('Too fast', 429, 50);
            }
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(attempts).toBe(2);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(1);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[0].reason).toBe('rate_limit_retry_after');
      expect(retryEvents[0].recoveryMode).toBe('restart');
      expect(retryEvents[0].delayMs).toBeLessThanOrEqual(50);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
    });

    it('uses exponential backoff for LLMServerError and gives up after maxRetries', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMServerError('bad gateway', 502);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // First attempt + 2 retries = 3 total adapter calls.
      expect(attempts).toBe(3);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0].reason).toBe('transient_backoff');
      // Backoff grows: attempt 1 uses base, attempt 2 doubles.
      expect(retryEvents[1].delayMs).toBeGreaterThanOrEqual(retryEvents[0].delayMs);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
    });

    it('classifies stream idle timeout retries separately and marks final retry exhaustion', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      // First attempt + 3 retries = 4 total adapter calls.
      expect(attempts).toBe(4);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(3);
      expect(retryEvents.map(e => e.reason)).toEqual([
        'stream_idle_timeout',
        'stream_idle_timeout',
        'stream_idle_timeout',
      ]);
      expect(retryEvents[0].message).toContain('20000ms');
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].retryable).toBe(true);
      expect(errorEvents[0].reason).toBe('stream_idle_timeout');
      expect(errorEvents[0].retryExhausted).toBe(true);
      expect(errorEvents[0].retryAttempts).toBe(3);
      expect(errorEvents[0].maxRetries).toBe(3);
      expect(errorEvents[0].error).toBeInstanceOf(LLMStreamIdleTimeoutError);

      // Once a complete tool call has crossed the stream boundary, retrying or
      // falling back could publish and execute it twice. Fail closed instead.
      let toolAttempts = 0;
      const toolEngine = new Engine({
        adapter: {
          async *stream() {
            toolAttempts += 1;
            yield { type: 'tool_call', id: 'call-once', name: 'echo', input: { value: 1 } };
            throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 90000ms', 90_000);
          },
        },
        trace,
        config: {
          model: 'test-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });
      const toolEvents = [];
      for await (const event of toolEngine.query({ prompt: 'use a tool' })) toolEvents.push(event);
      expect(toolAttempts).toBe(1);
      expect(toolEvents.filter(event => event.type === 'tool_call')).toHaveLength(1);
      expect(toolEvents.filter(event => event.type === 'llm_retry' || event.type === 'fallback')).toHaveLength(0);
      expect(toolEvents).toContainEqual(expect.objectContaining({
        type: 'error',
        reason: 'stream_idle_timeout',
        retryExhausted: false,
        retryAttempts: 0,
      }));
    });

    it('falls back after stream idle timeout retries are exhausted', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      const models = [];
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            models.push(params.model);
            if (params.model === 'primary-model') {
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(models).toEqual(['primary-model', 'primary-model', 'primary-model', 'fallback-model']);
      const retryEvents = events.filter(e => e.type === 'llm_retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents.map(e => e.reason)).toEqual(['stream_idle_timeout', 'stream_idle_timeout']);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'fallback',
        from: 'primary-model',
        to: 'fallback-model',
      }));
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'fallback ok' }));

      // A retry after visible text must continue from the accepted prefix on a
      // fresh request instead of replaying the original prompt and duplicating
      // the already-rendered output.
      const requests = [];
      const traceRows = [];
      const continuationTrace = Object.create(trace);
      continuationTrace.startTurn = () => 'retry-trace';
      continuationTrace.endTurn = (_id, row) => traceRows.push(row);
      const continuationDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-idle-continuation-'));
      const continuationStore = new ConversationStore(continuationDir);
      let attempt = 0;
      const continuationEngine = new Engine({
        adapter: {
          async *stream(params) {
            requests.push(params.messages.map(message => ({
              role: message.role,
              content: message.content,
            })));
            attempt += 1;
            if (attempt === 1) {
              yield { type: 'text_delta', text: 'first half ' };
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 90000ms', 90_000);
            }
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace: continuationTrace,
        conversationStore: continuationStore,
        yeaftDir: continuationDir,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });
      const continuationEvents = [];
      for await (const event of continuationEngine.query({
        prompt: 'hello',
        sessionId: 'session-idle-continuation',
      })) continuationEvents.push(event);
      expect(attempt).toBe(2);
      expect(continuationEvents.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(['first half ']);
      expect(continuationEvents.filter(event => event.type === 'llm_retry')).toEqual([
        expect.objectContaining({ reason: 'stream_idle_timeout', recoveryMode: 'continue' }),
      ]);
      expect(requests[1].slice(-2)).toEqual([
        expect.objectContaining({ role: 'assistant', content: 'first half ' }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Continue from the exact point'),
        }),
      ]);
      const retryTrace = traceRows.find(row => row.stopReason === 'llm_retry');
      expect(retryTrace.messages).not.toContainEqual(expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Continue from the exact point'),
      }));
      expect(traceRows.at(-1).messages).toContainEqual(expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Continue from the exact point'),
      }));
      expect(continuationStore.loadRecentBySession('session-idle-continuation', 10)
        .find(message => message.content === 'first half ')).toMatchObject({
          responseKind: 'result',
          stopReason: 'end_turn',
        });
      rmSync(continuationDir, { recursive: true, force: true });
    });

    it('does not emit debug loop rows for retryable attempts before fallback succeeds', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            if (params.model === 'primary-model') {
              throw new LLMServerError('Anthropic stream ended before stop event', 0);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(1);
      expect(events.filter(e => e.type === 'fallback')).toHaveLength(1);
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      const loops = events.filter(e => e.type === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0].model).toBe('fallback-model');
      expect(loops[0].response).toBe('fallback ok');
    });

    it('falls back immediately on stream idle timeout when maxRetries is zero', async () => {
      const { LLMStreamIdleTimeoutError } = await import('../../../agent/yeaft/llm/adapter.js');
      const models = [];
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            models.push(params.model);
            if (params.model === 'primary-model') {
              throw new LLMStreamIdleTimeoutError('OpenAI stream idle timeout after 20000ms', 20_000);
            }
            yield { type: 'text_delta', text: 'fallback ok' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: {
          model: 'primary-model',
          fallbackModel: 'fallback-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(models).toEqual(['primary-model', 'fallback-model']);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'fallback',
        from: 'primary-model',
        to: 'fallback-model',
      }));
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'fallback ok' }));
    });

    it('retries generic 403 with the dedicated schedule then exposes the final status', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('LLM provider returned HTTP 403 (unknown_forbidden)', 403, {
              reasonCode: 'unknown_forbidden',
              temporary: true,
            });
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { forbiddenRetryDelaysMs: [0, 0] },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(attempts).toBe(3);
      expect(events.filter(e => e.type === 'llm_retry')).toEqual([
        expect.objectContaining({ reason: 'temporary_forbidden', attempt: 1, maxRetries: 2, statusCode: 403 }),
        expect.objectContaining({ reason: 'temporary_forbidden', attempt: 2, maxRetries: 2, statusCode: 403 }),
      ]);
      const finalError = events.find(e => e.type === 'error');
      expect(finalError.error.statusCode).toBe(403);
      expect(finalError.error.reasonCode).toBe('unknown_forbidden');
      expect(finalError.retryable).toBe(false);
    });

    it('retries a content-policy 422 once with a safe recovery instruction', async () => {
      const { LLMPolicyError } = await import('../../../agent/yeaft/llm/adapter.js');
      const requests = [];
      const engine = new Engine({
        adapter: {
          async *stream(params) {
            requests.push(params);
            if (requests.length === 1) {
              throw new LLMPolicyError('LLM provider rejected the request because its content may violate the provider safety policy', 422);
            }
            yield { type: 'text_delta', text: 'Recovered without repeating sensitive samples.' };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'review the security boundary' })) events.push(event);

      expect(requests).toHaveLength(2);
      expect(requests[1].messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining('authorized code review'),
      });
      expect(requests[1].messages.at(-1).content).toContain('Do not repeat credential-like or exploit payloads');
      expect(events.filter(event => event.type === 'llm_retry')).toEqual([
        expect.objectContaining({
          reason: 'content_policy_recovery',
          attempt: 1,
          maxRetries: 1,
          statusCode: 422,
          recoveryMode: 'continue',
        }),
      ]);
      expect(events.find(event => event.type === 'error')).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        type: 'text_delta',
        text: 'Recovered without repeating sensitive samples.',
      }));
    });

    it('stops after one content-policy recovery and exposes a safe actionable error', async () => {
      const { LLMPolicyError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMPolicyError('raw provider body containing credential-like sample SECRET', 422);
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'review the security boundary' })) events.push(event);

      expect(attempts).toBe(2);
      expect(events.filter(event => event.type === 'llm_retry')).toHaveLength(1);
      const errorEvent = events.find(event => event.type === 'error');
      expect(errorEvent).toMatchObject({
        retryable: false,
        reason: 'content_policy_denied',
        retryExhausted: true,
        retryAttempts: 1,
        maxRetries: 1,
        error: expect.objectContaining({
          name: 'LLMPolicyError',
          statusCode: 422,
          reasonCode: 'content_policy_denied',
          message: expect.stringContaining('Continue and avoid repeating sensitive payloads'),
        }),
      });
      expect(errorEvent.error.message).not.toContain('SECRET');
      expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({
        stopReason: 'error',
        terminal: true,
        detail: expect.objectContaining({
          reason: 'content_policy_denied',
          statusCode: 422,
        }),
      });
    });

    it('does not retry a generic validation 422', async () => {
      let attempts = 0;
      const invalid = Object.assign(new Error('Invalid request schema'), { statusCode: 422 });
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw invalid;
          },
        },
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(attempts).toBe(1);
      expect(events.filter(event => event.type === 'llm_retry')).toHaveLength(0);
      expect(events.find(event => event.type === 'error')).toMatchObject({ retryable: false });
    });

    it('does not retry on non-retryable error', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('bad key', 401);
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(attempts).toBe(1);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      // Static credentials cannot self-heal; waiting would only delay the same failure.
      expect(errorEvents[0].retryable).toBe(false);
      expect(errorEvents[0].error.statusCode).toBe(401);
    });

    it('does not retry a policy-denied 403', async () => {
      const { LLMAuthError } = await import('../../../agent/yeaft/llm/adapter.js');
      let attempts = 0;
      const engine = new Engine({
        adapter: {
          async *stream() {
            attempts += 1;
            throw new LLMAuthError('LLM provider returned HTTP 403 (permission_denied)', 403, {
              reasonCode: 'permission_denied',
              temporary: false,
            });
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { forbiddenRetryDelaysMs: [0, 0] },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(attempts).toBe(1);
      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      expect(events.find(e => e.type === 'error').error.reasonCode).toBe('permission_denied');
    });

    it('terminates on non-retryable in-band adapter error instead of normal end_turn', async () => {
      const failed = new Error('bad request body');
      failed.code = 'invalid_request_error';
      const engine = new Engine({
        adapter: {
          async *stream() {
            yield { type: 'error', error: failed, retryable: false };
          },
        },
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(0);
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('bad request body');
      expect(errorEvents[0].retryable).toBe(false);
      const loops = events.filter(e => e.type === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0].stopReason).toBe('error');
      expect(loops[0].response).toBe('Error: bad request body');
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'error' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'end_turn' }));
    });

    it('settles retry persistence at dispatch, close, and terminal failure boundaries', async () => {
      const { LLMServerError } = await import('../../../agent/yeaft/llm/adapter.js');
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-turn-start-close-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              if (attempts === 1) {
                yield { type: 'text_delta', text: 'visible partial before retry' };
                throw new LLMServerError('temporary upstream failure', 503);
              }
              yield { type: 'stop', stopReason: 'end_turn' };
            },
          },
          trace,
          conversationStore,
          yeaftDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const iterator = engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-turn-start-close',
          vpTurnId: 'turn-retry-turn-start-close',
        })[Symbol.asyncIterator]();
        let secondTurnStart = false;
        while (true) {
          const step = await iterator.next();
          if (step.done) throw new Error('retry ended before its next turn_start');
          if (step.value.type === 'turn_start' && step.value.turnNumber === 2) {
            secondTurnStart = true;
            break;
          }
        }
        expect(secondTurnStart).toBe(true);
        expect(attempts).toBe(1);
        await iterator.return();

        expect(attempts).toBe(1);
        expect(conversationStore.loadRecentBySession('session-retry-turn-start-close', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before retry',
            incomplete: true,
            stopReason: 'aborted',
            turnId: 'turn-retry-turn-start-close',
          }),
        ]);
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }

      const routerDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-router-retry-close-'));
      const routerFetch = globalThis.fetch;
      try {
        const conversationStore = new ConversationStore(routerDir);
        let fetches = 0;
        globalThis.fetch = async () => {
          fetches += 1;
          return new Response(
            'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"visible router partial"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        };
        const router = new AdapterRouter({
          providers: [{
            name: 'retry-router',
            baseUrl: 'https://retry-router.example/v1',
            apiKey: 'retry-router-key',
            protocol: 'openai-responses',
            models: ['retry-router-model'],
          }],
        });
        const routerEngine = new Engine({
          adapter: router,
          trace,
          conversationStore,
          yeaftDir: routerDir,
          config: {
            model: 'retry-router/retry-router-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });
        const iterator = routerEngine.query({
          prompt: 'router retry',
          sessionId: 'session-router-retry-close',
          vpTurnId: 'turn-router-retry-close',
        })[Symbol.asyncIterator]();
        while (true) {
          const step = await iterator.next();
          if (step.done) throw new Error('retry ended before second turn_start');
          if (step.value.type === 'turn_start' && step.value.turnNumber === 2) break;
        }
        expect(fetches).toBe(1);
        await iterator.return();
        expect(fetches).toBe(1);
        expect(conversationStore.loadRecentBySession('session-router-retry-close', Infinity))
          .not.toContainEqual(expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Continue from the exact point'),
          }));
      } finally {
        globalThis.fetch = routerFetch;
        rmSync(routerDir, { recursive: true, force: true });
      }

      const boundaryDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-abort-partial-'));
      try {
        const conversationStore = new ConversationStore(boundaryDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              yield { type: 'text_delta', text: 'visible partial before retry' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir: boundaryDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const iterator = engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-abort',
          vpTurnId: 'turn-retry-abort',
        })[Symbol.asyncIterator]();
        const events = [];
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          events.push(step.value);
          if (step.value.type === 'turn_end' && step.value.stopReason === 'llm_retry') break;
        }
        await iterator.return();

        expect(attempts).toBe(1);
        expect(events.some(e => e.type === 'llm_retry')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'llm_retry' }));
        expect(conversationStore.loadRecentBySession('session-retry-abort', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before retry',
            incomplete: true,
            stopReason: 'aborted',
            turnId: 'turn-retry-abort',
          }),
        ]);
      } finally {
        rmSync(boundaryDir, { recursive: true, force: true });
      }
      const errorDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-final-partial-'));
      try {
        const conversationStore = new ConversationStore(errorDir);
        let attempts = 0;
        const engine = new Engine({
          adapter: {
            async *stream() {
              attempts += 1;
              if (attempts === 1) yield { type: 'text_delta', text: 'visible partial before failure' };
              throw new LLMServerError('temporary upstream failure', 503);
            },
          },
          trace,
          conversationStore,
          yeaftDir: errorDir,
          config: {
            model: 'test-model',
            maxOutputTokens: 1024,
            llmRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });

        const events = [];
        for await (const event of engine.query({
          prompt: 'hi',
          sessionId: 'session-retry-final-partial',
          vpTurnId: 'turn-retry-final-partial',
        })) events.push(event);

        expect(attempts).toBe(3);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true }));
        expect(conversationStore.loadRecentBySession('session-retry-final-partial', Infinity)).toEqual([
          expect.objectContaining({ role: 'user', content: 'hi' }),
          expect.objectContaining({
            role: 'assistant',
            content: 'visible partial before failure',
            incomplete: true,
            stopReason: 'error',
            turnId: 'turn-retry-final-partial',
          }),
          expect.objectContaining({
            role: 'user',
            userAuthored: false,
            content: expect.stringContaining('Continue from the exact point'),
          }),
        ]);
      } finally {
        rmSync(errorDir, { recursive: true, force: true });
      }
    });
  });

  describe('max_tokens stop reason', () => {
    it('should yield turn_end with max_tokens when output is truncated', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'This response was cut short because—' },
        { type: 'usage', inputTokens: 50, outputTokens: 16384 },
        { type: 'stop', stopReason: 'max_tokens' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 16384 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'write a long essay' })) {
        events.push(event);
      }

      // Should have stop event with max_tokens
      const stopEvents = events.filter(e => e.type === 'stop');
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0].stopReason).toBe('max_tokens');

      // turn_end should reflect max_tokens_continue (Phase 2: auto-continue)
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd.stopReason).toBe('max_tokens_continue');
      expect(turnEnd.turnNumber).toBe(1);

      // Phase 2: auto-continue triggers additional turns
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('abort signal', () => {
    it('links normal signals and handles pre-aborted signals', async () => {
      const ac = new AbortController();
      let receivedSignal = null;

      const abortAdapter = {
        async *stream(params) {
          receivedSignal = params.signal;
          // Simulate checking the signal
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Hello' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const engine = new Engine({
        adapter: abortAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello', signal: ac.signal })) {
        events.push(event);
      }

      // task-325a: the engine now owns an internal AbortController that
      // mirrors the caller-provided signal, so the adapter receives the
      // engine's linked signal (not the caller's identity). Verify that
      // a valid AbortSignal was propagated rather than identity.
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      // Verify normal completion when signal is not aborted
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(1);

      const preAbortedController = new AbortController();
      preAbortedController.abort(); // Pre-abort

      const preAbortedAdapter = {
        async *stream(params) {
          if (params.signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield { type: 'text_delta', text: 'Should not reach' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const preAbortedEngine = new Engine({
        adapter: preAbortedAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const preAbortedEvents = [];
      for await (const event of preAbortedEngine.query({ prompt: 'hello', signal: preAbortedController.signal })) {
        preAbortedEvents.push(event);
      }

      // task-325a: pre-aborted external signal now converges on the
      // typed `aborted` event (not a generic `error`), and the turn
      // ends with stopReason 'aborted'.
      const abortedEvents = preAbortedEvents.filter(e => e.type === 'aborted');
      expect(abortedEvents).toHaveLength(1);
      expect(abortedEvents[0].reason).toBe('external');
      const turnEnds = preAbortedEvents.filter(e => e.type === 'turn_end');
      expect(turnEnds.at(-1).stopReason).toBe('aborted');
    });

    it('should pass signal to tool execute function', async () => {
      const ac = new AbortController();
      let toolReceivedSignal = null;

      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call_1', name: 'slow_tool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'slow_tool',
        description: 'A slow tool',
        parameters: {},
        execute: async (input, ctx) => {
          toolReceivedSignal = ctx?.signal;
          return 'done';
        },
      });

      for await (const _event of engine.query({ prompt: 'use tool', signal: ac.signal })) {
        // consume
      }

      // task-325a: engine's internal linked signal is forwarded, so the
      // tool receives an AbortSignal — not the caller's identity.
      expect(toolReceivedSignal).toBeInstanceOf(AbortSignal);
    });

    // Regression: per-VP Stop in Yeaft Session was not interrupting the
    // current turn promptly. The wire frame reached the agent, the
    // controller fired, but the upstream LLM stream had already buffered
    // a batch of SSE chunks at the network/proxy layer. The adapter
    // continued reading them (reader.read() doesn't observe the signal
    // synchronously when chunks are already in the kernel buffer), and
    // the engine for-await loop happily yielded each chunk to the
    // web-bridge, which pushed yeaft_output frames to the browser for
    // 1–2s after Stop. The fix: engine must check signal.aborted before
    // yielding each adapter event so already-buffered chunks are
    // dropped — not forwarded — once the user has requested abort.
    it('drops buffered adapter chunks emitted after abort fires', async () => {
      // A non-cooperative adapter: it does NOT observe params.signal and
      // synchronously yields a long sequence of text_delta + tool_call
      // events, exactly like a fetch() ReadableStream that already has
      // SSE chunks in its kernel/proxy buffer when AbortSignal fires.
      const noncoopAdapter = {
        async *stream(_params) {
          // Pre-buffered chunks. None of these observe the signal —
          // that's the whole point: this models the network reality
          // where bytes are already in flight when Stop is pressed.
          for (let i = 0; i < 30; i += 1) {
            yield { type: 'text_delta', text: `chunk-${i} ` };
          }
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const ac = new AbortController();
      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      // Abort fires synchronously BEFORE the first yield is consumed.
      // This is the most adversarial timing: every single chunk the
      // adapter emits is post-abort, so a correctly-behaving engine
      // must yield zero text_delta events to the caller.
      ac.abort('user');

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const aborted = events.filter(e => e.type === 'aborted');
      const turnEnds = events.filter(e => e.type === 'turn_end');

      // With the bug: textDeltas.length === 30 (all buffered chunks
      // leaked through). With the fix: textDeltas.length === 0 because
      // the engine checks signal.aborted before forwarding each adapter
      // event.
      expect(textDeltas).toHaveLength(0);
      expect(aborted).toHaveLength(1);
      expect(aborted[0].reason).toBe('external');
      expect(turnEnds.at(-1)?.stopReason).toBe('aborted');
    });

    it('treats a clean stream end after abort as aborted', async () => {
      let abortFn = null;
      const noncoopAdapter = {
        async *stream() {
          yield { type: 'text_delta', text: 'partial ' };
          if (abortFn) abortFn();
          // Some proxies close the body cleanly on abort instead of throwing.
          // No more events are yielded, so only the post-stream guard can
          // prevent this truncated response from reaching persistence.
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');
      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      expect(events.filter(e => e.type === 'text_delta')).toHaveLength(1);
      expect(events.filter(e => e.type === 'aborted')).toHaveLength(1);
      expect(events.filter(e => e.type === 'turn_end').at(-1)?.stopReason).toBe('aborted');
    });

    it('drops adapter chunks emitted after abort fires mid-stream', async () => {
      // Same as above but abort fires AFTER a few chunks were already
      // legitimately delivered. Everything emitted post-abort must be
      // dropped; pre-abort chunks must still flow.
      let abortFn = null;
      const noncoopAdapter = {
        async *stream(_params) {
          for (let i = 0; i < 5; i += 1) {
            yield { type: 'text_delta', text: `pre-${i} ` };
          }
          // Trigger abort mid-stream. The remaining 25 chunks are the
          // "already in network buffer" payload the engine must drop.
          if (abortFn) abortFn();
          for (let i = 0; i < 25; i += 1) {
            yield { type: 'text_delta', text: `post-${i} ` };
          }
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const ac = new AbortController();
      abortFn = () => ac.abort('user');

      const engine = new Engine({
        adapter: noncoopAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hi', signal: ac.signal })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const preChunks = textDeltas.filter(e => e.text.startsWith('pre-'));
      const postChunks = textDeltas.filter(e => e.text.startsWith('post-'));

      expect(preChunks).toHaveLength(5);
      // With the bug: postChunks.length === 25. With the fix: 0.
      expect(postChunks).toHaveLength(0);
      const aborted = events.filter(e => e.type === 'aborted');
      const turnEnds = events.filter(e => e.type === 'turn_end');
      expect(aborted).toHaveLength(1);
      expect(turnEnds.at(-1)?.stopReason).toBe('aborted');
    });
  });

  describe('debug trace integration', () => {
    it('should record turns and tools in debug trace', async () => {
      const dbTrace = new DebugTrace(TEST_DB);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test' } },
        { type: 'usage', inputTokens: 50, outputTokens: 20 },
        { type: 'stop', stopReason: 'tool_use' },
      ]);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'Done.' },
        { type: 'usage', inputTokens: 80, outputTokens: 10 },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace: dbTrace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of engine.query({ prompt: 'search test' })) {
        // consume events
      }

      // Check debug trace recorded the turns
      const stats = await dbTrace.stats();
      expect(stats.turnCount).toBe(2);
      expect(stats.toolCount).toBe(1);

      // Check turn details
      const recent = await dbTrace.queryRecent(10);
      expect(recent).toHaveLength(2);

      // Check tool details
      const tools = await dbTrace.queryTools({ name: 'search' });
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe('search');
      expect(tools[0].tool_output).toBe('results');

      dbTrace.refreshConfig({ traceTextMaxBytes: 64 });
      const boundedTurn = dbTrace.startTurn({ traceId: 'trace-bounded', turnNumber: 3 });
      dbTrace.endTurn(boundedTurn, {
        systemPrompt: 'system',
        messages: [{ role: 'user', content: '😀'.repeat(200) }],
        responseText: 'ok',
        stopReason: 'end_turn',
      });
      await dbTrace.flush();
      const bounded = await dbTrace.fetchRecentDebugHistory({ detailTurnId: 'trace-bounded' });
      expect(Buffer.byteLength(JSON.stringify(bounded.loops[0]?.messages || []), 'utf8')).toBeLessThanOrEqual(64);

      await dbTrace.close();

      const traceRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-raw-response-'));
      const boundedTrace = new DebugTrace(traceRoot);
      const rawResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(420_000),
        format: 'openai-responses',
      };

      try {
        for (let i = 1; i <= 100; i += 1) {
          const turnId = boundedTrace.startTurn({
            traceId: 'long-tool-turn',
            turnNumber: i,
            sessionId: 's-long',
            userPrompt: 'do long work',
            memoryLoaded: [{
              id: 'resident:sessions/s-long',
              layer: 'resident',
              scope: 'sessions/s-long',
              body: 'remember this exact resident summary',
            }],
            memoryLoadedMeta: { recallLimit: 8, recallCandidates: 1 },
          });
          boundedTrace.endTurn(turnId, {
            responseText: '',
            rawResponse,
            stopReason: 'tool_use',
            model: 'gateway-search-model',
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            latencyMs: 5,
            messages: [{ role: 'user', content: 'do long work' }],
          });
          if (i === 1) boundedTrace.logTool(turnId, { toolName: 'search', toolOutput: 'ok' });
        }
        boundedTrace.finalizeQuery('long-tool-turn', { sessionId: 's-long', stopReason: 'end_turn' });
        await boundedTrace.flush();

        const beforeEviction = await boundedTrace.fetchRecentDebugHistory({
          sessionId: 's-long',
          indexOnly: true,
          search: '/gateway-search-model|search|tool_use|end_turn/',
        });
        expect(beforeEviction.turns).toEqual([
          expect.objectContaining({
            turnId: 'long-tool-turn',
            loopCount: 100,
            totalTokens: 300,
            totalMs: 500,
          }),
        ]);

        const requestRoot = join(traceRoot, 'sessions', 's-long', 'debug', 'requests');
        const [requestDir] = readdirSync(requestRoot);
        const eventFile = join(requestRoot, requestDir, 'events.jsonl');
        const savedEvents = readFileSync(eventFile, 'utf8');
        writeFileSync(eventFile, '', 'utf8');
        const evictedDetail = await boundedTrace.fetchTurnDebug({ sessionId: 's-long', turnId: 'long-tool-turn' });
        expect(evictedDetail.loops).toEqual([]);
        writeFileSync(eventFile, savedEvents, 'utf8');
        await boundedTrace.close();

        const storedLoops = readFileSync(eventFile, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
          .filter(event => event.type === 'loop')
          .map(event => event.record);

        expect(storedLoops).toHaveLength(100);
        expect(storedLoops.every(loop => loop.rawResponse?.__truncated === true)).toBe(true);
        expect(storedLoops.every(loop => loop.rawResponse?.maxBytes === 64 * 1024)).toBe(true);
        expect(lstatSync(eventFile).size).toBeLessThan(8 * 1024 * 1024);

        const reopened = new DebugTrace(traceRoot);
        const reopenedStats = await reopened.stats();
        expect(reopenedStats.turnCount).toBeGreaterThanOrEqual(100);
        const detail = await reopened.fetchTurnDebug({ sessionId: 's-long', turnId: 'long-tool-turn' });
        expect(detail.turns).toHaveLength(1);
        expect(detail.turns[0]).toMatchObject({
          memoryLoaded: [{
            id: 'resident:sessions/s-long',
            layer: 'resident',
            scope: 'sessions/s-long',
            body: 'remember this exact resident summary',
          }],
          memoryLoadedMeta: { recallLimit: 8, recallCandidates: 1 },
        });
        expect(detail.loops).toHaveLength(100);
        expect(detail.loops.at(-1)?.loopNumber).toBe(100);
        expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThan(6 * 1024 * 1024);

        const oversizedDetail = {
          loops: Array.from({ length: 4 }, (_, index) => ({
            turnId: 'oversized-turn',
            loopNumber: index + 1,
            systemPrompt: 'system prompt',
            response: 'R'.repeat(3 * 1024 * 1024),
            rawResponse: { body: 'X'.repeat(3 * 1024 * 1024) },
          })),
          turns: [{ turnId: 'oversized-turn', loopCount: 4 }],
          dreamEvents: [],
          detailTurnId: 'oversized-turn',
        };
        const projectedDetail = projectDebugDetailForWire(oversizedDetail);
        expect(Buffer.byteLength(JSON.stringify(projectedDetail), 'utf8')).toBeLessThan(6 * 1024 * 1024);
        expect(projectedDetail.projection).toMatchObject({
          truncated: true,
          reason: 'debug_detail_wire_budget',
          maxBytes: 6 * 1024 * 1024,
        });
        expect(projectedDetail.loops.some(loop => (
          loop.rawResponse?.__truncated === true
          && loop.rawResponse?.reason === 'debug_detail_wire_budget'
        ))).toBe(true);

        for (const toolCount of [24, 100]) {
          const toolDetail = {
            loops: [],
            turns: [{
              turnId: `tool-turn-${toolCount}`,
              tools: Array.from({ length: toolCount }, (_, index) => ({
                name: 'large-tool',
                toolInput: `input-${index}`,
                toolOutput: 'T'.repeat(256 * 1024),
              })),
            }],
            dreamEvents: [],
          };
          const projectedTools = projectDebugDetailForWire(toolDetail);
          expect(Buffer.byteLength(JSON.stringify(projectedTools), 'utf8')).toBeLessThan(6 * 1024 * 1024);
          expect(projectedTools.turns[0].tools).toHaveLength(toolCount);
          expect(projectedTools.turns[0].tools.every(tool => (
            typeof tool.toolOutput === 'string' && tool.toolOutput.includes('wire truncated')
          ))).toBe(true);
        }

        const cumulativeRequest = { body: 'Q'.repeat(2 * 1024 * 1024) };
        const cumulativeDetail = {
          loops: Array.from({ length: 50 }, (_, index) => ({
            turnId: 'cumulative-turn',
            loopNumber: index + 1,
            rawRequest: cumulativeRequest,
            response: 'ok',
          })),
          turns: [{ turnId: 'cumulative-turn' }],
          dreamEvents: [],
        };
        const projectionStartedAt = performance.now();
        const projectedCumulative = projectDebugDetailForWire(cumulativeDetail);
        const projectionElapsedMs = performance.now() - projectionStartedAt;
        expect(Buffer.byteLength(JSON.stringify(projectedCumulative), 'utf8')).toBeLessThan(6 * 1024 * 1024);
        expect(projectedCumulative.projection.truncatedFields).toBe(50);
        // The old implementation re-stringified the entire 100 MiB payload for
        // every loop and independently took over 13 seconds for this shape.
        // Leave ample CI headroom while fencing it below the browser's 10s timer.
        expect(projectionElapsedMs).toBeLessThan(5_000);
        // The wire projection is derived after persistence; canonical event
        // records retain their normal per-field storage bounds.
        expect(storedLoops.every(loop => loop.rawResponse?.maxBytes === 64 * 1024)).toBe(true);

        // Aggregate queries must not pin every full request payload in memory.
        // After stats(), detail still comes from disk rather than a process-life
        // cache populated by a global hydrate.
        writeFileSync(eventFile, '', 'utf8');
        const detailAfterDiskChange = await reopened.fetchTurnDebug({
          sessionId: 's-long',
          turnId: 'long-tool-turn',
        });
        expect(detailAfterDiskChange.loops).toEqual([]);
        writeFileSync(eventFile, savedEvents, 'utf8');
        await reopened.close();

        appendFileSync(eventFile, '{"type":"loop"', 'utf8');
        const afterTornTail = new DebugTrace(traceRoot);
        const recovered = await afterTornTail.fetchTurnDebug({ sessionId: 's-long', turnId: 'long-tool-turn' });
        expect(recovered.loops).toHaveLength(100);
        await afterTornTail.close();

        const longPrefix = 's'.repeat(120);
        const firstLongSession = `${longPrefix}AAAA`;
        const secondLongSession = `${longPrefix}BBBB`;
        const isolated = new DebugTrace(traceRoot);
        const secretTurn = isolated.startTurn({ traceId: 'same-turn', turnNumber: 1, sessionId: firstLongSession, userPrompt: 'SECRET' });
        isolated.endTurn(secretTurn, { responseText: 'SECRET-X', stopReason: 'end_turn' });
        const publicTurn = isolated.startTurn({ traceId: 'same-turn', turnNumber: 1, sessionId: secondLongSession, userPrompt: 'PUBLIC' });
        isolated.endTurn(publicTurn, { responseText: 'PUBLIC-Y', stopReason: 'end_turn' });
        await isolated.close();
        const isolationReader = new DebugTrace(traceRoot);
        const isolatedDetail = await isolationReader.fetchTurnDebug({ sessionId: secondLongSession, turnId: 'same-turn' });
        expect(isolatedDetail.loops.map(loop => loop.response)).toEqual(['PUBLIC-Y']);
        await isolationReader.close();

        const continuationRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-continuation-'));
        try {
          const initial = new DebugTrace(continuationRoot);
          const initialTurn = initial.startTurn({ traceId: 'continued-turn', turnNumber: 1, sessionId: 'continued-session' });
          initial.endTurn(initialTurn, { responseText: 'loop-1', stopReason: 'tool_use' });
          await initial.close();
          const requests = join(continuationRoot, 'sessions', 'continued-session', 'debug', 'requests');
          const [continuedRequestKey] = readdirSync(requests);
          const continuedEvents = join(requests, continuedRequestKey, 'events.jsonl');
          appendFileSync(continuedEvents, '{"type":"loop"', 'utf8');

          const continued = new DebugTrace(continuationRoot);
          await continued.resumeTrace({ sessionId: 'continued-session', turnId: 'continued-turn' });
          const secondTurn = continued.startTurn({ traceId: 'continued-turn', turnNumber: 2, sessionId: 'continued-session' });
          continued.endTurn(secondTurn, { responseText: 'loop-2', stopReason: 'end_turn' });
          await continued.close();
          const continuationReader = new DebugTrace(continuationRoot);
          const continuedDetail = await continuationReader.fetchTurnDebug({ sessionId: 'continued-session', turnId: 'continued-turn' });
          expect(continuedDetail.loops.map(loop => loop.response)).toEqual(['loop-1', 'loop-2']);
          await continuationReader.close();
        } finally {
          rmSync(continuationRoot, { recursive: true, force: true });
        }

        const legacyRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-legacy-'));
        try {
          const legacyRequestDir = join(legacyRoot, 'sessions', 'legacy-session', 'debug', 'requests', 'legacy-request');
          mkdirSync(legacyRequestDir, { recursive: true });
          writeFileSync(join(legacyRequestDir, 'trace.json'), JSON.stringify({
            version: 2,
            requestKey: 'legacy-request',
            requestId: 'legacy-turn',
            traceId: 'legacy-turn',
            sessionId: 'legacy-session',
            openedAt: 1,
            updatedAt: 1,
            active: true,
            baseRequest: { systemPrompt: '', messages: [], rawRequest: null },
            loops: [{ loopInstanceId: 'legacy-loop-1', turnRowId: 'legacy-loop-1', loopNumber: 1, response: 'legacy-1', requestDelta: { base: true, systemPrompt: '', messages: [] }, at: 1 }],
            tools: [],
          }), 'utf8');
          const legacyWriter = new DebugTrace(legacyRoot);
          await legacyWriter.resumeTrace({ sessionId: 'legacy-session', turnId: 'legacy-turn' });
          const legacyNext = legacyWriter.startTurn({ traceId: 'legacy-turn', turnNumber: 2, sessionId: 'legacy-session' });
          legacyWriter.endTurn(legacyNext, { responseText: 'legacy-2', stopReason: 'end_turn' });
          await legacyWriter.close();
          const legacyReader = new DebugTrace(legacyRoot);
          const legacyStats = await legacyReader.stats();
          expect(legacyStats).toMatchObject({ turnCount: 2, toolCount: 0, requestCount: 1 });
          const legacyDetail = await legacyReader.fetchTurnDebug({ sessionId: 'legacy-session', turnId: 'legacy-turn' });
          expect(legacyDetail.loops.map(loop => loop.response)).toEqual(['legacy-1', 'legacy-2']);
          const rawPayloadSearch = await legacyReader.fetchRecentDebugHistory({
            sessionId: 'legacy-session',
            indexOnly: true,
            search: 'legacy-1',
          });
          expect(rawPayloadSearch.turns).toEqual([]);
          await legacyReader.close();
        } finally {
          rmSync(legacyRoot, { recursive: true, force: true });
        }

        const safeDirRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-safe-dir-'));
        try {
          const sessionId = 'legacy/session';
          const safeWriter = new DebugTrace(safeDirRoot);
          const oldSafeTurn = safeWriter.startTurn({ traceId: 'old-safe-turn', turnNumber: 1, sessionId });
          safeWriter.endTurn(oldSafeTurn, { responseText: 'old-response', stopReason: 'end_turn' });
          safeWriter.finalizeQuery('old-safe-turn', { sessionId });
          const safeTurn = safeWriter.startTurn({ traceId: 'safe-turn', turnNumber: 1, sessionId });
          safeWriter.logTool(safeTurn, { toolName: 'legacy_tool', toolOutput: 'needle-tool-output' });
          safeWriter.endTurn(safeTurn, { responseText: 'needle-response', stopReason: 'end_turn' });
          safeWriter.finalizeQuery('safe-turn', { sessionId });
          await safeWriter.close();

          const sessionsDir = join(safeDirRoot, 'sessions');
          const [currentSessionName] = readdirSync(sessionsDir);
          const currentSessionDir = join(sessionsDir, currentSessionName);
          const legacySessionDir = join(sessionsDir, 'legacy_session');
          renameSync(currentSessionDir, legacySessionDir);

          const safeReader = new DebugTrace(safeDirRoot);
          expect(await safeReader.stats()).toMatchObject({ turnCount: 2, toolCount: 1, requestCount: 2 });
          const safeDetail = await safeReader.fetchTurnDebug({ sessionId, turnId: 'safe-turn' });
          expect(safeDetail.loops.map(loop => loop.response)).toEqual(['needle-response']);
          expect(await safeReader.queryTools({ name: 'legacy_tool' })).toHaveLength(1);
          expect(await safeReader.search('needle-response')).toHaveLength(1);
          expect(await safeReader.cleanup(1)).toMatchObject({ deletedRequests: 1 });
          const afterPrune = await safeReader.fetchTurnDebug({ sessionId, turnId: 'safe-turn' });
          expect(afterPrune.loops.map(loop => loop.response)).toEqual(['needle-response']);
          const prunedSafe = await safeReader.fetchTurnDebug({ sessionId, turnId: 'old-safe-turn' });
          expect(prunedSafe.loops).toEqual([]);
          await safeReader.close();
        } finally {
          rmSync(safeDirRoot, { recursive: true, force: true });
        }

        const retentionRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-retention-'));
        try {
          const sessionId = `${'r'.repeat(120)}TAIL`;
          const firstProcess = new DebugTrace(retentionRoot);
          for (let i = 1; i <= 10; i += 1) {
            const id = `retention-${i}`;
            const rowId = firstProcess.startTurn({ traceId: id, turnNumber: 1, sessionId });
            firstProcess.endTurn(rowId, { responseText: id, stopReason: 'end_turn' });
          }
          await firstProcess.close();
          const currentRequests = join(retentionRoot, 'sessions', sessionId, 'debug', 'requests');
          const currentTurns = join(retentionRoot, 'sessions', sessionId, 'debug', 'turns');
          expect(readdirSync(currentRequests)).toHaveLength(10);
          const firstLocator = readdirSync(currentTurns).find(name => name.startsWith('retention-1-'));
          expect(firstLocator).toBeTruthy();

          // Simulate coexistence with the old lossy directory mapping. The
          // retained request is moved, not copied, so the unified timeline is
          // still exactly ten requests before process B appends one.
          const [firstRequestDir] = readdirSync(currentRequests).sort();
          const legacyDebugDir = join(retentionRoot, 'sessions', sessionId.slice(0, 120), 'debug');
          const legacyRequests = join(legacyDebugDir, 'requests');
          const legacyTurns = join(legacyDebugDir, 'turns');
          mkdirSync(legacyRequests, { recursive: true });
          mkdirSync(legacyTurns, { recursive: true });
          renameSync(join(currentRequests, firstRequestDir), join(legacyRequests, firstRequestDir));
          renameSync(join(currentTurns, firstLocator), join(legacyTurns, firstLocator));

          const secondProcess = new DebugTrace(retentionRoot);
          const eleventh = secondProcess.startTurn({ traceId: 'retention-11', turnNumber: 1, sessionId });
          secondProcess.endTurn(eleventh, { responseText: 'retention-11', stopReason: 'end_turn' });
          await secondProcess.close();

          const remainingCurrent = readdirSync(currentRequests);
          const remainingLegacy = readdirSync(legacyRequests);
          expect(remainingCurrent.length + remainingLegacy.length).toBe(10);
          expect(remainingLegacy).toHaveLength(0);
          expect(existsSync(join(currentTurns, firstLocator))).toBe(false);
          expect(existsSync(join(legacyTurns, firstLocator))).toBe(false);
          const retentionReader = new DebugTrace(retentionRoot);
          const newest = await retentionReader.fetchTurnDebug({ sessionId, turnId: 'retention-11' });
          expect(newest.loops.map(loop => loop.response)).toEqual(['retention-11']);
          const pruned = await retentionReader.fetchTurnDebug({ sessionId, turnId: 'retention-1' });
          expect(pruned.loops).toEqual([]);
          await retentionReader.close();
        } finally {
          rmSync(retentionRoot, { recursive: true, force: true });
        }

        const duplicateRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-legacy-duplicate-'));
        try {
          const sessionId = `${'d'.repeat(120)}TAIL`;
          const currentRequests = join(duplicateRoot, 'sessions', sessionId, 'debug', 'requests');
          const legacyRequests = join(duplicateRoot, 'sessions', sessionId.slice(0, 120), 'debug', 'requests');
          const normalWriter = new DebugTrace(duplicateRoot);
          for (let i = 1; i <= 9; i += 1) {
            const id = `normal-${i}`;
            const rowId = normalWriter.startTurn({ traceId: id, turnNumber: 1, sessionId });
            normalWriter.endTurn(rowId, { responseText: id, stopReason: 'end_turn' });
          }
          await normalWriter.close();
          const legacyRequestDir = join(legacyRequests, 'legacy-active-request');
          mkdirSync(legacyRequestDir, { recursive: true });
          writeFileSync(join(legacyRequestDir, 'trace.json'), JSON.stringify({
            version: 2,
            requestKey: 'legacy-active-request',
            requestId: 'legacy-active-turn',
            traceId: 'legacy-active-turn',
            sessionId,
            openedAt: Date.now(),
            updatedAt: Date.now(),
            active: true,
            baseRequest: { systemPrompt: '', messages: [], rawRequest: null },
            loops: [{ loopInstanceId: 'legacy-active-1', turnRowId: 'legacy-active-1', loopNumber: 1, response: 'legacy-active-1', requestDelta: { base: true, systemPrompt: '', messages: [] }, at: Date.now() }],
            tools: [],
          }), 'utf8');

          const migrationWriter = new DebugTrace(duplicateRoot);
          await migrationWriter.resumeTrace({ sessionId, turnId: 'legacy-active-turn' });
          const migratedTurn = migrationWriter.startTurn({ traceId: 'legacy-active-turn', turnNumber: 2, sessionId });
          migrationWriter.endTurn(migratedTurn, { responseText: 'legacy-active-2', stopReason: 'tool_use' });
          await migrationWriter.flush();
          expect(readdirSync(currentRequests)).toHaveLength(10);
          expect(readdirSync(legacyRequests)).toHaveLength(0);

          // A later loop must keep using the same live request after retention.
          const nextTurn = migrationWriter.startTurn({ traceId: 'legacy-active-turn', turnNumber: 3, sessionId });
          migrationWriter.endTurn(nextTurn, { responseText: 'legacy-active-3', stopReason: 'end_turn' });
          await migrationWriter.close();
          expect(readdirSync(currentRequests)).toHaveLength(10);
          const duplicateReader = new DebugTrace(duplicateRoot);
          const migratedDetail = await duplicateReader.fetchTurnDebug({ sessionId, turnId: 'legacy-active-turn' });
          expect(migratedDetail.loops.map(loop => loop.response)).toEqual([
            'legacy-active-1',
            'legacy-active-2',
            'legacy-active-3',
          ]);
          await duplicateReader.close();
        } finally {
          rmSync(duplicateRoot, { recursive: true, force: true });
        }

        const snapshotTraceRoot = mkdtempSync(join(tmpdir(), 'yeaft-trace-snapshot-budget-'));
        const snapshotTrace = new DebugTrace(snapshotTraceRoot);
        try {
          const largeMessages = Array.from({ length: 2_000 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message ${index}: ${'x'.repeat(256)}`,
          }));
          const startedAt = Date.now();
          const snapshotTurn = snapshotTrace.startTurn({
            traceId: 'snapshot-budget-turn',
            turnNumber: 1,
            sessionId: 's-snapshot-budget',
          });
          snapshotTrace.endTurn(snapshotTurn, {
            responseText: '',
            messages: largeMessages,
            stopReason: 'end_turn',
          });
          await snapshotTrace.close();
          // The exact wall-clock threshold is intentionally generous for slow
          // CI. This catches the old O(n²) prefix reserialization without
          // turning normal host load into a flaky failure.
          expect(Date.now() - startedAt).toBeLessThan(5_000);
          const snapshotReader = new DebugTrace(snapshotTraceRoot);
          const snapshotDetail = await snapshotReader.fetchTurnDebug({
            sessionId: 's-snapshot-budget',
            turnId: 'snapshot-budget-turn',
          });
          expect(Buffer.byteLength(JSON.stringify(snapshotDetail.loops[0]?.messages || []), 'utf8')).toBeLessThanOrEqual(256 * 1024);
          await snapshotReader.close();
        } finally {
          rmSync(snapshotTraceRoot, { recursive: true, force: true });
        }
      } finally {
        await boundedTrace.close();
        rmSync(traceRoot, { recursive: true, force: true });
      }
    });
  });

  describe('existing messages', () => {
    it('should prepend existing messages to conversation', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'I remember.' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      const existingMessages = [
        { role: 'user', content: 'my name is Alice' },
        { role: 'assistant', content: 'Nice to meet you, Alice!' },
      ];

      const events = [];
      for await (const event of engine.query({
        prompt: 'what is my name?',
        messages: existingMessages,
      })) {
        events.push(event);
      }

      // Adapter should have received all messages
      const call = mockAdapter.callLog[0];
      expect(call.messages).toHaveLength(3);
      expect(call.messages[0].content).toBe('my name is Alice');
      expect(call.messages[1].content).toBe('Nice to meet you, Alice!');
      expect(call.messages[2].content).toBe('what is my name?');
    });
  });

  describe('tools passed to adapter', () => {
    it('passes tool definitions only when tools are registered', async () => {
      const withToolsAdapter = new MockAdapter();
      withToolsAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const withToolsEngine = new Engine({
        adapter: withToolsAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      withToolsEngine.registerTool({
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
        execute: async () => '42',
      });

      for await (const _event of withToolsEngine.query({ prompt: 'test' })) {
        // consume
      }

      const withToolsCall = withToolsAdapter.callLog[0];
      expect(withToolsCall.tools).toHaveLength(1);
      expect(withToolsCall.tools[0].name).toBe('calculator');
      expect(withToolsCall.tools[0].description).toBe('Calculate math');

      const withoutToolsAdapter = new MockAdapter();
      withoutToolsAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const withoutToolsEngine = new Engine({
        adapter: withoutToolsAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of withoutToolsEngine.query({ prompt: 'test' })) {
        // consume
      }

      const withoutToolsCall = withoutToolsAdapter.callLog[0];
      expect(withoutToolsCall.tools).toBeUndefined();
    });

    it('filters plugin-disabled tools and MCP servers from adapter definitions and execution', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      engine.registerTool({
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
        execute: async () => '42',
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.tools).toHaveLength(1);
      expect(call.tools[0].name).toBe('calculator');
      expect(call.tools[0].description).toBe('Calculate math');

      const registry = new ToolRegistry();
      let disabledCalls = 0;
      registry.register(defineTool({
        name: 'EnabledTool',
        description: 'Enabled',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'ok',
      }));
      registry.register(defineTool({
        name: 'DisabledTool',
        description: 'Disabled',
        parameters: { type: 'object', properties: {} },
        execute: async () => { disabledCalls += 1; return 'must not run'; },
      }));
      registry.register(defineTool({
        name: 'mcp__github__list_prs',
        mcpServer: 'github',
        description: 'GitHub',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'github',
      }));
      registry.register(defineTool({
        name: 'mcp__slack__send_message',
        mcpServer: 'slack',
        description: 'Slack',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'slack',
      }));
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'call-disabled', name: 'DisabledTool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'handled' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const filteredEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          plugins: { tools: ['EnabledTool'], mcpServers: ['github'] },
        },
        toolRegistry: registry,
      });
      const events = [];
      for await (const event of filteredEngine.query({ prompt: 'use MCP github and try disabled tool' })) events.push(event);
      expect(mockAdapter.callLog.at(-2).tools.map(tool => tool.name)).toEqual([
        'EnabledTool',
        'mcp__github__list_prs',
      ]);
      expect(disabledCalls).toBe(0);
      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'DisabledTool',
        isError: true,
      });
    });

    it('fails closed for an invalid persisted policy across tools and skills', async () => {
      const registry = new ToolRegistry();
      let executions = 0;
      registry.register(defineTool({
        name: 'SensitiveTool',
        description: 'Must not run under a deny-all policy',
        parameters: { type: 'object', properties: {} },
        execute: async () => { executions += 1; return 'unexpected'; },
      }));
      const skillManager = {
        has: () => true,
        list: () => [{ name: 'sensitive-skill', description: 'Sensitive skill' }],
        get: name => ({ name }),
        resolve: name => ({ name }),
        view: name => ({ name }),
        findRelevant: () => [{ name: 'sensitive-skill', description: 'Sensitive skill' }],
        getPromptContent: () => 'SENSITIVE SKILL CONTENT',
      };
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'deny-all-tool', name: 'SensitiveTool', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: {
          model: 'test-model',
          maxOutputTokens: 1024,
          plugins: { tools: [], skills: [], mcpServers: [] },
          pluginConfigError: 'plugins.tools must be an array',
        },
        toolRegistry: registry,
        skillManager,
      });
      const events = [];
      for await (const event of engine.query({ prompt: 'run sensitive capability' })) events.push(event);
      expect(mockAdapter.callLog.at(-2).tools).toBeUndefined();
      expect(mockAdapter.callLog.at(-2).system).not.toContain('SENSITIVE SKILL CONTENT');
      expect(executions).toBe(0);
      expect(events.find(event => event.type === 'tool_end')).toMatchObject({
        name: 'SensitiveTool',
        isError: true,
      });
    });

    it('filters disabled skills from automatic and explicit prompt injection', async () => {
      const skillManager = {
        has: name => ['allowed-skill', 'blocked-skill'].includes(name),
        list: () => [
          { name: 'allowed-skill', description: 'Allowed skill' },
          { name: 'blocked-skill', description: 'Blocked skill' },
        ],
        get: name => ({ name }),
        resolve: name => ({ name }),
        view: name => ({ name }),
        findRelevant: () => [
          { name: 'allowed-skill', description: 'Allowed skill' },
          { name: 'blocked-skill', description: 'Blocked skill' },
        ],
        getPromptContent: name => name === 'allowed-skill'
          ? 'ALLOWED SKILL CONTENT'
          : 'BLOCKED SKILL CONTENT',
      };

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'automatic complete' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const automaticEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, plugins: { skills: ['allowed-skill'] } },
        skillManager,
      });
      const automaticEvents = [];
      for await (const event of automaticEngine.query({ prompt: 'use relevant skills' })) automaticEvents.push(event);
      expect(mockAdapter.callLog.at(-1).system).toContain('ALLOWED SKILL CONTENT');
      expect(mockAdapter.callLog.at(-1).system).not.toContain('BLOCKED SKILL CONTENT');
      expect(automaticEvents.filter(event => event.type === 'skill_loaded').map(event => event.skill.name))
        .toEqual(['allowed-skill']);

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'explicit complete' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);
      const explicitEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, plugins: { skills: ['allowed-skill'] } },
        skillManager,
      });
      const explicitEvents = [];
      for await (const event of explicitEngine.query({ prompt: '/skill:blocked-skill inspect this' })) {
        explicitEvents.push(event);
      }
      expect(mockAdapter.callLog.at(-1).system).not.toContain('BLOCKED SKILL CONTENT');
      expect(explicitEvents.find(event => event.type === 'skill_error')).toMatchObject({
        skillName: 'blocked-skill',
      });
    });

    it('revokes automatic and explicit Skill prompt content at the next tool-loop request', async () => {
      const skillManager = {
        has: name => ['automatic-skill', 'explicit-skill'].includes(name),
        list: () => [
          { name: 'automatic-skill', description: 'Automatic skill' },
          { name: 'explicit-skill', description: 'Explicit skill' },
        ],
        get: name => ({ name }),
        resolve: name => ({ name }),
        view: name => ({ name }),
        findRelevant: () => [{ name: 'automatic-skill', description: 'Automatic skill' }],
        getPromptContent: name => name === 'automatic-skill'
          ? 'SENSITIVE_AUTOMATIC_SKILL_CONTENT'
          : 'SENSITIVE_EXPLICIT_SKILL_CONTENT',
      };

      for (const testCase of [
        {
          name: 'automatic',
          prompt: 'use the automatic skill',
          secret: 'SENSITIVE_AUTOMATIC_SKILL_CONTENT',
        },
        {
          name: 'explicit',
          prompt: '/skill:explicit-skill use the explicit skill',
          secret: 'SENSITIVE_EXPLICIT_SKILL_CONTENT',
        },
      ]) {
        const adapter = new MockAdapter();
        adapter.pushResponse([
          { type: 'tool_call', id: `refresh-${testCase.name}`, name: 'save_plugin_policy', input: {} },
          { type: 'stop', stopReason: 'tool_use' },
        ]);
        adapter.pushResponse([
          { type: 'text_delta', text: 'policy refreshed' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);
        const engine = new Engine({
          adapter,
          trace,
          config: { model: 'test-model', maxOutputTokens: 1024 },
          skillManager,
        });
        engine.registerTool({
          name: 'save_plugin_policy',
          description: 'Disable all Skills for the active Agent',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            engine.refreshConfig({
              model: 'test-model',
              maxOutputTokens: 1024,
              plugins: { skills: [] },
            });
            return 'saved';
          },
        });

        const events = [];
        for await (const event of engine.query({ prompt: testCase.prompt })) events.push(event);

        expect(adapter.callLog).toHaveLength(2);
        expect(adapter.callLog[0].system).toContain(testCase.secret);
        expect(adapter.callLog[1].system).not.toContain(testCase.secret);
        if (testCase.name === 'explicit') {
          expect(adapter.callLog[1].system).toContain('Skill command error');
          expect(events.filter(event => event.type === 'skill_loaded' && event.skill.name === 'explicit-skill'))
            .toHaveLength(1);
          expect(events.filter(event => event.type === 'skill_error' && event.skillName === 'explicit-skill'))
            .toHaveLength(1);
        } else {
          expect(events.filter(event => event.type === 'skill_loaded' && event.skill.name === 'automatic-skill'))
            .toHaveLength(1);
        }
      }
    });

  });

  describe('active scope in system prompt', () => {
    it('should render session id and session members without current member or group label', async () => {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
      });

      for await (const _event of engine.query({
        prompt: 'test',
        sessionId: 'session_active',
        sessionMembers: ['vp-omni', 'vp-martin', 'vp-linus'],
        sessionTopics: ['dream/segments', 'active_scope/rendering'],
        vpPersona: { vpId: 'vp-linus', displayName: 'Linus' },
      })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('## Current session context');
      expect(call.system).toContain('Session ID: session_active');
      expect(call.system).not.toContain('session_member:');
      expect(call.system).not.toContain('session_members:');
      expect(call.system).not.toContain('session_topics:');
      expect(call.system).toContain('Session members: vp-omni, vp-martin, vp-linus');
      expect(call.system).not.toContain('Current focus:');
      expect(call.system).not.toContain('group: session_active');
      expect(call.system).not.toContain('\nvp: vp-linus');
      expect(call.system).not.toContain('\nmembers: vp-omni');
    });

    it('derives current focus only from query-selected canonical topic scopes', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-topics-'));
      try {
        mkdirSync(join(yeaftDir, 'memory', 'sessions', 'session_active', 'topic', 'dream', 'segments'), { recursive: true });
        writeFileSync(join(yeaftDir, 'memory', 'sessions', 'session_active', 'topic', 'dream', 'segments', 'memory.md'), 'segment memory');
        writeFileSync(join(yeaftDir, 'memory', 'sessions', 'session_active', 'topic', 'dream', 'segments', 'content.md'), 'Canonical topic content.');

        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]);

        const engine = new Engine({
          adapter: mockAdapter,
          trace,
          yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024, language: 'en' },
          memoryIndex: {
            search({ scopeFilter, requiredTag }) {
              const scope = 'sessions/session_active/topic/dream/segments';
              return requiredTag === 'canonical-content' && scopeFilter.includes(scope) ? [{
                id: 'topic-selector', scope, kind: 'context', tags: [], sourceMessages: [],
                body: 'Canonical topic content.', rank: -1,
                createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
              }] : [];
            },
          },
        });

        for await (const _event of engine.query({
          prompt: 'inspect canonical segments',
          sessionId: 'session_active',
          sessionMembers: ['vp-linus'],
          vpPersona: { vpId: 'vp-linus', displayName: 'Linus' },
        })) {
          // consume
        }

        const call = mockAdapter.callLog[0];
        expect(call.system).toContain('Current focus: Dream memory segment extraction and organization');
        expect(call.system).not.toContain('session_topics: dream/segments');
      } finally {
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('language in system prompt', () => {
    async function verifyEnglishSystemPrompt() {
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).not.toContain('核心原则');
    }

    it('uses English and Chinese system prompts with configured tool guidance', async () => {
      await verifyEnglishSystemPrompt();
      mockAdapter = new MockAdapter();
      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      for await (const _event of engine.query({ prompt: 'test' })) {
        // consume
      }

      const call = mockAdapter.callLog[0];
      expect(call.system).toContain('会话参与者');
      expect(call.system).not.toContain('Session Participant');
      expect(call.system).not.toContain('Yeaft — AI');
      expect(call.system).toContain('核心原则');
      expect(call.system).not.toContain('统一模式');
      expect(call.system).not.toContain('你是一个持续伴随的 AI 伙伴');
      mockAdapter = new MockAdapter();

      mockAdapter.pushResponse([
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const toolGuidanceEngine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024, language: 'zh' },
      });

      toolGuidanceEngine.registerTool({
        name: 'search',
        description: 'Search',
        parameters: {},
        execute: async () => 'results',
      });

      for await (const _event of toolGuidanceEngine.query({ prompt: 'test' })) {
        // consume
      }

      const toolGuidanceCall = mockAdapter.callLog[0];
      expect(toolGuidanceCall.tools.map(tool => tool.name)).toContain('search');
      expect(toolGuidanceCall.system).not.toContain('可用工具：search');

      const enSystem = buildSystemPrompt({
        language: 'en',
        toolNames: ['TodoWrite'],
        projectLabel: 'Yeaft (project-123)',
        projectInstruction: 'Run the shared Project verification before release.',
      });
      const zhSystem = buildSystemPrompt({
        language: 'zh',
        projectLabel: 'Yeaft（project-123）',
        projectInstruction: '发布前执行统一验证。',
        toolNames: ['TodoWrite'],
      });

      expect(enSystem).toContain('[Project Instruction]');
      expect(enSystem).toContain('The current Session belongs to Project Yeaft (project-123). The unified instruction for this Project is:');
      expect(enSystem).toContain('Run the shared Project verification before release.');
      expect(buildSystemPrompt({
        language: 'en',
        projectInstruction: 'Use the current Project instruction.',
      })).toContain('The current Session belongs to the current Project. The unified instruction for this Project is:');
      expect(buildSystemPrompt({
        language: 'zh',
        projectLabel: '   ',
        projectInstruction: '使用当前 Project 指令。',
      })).toContain('当前 Session 隶属于当前 Project。当前 Project 的统一 instruction 是：');
      expect(buildSystemPrompt({ language: 'en', projectInstruction: '   ' }))
        .not.toContain('[Project Instruction]');
      expect(enSystem).toContain('write a brief visible plan');
      expect(enSystem).toContain('same assistant response as the first independent work tools');
      expect(enSystem).toContain('Do not spend a separate model round entering planning mode');
      expect(enSystem).toContain('do not stop after planning');
      expect(zhSystem).toContain('当前 Session 隶属于 Project Yeaft（project-123）。当前 Project 的统一 instruction 是：');
      expect(zhSystem).toContain('发布前执行统一验证。');
      expect(zhSystem).toContain('先写简短可见计划');
      expect(zhSystem).toContain('不要用单独的模型回合进入规划模式');
      expect(zhSystem).toContain('只有用户信息确实阻塞第一步时才在规划后停下');

      expect(todoWriteTool.description.en).toContain('PLAN WITHOUT AN EXTRA MODEL ROUND');
      expect(todoWriteTool.description.en).toContain('do not call a separate planning-mode tool first');
      expect(todoWriteTool.description.zh).toContain('不要浪费额外模型回合进入规划模式');
      expect(todoWriteTool.description.zh).toContain('不要先调用单独的规划模式工具');
      expect(todoWriteTool.description.en).toContain('BATCH WITH WORK');
      expect(todoWriteTool.description.en).toContain('same assistant response');
      expect(todoWriteTool.description.en).toContain('only after evidence');
      expect(todoWriteTool.description.en).toContain('standalone TodoWrite remains valid');
      expect(todoWriteTool.description.zh).toContain('和工作工具合批');
      expect(todoWriteTool.description.zh).toContain('同一个 assistant response');
      expect(todoWriteTool.description.zh).toContain('只有已有证据时');
      expect(todoWriteTool.description.zh).toContain('TodoWrite 仍可单独调用');

      const enPlan = await startPlanTool.execute(
        { topic: 'Batch plan setup with its first investigation' },
        { config: { language: 'en' }, vpPersona: {} },
      );
      const zhPlan = await startPlanTool.execute(
        { topic: '把计划建立和第一批调查工具合批' },
        { config: { language: 'zh-CN' }, vpPersona: {} },
      );

      expect(enPlan).toContain('emit `TodoWrite` and those independent tool calls in the same assistant response');
      expect(enPlan).toContain('Stop after the plan only when the first step must ask the user');
      expect(zhPlan).toContain('在同一个 assistant response 中发出 `TodoWrite`');
      expect(zhPlan).toContain('只有第一步必须询问用户时才在计划后停下');
    });
  });
});
const managedCliTempDirs = [];

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `yeaft-${name}-`));
  managedCliTempDirs.push(dir);
  return dir;
}

function tarArchive(path, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return gzipSync(Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - data.length % 512) % 512),
    Buffer.alloc(1024),
  ]));
}

function emptyPathEnv() {
  return { ...process.env, PATH: '' };
}

function trustManagedCliFixtures(yeaftDir, names) {
  const statePath = join(yeaftDir, 'managed-cli.json');
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  const installations = { ...(state.installations || {}) };
  for (const name of names) {
    const path = join(managedCliBinDir(yeaftDir), name);
    const [assetFileName, archiveSha256] = managedCliToolSpecs[name].assets[
      `${process.platform}-${process.arch}`
    ];
    installations[name] = {
      version: managedCliToolSpecs[name].version,
      platform: process.platform,
      arch: process.arch,
      assetFileName,
      archiveSha256,
      binarySha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  }
  writeFileSync(statePath, `${JSON.stringify({
    ...state,
    version: 2,
    installations,
  }, null, 2)}\n`);
}

function zipArchive(path, content) {
  const name = Buffer.from(path);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

afterEach(() => {
  for (const dir of managedCliTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('managed CLI setup and fast tool integration', () => {
  async function verifyProcessTermination() {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      signal: preAborted.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    const crScript = "process.stdout.write('out\\r\\n'); process.stderr.write('err\\r\\n')";
    await expect(runProcess(process.execPath, ['-e', crScript])).resolves.toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
    });
    const replacementScript = "process.stdout.write('valid \\ufffd value')";
    await expect(runProcess(process.execPath, ['-e', replacementScript])).resolves.toMatchObject({
      stdout: 'valid \ufffd value',
    });
    await expect(runProcess(process.execPath, ['-e', crScript], {
      preserveCarriageReturns: true,
    })).resolves.toMatchObject({
      stdout: 'out\r\n',
      stderr: 'err\n',
    });

    if (process.platform !== 'win32') {
      const termResistant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const startedAt = Date.now();
      const timedOut = await runProcess(process.execPath, ['-e', termResistant], {
        timeoutMs: 50,
        killGraceMs: 25,
      });
      expect(timedOut).toMatchObject({ code: 124, timedOut: true });
      expect(Date.now() - startedAt).toBeLessThan(1000);

      const controller = new AbortController();
      const pending = runProcess(process.execPath, ['-e', termResistant], {
        signal: controller.signal,
        killGraceMs: 25,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }
  }

  async function verifyWindowsProcessTreeTermination() {
    for (const taskkillFailure of ['nonzero', 'throw']) {
      const calls = [];
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = signal => {
        calls.push(`proc.kill ${signal}`);
        setImmediate(() => child.emit('close', 1));
        return true;
      };
      const spawnProcess = () => child;
      const spawnProcessSync = (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (taskkillFailure === 'throw') throw new Error('taskkill unavailable');
        return { status: 1 };
      };

      const result = await runProcess('ignored.exe', [], {
        timeoutMs: 1,
        platform: 'win32',
        spawnProcess,
        spawnProcessSync,
      });
      expect(result).toMatchObject({ code: 124, timedOut: true });
      expect(calls).toEqual([
        'taskkill /pid 4242 /t /f',
        'proc.kill SIGKILL',
      ]);
      expect(child.listenerCount('close')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
    }

    const child = new EventEmitter();
    child.pid = 4343;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const result = await runProcess('powershell.exe', [], {
      timeoutMs: 1,
      forceSettleMs: 5,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => child,
      spawnProcessSync: () => ({ status: 0 }),
    });
    expect(result).toMatchObject({
      code: 124,
      timedOut: true,
      terminationError: 'Process tree did not exit within 5ms after SIGKILL: powershell.exe',
    });
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);

    const abortedChild = new EventEmitter();
    abortedChild.pid = 4545;
    abortedChild.stdout = new PassThrough();
    abortedChild.stderr = new PassThrough();
    abortedChild.kill = () => true;
    const controller = new AbortController();
    const aborted = runProcess('powershell.exe', [], {
      signal: controller.signal,
      timeoutMs: 1,
      forceSettleMs: 20,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => abortedChild,
      spawnProcessSync: () => ({ status: 0 }),
    });
    setTimeout(() => controller.abort(), 5);
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedChild.listenerCount('close')).toBe(0);
    expect(abortedChild.listenerCount('error')).toBe(0);
    expect(abortedChild.stdout.listenerCount('data')).toBe(0);
    expect(abortedChild.stderr.listenerCount('data')).toBe(0);

    const overflowChild = new EventEmitter();
    overflowChild.pid = 4646;
    overflowChild.stdout = new PassThrough();
    overflowChild.stderr = new PassThrough();
    overflowChild.kill = () => true;
    const overflowed = runProcess('powershell.exe', [], {
      timeoutMs: 5,
      forceSettleMs: 20,
      maxBytes: 1,
      requireExitConfirmation: true,
      platform: 'win32',
      spawnProcess: () => overflowChild,
      spawnProcessSync: () => ({ status: 0 }),
    });
    overflowChild.stdout.write('too much output');
    await expect(overflowed).rejects.toMatchObject({ name: 'ProcessTerminationError' });
    expect(overflowChild.listenerCount('close')).toBe(0);
    expect(overflowChild.listenerCount('error')).toBe(0);
    expect(overflowChild.stdout.listenerCount('data')).toBe(0);
    expect(overflowChild.stderr.listenerCount('data')).toBe(0);
  }

  function verifyGrepExactBudget() {
    const marker = '\n\n[Output truncated]';
    for (const finalSize of [32767, 32768]) {
      const collector = createOutputCollector(32768);
      const lastSize = finalSize - 24002;
      expect(collector.add('x'.repeat(12000))).toBe(true);
      expect(collector.add('x'.repeat(12000))).toBe(true);
      expect(collector.add('x'.repeat(lastSize))).toBe(true);
      expect(Buffer.byteLength(collector.toString())).toBe(finalSize);
      expect(collector.toString()).not.toContain(marker);
    }
    const overflow = createOutputCollector(32768);
    expect(overflow.add('x'.repeat(12000))).toBe(true);
    expect(overflow.add('x'.repeat(12000))).toBe(true);
    expect(overflow.add('x'.repeat(8767))).toBe(false);
    expect(Buffer.byteLength(overflow.toString())).toBe(32768);
    expect(overflow.toString().endsWith(marker)).toBe(true);
    const settled = overflow.toString();
    expect(overflow.add('late')).toBe(false);
    expect(overflow.toString()).toBe(settled);

    for (const maxBytes of [0, 1, Buffer.byteLength(marker) - 1, Buffer.byteLength(marker)]) {
      const tiny = createOutputCollector(maxBytes);
      expect(tiny.add('x'.repeat(maxBytes + 1))).toBe(false);
      expect(Buffer.byteLength(tiny.toString())).toBe(maxBytes);
      expect(tiny.toString()).not.toContain('\ufffd');
    }

    const unicode = createOutputCollector(16);
    expect(unicode.add('界'.repeat(6))).toBe(false);
    expect(Buffer.byteLength(unicode.toString())).toBe(16);
    expect(unicode.toString()).not.toContain('\ufffd');
  }

  async function verifyRipgrepRecordFraming() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    const raw = Buffer.from(
      'C:/a.js\u00001:needle\nsrc/界\nbreak.js\u00002:needle\nsrc/a:12:b.js\u00003:needle\n',
      'utf8',
    );
    for (const byte of raw) child.stdout.write(Buffer.from([byte]));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({
      records: [
        { path: 'C:/a.js', suffix: '1:needle', kind: 'match' },
        { path: 'src/界\nbreak.js', suffix: '2:needle', kind: 'match' },
        { path: 'src/a:12:b.js', suffix: '3:needle', kind: 'match' },
      ],
      resultCount: 3,
      truncated: false,
    });
  }

  async function verifyRipgrepFilteredLongLineFraming() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killCalls = 0;
    child.kill = () => { killCalls += 1; };
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      glob: '**/*.js',
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    child.stdout.write(Buffer.from(`a.txt\u0000${'x'.repeat(17000)}`));
    await new Promise(resolve => setImmediate(resolve));
    expect(killCalls).toBe(0);
    child.stdout.write(Buffer.from('tail\nb.js\u00001:needle\n'));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({
      records: [{ path: 'b.js', suffix: '1:needle', kind: 'match' }],
      resultCount: 1,
      truncated: false,
    });
    expect(killCalls).toBe(0);
  }

  async function verifyRipgrepLongLineStopsDuringCapture() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killCalls = 0;
    child.kill = () => { killCalls += 1; };
    const pending = runRipgrep('needle', process.cwd(), {
      fixedStrings: true,
      filesOnly: false,
      maxResults: 10,
      byteBudget: 32768,
      cwd: process.cwd(),
      structured: true,
    }, () => child);
    child.stdout.write(Buffer.from(`src/a.js\u0000${'界'.repeat(7000)}`));
    await new Promise(resolve => setImmediate(resolve));
    expect(killCalls).toBe(1);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null);
    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768);
    expect(result.output).toContain('[Output truncated]');
    expect(result.output).not.toContain('\ufffd');
  }

  async function verifyRipgrepAbortReentry() {
    for (const event of ['close', 'error']) {
      const controller = new AbortController();
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let killCalls = 0;
      child.kill = () => {
        killCalls += 1;
        if (event === 'close') child.emit('close', 130);
        else child.emit('error', new Error('sync process error'));
      };
      const pending = runRipgrep('needle', process.cwd(), {
        fixedStrings: true,
        filesOnly: true,
        maxResults: 10,
        byteBudget: 32768,
        cwd: process.cwd(),
        signal: controller.signal,
      }, () => child);
      controller.abort('user');
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(killCalls).toBe(1);
      child.emit('error', new Error('late process error'));
      child.emit('close', 0);
      expect(killCalls).toBe(1);
    }
  }

  async function verifyRipgrepParity() {
    if (process.platform === 'win32') return;
    const root = tempDir('grep-semantic-parity');
    const binDir = join(root, 'bin');
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.yeaft', 'worktrees', 'ignored'), { recursive: true });
    mkdirSync(join(root, 'src', '.yeaft', 'worktrees', 'ignored'), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(root, 'src', 'a.txt'), 'needle\n');
    writeFileSync(join(root, '.hidden', 'h.txt'), 'needle\n');
    writeFileSync(join(root, 'node_modules', 'n.txt'), 'needle\n');
    writeFileSync(join(root, '.git', 'g.txt'), 'needle\n');
    writeFileSync(join(root, '.yeaft', 'worktrees', 'ignored', 'w.txt'), 'needle\n');
    writeFileSync(join(root, 'src', '.yeaft', 'worktrees', 'ignored', 'w.txt'), 'needle\n');
    const rgPath = join(binDir, 'rg');
    const capturedArgs = join(tmpdir(), `yeaft-rg-args-${process.pid}-${Date.now()}.txt`);
    writeFileSync(rgPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturedArgs)}\nprintf 'src/a.txt\\000.hidden/h.txt\\000'\n`, { mode: 0o755 });
    const options = {
      caseInsensitive: false,
      fixedStrings: true,
      filesOnly: true,
      count: false,
      multiline: false,
      maxResults: 50,
      byteBudget: 32 * 1024,
      cwd: root,
    };
    const fast = (await runRipgrep('needle', root, options, undefined, rgPath)).trim().split('\n').sort();
    const fallback = (await nodeGrep('needle', root, options)).trim().split('\n').sort();
    expect(fast).toEqual(fallback);
    expect(fast).toEqual(['.hidden/h.txt', 'src/a.txt']);
    const args = readFileSync(capturedArgs, 'utf8').trim().split('\n');
    expect(args).toContain('--hidden');
    expect(args).toContain('--no-ignore');
    expect(args).toContain('!**/node_modules/**');
    expect(args).toContain('!.yeaft/worktrees/**');
    expect(args).toContain('!**/.yeaft/worktrees/**');
    options.glob = '**/*.txt';
    const filteredFallback = (await nodeGrep('needle', root, options)).trim().split('\n').sort();
    expect(filteredFallback).toEqual(['.hidden/h.txt', 'src/a.txt']);
    await runRipgrep('needle', root, options, undefined, rgPath);
    const filteredArgs = readFileSync(capturedArgs, 'utf8').trim().split('\n');
    expect(filteredArgs).not.toContain('**/*.txt');
    expect(filteredArgs).toContain('!**/node_modules/**');
    expect(filteredArgs).toContain('!.yeaft/worktrees/**');
    expect(filteredArgs).toContain('!**/.yeaft/worktrees/**');
    rmSync(capturedArgs, { force: true });
  }

  async function verifyManagedRgEnvironment() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-environment');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'git'), '#!/bin/sh\necho UNTRUSTED-GIT\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'fd'), '#!/bin/sh\necho UNVERIFIED-FD\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);

    const systemBin = join(yeaftDir, 'system-bin');
    mkdirSync(systemBin);
    writeFileSync(join(systemBin, 'git'), '#!/bin/sh\necho SYSTEM-GIT\n', { mode: 0o755 });
    writeFileSync(join(systemBin, 'fd'), '#!/bin/sh\necho SYSTEM-FD\n', { mode: 0o755 });

    let markReady;
    const rgReady = new Promise(resolveReady => { markReady = resolveReady; });
    const ready = Promise.resolve([]);
    ready.toolReady = { rg: rgReady };
    const originalPath = process.env.PATH;
    process.env.PATH = [systemBin, '/usr/bin', '/bin'].join(delimiter);
    try {
      const pending = prepareManagedCliToolEnvironment(ready, 'rg', { yeaftDir });
      await new Promise(resolveTick => setImmediate(resolveTick));
      expect(process.env.PATH.split(delimiter)).not.toContain(binDir);

      markReady({ name: 'rg', status: 'available', path: join(binDir, 'rg') });
      const environment = await pending;
      expect(environment).toMatchObject({ name: 'rg', activated: true });
      expect(environment.command).toBe(join(environment.binDir, 'rg'));
      expect(environment.binDir).not.toBe(binDir);
      expect(readdirSync(environment.binDir)).toEqual(['rg']);
      expect(process.env.PATH.split(delimiter)[0]).toBe(environment.binDir);
      expect(process.env.PATH.split(delimiter)).not.toContain(binDir);
      const inheritedPathBash = createBashTool({
        runProcessImpl: async (_command, _args, options) => {
          const result = spawnSync('/bin/sh', ['-c', 'rg --version; git --version; fd --version'], {
            encoding: 'utf8',
            env: options.env,
          });
          return {
            code: result.status,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            timedOut: false,
            terminationError: null,
          };
        },
      });
      await expect(inheritedPathBash.execute({
        command: 'rg --version',
        cwd: yeaftDir,
        timeout_ms: 5000,
      }, {})).resolves.toBe('ripgrep 15.2.0\nSYSTEM-GIT\nSYSTEM-FD');
    } finally {
      process.env.PATH = originalPath;
      cleanupManagedCliRuntimePaths();
    }
  }

  async function verifyManagedRgSignalCleanup() {
    if (process.platform === 'win32') return;

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const cliDir = tempDir(`cli-rg-${signal.toLowerCase()}`);
      const binDir = managedCliBinDir(cliDir);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
      trustManagedCliFixtures(cliDir, ['rg']);
      const tmpRoot = join(cliDir, 'tmp');
      mkdirSync(tmpRoot);
      const child = spawn(process.execPath, [
        join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
        '--skip-mcp',
        '--skip-skills',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: tmpRoot,
          YEAFT_DIR: cliDir,
          YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      try {
        for (let i = 0; i < 500; i += 1) {
          if (readdirSync(tmpRoot).some(name => name.startsWith('yeaft-managed-cli-'))) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        const runtimeDirectories = readdirSync(tmpRoot)
          .filter(name => name.startsWith('yeaft-managed-cli-'));
        expect(runtimeDirectories).toHaveLength(1);
        for (let i = 0; i < 500; i += 1) {
          if (stdout.includes('"subtype":"init"')) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        const stdoutEvents = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(stdoutEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'system', subtype: 'init' }),
        ]));
        child.kill(signal);
        const outcome = await new Promise((resolveClose, rejectClose) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectClose(new Error(`CLI did not preserve ${signal}; stdout=${stdout}; stderr=${stderr}`));
          }, 10_000);
          child.once('error', rejectClose);
          child.once('close', (code, closeSignal) => {
            clearTimeout(timer);
            resolveClose({ code, signal: closeSignal });
          });
        });
        expect(outcome).toEqual({ code: null, signal });
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }

  async function verifyManagedRgCleanupRetry() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-cleanup-retry');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);
    const runtimeRoot = join(yeaftDir, 'runtime-root');
    mkdirSync(runtimeRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeRoot;
    try {
      const environment = await prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
        yeaftDir,
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(existsSync(environment.binDir)).toBe(true);

      chmodSync(runtimeRoot, 0o500);
      cleanupManagedCliRuntimePaths();
      expect(existsSync(environment.binDir)).toBe(true);

      chmodSync(runtimeRoot, 0o700);
      cleanupManagedCliRuntimePaths();
      expect(existsSync(environment.binDir)).toBe(false);
    } finally {
      chmodSync(runtimeRoot, 0o700);
      cleanupManagedCliRuntimePaths();
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  }

  async function verifyManagedRgAgentShutdownOrder() {
    if (process.platform === 'win32') return;

    const yeaftDir = tempDir('cli-rg-agent-shutdown-order');
    const binDir = managedCliBinDir(yeaftDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'rg'), '#!/bin/sh\necho ripgrep 15.2.0\n', { mode: 0o755 });
    trustManagedCliFixtures(yeaftDir, ['rg']);
    const runtimeRoot = join(yeaftDir, 'runtime-root');
    mkdirSync(runtimeRoot);
    const originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = runtimeRoot;
    try {
      const environment = await prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
        yeaftDir,
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(existsSync(environment.binDir)).toBe(true);

      let laterShutdownStarted = false;
      const laterShutdown = new Promise(() => {});
      const shutdown = runAfterManagedCliRuntimeCleanup(() => {
        laterShutdownStarted = true;
        return laterShutdown;
      });

      expect(laterShutdownStarted).toBe(true);
      expect(existsSync(environment.binDir)).toBe(false);
      await expect(Promise.race([
        shutdown.then(() => 'settled'),
        new Promise(resolveDelay => setTimeout(() => resolveDelay('pending'), 25)),
      ])).resolves.toBe('pending');
    } finally {
      cleanupManagedCliRuntimePaths();
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
    }
  }

  async function verifyManagedRgNormalExitCleanup() {
    if (process.platform === 'win32') return;

    for (const scenario of [
      { name: 'success', input: '', expectedCode: 0 },
      { name: 'failure', input: 'not-json\n', expectedCode: 1 },
    ]) {
      const cliDir = tempDir(`cli-rg-normal-${scenario.name}`);
      const binDir = managedCliBinDir(cliDir);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'rg'), [
        '#!/bin/sh',
        `printf '%s' "$0" > "$YEAFT_DIR/runtime-command"`,
        'echo ripgrep 15.2.0',
        '',
      ].join('\n'), { mode: 0o755 });
      trustManagedCliFixtures(cliDir, ['rg']);
      const tmpRoot = join(cliDir, 'tmp');
      mkdirSync(tmpRoot);
      const child = spawn(process.execPath, [
        join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
        '--skip-mcp',
        '--skip-skills',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: tmpRoot,
          YEAFT_DIR: cliDir,
          YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.end(scenario.input);
      const outcome = await new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          rejectClose(new Error(`CLI ${scenario.name} timed out; stdout=${stdout}; stderr=${stderr}`));
        }, 10_000);
        child.once('error', rejectClose);
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolveClose({ code, signal });
        });
      });
      expect(outcome).toEqual({ code: scenario.expectedCode, signal: null });
      const runtimeCommand = readFileSync(join(cliDir, 'runtime-command'), 'utf8');
      expect(runtimeCommand.startsWith(`${tmpRoot}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true);
      expect(existsSync(runtimeCommand)).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual([]);
      const stdoutEvents = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(stdoutEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'system', subtype: 'init' }),
      ]));
      if (scenario.expectedCode !== 0) {
        expect(stderr).toContain('Invalid stream-json input');
      }
    }
  }

  async function verifyUnverifiedManagedRgIsNotExposed() {
    if (process.platform === 'win32') return;

    const unverifiedDir = tempDir('cli-rg-unverified');
    const unverifiedBin = managedCliBinDir(unverifiedDir);
    mkdirSync(unverifiedBin, { recursive: true });
    writeFileSync(join(unverifiedBin, 'rg'), '#!/bin/sh\necho unverified\n', { mode: 0o755 });
    const unverifiedEnv = { PATH: '' };
    await expect(prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
      yeaftDir: unverifiedDir,
      env: unverifiedEnv,
    })).resolves.toEqual({ name: 'rg', activated: false, command: null });
    expect(unverifiedEnv.PATH).toBe('');

    const systemDir = tempDir('cli-rg-system');
    const systemBin = join(systemDir, 'system-bin');
    mkdirSync(systemBin);
    const systemRg = join(systemBin, 'rg');
    writeFileSync(systemRg, '#!/bin/sh\necho system rg\n', { mode: 0o755 });
    const systemEnv = { PATH: systemBin };
    await expect(prepareManagedCliToolEnvironment(Promise.resolve([]), 'rg', {
      yeaftDir: systemDir,
      env: systemEnv,
    })).resolves.toEqual({ name: 'rg', activated: false, command: systemRg });
    expect(systemEnv.PATH).toBe(systemBin);
  }

  it('keeps managed CLI filters, process, and fallback boundaries', async () => {
    await verifyManagedRgEnvironment();
    await verifyManagedRgSignalCleanup();
    await verifyManagedRgCleanupRetry();
    await verifyManagedRgAgentShutdownOrder();
    await verifyManagedRgNormalExitCleanup();
    await verifyUnverifiedManagedRgIsNotExposed();

    const processResult = (overrides = {}) => ({
      code: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      ...overrides,
    });

    const fdRoot = tempDir('fd-pattern');
    let fdCall;
    const fdOutput = await listFilesWithFd('fd', fdRoot, 'src/**/*.{js,md}', undefined,
      async (command, args, options) => {
        fdCall = { command, args, options };
        return processResult({
          stdout: `src${process.platform === 'win32' ? '\\' : '/'}a.js\0`,
        });
      });
    expect(fdOutput).toEqual([join('src', 'a.js')]);
    expect(fdCall.args).toContain('--full-path');
    expect(fdCall.args).toContain('--case-sensitive');
    expect(fdCall.args.at(-1)).toBe('.');
    const pushedPattern = fdCall.args.at(-2);
    expect(new RegExp(pushedPattern).test(join(fdRoot, 'src', 'nested', 'a.js'))).toBe(true);
    expect(new RegExp(pushedPattern).test(join(fdRoot, 'src', 'nested', 'a.txt'))).toBe(false);

    const rgRoot = tempDir('rg-candidates');
    mkdirSync(join(rgRoot, 'src'));
    writeFileSync(join(rgRoot, 'src', 'hit.js'), 'needle\n');
    writeFileSync(join(rgRoot, 'src', 'miss.js'), 'needle\n');
    let rgCall;
    const candidatePaths = await listRipgrepCandidatePaths('rg', rgRoot, {
      pattern: 'needle', fixedStrings: true,
    }, async (command, args, options) => {
      rgCall = { command, args, options };
      return processResult({
        stdout: `src${process.platform === 'win32' ? '\\' : '/'}hit.js\0`,
      });
    });
    expect(rgCall.args).toContain('--files-with-matches');
    expect(rgCall.args).toContain('--max-filesize');
    expect(rgCall.args).not.toContain('--sort');
    const rgResult = await nodeGrep('needle', rgRoot, {
      fixedStrings: true,
      filesOnly: true,
      count: false,
      multiline: false,
      maxResults: 10,
      structured: true,
      candidatePaths,
    });
    expect(rgResult.records.map(record => record.path)).toEqual(['src/hit.js']);

    const dustRoot = tempDir('dust-limit');
    let dustCall;
    const dustRows = await runDust('dust', dustRoot, { depth: 2, limit: 5 },
      async (command, args, options) => {
        dustCall = { command, args, options };
        return processResult({
          stdout: JSON.stringify({
            size: '10B',
            name: dustRoot,
            children: [{ size: '5B', name: join(dustRoot, 'child'), children: [] }],
          }),
        });
      });
    const lineLimit = dustCall.args.indexOf('--number-of-lines');
    expect(lineLimit).toBeGreaterThanOrEqual(0);
    expect(Number(dustCall.args[lineLimit + 1])).toBe(200);
    expect(dustRows.map(row => row.path)).toEqual(['.', 'child']);

    for (const invoke of [
      runner => listFilesWithFd('fd', tempDir('fd-limit'), '**/*', undefined, runner),
      runner => listRipgrepCandidatePaths('rg', tempDir('rg-limit'), {
        pattern: 'needle', fixedStrings: true,
      }, runner),
      runner => runDust('dust', tempDir('dust-output-limit'), {
        depth: 2, limit: 20,
      }, runner),
    ]) {
      let calls = 0;
      const runner = async () => {
        calls += 1;
        return processResult({ truncated: true });
      };
      await expect(invoke(runner)).rejects.toBeInstanceOf(SearchBackendLimitError);
      expect(calls).toBe(1);
    }

    await verifyProcessTermination();
    await verifyWindowsProcessTreeTermination();
    verifyGrepExactBudget();
    await verifyRipgrepRecordFraming();
    await verifyRipgrepFilteredLongLineFraming();
    await verifyRipgrepLongLineStopsDuringCapture();
    await verifyRipgrepAbortReentry();
    const yeaftDir = tempDir('cli-path');
    const systemBin = join(yeaftDir, 'system-bin');
    mkdirSync(systemBin);
    const fdfind = join(systemBin, 'fdfind');
    writeFileSync(fdfind, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { PATH: systemBin };
    const binDir = prependManagedCliBinToPath(yeaftDir, env);
    prependManagedCliBinToPath(yeaftDir, env);
    expect(env.PATH.split(delimiter)).toEqual([binDir, systemBin]);
    const windowsEnv = { Path: systemBin };
    prependManagedCliBinToPath(yeaftDir, windowsEnv, 'win32');
    expect(windowsEnv.PATH).toBe(windowsEnv.Path);
    expect(resolveManagedCliCommand('fd', { yeaftDir, env, platform: 'linux' })).toBe(fdfind);

    const tar = tarArchive('ripgrep-15.2.0/rg', '#!/bin/sh\necho ripgrep 15.2.0\n');
    expect(extractManagedCliBinary(tar, 'ripgrep.tar.gz', 'rg', 'linux').toString())
      .toContain('ripgrep 15.2.0');
    const zip = zipArchive('fd-v10.3.0/fd.exe', Buffer.from('MZ-test-binary'));
    expect(extractManagedCliBinary(zip, 'fd.zip', 'fd', 'win32').toString())
      .toBe('MZ-test-binary');

    if (process.platform !== 'win32') {
      const installDir = tempDir('cli-successful-install');
      const archives = {
        rg: tarArchive('package/rg', '#!/bin/sh\necho ripgrep 15.2.0\n'),
        fd: tarArchive('package/fd', '#!/bin/sh\necho fd 10.3.0\n'),
        dust: tarArchive('package/dust', '#!/bin/sh\necho Dust 1.2.4\n'),
      };
      const originalAssets = {};
      const archiveByFileName = new Map();
      for (const [name, archive] of Object.entries(archives)) {
        originalAssets[name] = managedCliToolSpecs[name].assets['linux-x64'];
        const fileName = originalAssets[name][0];
        managedCliToolSpecs[name].assets['linux-x64'] = [
          fileName,
          createHash('sha256').update(archive).digest('hex'),
        ];
        archiveByFileName.set(fileName, archive);
      }
      try {
        let successfulFetches = 0;
        const installOptions = {
          yeaftDir: installDir,
          platform: 'linux',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => {
            successfulFetches += 1;
            const fileName = String(url).split('/').at(-1);
            return new Response(archiveByFileName.get(fileName));
          },
        };
        const [firstInstall, joinedInstall] = await Promise.all([
          ensureManagedCliTools(installOptions),
          ensureManagedCliTools(installOptions),
        ]);
        expect(firstInstall).toEqual(joinedInstall);
        expect(firstInstall.every(result => result.status === 'installed')).toBe(true);
        expect(successfulFetches).toBe(3);
        const installedState = JSON.parse(
          readFileSync(join(installDir, 'managed-cli.json'), 'utf8'),
        );
        expect(Object.keys(installedState.installations).sort()).toEqual(['dust', 'fd', 'rg']);
        for (const name of ['rg', 'fd', 'dust']) {
          const installation = installedState.installations[name];
          expect(installation).toMatchObject({
            version: managedCliToolSpecs[name].version,
            platform: 'linux',
            arch: 'x64',
            assetFileName: managedCliToolSpecs[name].assets['linux-x64'][0],
            archiveSha256: managedCliToolSpecs[name].assets['linux-x64'][1],
          });
          expect(installation.binarySha256).toBe(
            createHash('sha256')
              .update(readFileSync(join(managedCliBinDir(installDir), name)))
              .digest('hex'),
          );
        }
        const available = await ensureManagedCliTools({
          ...installOptions,
          fetchFn: async () => { throw new Error('valid installs must not redownload'); },
        });
        expect(available.every(result => result.status === 'available')).toBe(true);
      } finally {
        for (const [name, asset] of Object.entries(originalAssets)) {
          managedCliToolSpecs[name].assets['linux-x64'] = asset;
        }
      }

      const windowsInstallDir = tempDir('cli-windows-install');
      const windowsBinDir = managedCliBinDir(windowsInstallDir);
      mkdirSync(windowsBinDir, { recursive: true });
      writeFileSync(join(windowsBinDir, 'fd.exe'), 'old fd binary');
      const windowsScripts = {
        rg: '#!/bin/sh\necho ripgrep 15.2.0\n',
        fd: '#!/bin/sh\necho fd 10.3.0\n',
        dust: '#!/bin/sh\necho dust 1.2.4\n',
      };
      const windowsArchives = Object.fromEntries(Object.entries(windowsScripts).map(([name, script]) => [
        name,
        zipArchive(`package/${name}.exe`, script),
      ]));
      const originalWindowsAssets = {};
      try {
        const windowsArchiveByFileName = new Map();
        for (const [name, archive] of Object.entries(windowsArchives)) {
          originalWindowsAssets[name] = managedCliToolSpecs[name].assets['win32-x64'];
          const fileName = originalWindowsAssets[name][0];
          managedCliToolSpecs[name].assets['win32-x64'] = [
            fileName,
            createHash('sha256').update(archive).digest('hex'),
          ];
          windowsArchiveByFileName.set(fileName, archive);
        }
        const windowsInstall = await ensureManagedCliTools({
          yeaftDir: windowsInstallDir,
          platform: 'win32',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => new Response(
            windowsArchiveByFileName.get(String(url).split('/').at(-1)),
          ),
        });
        expect(windowsInstall.map(result => [result.name, result.status])).toEqual([
          ['rg', 'installed'],
          ['fd', 'installed'],
          ['dust', 'installed'],
        ]);
        for (const [name, script] of Object.entries(windowsScripts)) {
          expect(readFileSync(join(windowsBinDir, `${name}.exe`), 'utf8')).toBe(script);
        }

        const rollbackDir = tempDir('cli-windows-rollback');
        const rollbackBinDir = managedCliBinDir(rollbackDir);
        mkdirSync(rollbackBinDir, { recursive: true });
        const oldRg = 'old rg binary';
        writeFileSync(join(rollbackBinDir, 'rg.exe'), oldRg);
        const rollbackArchives = {
          ...windowsArchives,
          rg: zipArchive(
            'package/rg.exe',
            '#!/bin/sh\nrm -- "$0"\necho ripgrep 15.2.0\n',
          ),
        };
        const rollbackArchiveByFileName = new Map();
        for (const [name, archive] of Object.entries(rollbackArchives)) {
          const fileName = originalWindowsAssets[name][0];
          managedCliToolSpecs[name].assets['win32-x64'] = [
            fileName,
            createHash('sha256').update(archive).digest('hex'),
          ];
          rollbackArchiveByFileName.set(fileName, archive);
        }
        const rollbackInstall = await ensureManagedCliTools({
          yeaftDir: rollbackDir,
          platform: 'win32',
          arch: 'x64',
          env: emptyPathEnv(),
          force: true,
          fetchFn: async url => new Response(
            rollbackArchiveByFileName.get(String(url).split('/').at(-1)),
          ),
        });
        expect(rollbackInstall.find(result => result.name === 'rg')).toMatchObject({
          status: 'failed',
        });
        expect(rollbackInstall.filter(result => result.name !== 'rg')
          .every(result => result.status === 'installed')).toBe(true);
        expect(readFileSync(join(rollbackBinDir, 'rg.exe'), 'utf8')).toBe(oldRg);
        expect(readdirSync(rollbackBinDir).some(name => name.includes('.backup'))).toBe(false);
      } finally {
        for (const [name, asset] of Object.entries(originalWindowsAssets)) {
          managedCliToolSpecs[name].assets['win32-x64'] = asset;
        }
      }
    }

    let unsupportedRequests = 0;
    const unsupported = await ensureManagedCliTools({
      yeaftDir: tempDir('cli-unsupported'),
      platform: 'aix',
      arch: 'ppc64',
      env: emptyPathEnv(),
      force: true,
      fetchFn: async () => {
        unsupportedRequests += 1;
        throw new Error('must not download');
      },
    });
    expect(unsupported.every(result => result.status === 'unsupported')).toBe(true);
    expect(unsupportedRequests).toBe(0);

    const flightDir = tempDir('cli-single-flight');
    const flightBinDir = managedCliBinDir(flightDir);
    mkdirSync(flightBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) {
      writeFileSync(join(flightBinDir, name), `#!/bin/sh\necho ${name} 0.0.0\n`, { mode: 0o755 });
    }
    let flightRequests = 0;
    const flightOptions = {
      yeaftDir: flightDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      force: true,
      fetchFn: async () => {
        flightRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response(Buffer.from('invalid archive'));
      },
    };
    const [left, right] = await Promise.all([
      ensureManagedCliTools(flightOptions),
      ensureManagedCliTools(flightOptions),
    ]);
    expect(left).toEqual(right);
    expect(flightRequests).toBe(3);

    const cooldownDir = tempDir('cli-cooldown');
    let cooldownRequests = 0;
    const cooldownOptions = {
      yeaftDir: cooldownDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      now: () => 1000,
      fetchFn: async () => {
        cooldownRequests += 1;
        return new Response(Buffer.from('not an official archive'));
      },
    };
    const first = await ensureManagedCliTools({ ...cooldownOptions, force: true });
    const second = await ensureManagedCliTools(cooldownOptions);
    expect(first.every(result => result.status === 'failed')).toBe(true);
    expect(second.every(result => result.status === 'cooldown')).toBe(true);
    expect(cooldownRequests).toBe(3);

    const busyDir = tempDir('cli-busy');
    const busyBinDir = managedCliBinDir(busyDir);
    mkdirSync(busyBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) mkdirSync(join(busyBinDir, `.install-${name}.lock`));
    const busyOptions = {
      yeaftDir: busyDir,
      platform: 'linux',
      arch: 'x64',
      env: emptyPathEnv(),
      lockWaitMs: 0,
      fetchFn: async () => { throw new Error('busy must not download'); },
    };
    const busyFirst = await ensureManagedCliTools(busyOptions);
    const busySecond = await ensureManagedCliTools(busyOptions);
    expect(busyFirst.every(result => result.status === 'busy')).toBe(true);
    expect(busySecond.every(result => result.status === 'busy')).toBe(true);
    expect(JSON.parse(readFileSync(join(busyDir, 'managed-cli.json'), 'utf8')).failures).toEqual({});

    if (process.platform !== 'win32') {
      const managedCliModuleUrl = new URL(
        '../../../agent/yeaft/managed-cli.js',
        import.meta.url,
      ).href;
      const runLockWatchdog = (yeaftDir, skipInstall = false) => {
        const script = `
          import { ensureManagedCliTools } from ${JSON.stringify(managedCliModuleUrl)};
          let fetches = 0;
          let timerFired = false;
          setTimeout(() => { timerFired = true; }, 0);
          const env = { ...process.env, PATH: '', YEAFT_SKIP_MANAGED_CLI_INSTALLS: ${skipInstall ? "'true'" : "'false'"} };
          const results = await ensureManagedCliTools({
            yeaftDir: ${JSON.stringify(yeaftDir)},
            platform: 'linux',
            arch: 'x64',
            env,
            force: true,
            lockWaitMs: 0,
            fetchFn: async () => {
              fetches += 1;
              throw new Error('lock watchdog must not download');
            },
          });
          await new Promise(resolve => setTimeout(resolve, 0));
          console.log(JSON.stringify({
            fetches,
            timerFired,
            statuses: results.map(result => result.status),
          }));
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 1500,
        });
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout.trim());
      };

      const danglingInstallDir = tempDir('cli-dangling-install-lock');
      const danglingInstallBin = managedCliBinDir(danglingInstallDir);
      mkdirSync(danglingInstallBin, { recursive: true });
      const danglingInstallLocks = ['rg', 'fd', 'dust'].map(name => (
        join(danglingInstallBin, `.install-${name}.lock`)
      ));
      for (const lockPath of danglingInstallLocks) {
        symlinkSync(`${lockPath}.missing`, lockPath, 'dir');
      }
      expect(runLockWatchdog(danglingInstallDir)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['busy', 'busy', 'busy'],
      });
      for (const lockPath of danglingInstallLocks) {
        expect(() => lstatSync(lockPath)).toThrow();
      }

      const danglingStateDir = tempDir('cli-dangling-state-lock');
      const danglingStateLock = join(danglingStateDir, '.managed-cli-state.lock');
      symlinkSync(`${danglingStateLock}.missing`, danglingStateLock, 'dir');
      expect(runLockWatchdog(danglingStateDir, true)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['skipped', 'skipped', 'skipped'],
      });
      expect(() => lstatSync(danglingStateLock)).toThrow();

      const directoryLockDir = tempDir('cli-directory-lock-watchdog');
      const directoryLockBin = managedCliBinDir(directoryLockDir);
      mkdirSync(directoryLockBin, { recursive: true });
      for (const name of ['rg', 'fd', 'dust']) {
        mkdirSync(join(directoryLockBin, `.install-${name}.lock`));
      }
      expect(runLockWatchdog(directoryLockDir)).toEqual({
        fetches: 0,
        timerFired: true,
        statuses: ['busy', 'busy', 'busy'],
      });
    }

    const identityDir = tempDir('cli-identity');
    const identityBinDir = managedCliBinDir(identityDir);
    mkdirSync(identityBinDir, { recursive: true });
    for (const name of ['rg', 'fd', 'dust']) {
      writeFileSync(join(identityBinDir, name), `#!/bin/sh\necho ${name} 0.0.0\n`, { mode: 0o755 });
      expect(resolveManagedCliCommand(name, {
        yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
      })).toBeNull();
    }
    const identityEnv = emptyPathEnv();
    prependManagedCliBinToPath(identityDir, identityEnv, 'linux');
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: identityEnv, platform: 'linux', arch: 'x64',
    })).toBeNull();
    const managedBinAlias = join(identityDir, 'bin-alias');
    symlinkSync(identityBinDir, managedBinAlias, 'dir');
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir,
      env: { ...process.env, PATH: managedBinAlias },
      platform: 'linux',
      arch: 'x64',
    })).toBeNull();
    let identityFetches = 0;
    const identityResults = await ensureManagedCliTools({
      yeaftDir: identityDir,
      platform: 'linux',
      arch: 'x64',
      env: identityEnv,
      force: true,
      fetchFn: async () => {
        identityFetches += 1;
        return new Response(Buffer.from('invalid repair archive'));
      },
    });
    expect(identityResults.every(result => result.status === 'failed')).toBe(true);
    expect(identityFetches).toBe(3);
    trustManagedCliFixtures(identityDir, ['rg', 'fd', 'dust']);
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBe(join(identityBinDir, 'rg'));
    const identityStatePath = join(identityDir, 'managed-cli.json');
    const oldVersionState = JSON.parse(readFileSync(identityStatePath, 'utf8'));
    oldVersionState.installations.rg.version = '0.0.0';
    writeFileSync(identityStatePath, `${JSON.stringify(oldVersionState, null, 2)}\n`);
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBeNull();
    trustManagedCliFixtures(identityDir, ['rg']);
    writeFileSync(join(identityBinDir, 'rg'), '\n# bit flip\n', { flag: 'a' });
    expect(resolveManagedCliCommand('rg', {
      yeaftDir: identityDir, env: emptyPathEnv(), platform: 'linux',
    })).toBeNull();

    if (process.platform !== 'win32') {
      const verifyRejectedManagedAliases = async (aliasKind, createAlias) => {
        const aliasStateDir = tempDir(`cli-${aliasKind}-alias`);
        const aliasManagedBin = managedCliBinDir(aliasStateDir);
        const aliasBin = join(aliasStateDir, 'external-bin');
        const corruptLog = join(aliasStateDir, 'corrupt.log');
        mkdirSync(aliasManagedBin, { recursive: true });
        mkdirSync(aliasBin);
        for (const name of ['rg', 'fd', 'dust']) {
          writeFileSync(
            join(aliasManagedBin, name),
            `#!/bin/sh\necho ${name} >> ${JSON.stringify(corruptLog)}\n${name === 'dust'
              ? "printf '{\"size\":\"0B\",\"name\":\".\",\"children\":[]}'"
              : 'exit 0'}\n`,
            { mode: 0o755 },
          );
        }
        for (const [alias, target] of [
          ['rg', 'rg'],
          ['fd', 'fd'],
          ['fdfind', 'fd'],
          ['dust', 'dust'],
        ]) createAlias(join(aliasManagedBin, target), join(aliasBin, alias));

        const aliasEnv = { ...process.env, PATH: aliasBin };
        const processPathBeforeRepair = process.env.PATH;
        for (const name of ['rg', 'fd', 'dust']) {
          expect(resolveManagedCliCommand(name, {
            yeaftDir: aliasStateDir,
            env: aliasEnv,
            platform: 'linux',
            arch: 'x64',
          })).toBeNull();
        }
        rmSync(join(aliasBin, 'fd'));
        expect(resolveManagedCliCommand('fd', {
          yeaftDir: aliasStateDir,
          env: aliasEnv,
          platform: 'linux',
          arch: 'x64',
        })).toBeNull();
        createAlias(join(aliasManagedBin, 'fd'), join(aliasBin, 'fd'));

        let offlineRepairFetches = 0;
        const offlineRepair = await ensureManagedCliTools({
          yeaftDir: aliasStateDir,
          platform: 'linux',
          arch: 'x64',
          env: aliasEnv,
          force: true,
          fetchFn: async () => {
            offlineRepairFetches += 1;
            throw new Error('offline');
          },
        });
        expect(offlineRepair.every(result => result.status === 'failed')).toBe(true);
        expect(offlineRepairFetches).toBe(3);
        expect(aliasEnv.PATH).toBe(aliasBin);
        expect(process.env.PATH).toBe(processPathBeforeRepair);

        const aliasSearchRoot = tempDir(`cli-${aliasKind}-alias-search`);
        mkdirSync(join(aliasSearchRoot, 'src'));
        writeFileSync(join(aliasSearchRoot, 'src', 'hit.js'), 'needle\n');
        writeFileSync(join(aliasSearchRoot, 'src', 'data.bin'), Buffer.alloc(4096));
        const aliasRegistry = createFullRegistry();
        const aliasContext = {
          cwd: aliasSearchRoot,
          yeaftDir: aliasStateDir,
          managedCliReady: Promise.resolve(offlineRepair),
        };
        const previousProcessPath = process.env.PATH;
        process.env.PATH = aliasBin;
        try {
          expect(await aliasRegistry.execute('Grep', {
            pattern: 'needle',
            path: aliasSearchRoot,
            output_mode: 'content',
            fixed_strings: true,
          }, aliasContext)).toBe('src/hit.js:1:needle');
          expect(await aliasRegistry.execute('Glob', {
            pattern: '**/*.js',
            path: aliasSearchRoot,
          }, aliasContext)).toBe('src/hit.js');
          const aliasDiskUsage = await aliasRegistry.execute('DiskUsage', {
            path: aliasSearchRoot,
            depth: 1,
            limit: 10,
          }, aliasContext);
          expect(aliasDiskUsage).toContain('src');
          expect(aliasDiskUsage).not.toContain('0B  .');
        } finally {
          process.env.PATH = previousProcessPath;
        }
        expect(existsSync(corruptLog)).toBe(false);
        return { aliasContext, aliasRegistry, aliasSearchRoot, aliasStateDir, offlineRepair };
      };

      await verifyRejectedManagedAliases(
        'symlink',
        (target, alias) => symlinkSync(target, alias, 'file'),
      );
      const hardLinkCase = await verifyRejectedManagedAliases('hard-link', linkSync);

      const systemBin = join(hardLinkCase.aliasStateDir, 'system-bin');
      const systemLog = join(hardLinkCase.aliasStateDir, 'system.log');
      mkdirSync(systemBin);
      writeFileSync(join(systemBin, 'rg'), `#!/bin/sh\necho rg >> ${JSON.stringify(systemLog)}\nprintf 'src/hit.js\\0'\n`, { mode: 0o755 });
      writeFileSync(join(systemBin, 'fdfind'), `#!/bin/sh\necho fd >> ${JSON.stringify(systemLog)}\nprintf 'src/hit.js\\0'\n`, { mode: 0o755 });
      writeFileSync(join(systemBin, 'dust'), `#!/bin/sh\necho dust >> ${JSON.stringify(systemLog)}\nprintf '{\"size\":\"4096B\",\"name\":${JSON.stringify(hardLinkCase.aliasSearchRoot)},\"children\":[{\"size\":\"4096B\",\"name\":${JSON.stringify(join(hardLinkCase.aliasSearchRoot, 'src'))},\"children\":[]}]}'\n`, { mode: 0o755 });
      for (const [name, commandName] of [
        ['rg', 'rg'],
        ['fd', 'fdfind'],
        ['dust', 'dust'],
      ]) {
        expect(resolveManagedCliCommand(name, {
          yeaftDir: hardLinkCase.aliasStateDir,
          env: { ...process.env, PATH: systemBin },
          platform: 'linux',
          arch: 'x64',
        })).toBe(join(systemBin, commandName));
      }
      const previousProcessPath = process.env.PATH;
      process.env.PATH = systemBin;
      try {
        expect(await hardLinkCase.aliasRegistry.execute('Grep', {
          pattern: 'needle',
          path: hardLinkCase.aliasSearchRoot,
          output_mode: 'content',
          fixed_strings: true,
        }, hardLinkCase.aliasContext)).toBe('src/hit.js:1:needle');
        expect(await hardLinkCase.aliasRegistry.execute('Glob', {
          pattern: '**/*.js',
          path: hardLinkCase.aliasSearchRoot,
        }, hardLinkCase.aliasContext)).toBe('src/hit.js');
        expect(await hardLinkCase.aliasRegistry.execute('DiskUsage', {
          path: hardLinkCase.aliasSearchRoot,
          depth: 1,
          limit: 10,
        }, hardLinkCase.aliasContext)).toContain('src');
      } finally {
        process.env.PATH = previousProcessPath;
      }
      expect(readFileSync(systemLog, 'utf8').trim().split('\n')).toEqual(['rg', 'fd', 'dust']);
    }

    const root = tempDir('fast-tools');
    mkdirSync(join(root, 'large'));
    mkdirSync(join(root, 'small'));
    writeFileSync(join(root, 'large', 'a.bin'), Buffer.alloc(2048));
    writeFileSync(join(root, 'small', 'b.bin'), Buffer.alloc(32));
    const registry = createFullRegistry();
    const fallbackOutput = await registry.execute('DiskUsage', { path: root, depth: 2, limit: 2 }, {
      cwd: root,
      yeaftDir: join(root, '.fallback'),
      managedCliReady: Promise.resolve([]),
    });
    expect(registry.getToolNames()).toContain('DiskUsage');
    expect(fallbackOutput).toContain('large');
    expect(fallbackOutput.trim().split('\n')).toHaveLength(4);

    if (process.platform !== 'win32') {
      const toolDir = join(root, '.yeaft');
      const toolBinDir = managedCliBinDir(toolDir);
      const log = join(root, 'calls.log');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.js'), 'needle\n');
      mkdirSync(toolBinDir, { recursive: true });
      writeFileSync(join(toolBinDir, 'rg'), `#!/bin/sh\necho rg >> ${JSON.stringify(log)}\nprintf 'src/a.js\\000'\n`, { mode: 0o755 });
      writeFileSync(join(toolBinDir, 'fd'), `#!/bin/sh\necho fd >> ${JSON.stringify(log)}\nprintf 'src/a.js\\0src/b.txt\\0'\n`, { mode: 0o755 });
      writeFileSync(join(toolBinDir, 'dust'), `#!/bin/sh\necho dust >> ${JSON.stringify(log)}\nprintf '{"size":"2080B","name":${JSON.stringify(root)},"children":[{"size":"2048B","name":${JSON.stringify(join(root, 'large'))},"children":[]}]}'\n`, { mode: 0o755 });
      trustManagedCliFixtures(toolDir, ['rg', 'fd', 'dust']);
      const neverReady = new Promise(() => {});
      const ctx = { cwd: root, yeaftDir: toolDir, managedCliReady: neverReady };
      expect(await Promise.race([
        registry.execute('Grep', { pattern: 'needle', path: root }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Grep waited for unrelated installs')), 500)),
      ])).toContain('src/a.js');
      const globOutput = await Promise.race([
        registry.execute('Glob', { pattern: '**/*.js', path: root }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Glob waited for unrelated installs')), 500)),
      ]);
      expect(globOutput).toContain('src/a.js');
      expect(globOutput).not.toContain('b.txt');
      const dustOutput = await Promise.race([
        registry.execute('DiskUsage', { path: root, depth: 2, limit: 2 }, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DiskUsage waited for unrelated installs')), 500)),
      ]);
      expect(dustOutput).toContain('large');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['rg', 'fd', 'dust']);

      const rg = resolveManagedCliCommand('rg', { yeaftDir: toolDir, env: emptyPathEnv() });
      expect(execFileSync(rg, ['--version'], { encoding: 'utf8' })).toContain('src/a.js');
      expect(createHash('sha256').update(readFileSync(rg)).digest('hex')).toHaveLength(64);
      expect(existsSync(rg)).toBe(true);
    }
    const parityRoot = tempDir('search-backend-parity');
    mkdirSync(join(parityRoot, 'src', '.yeaft', 'worktrees', 'nested'), { recursive: true });
    mkdirSync(join(parityRoot, '.yeaft', 'worktrees', 'root'), { recursive: true });
    writeFileSync(join(parityRoot, 'root.txt'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', 'a.js'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', 'a.txt'), 'needle\n');
    writeFileSync(join(parityRoot, 'src', '.yeaft', 'worktrees', 'nested', 'nested.js'), 'needle\n');
    writeFileSync(join(parityRoot, '.yeaft', 'worktrees', 'root', 'root.js'), 'needle\n');
    const realBinDir = managedCliBinDir(parityRoot);
    mkdirSync(realBinDir, { recursive: true });
    const realRg = process.env.YEAFT_TEST_RG;
    const realFd = process.env.YEAFT_TEST_FD;
    const realDust = process.env.YEAFT_TEST_DUST;
    if (realRg && realFd) {
      writeFileSync(join(realBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      writeFileSync(join(realBinDir, 'fd'), readFileSync(realFd), { mode: 0o755 });
      trustManagedCliFixtures(parityRoot, ['rg', 'fd']);
      const fastCtx = { cwd: parityRoot, yeaftDir: parityRoot, managedCliReady: Promise.resolve([]) };
      const fallbackCtx = { cwd: parityRoot, yeaftDir: join(parityRoot, 'fallback'), managedCliReady: Promise.resolve([]) };
      for (const filters of [
        { glob: '**/*.txt', type: 'js' },
        { glob: 'src/**', type: 'js' },
        { glob: '*.{js,txt}' },
        { glob: '**/*.txt' },
      ]) {
        const input = { pattern: 'needle', path: parityRoot, output_mode: 'files_with_matches', fixed_strings: true, ...filters };
        const fast = (await registry.execute('Grep', input, fastCtx)).split('\n').sort();
        const fallback = (await registry.execute('Grep', input, fallbackCtx)).split('\n').sort();
        expect(fast).toEqual(fallback);
      }

      writeFileSync(join(parityRoot, 'src', 'a[0-9].js'), 'needle\n');
      for (const directory of SEARCH_SKIP_DIRS) {
        mkdirSync(join(parityRoot, directory), { recursive: true });
        writeFileSync(join(parityRoot, directory, 'hit.js'), 'needle\n');
      }
      const skipInput = {
        pattern: 'needle', path: parityRoot, glob: '**/*.js',
        output_mode: 'files_with_matches', fixed_strings: true, head_limit: 50,
      };
      expect(await registry.execute('Grep', skipInput, fastCtx))
        .toBe(await registry.execute('Grep', skipInput, fallbackCtx));
      for (const directory of SEARCH_SKIP_DIRS) {
        expect(await registry.execute('Grep', skipInput, fastCtx))
          .not.toContain(`${directory}/hit.js`);
      }
      const literalBracketInput = {
        pattern: 'needle', path: parityRoot, glob: 'a[0-9].js',
        output_mode: 'files_with_matches', fixed_strings: true,
      };
      const literalBracketFast = await registry.execute('Grep', literalBracketInput, fastCtx);
      const literalBracketFallback = await registry.execute('Grep', literalBracketInput, fallbackCtx);
      expect(literalBracketFast).toBe('src/a[0-9].js');
      expect(literalBracketFast).toBe(literalBracketFallback);

      writeFileSync(join(parityRoot, 'src', 'line\nbreak.js'), 'needle\n');
      mkdirSync(join(parityRoot, 'C:'));
      writeFileSync(join(parityRoot, 'C:', 'a.js'), 'needle\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: outputMode, fixed_strings: true, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).toContain('C:/a.js');
        expect(fast).toContain('src/line\nbreak.js');
      }
      writeFileSync(join(parityRoot, 'src', 'context.js'), 'zero\r\nneedle\r\ntwo\r\n');
      for (const contextOptions of [{}, { context: 1 }, { before: 1 }, { after: 1 }]) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: 'content', fixed_strings: true, head_limit: 20,
          ...contextOptions,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).not.toContain('\r');
      }
      writeFileSync(join(parityRoot, 'src', 'count.js'), 'needle needle\nneedle\n');
      const countInput = {
        pattern: 'needle', path: parityRoot, glob: 'count.js',
        output_mode: 'count', fixed_strings: true,
      };
      expect(await registry.execute('Grep', countInput, fastCtx)).toBe('src/count.js:3');
      expect(await registry.execute('Grep', countInput, fastCtx))
        .toBe(await registry.execute('Grep', countInput, fallbackCtx));

      writeFileSync(join(parityRoot, 'src', 'multiline.js'), 'alpha\nbeta\nalpha\nbeta\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        for (const search of [
          { pattern: 'alpha.*beta', fixed_strings: false, expectedCount: 1 },
          { pattern: 'alpha\nbeta', fixed_strings: true, expectedCount: 2 },
        ]) {
          const input = {
            ...search, path: parityRoot, glob: 'multiline.js',
            output_mode: outputMode, multiline: true, head_limit: 20,
          };
          const fast = await registry.execute('Grep', input, fastCtx);
          const fallback = await registry.execute('Grep', input, fallbackCtx);
          const expected = outputMode === 'files_with_matches'
            ? 'src/multiline.js'
            : outputMode === 'count'
              ? `src/multiline.js:${search.expectedCount}`
              : [1, 2, 3, 4]
                  .map(line => `src/multiline.js:${line}:${line % 2 ? 'alpha' : 'beta'}`)
                  .join('\n');
          expect(fast).toBe(expected);
          expect(fast).toBe(fallback);
        }
      }
      writeFileSync(join(parityRoot, 'src', 'anchor.js'), 'alpha\nbeta\ngamma\n^beta$\n');
      for (const pattern of ['^beta$', '(?m)^beta$']) {
        for (const multiline of [false, true]) {
          for (const outputMode of ['files_with_matches', 'count', 'content']) {
            const input = {
              pattern, path: parityRoot, glob: 'anchor.js',
              output_mode: outputMode, multiline, head_limit: 20,
            };
            const expected = outputMode === 'files_with_matches'
              ? 'src/anchor.js'
              : outputMode === 'count'
                ? 'src/anchor.js:1'
                : 'src/anchor.js:2:beta';
            const fast = await registry.execute('Grep', input, fastCtx);
            const fallback = await registry.execute('Grep', input, fallbackCtx);
            expect(fast).toBe(expected);
            expect(fast).toBe(fallback);
          }
        }
      }
      for (const pattern of ['\\^beta\\$', 'beta[$]']) {
        const input = {
          pattern, path: parityRoot, glob: 'anchor.js',
          output_mode: 'content', multiline: true, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe('src/anchor.js:4:^beta$');
        expect(fast).toBe(fallback);
      }
      const disabledAnchorInput = {
        pattern: '(?-m)^beta$', path: parityRoot, glob: 'anchor.js',
        output_mode: 'content', multiline: true, head_limit: 20,
      };
      expect(await registry.execute('Grep', disabledAnchorInput, fastCtx)).toBe('(no matches)');
      expect(await registry.execute('Grep', disabledAnchorInput, fallbackCtx)).toBe('(no matches)');

      for (const pattern of [
        '(?-m:^beta$)',
        '(?m:(?-m:^beta$)|^gamma$)',
        '(?m:^beta(?-m:$))',
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern, path: parityRoot, glob: 'anchor.js',
            output_mode: outputMode, multiline: true, head_limit: 20,
          };
          const fast = await registry.execute('Grep', input, fastCtx);
          const fallback = await registry.execute('Grep', input, fallbackCtx);
          expect(fast).toBe(fallback);
          if (process.version.startsWith('v20.')) expect(fast).toContain('Invalid regular expression');
          else expect(fast).not.toContain('unsupported');
        }
      }

      writeFileSync(join(parityRoot, 'src', 'multiline-crlf.js'), 'alpha\r\nbeta\r\n');
      const scopedCrlfInput = {
        pattern: '(?m:^beta$)', path: parityRoot, glob: 'multiline-crlf.js',
        output_mode: 'content', multiline: false, head_limit: 20,
      };
      const scopedCrlfFast = await registry.execute('Grep', scopedCrlfInput, fastCtx);
      expect(scopedCrlfFast).toBe(await registry.execute('Grep', scopedCrlfInput, fallbackCtx));
      if (!process.version.startsWith('v20.')) expect(scopedCrlfFast).toBe('src/multiline-crlf.js:2:beta');
      for (const multiline of [false, true]) {
        const input = {
          pattern: 'beta$', path: parityRoot, glob: 'multiline-crlf.js',
          output_mode: 'content', multiline, head_limit: 20,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        expect(fast).toBe('src/multiline-crlf.js:2:beta');
        expect(fast).toBe(await registry.execute('Grep', input, fallbackCtx));
      }
      for (const fixedStrings of [false, true]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern: 'alpha\nbeta', path: parityRoot, glob: 'multiline-crlf.js',
            output_mode: outputMode, fixed_strings: fixedStrings,
            multiline: true, head_limit: 20,
          };
          expect(await registry.execute('Grep', input, fastCtx)).toBe('(no matches)');
          expect(await registry.execute('Grep', input, fallbackCtx)).toBe('(no matches)');
        }
      }

      writeFileSync(join(parityRoot, 'src', 'isolated-cr.js'), 'alpha\rbeta\n');
      for (const outputMode of ['files_with_matches', 'count', 'content']) {
        const input = {
          pattern: 'alpha.*beta', path: parityRoot, glob: 'isolated-cr.js',
          output_mode: outputMode, multiline: true, head_limit: 20,
        };
        const expected = outputMode === 'files_with_matches'
          ? 'src/isolated-cr.js'
          : outputMode === 'count'
            ? 'src/isolated-cr.js:1'
            : 'src/isolated-cr.js:1:alpha\nsrc/isolated-cr.js:2:beta';
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(expected);
        expect(fast).toBe(fallback);
      }

      const zeroLengthRoot = tempDir('grep-zero-length');
      mkdirSync(join(zeroLengthRoot, 'src'));
      writeFileSync(join(zeroLengthRoot, 'src', 'empty.js'), '');
      writeFileSync(join(zeroLengthRoot, 'src', 'only-newline.js'), '\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'middle.js'), 'alpha\n\nbeta\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'trailing.js'), 'alpha\nbeta\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'no-trailing.js'), 'alpha\nbeta');
      writeFileSync(join(zeroLengthRoot, 'src', 'crlf-empty.js'), 'alpha\r\n\r\nbeta\r\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-backref.js'), 'aa\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-legacy.js'), 'Aalpha\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'regex-literal.js'), '(?x)^a b$\n');
      writeFileSync(join(zeroLengthRoot, 'src', 'unicode-only.js'), '界\n');
      const zeroLengthBinDir = managedCliBinDir(zeroLengthRoot);
      mkdirSync(zeroLengthBinDir, { recursive: true });
      writeFileSync(join(zeroLengthBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(zeroLengthRoot, ['rg']);
      const zeroLengthContexts = [
        { cwd: zeroLengthRoot, yeaftDir: zeroLengthRoot, managedCliReady: Promise.resolve([]) },
        { cwd: zeroLengthRoot, yeaftDir: join(zeroLengthRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      for (const pattern of [
        '(?m)^$', '(?m)^|$', '\\b', 'a*', 'a?', 'a{0}', 'a{00,2}',
        '(?:alpha|)', '(?:a*)+', '(?<name>a*)', '(?=alpha)',
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const input = {
            pattern, path: zeroLengthRoot, glob: '**/*.js',
            output_mode: outputMode, multiline: true, head_limit: 50,
          };
          const outputs = await Promise.all(zeroLengthContexts.map(context => (
            registry.execute('Grep', input, context)
          )));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0]).not.toContain('Grep failed');
        }
      }
      for (const context of zeroLengthContexts) {
        for (const pattern of ['(?P<name>alpha)', '(?x)^a b$']) {
          expect(await registry.execute('Grep', {
            pattern, path: zeroLengthRoot, glob: 'no-trailing.js',
            output_mode: 'content', multiline: true,
          }, context)).toContain('Invalid regular expression');
        }
        expect(await registry.execute('Grep', {
          pattern: '(?x)^a b$', path: zeroLengthRoot, glob: 'regex-literal.js',
          output_mode: 'content', multiline: true, fixed_strings: true,
        }, context)).toBe('src/regex-literal.js:1:(?x)^a b$');
      }
      let managedCliLookupCount = 0;
      const lookupProbeContext = {
        cwd: zeroLengthRoot,
        get yeaftDir() {
          managedCliLookupCount += 1;
          return zeroLengthRoot;
        },
        managedCliReady: Promise.resolve([]),
      };
      expect(await registry.execute('Grep', {
        pattern: '(?=(a))\\1', path: zeroLengthRoot, glob: 'regex-backref.js',
        output_mode: 'content', multiline: true,
      }, lookupProbeContext)).toBe('src/regex-backref.js:1:aa');
      expect(managedCliLookupCount).toBe(0);
      expect(await registry.execute('Grep', {
        pattern: 'alpha', path: zeroLengthRoot, glob: 'no-trailing.js',
        output_mode: 'content', multiline: false,
      }, lookupProbeContext)).toBe('src/no-trailing.js:1:alpha');
      expect(managedCliLookupCount).toBeGreaterThan(0);
      for (const pattern of ['\ud800', '\0', '\r', '\n']) {
        managedCliLookupCount = 0;
        await registry.execute('Grep', {
          pattern, path: zeroLengthRoot, output_mode: 'content', fixed_strings: true,
        }, lookupProbeContext);
        expect(managedCliLookupCount).toBe(0);
      }

      const eligibilityRoot = tempDir('grep-file-eligibility');
      mkdirSync(join(eligibilityRoot, 'src'));
      writeFileSync(join(eligibilityRoot, 'src', 'large.txt'), `${'x'.repeat(1024 * 1024 + 1)}\nneedle\n`);
      writeFileSync(join(eligibilityRoot, 'src', 'fake.pdf'), 'needle\n');
      writeFileSync(join(eligibilityRoot, 'src', 'invalid.txt'), Buffer.concat([
        Buffer.from('needle\n'), Buffer.from([0xff]),
      ]));
      writeFileSync(join(eligibilityRoot, 'src', 'replacement.txt'), 'x\ufffdy\n');
      const eligibilityBinDir = managedCliBinDir(eligibilityRoot);
      const eligibilityRgLog = join(tmpdir(), `yeaft-rg-candidate-${process.pid}-${Date.now()}.log`);
      managedCliTempDirs.push(eligibilityRgLog);
      mkdirSync(eligibilityBinDir, { recursive: true });
      writeFileSync(join(eligibilityBinDir, 'rg'), `#!/bin/sh\nprintf 'env=%s\\n' "\${RIPGREP_CONFIG_PATH-unset}" >> ${JSON.stringify(eligibilityRgLog)}\nprintf 'arg=%s\\n' "$@" >> ${JSON.stringify(eligibilityRgLog)}\nexec ${JSON.stringify(realRg)} "$@"\n`, { mode: 0o755 });
      trustManagedCliFixtures(eligibilityRoot, ['rg']);
      const eligibilityContexts = [
        { cwd: eligibilityRoot, yeaftDir: eligibilityRoot, managedCliReady: Promise.resolve([]) },
        { cwd: eligibilityRoot, yeaftDir: join(eligibilityRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      const hostileRgConfig = join(eligibilityRoot, 'ripgrep.rc');
      writeFileSync(hostileRgConfig, '--max-filesize=1\n--glob=!large.txt\n');
      const previousRgConfig = process.env.RIPGREP_CONFIG_PATH;
      process.env.RIPGREP_CONFIG_PATH = hostileRgConfig;
      try {
        const fast = await registry.execute('Grep', {
          pattern: 'needle', path: eligibilityRoot, glob: 'large.txt',
          output_mode: 'content', fixed_strings: true,
        }, eligibilityContexts[0]);
        const fallback = await registry.execute('Grep', {
          pattern: 'needle', path: eligibilityRoot, glob: 'large.txt',
          output_mode: 'content', fixed_strings: true,
        }, eligibilityContexts[1]);
        expect(fast).toBe('src/large.txt:2:needle');
        expect(fast).toBe(fallback);
        const candidateLog = readFileSync(eligibilityRgLog, 'utf8');
        expect(candidateLog).toContain('env=unset');
        expect(candidateLog).toContain('arg=--no-config');
        expect(candidateLog).toContain('arg=--files-with-matches');
      } finally {
        if (previousRgConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
        else process.env.RIPGREP_CONFIG_PATH = previousRgConfig;
      }
      for (const input of [
        { pattern: 'needle', fixed_strings: true },
        { pattern: 'needl.', fixed_strings: false },
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
            ...input, path: eligibilityRoot, output_mode: outputMode, head_limit: 50,
          }, context)));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0]).toContain('src/large.txt');
          expect(outputs[0]).not.toContain('fake.pdf');
          expect(outputs[0]).not.toContain('invalid.txt');
        }
      }
      const surrogateOutputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
        pattern: '\ud800', path: eligibilityRoot, output_mode: 'content', fixed_strings: true,
      }, context)));
      expect(surrogateOutputs).toEqual(['(no matches)', '(no matches)']);

      for (const [file, content] of [
        ['empty.txt', ''],
        ['trailing.txt', 'alpha\n'],
        ['crlf.txt', 'alpha\r\nbeta\r\n'],
        ['cr.txt', 'alpha\rbeta\r'],
        ['line-separators.txt', 'alpha\u2028beta\u2029'],
      ]) writeFileSync(join(eligibilityRoot, 'src', file), content);
      for (const [glob, pattern, expectedContent, expectedCount] of [
        ['empty.txt', '(?m)^$', 'src/empty.txt:1:', 1],
        ['trailing.txt', '(?m)^$', 'src/trailing.txt:2:', 1],
        ['crlf.txt', '^beta$', 'src/crlf.txt:2:beta', 1],
        ['cr.txt', '^beta$', 'src/cr.txt:2:beta', 1],
        ['line-separators.txt', '^beta$', 'src/line-separators.txt:2:beta', 1],
      ]) {
        for (const outputMode of ['files_with_matches', 'count', 'content']) {
          const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
            pattern, path: eligibilityRoot, glob, output_mode: outputMode, multiline: true,
          }, context)));
          const expected = outputMode === 'files_with_matches'
            ? `src/${glob}`
            : outputMode === 'count' ? `src/${glob}:${expectedCount}` : expectedContent;
          expect(outputs).toEqual([expected, expected]);
        }
      }
      for (const context of eligibilityContexts) {
        for (const [outputMode, expected] of [
          ['files_with_matches', 'large.txt'],
          ['count', 'large.txt:1'],
          ['content', 'large.txt:2:needle'],
        ]) {
          expect(await registry.execute('Grep', {
            pattern: 'needle', path: join(eligibilityRoot, 'src', 'large.txt'),
            output_mode: outputMode, fixed_strings: true,
          }, context)).toBe(expected);
        }
      }
      const linkPath = join(eligibilityRoot, 'src', 'large-link.txt');
      symlinkSync(join(eligibilityRoot, 'src', 'large.txt'), linkPath);
      for (const context of eligibilityContexts) {
        expect(await registry.execute('Grep', {
          pattern: 'needle', path: linkPath, output_mode: 'content', fixed_strings: true,
        }, context)).toBe('(no matches)');
      }
      const zeroWidthCounts = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
        pattern: '(?:)', path: eligibilityRoot, glob: 'trailing.txt',
        output_mode: 'count', multiline: true,
      }, context)));
      expect(zeroWidthCounts).toEqual(['src/trailing.txt:7', 'src/trailing.txt:7']);
      for (const [pattern, outputMode, expected] of [
        ['(?:)', 'count', 'src/crlf.txt:14'],
        ['(?:)', 'content', 'src/crlf.txt:1:alpha\nsrc/crlf.txt:2:beta\nsrc/crlf.txt:3:'],
        ['(?m)^$', 'count', 'src/crlf.txt:3'],
        ['(?m)^$', 'content', 'src/crlf.txt:2:\nsrc/crlf.txt:3:'],
        ['$', 'count', 'src/crlf.txt:5'],
        ['$', 'content', 'src/crlf.txt:1:alpha\nsrc/crlf.txt:2:beta\nsrc/crlf.txt:3:'],
      ]) {
        const outputs = await Promise.all(eligibilityContexts.map(context => registry.execute('Grep', {
          pattern, path: eligibilityRoot, glob: 'crlf.txt',
          output_mode: outputMode, multiline: true,
        }, context)));
        expect(outputs).toEqual([expected, expected]);
      }

      const safeRegexCases = [
        { pattern: '(?i)(?m)^BETA$', glob: 'no-trailing.js', expected: 'src/no-trailing.js:2:beta' },
        { pattern: '(?:alpha|beta)+', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?:alpha)?beta', glob: 'no-trailing.js', expected: 'src/no-trailing.js:2:beta' },
        { pattern: '(?:alpha|beta){1,2}', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?<name>alpha)', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?=alpha)alpha', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '(?=(a))\\1', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '(?<=(a))\\1', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '(?<letter>a)\\k<letter>', glob: 'regex-backref.js', expected: 'src/regex-backref.js:1:aa' },
        { pattern: '\\Aalpha', glob: 'regex-legacy.js', expected: 'src/regex-legacy.js:1:Aalpha' },
        { pattern: '^\\w+$', glob: 'unicode-only.js', expected: '(no matches)' },
        { pattern: '\\b界', glob: 'unicode-only.js', expected: '(no matches)' },
        { pattern: '[a*]+', glob: 'no-trailing.js', expected: 'src/no-trailing.js:1:alpha' },
        { pattern: '\\^', glob: 'no-trailing.js', expected: '(no matches)' },
      ];
      for (const { pattern, glob, expected } of safeRegexCases) {
        const input = {
          pattern, path: zeroLengthRoot, glob,
          output_mode: 'content', multiline: true, head_limit: 50,
        };
        const outputs = await Promise.all(zeroLengthContexts.map(context => (
          registry.execute('Grep', input, context)
        )));
        expect(outputs[0].split('\n')[0]).toBe(expected);
        expect(outputs[0]).toBe(outputs[1]);
      }

      for (const headLimit of [1, 2]) {
        const input = {
          pattern: 'needle', path: parityRoot, glob: '**/*.js',
          output_mode: 'files_with_matches', fixed_strings: true, head_limit: headLimit,
        };
        const fast = await registry.execute('Grep', input, fastCtx);
        const fallback = await registry.execute('Grep', input, fallbackCtx);
        expect(fast).toBe(fallback);
        expect(fast).toContain('(more results omitted)');
      }

      const contextLimitRoot = tempDir('grep-context-limit');
      for (const name of ['a.txt', 'b.txt']) {
        writeFileSync(join(contextLimitRoot, name), `${name}-0\n${name}-1\nHIT\n${name}-3\n${name}-4\n`);
      }
      const contextLimitBin = managedCliBinDir(contextLimitRoot);
      mkdirSync(contextLimitBin, { recursive: true });
      writeFileSync(join(contextLimitBin, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(contextLimitRoot, ['rg']);
      const contextLimitContexts = [
        { cwd: contextLimitRoot, yeaftDir: contextLimitRoot, managedCliReady: Promise.resolve([]) },
        { cwd: contextLimitRoot, yeaftDir: join(contextLimitRoot, 'fallback'), managedCliReady: Promise.resolve([]) },
      ];
      for (const contextOptions of [{ before: 2 }, { after: 2 }, { context: 2 }]) {
        for (const headLimit of [1, 2]) {
          const outputs = await Promise.all(contextLimitContexts.map(context => registry.execute('Grep', {
            pattern: 'HIT', path: contextLimitRoot, output_mode: 'content', fixed_strings: true,
            head_limit: headLimit, ...contextOptions,
          }, context)));
          expect(outputs[0]).toBe(outputs[1]);
          expect(outputs[0].split('\n').filter(line => line.endsWith(':3:HIT'))).toHaveLength(headLimit);
          expect(outputs[0]).toContain('a.txt:3:HIT');
          if (headLimit === 2) expect(outputs[0]).toContain('b.txt:3:HIT');
        }
      }
      writeFileSync(join(contextLimitRoot, 'adjacent.txt'), 'HIT\nHIT\nafter\n');
      for (const context of contextLimitContexts) {
        const output = await registry.execute('Grep', {
          pattern: 'HIT', path: contextLimitRoot, glob: 'adjacent.txt',
          output_mode: 'content', fixed_strings: true, after: 2, head_limit: 1,
        }, context);
        expect(output.split('\n').filter(line => line.includes(':HIT'))).toHaveLength(1);
        expect(output).toContain('adjacent.txt:1:HIT');
        expect(output).toContain('adjacent.txt-3-after');
        expect(output).toContain('(more results omitted)');
      }
      rmSync(join(contextLimitRoot, 'adjacent.txt'));
      writeFileSync(join(contextLimitRoot, 'a.txt'), `${'界'.repeat(6000)}\nHIT\n`);
      writeFileSync(join(contextLimitRoot, 'b.txt'), `${'界'.repeat(6000)}\nHIT\n`);
      for (const context of contextLimitContexts) {
        const output = await registry.execute('Grep', {
          pattern: 'HIT', path: contextLimitRoot, output_mode: 'content', fixed_strings: true,
          before: 1, head_limit: 2,
        }, context);
        expect(output).toContain('a.txt:2:HIT');
        expect(output).toContain('b.txt:2:HIT');
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32 * 1024);
      }

      const orderingRoot = tempDir('search-order-parity');
      mkdirSync(join(orderingRoot, 'a'));
      writeFileSync(join(orderingRoot, 'z1.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'z2.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'z3.js'), 'needle\n');
      writeFileSync(join(orderingRoot, 'a', 'a.js'), 'needle\n');
      const orderingBinDir = managedCliBinDir(orderingRoot);
      mkdirSync(orderingBinDir, { recursive: true });
      writeFileSync(join(orderingBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(orderingRoot, ['rg']);
      const orderingInput = {
        pattern: 'needle', path: orderingRoot, glob: '**/*.js',
        output_mode: 'files_with_matches', fixed_strings: true, head_limit: 1,
      };
      const orderingFast = await registry.execute('Grep', orderingInput, {
        cwd: orderingRoot, yeaftDir: orderingRoot, managedCliReady: Promise.resolve([]),
      });
      const orderingFallback = await registry.execute('Grep', orderingInput, {
        cwd: orderingRoot, yeaftDir: join(orderingRoot, 'fallback'), managedCliReady: Promise.resolve([]),
      });
      expect(orderingFast).toBe('a/a.js\n\n... (more results omitted)');
      expect(orderingFast).toBe(orderingFallback);
      const budgetRoot = tempDir('grep-render-budget');
      mkdirSync(join(budgetRoot, 'src'));
      const exactFirstMatch = `${'界'.repeat(5455)}aa`;
      const exactSecondMatch = `${'界'.repeat(5455)}a`;
      writeFileSync(join(budgetRoot, 'src', 'a.js'), `needle${exactFirstMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'b.js'), `needle${exactSecondMatch}\n`);
      const budgetBinDir = managedCliBinDir(budgetRoot);
      mkdirSync(budgetBinDir, { recursive: true });
      writeFileSync(join(budgetBinDir, 'rg'), readFileSync(realRg), { mode: 0o755 });
      trustManagedCliFixtures(budgetRoot, ['rg']);
      const budgetInput = {
        pattern: 'needle', path: budgetRoot, glob: '**/*.js',
        output_mode: 'content', fixed_strings: true, head_limit: 2,
      };
      const budgetContexts = [budgetRoot, join(budgetRoot, 'fallback')];
      for (const yeaftDir of budgetContexts) {
        const output = await registry.execute('Grep', budgetInput, {
          cwd: budgetRoot, yeaftDir, managedCliReady: Promise.resolve([]),
        });
        expect(Buffer.byteLength(output)).toBe(32768);
        expect(output).not.toContain('[Output truncated]');
        expect(output).not.toContain('\ufffd');
      }

      const longMatch = '界'.repeat(5451);
      writeFileSync(join(budgetRoot, 'src', 'a.js'), `needle${longMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'b.js'), `needle${longMatch}\n`);
      writeFileSync(join(budgetRoot, 'src', 'c.js'), 'needle\n');
      for (const yeaftDir of budgetContexts) {
        const output = await registry.execute('Grep', budgetInput, {
          cwd: budgetRoot, yeaftDir, managedCliReady: Promise.resolve([]),
        });
        expect(Buffer.byteLength(output)).toBe(32768);
        expect(output).toContain('[Output truncated]');
        expect(output).not.toContain('\ufffd');
      }
      const fastGlob = await registry.execute('Glob', { pattern: '**/*.js', path: parityRoot }, fastCtx);
      const fallbackGlob = await registry.execute('Glob', { pattern: '**/*.js', path: parityRoot }, fallbackCtx);
      expect(fastGlob).toBe(fallbackGlob);
      expect(fastGlob).toContain('src/a.js');
      expect(fastGlob).not.toContain('.yeaft/worktrees');

      const equalMtimeRoot = tempDir('glob-equal-mtime');
      for (const name of ['c.js', 'b.js', 'a.js']) writeFileSync(join(equalMtimeRoot, name), 'value\n');
      const equalTime = new Date('2026-08-01T00:00:00.000Z');
      for (const name of ['c.js', 'b.js', 'a.js']) utimesSync(join(equalMtimeRoot, name), equalTime, equalTime);
      const equalMtimeBin = managedCliBinDir(equalMtimeRoot);
      mkdirSync(equalMtimeBin, { recursive: true });
      writeFileSync(join(equalMtimeBin, 'fd'), '#!/bin/sh\nprintf "c.js\\0b.js\\0a.js\\0"\n', { mode: 0o755 });
      trustManagedCliFixtures(equalMtimeRoot, ['fd']);
      for (const limit of [1, 2]) {
        const input = { pattern: '*.js', path: equalMtimeRoot, limit };
        const fast = await registry.execute('Glob', input, {
          cwd: equalMtimeRoot, yeaftDir: equalMtimeRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('Glob', input, {
          cwd: equalMtimeRoot, yeaftDir: join(equalMtimeRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        expect(fast).toBe(fallback);
        expect(fast).toBe(limit === 1 ? 'a.js' : 'a.js\nb.js');
      }

      const specialPathRoot = tempDir('glob-special-paths');
      mkdirSync(join(specialPathRoot, 'src'));
      writeFileSync(join(specialPathRoot, 'src', 'car\rriage.js'), 'value\n');
      writeFileSync(join(specialPathRoot, 'src', 'line\nbreak.js'), 'value\n');
      const specialPathBinDir = managedCliBinDir(specialPathRoot);
      mkdirSync(specialPathBinDir, { recursive: true });
      writeFileSync(join(specialPathBinDir, 'fd'), readFileSync(realFd), { mode: 0o755 });
      trustManagedCliFixtures(specialPathRoot, ['fd']);
      for (const expected of ['src/car\rriage.js', 'src/line\nbreak.js']) {
        const input = { pattern: expected, path: specialPathRoot };
        const fast = await registry.execute('Glob', input, {
          cwd: specialPathRoot, yeaftDir: specialPathRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('Glob', input, {
          cwd: specialPathRoot, yeaftDir: join(specialPathRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        expect(fast).toBe(expected);
        expect(fast).toBe(fallback);
      }

      if (realDust) {
        const equalSizeDiskRoot = tempDir('disk-usage-equal-size');
        for (const name of ['A', 'a', 'Z', 'z', 'ä', 'é']) {
          mkdirSync(join(equalSizeDiskRoot, name));
          writeFileSync(join(equalSizeDiskRoot, name, 'data.bin'), Buffer.alloc(16));
        }
        const equalSizeDiskBin = managedCliBinDir(equalSizeDiskRoot);
        mkdirSync(equalSizeDiskBin, { recursive: true });
        writeFileSync(join(equalSizeDiskBin, 'dust'), readFileSync(realDust), { mode: 0o755 });
        trustManagedCliFixtures(equalSizeDiskRoot, ['dust']);
        for (const limit of [2, 3, 6]) {
          const input = { path: equalSizeDiskRoot, depth: 1, limit };
          const fast = await registry.execute('DiskUsage', input, {
            cwd: equalSizeDiskRoot, yeaftDir: equalSizeDiskRoot, managedCliReady: Promise.resolve([]),
          });
          const fallback = await registry.execute('DiskUsage', input, {
            cwd: equalSizeDiskRoot, yeaftDir: join(equalSizeDiskRoot, 'fallback'), managedCliReady: Promise.resolve([]),
          });
          expect(fast).toBe(fallback);
        }

        const diskConcurrencyRoot = tempDir('disk-usage-concurrency');
        let diskLevel = [diskConcurrencyRoot];
        for (let level = 0; level < 3; level += 1) {
          const next = [];
          for (const parent of diskLevel) {
            for (let index = 0; index < 8; index += 1) {
              const child = join(parent, `d${index}`);
              mkdirSync(child);
              next.push(child);
            }
          }
          diskLevel = next;
        }
        let activeFs = 0;
        let maxActiveFs = 0;
        const wrapFs = operation => async (...args) => {
          activeFs += 1;
          maxActiveFs = Math.max(maxActiveFs, activeFs);
          await new Promise(resolve => setTimeout(resolve, 1));
          try { return await operation(...args); } finally { activeFs -= 1; }
        };
        await nodeDiskUsage(diskConcurrencyRoot, 3, 20, undefined, {
          lstat: wrapFs(lstatAsync),
          readdir: wrapFs(readdirAsync),
          stat: wrapFs(statAsync),
        });
        expect(maxActiveFs).toBeLessThanOrEqual(16);
        expect(activeFs).toBe(0);

        const diskAbort = new AbortController();
        activeFs = 0;
        const abortingFs = operation => async (...args) => {
          activeFs += 1;
          await new Promise(resolve => setTimeout(resolve, 5));
          try { return await operation(...args); } finally { activeFs -= 1; }
        };
        const abortedScan = nodeDiskUsage(diskConcurrencyRoot, 3, 20, diskAbort.signal, {
          lstat: abortingFs(lstatAsync),
          readdir: abortingFs(readdirAsync),
          stat: abortingFs(statAsync),
        });
        setImmediate(() => diskAbort.abort('user'));
        await expect(abortedScan).rejects.toMatchObject({ name: 'AbortError' });
        expect(activeFs).toBe(0);

        const symlinkRoot = tempDir('disk-usage-symlink');
        mkdirSync(join(symlinkRoot, 'target'));
        writeFileSync(join(symlinkRoot, 'target', 'data.bin'), Buffer.alloc(16));
        writeFileSync(join(symlinkRoot, 'target-file.bin'), Buffer.alloc(8));
        symlinkSync('target', join(symlinkRoot, 'linkdir'), 'dir');
        symlinkSync('target-file.bin', join(symlinkRoot, 'filelink'), 'file');
        symlinkSync('missing-target', join(symlinkRoot, 'broken'));
        const symlinkBinDir = managedCliBinDir(symlinkRoot);
        mkdirSync(symlinkBinDir, { recursive: true });
        writeFileSync(join(symlinkBinDir, 'dust'), readFileSync(realDust), { mode: 0o755 });
        trustManagedCliFixtures(symlinkRoot, ['dust']);
        const diskInput = { path: symlinkRoot, depth: 2, limit: 20 };
        const fast = await registry.execute('DiskUsage', diskInput, {
          cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
        });
        const fallback = await registry.execute('DiskUsage', diskInput, {
          cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        const fastLinkRow = fast.split('\n').find(line => line.endsWith('  linkdir'));
        const fallbackLinkRow = fallback.split('\n').find(line => line.endsWith('  linkdir'));
        expect(fastLinkRow).toBeDefined();
        expect(fallbackLinkRow).toBe(fastLinkRow);
        for (const nonDirectoryLink of ['filelink', 'broken']) {
          expect(fast.split('\n').some(line => line.endsWith(`  ${nonDirectoryLink}`))).toBe(false);
          expect(fallback.split('\n').some(line => line.endsWith(`  ${nonDirectoryLink}`))).toBe(false);
        }
        for (const { depth, limit } of [
          { depth: 0, limit: 1 },
          { depth: 1, limit: 2 },
          { depth: 2, limit: 20 },
        ]) {
          const boundedInput = { path: symlinkRoot, depth, limit };
          const boundedFast = await registry.execute('DiskUsage', boundedInput, {
            cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
          });
          const boundedFallback = await registry.execute('DiskUsage', boundedInput, {
            cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
          });
          expect(boundedFast).toBe(boundedFallback);
        }

        const regularFileInput = { path: join(symlinkRoot, 'target-file.bin'), depth: 2, limit: 20 };
        for (const yeaftDir of [symlinkRoot, join(symlinkRoot, 'fallback')]) {
          expect(await registry.execute('DiskUsage', regularFileInput, {
            cwd: symlinkRoot, yeaftDir, managedCliReady: Promise.resolve([]),
          })).toContain('path must be a directory or a directory symlink');
        }

        const rootLink = join(symlinkRoot, 'rootlink');
        symlinkSync(join(symlinkRoot, 'target'), rootLink, 'dir');
        const rootInput = { path: rootLink, depth: 2, limit: 20 };
        const fastRoot = await registry.execute('DiskUsage', rootInput, {
          cwd: symlinkRoot, yeaftDir: symlinkRoot, managedCliReady: Promise.resolve([]),
        });
        const fallbackRoot = await registry.execute('DiskUsage', rootInput, {
          cwd: symlinkRoot, yeaftDir: join(symlinkRoot, 'fallback'), managedCliReady: Promise.resolve([]),
        });
        const fastRootRow = fastRoot.split('\n').find(line => line.endsWith('  .'));
        const fallbackRootRow = fallbackRoot.split('\n').find(line => line.endsWith('  .'));
        expect(fastRootRow).toBeDefined();
        expect(fallbackRootRow).toBe(fastRootRow);
      }
    }

    for (const name of ['Grep', 'Glob', 'DiskUsage']) {
      const controller = new AbortController();
      controller.abort();
      const input = name === 'Grep'
        ? { pattern: 'needle', path: parityRoot }
        : name === 'Glob' ? { pattern: '**/*', path: parityRoot } : { path: parityRoot };
      await expect(registry.execute(name, input, {
        cwd: parityRoot,
        yeaftDir: join(parityRoot, 'fallback'),
        managedCliReady: Promise.resolve([]),
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    }

    const fallbackAbortDir = tempDir('search-fallback-mid-abort');
    for (let dir = 0; dir < 32; dir += 1) {
      const dirPath = join(fallbackAbortDir, `d${dir}`);
      mkdirSync(dirPath);
      for (let file = 0; file < 16; file += 1) {
        writeFileSync(join(dirPath, `f${file}.txt`), 'needle\n');
      }
    }
    for (const name of ['Grep', 'Glob', 'DiskUsage']) {
      const controller = new AbortController();
      const input = name === 'Grep'
        ? { pattern: 'needle', path: fallbackAbortDir }
        : name === 'Glob' ? { pattern: '**/*.txt', path: fallbackAbortDir } : { path: fallbackAbortDir };
      const pending = registry.execute(name, input, {
        cwd: fallbackAbortDir,
        yeaftDir: join(fallbackAbortDir, 'missing'),
        managedCliReady: Promise.resolve([]),
        signal: controller.signal,
      });
      setImmediate(() => controller.abort('user'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    }

    if (process.platform !== 'win32') {
      const abortDir = tempDir('search-mid-abort');
      const abortBinDir = managedCliBinDir(abortDir);
      mkdirSync(abortBinDir, { recursive: true });
      for (const name of ['rg', 'fd', 'dust']) {
        writeFileSync(join(abortBinDir, name), '#!/bin/sh\ntrap "exit 130" TERM\nwhile :; do :; done\n', { mode: 0o755 });
      }
      trustManagedCliFixtures(abortDir, ['rg', 'fd', 'dust']);
      for (const name of ['Grep', 'Glob', 'DiskUsage']) {
        const controller = new AbortController();
        const input = name === 'Grep'
          ? { pattern: 'needle', path: abortDir }
          : name === 'Glob' ? { pattern: '**/*', path: abortDir } : { path: abortDir };
        const pending = registry.execute(name, input, {
          cwd: abortDir,
          yeaftDir: abortDir,
          managedCliReady: Promise.resolve([]),
          signal: controller.signal,
        });
        setTimeout(() => controller.abort('user'), 20);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      }
    }
    await verifyRipgrepParity();
  }, 120_000);
});
