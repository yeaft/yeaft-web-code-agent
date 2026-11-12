import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { providerProjectionDigest } from '../../../agent/yeaft/llm/provider-state.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import {
  projectDocPathHintsFromToolCall,
  projectDocToolCallNeedsWriteReview,
  selectProjectDocContext,
} from '../../../agent/yeaft/sessions/project-doc.js';

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

let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

describe('Engine', () => {
  describe('simple query (no tools)', () => {
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

        const events = [];
        for await (const event of engine.query({
          prompt: 'one prompt',
          sessionId: 'session-no-duplicates',
        })) events.push(event);
        expect(events.filter(event => event.type === 'turn_end')).toEqual([
          expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'turn_close' });

        expect(conversationStore.loadRecentBySession('session-no-duplicates', 10).map(message => ({
          role: message.role,
          content: message.content,
        }))).toEqual([
          { role: 'user', content: 'one prompt' },
          { role: 'assistant', content: 'one reply' },
        ]);
      } finally {
        await closeConversationHistoryIndexes();
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
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('provider completion semantics', () => {
    it('resumes pause_turn with exact assistant state and durable safe merged metadata, without a synthetic user', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-pause-'));
      try {
        const store = new ConversationStore(yeaftDir);
        const endTrace = vi.spyOn(trace, 'endTurn');
        const nativeState = {
          version: 1, protocol: 'anthropic', responseId: 'response-paused',
          items: [{ type: 'text', text: 'Still working.' }, { type: 'redacted_thinking', data: 'PRIVATE' }],
          projectionDigest: providerProjectionDigest({ content: 'Still working.' }),
        };
        mockAdapter.pushResponse([
          { type: 'provider_metadata', metadata: { protocol: 'anthropic', responseId: 'response-paused', model: 'claude-test',
            inputTransformations: [{ type: 'context_management', removed: 2 }], thinking: 'PRIVATE',
            contentBlocks: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'server_tool_use', id: 'server-1' }] } },
          { type: 'text_delta', text: 'Still working.' },
          { type: 'provider_state', providerState: nativeState },
          { type: 'provider_metadata', metadata: { protocol: 'anthropic', stopReason: 'pause_turn',
            inputTransformations: [{ type: 'context_management', removed: 3 }],
            stopDetails: { type: 'server_tool_paused', reasoning: 'PRIVATE' } } },
          { type: 'stop', stopReason: 'pause_turn' },
        ]);
        mockAdapter.pushResponse([{ type: 'text_delta', text: 'Finished.' }, { type: 'stop', stopReason: 'end_turn' }]);
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore: store, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'finish the work', sessionId: 'pause-session' })) events.push(event);
        expect(mockAdapter.callLog).toHaveLength(2);
        const resumeMessages = mockAdapter.callLog[1].messages;
        expect(resumeMessages.map(row => row.role)).toEqual(['user', 'assistant']);
        expect(resumeMessages[1]).toMatchObject({ content: 'Still working.', providerState: nativeState });
        expect(events.filter(event => event.type === 'turn_end')).toEqual([
          expect.objectContaining({ stopReason: 'pause_turn_continue' }),
          expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
        ]);
        expect(events.some(event => event.type === 'provider_metadata')).toBe(false);
        const rows = new ConversationStore(yeaftDir).loadRecentBySession('pause-session', 20);
        expect(rows.filter(row => row.role === 'user')).toHaveLength(1);
        const paused = rows.find(row => row.stopReason === 'pause_turn');
        expect(paused).toMatchObject({ incomplete: true, responseKind: 'progress', providerState: nativeState,
          providerMetadata: { protocol: 'anthropic', responseId: 'response-paused', model: 'claude-test', stopReason: 'pause_turn',
            stopDetails: { type: 'server_tool_paused' }, contentBlocks: [{ type: 'server_tool_use', id: 'server-1' }],
            inputTransformations: [{ type: 'context_management', removed: 2 }, { type: 'context_management', removed: 3 }] } });
        expect(JSON.stringify(paused.providerMetadata)).not.toContain('PRIVATE');
        expect(endTrace.mock.calls[0][1].providerMetadata).toEqual(paused.providerMetadata);
        expect(events.find(event => event.type === 'loop').providerMetadata).toEqual(paused.providerMetadata);
        expect(rows.at(-1)).toMatchObject({ content: 'Finished.', responseKind: 'result' });
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('bounds repeated pause_turn without tools, invented Continue messages or a false result', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-pause-limit-'));
      try {
        const store = new ConversationStore(yeaftDir);
        for (let index = 0; index < 4; index++) mockAdapter.pushResponse([
          { type: 'text_delta', text: `paused-${index}` },
          { type: 'provider_state', providerState: { version: 1, protocol: 'anthropic',
            items: [{ type: 'text', text: `paused-${index}` }], projectionDigest: providerProjectionDigest({ content: `paused-${index}` }) } },
          { type: 'stop', stopReason: 'pause_turn' },
        ]);
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore: store, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'continue work', sessionId: 'pause-limit-session' })) events.push(event);
        expect(mockAdapter.callLog).toHaveLength(4);
        expect(mockAdapter.callLog.every(call => call.messages.filter(row => row.role === 'user').length === 1)).toBe(true);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'pause_turn', terminal: true }),
        ]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'provider_pause_limit', retryable: false }));
        expect(store.loadRecentBySession('pause-limit-session', 20).filter(row => row.responseKind === 'result')).toEqual([]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it.each(['disabled-native-state', 'unsupported-native-block'])('never reissues a paused server operation when state is %s', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-paused-unreplayable-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ id: 'paused', model: 'claude-opus-5.5', stop_reason: 'pause_turn',
            content: [{ type: 'server_tool_use', id: 'server-op', name: 'web_search', input: { query: 'question' } },
              mode === 'disabled-native-state' ? { type: 'web_search_tool_result', tool_use_id: 'server-op', content: [] }
                : { type: 'future_tool_result', tool_use_id: 'server-op', content: [] }], usage: { input_tokens: 10, output_tokens: 2 } }),
          { headers: { 'content-type': 'application/json' } });
        });
        const adapter = new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic', baseUrl: 'https://gateway.invalid',
          apiKey: 'fixture', models: ['claude-opus-5.5'], ...(mode === 'disabled-native-state' ? { capabilities: { nativeReasoningState: false } } : {}) }] });
        const engine = new Engine({ adapter, trace, yeaftDir: dir, conversationStore: new ConversationStore(dir),
          config: { model: 'gateway/claude-opus-5.5', maxOutputTokens: 1024 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'perform authorized operation', sessionId: 'pause-unreplayable' })) events.push(event);
        expect(requests).toHaveLength(1);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'provider_pause_not_replayable', retryable: false }));
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'pause_turn', terminal: true }),
        ]);
      } finally { globalThis.fetch = originalFetch; await closeConversationHistoryIndexes(); rmSync(dir, { recursive: true, force: true }); }
    });

    it.each(['refusal', 'model_context_window_exceeded', 'unknown', 'future_provider_reason'])('fails visibly for %s before running tools or marking results', async stopReason => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-provider-terminal-'));
      try {
        const store = new ConversationStore(yeaftDir);
        const execute = vi.fn(async () => 'must not run');
        const finishRequest = vi.fn();
        const failRequest = vi.fn();
        mockAdapter.pushResponse([
          { type: 'provider_metadata', metadata: { protocol: 'anthropic', inputTransformations: [{ type: 'trim', removed: 1 }] } },
          { type: 'text_delta', text: 'Incomplete response.' },
          { type: 'tool_call', id: 'unsafe-call', name: 'side_effect', input: {} },
          { type: 'stop', stopReason, stopDetails: { type: 'provider_limit' } },
        ]);
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore: store, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        engine.registerTool({ name: 'side_effect', description: 'side effect', parameters: {}, execute });
        const events = [];
        for await (const event of engine.query({ prompt: 'do the work', sessionId: 'terminal-session',
          prepareProviderRequest: () => ({ id: 'request' }), finishProviderRequest: finishRequest, failProviderRequest: failRequest })) events.push(event);
        const expectedReason = stopReason === 'future_provider_reason' ? 'unknown' : stopReason;
        expect(execute).not.toHaveBeenCalled();
        expect(finishRequest).not.toHaveBeenCalled();
        expect(failRequest).toHaveBeenCalledWith({ id: 'request' }, expect.objectContaining({ code: expectedReason }));
        expect(mockAdapter.callLog).toHaveLength(1);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: expectedReason, terminal: true }),
        ]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: expectedReason, retryable: false }));
        const rows = store.loadRecentBySession('terminal-session', 20);
        expect(rows.filter(row => row.role === 'user')).toHaveLength(1);
        expect(rows.at(-1)).toMatchObject({ role: 'assistant', responseKind: 'progress', incomplete: true, stopReason: expectedReason,
          providerMetadata: { stopReason, stopDetails: { type: 'provider_limit' }, inputTransformations: [{ type: 'trim', removed: 1 }] } });
        expect(rows.flatMap(row => row.toolCalls || [])).toEqual([]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('treats stop_sequence as completed with the exact stop sequence preserved', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-stop-sequence-'));
      try {
        const store = new ConversationStore(yeaftDir);
        mockAdapter.pushResponse([
          { type: 'text_delta', text: 'Answer before the delimiter.' },
          { type: 'stop', stopReason: 'stop_sequence', stopSequence: '<END>', stopDetails: { type: 'matched' } },
        ]);
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore: store, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'answer until the delimiter', sessionId: 'sequence-session' })) events.push(event);
        expect(mockAdapter.callLog).toHaveLength(1);
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
        expect(events.filter(event => event.type === 'turn_end')).toEqual([
          expect.objectContaining({ stopReason: 'stop_sequence', terminal: true }),
        ]);
        expect(store.loadRecentBySession('sequence-session', 20).at(-1)).toMatchObject({ responseKind: 'result', stopReason: 'stop_sequence',
          providerMetadata: { stopSequence: '<END>', stopDetails: { type: 'matched' } } });
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('does not silently succeed without a provider stop and retains transformations on partial failure', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-metadata-failure-'));
      try {
        const store = new ConversationStore(yeaftDir);
        const endTrace = vi.spyOn(trace, 'endTurn');
        mockAdapter.pushResponse([
          { type: 'provider_metadata', metadata: { protocol: 'anthropic', responseId: 'partial-response', inputTransformations: [{ type: 'trim' }] } },
          { type: 'text_delta', text: 'Partial response' },
          { type: 'error', error: new Error('stream failed'), retryable: false },
        ]);
        mockAdapter.pushResponse([{ type: 'text_delta', text: 'No stop event' }]);
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore: store, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        for await (const _event of engine.query({ prompt: 'first attempt', sessionId: 'metadata-failure-session' })) { /* consume */ }
        const partial = store.loadRecentBySession('metadata-failure-session', 20).find(row => row.role === 'assistant');
        expect(partial).toMatchObject({ incomplete: true, responseKind: 'progress', providerMetadata: {
          protocol: 'anthropic', responseId: 'partial-response', inputTransformations: [{ type: 'trim' }],
        } });
        expect(endTrace.mock.calls[0][1].providerMetadata).toEqual(partial.providerMetadata);
        const events = [];
        for await (const event of engine.query({ prompt: 'second attempt', sessionId: 'missing-stop-session' })) events.push(event);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'unknown' }));
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'unknown', terminal: true }),
        ]);
      } finally {
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });
  });

  describe('active signed Anthropic prefixes', () => {
    const response = (id, tool, input = {}, model = 'claude-opus-4.8', usage) => {
      const blocks = [{ type: 'thinking', thinking: `private-${id}`, signature: `signature-${id}` },
        tool ? { type: 'tool_use', id, name: tool, input } : { type: 'text', text: 'Finished safely.' }];
      const events = [{ type: 'message_start', message: { id, model, role: 'assistant', content: [], ...(usage ? { usage } : {}) } },
        ...blocks.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }]),
        { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const router = model => new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic',
      baseUrl: 'https://anthropic-gateway.invalid', apiKey: 'fixture-key', models: [model] }] });

    it('keeps real gateway prefixes byte-stable through discovery, instruction reloads, archiving and permission removal', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-prefix-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      const registry = new ToolRegistry();
      const history = [{ role: 'user', content: 'original historical instruction' }, { role: 'assistant', content: 'historical answer' }];
      const originalResult = 'UNCHANGED_TOOL_RESULT '.repeat(1000);
      let skillText = 'FIRST_SKILL_INSTRUCTION';
      const skillManager = { findRelevant: () => [{ name: 'live-skill' }], list: () => [{ name: 'live-skill' }],
        getPromptContent: () => skillText };
      const read = vi.fn(async () => {
        history[0].content = 'MUTATED_HISTORY_MUST_NOT_REACH_WIRE';
        skillText = 'SECOND_SKILL_INSTRUCTION';
        writeFileSync(join(dir, 'CLAUDE.md'), 'SECOND_PROJECT_INSTRUCTION');
        const future = new Date(Date.now() + 2000);
        utimesSync(join(dir, 'CLAUDE.md'), future, future);
        return originalResult;
      });
      const config = { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, language: 'en',
        archive: { turnAgeMin: -1, lengthMin: 10 } };
      let engine;
      registry.register(defineTool({ name: 'FileRead', description: 'Read evidence', parameters: { type: 'object' }, readOnly: true, execute: read }));
      registry.register(defineTool({ name: 'DiscoverTools', description: 'Discover available tools', parameters: { type: 'object' },
        execute: async (_, ctx) => JSON.stringify(ctx.discoverTools({ query: 'disk', maxResults: 1 })) }));
      registry.register(defineTool({ name: 'DiskUsage', description: 'Inspect disk use', parameters: { type: 'object' }, readOnly: true,
        execute: async () => {
          engine.refreshConfig({ ...config, plugins: { tools: ['DiscoverTools', 'DiskUsage'], skills: ['live-skill'], mcpServers: [] } });
          return 'Disk evidence obtained; FileRead permission withdrawn.';
        } }));
      try {
        writeFileSync(join(dir, 'CLAUDE.md'), 'FIRST_PROJECT_INSTRUCTION');
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push({ body: JSON.parse(init.body), headers: init.headers });
          const index = requests.length - 1;
          return response(`signed-${index}`, ['FileRead', 'DiscoverTools', 'DiskUsage', 'FileRead'][index]);
        });
        engine = new Engine({ adapter: router('claude-opus-4.8'), trace, config, toolRegistry: registry,
          skillManager, yeaftDir: dir, conversationStore: new ConversationStore(dir) });
        const events = [];
        for await (const event of engine.query({ prompt: 'complete the requested operation', sessionId: 'signed-session', workDir: dir, messages: history })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(requests).toHaveLength(5);
        expect(read).toHaveBeenCalledTimes(1);
        const first = requests[0].body;
        expect(first.tools.map(tool => tool.name)).not.toContain('DiskUsage');
        for (const { body } of requests.slice(1)) {
          expect(body.system).toBe(first.system);
          expect(body.tools).toEqual(first.tools);
          expect(body.messages.slice(0, first.messages.length)).toEqual(first.messages);
          expect(JSON.stringify(body)).not.toContain('MUTATED_HISTORY_MUST_NOT_REACH_WIRE');
          expect(JSON.stringify(body)).not.toContain('[archived:');
          expect(body.messages.find(message => message.content?.[0]?.type === 'tool_result').content[0].content).toBe(originalResult);
        }
        expect(first.system).toContain('FIRST_SKILL_INSTRUCTION');
        expect(first.system).toContain('FIRST_PROJECT_INSTRUCTION');
        const updatedInstruction = requests[1].body.messages.find(message => message.role === 'system');
        expect(updatedInstruction.content[0].text).toContain('SECOND_SKILL_INSTRUCTION');
        expect(updatedInstruction.content[0].text).toContain('SECOND_PROJECT_INSTRUCTION');
        const additions = requests[2].body.messages.filter(message => message.role === 'system').flatMap(message => message.content);
        expect(additions).toContainEqual({ type: 'tool_addition', tool: { type: 'tool_definition', definition: {
          name: 'DiskUsage', description: 'Inspect disk use', input_schema: { type: 'object' },
        } } });
        const removals = requests[3].body.messages.filter(message => message.role === 'system').flatMap(message => message.content);
        expect(removals).toContainEqual({ type: 'tool_removal', tool: { type: 'tool_reference', name: 'FileRead' } });
        expect(requests[2].headers['anthropic-beta']).toContain('inline-tools-2026-09-15');
        expect(events).toContainEqual(expect.objectContaining({ type: 'tool_end', id: 'signed-3', name: 'FileRead', isError: true }));
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(['claude-sonnet-4', 'claude-opus-4.6'])('keeps legacy %s tool updates top-level despite signed thinking', async model => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-legacy-prefix-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      const registry = new ToolRegistry();
      let skillText = 'FIRST_LEGACY_INSTRUCTION';
      const skillManager = { findRelevant: () => [{ name: 'live-skill' }], list: () => [{ name: 'live-skill' }],
        getPromptContent: () => skillText };
      registry.register(defineTool({ name: 'DiscoverTools', description: 'Discover tools', parameters: { type: 'object' },
        execute: async (_, ctx) => {
          skillText = 'UPDATED_LEGACY_INSTRUCTION';
          return JSON.stringify(ctx.discoverTools({ query: 'disk', maxResults: 1 }));
        } }));
      const execute = vi.fn(async () => 'disk evidence');
      registry.register(defineTool({ name: 'DiskUsage', description: 'Inspect disk use', parameters: { type: 'object' }, readOnly: true, execute }));
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push({ body: JSON.parse(init.body), headers: init.headers });
          return response(`legacy-${requests.length}`, ['DiscoverTools', 'DiskUsage'][requests.length - 1], {}, model);
        });
        const store = new ConversationStore(dir);
        const engine = new Engine({ adapter: router(model), trace, toolRegistry: registry, skillManager,
          yeaftDir: dir, conversationStore: store,
          config: { model: `gateway/${model}`, maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'perform the requested operation', sessionId: 'legacy-session' })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(requests).toHaveLength(3);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(requests[0].body.tools.map(tool => tool.name)).not.toContain('DiskUsage');
        expect(requests[1].body.tools.map(tool => tool.name)).toContain('DiskUsage');
        expect(requests[1].body.system).toContain('UPDATED_LEGACY_INSTRUCTION');
        expect(requests.every(({ body, headers }) => !body.messages.some(row => row.role === 'system')
          && !headers['anthropic-beta']?.includes('inline-tools-2026-09-15'))).toBe(true);
        const state = store.loadAllBySession('legacy-session').find(row => row.role === 'assistant').providerState;
        expect(state.items).toContainEqual(expect.objectContaining({ type: 'thinking', signature: 'signature-legacy-1' }));
        expect(state.requestPrefix).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('appends background schemas and late completion evidence without rewriting a signed tool result', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-background-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      const registry = new ToolRegistry();
      let tasks = [];
      let engine;
      registry.register(defineTool({ name: 'Bash', description: 'Start work', parameters: { type: 'object' },
        execute: async (_, ctx) => {
          tasks = [{ id: 'bg-task', kind: 'bash', status: 'running' }];
          ctx.registerAsyncTask('bg-task');
          return 'original pending result';
        } }));
      registry.register(defineTool({ name: 'WaitTask', description: 'Wait for work', parameters: { type: 'object' },
        execute: async () => {
          tasks = [];
          expect(engine.notifyAsyncTaskCompleted('bg-task', 'LATE_COMPLETION_EVIDENCE')).toBe(true);
          return 'completion delivered';
        } }));
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push({ body: JSON.parse(init.body), headers: init.headers });
          return response(`background-${requests.length}`, ['Bash', 'WaitTask'][requests.length - 1]);
        });
        const store = new ConversationStore(dir);
        engine = new Engine({ adapter: router('claude-opus-4.8'), trace, toolRegistry: registry, yeaftDir: dir,
          conversationStore: store, taskManager: { listActiveTasks: () => tasks },
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'perform the requested operation', sessionId: 'signed-background' })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(requests).toHaveLength(3);
        expect(requests[0].body.tools.map(tool => tool.name)).toEqual(['Bash']);
        expect(requests[1].body.tools).toEqual(requests[0].body.tools);
        expect(requests[1].body.messages.flatMap(message => message.role === 'system' ? message.content : [])).toContainEqual({
          type: 'tool_addition', tool: { type: 'tool_definition', definition: {
            name: 'WaitTask', description: 'Wait for work', input_schema: { type: 'object' },
          } },
        });
        expect(requests[2].body.messages.slice(0, requests[1].body.messages.length)).toEqual(requests[1].body.messages);
        expect(requests[2].body.messages.find(message => message.content?.[0]?.type === 'tool_result').content[0].content)
          .toBe('original pending result');
        expect(requests[2].body.messages).toContainEqual({ role: 'user',
          content: '[system note] Async task completion:\nLATE_COMPLETION_EVIDENCE' });
        expect(requests[2].body.messages.flatMap(message => message.role === 'system' ? message.content : [])).toContainEqual({
          type: 'tool_removal', tool: { type: 'tool_reference', name: 'WaitTask' },
        });
        expect(store.loadAllBySession('signed-background').find(row => row.role === 'tool' && row.toolCallId === 'background-1').content)
          .toContain('LATE_COMPLETION_EVIDENCE');
      } finally {
        globalThis.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(['estimated', 'cached-usage', 'included-cache', 'repeated', 'exhausted', 'manual', 'extra-body', 'manual-room', 'manual-edge', 'extra-body-room'])('budgets signed output without editing the prefix: %s', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-reserve-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      const loops = [];
      const hasRoom = mode.endsWith('-room');
      const manual = mode.startsWith('manual');
      const result = 'SIGNED_TOOL_EVIDENCE '.repeat(1000);
      const config = { model: 'gateway/claude-opus-4.8', maxOutputTokens: hasRoom || mode === 'manual-edge' ? 16384 : 20000, projectDocMaxBytes: 0,
        modelInfo: { contextWindow: hasRoom ? 200000 : mode === 'manual-edge' ? 47500 : 40000, maxOutput: 64000 } };
      let engine;
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          const index = requests.length;
          const usage = mode === 'estimated' ? undefined : mode === 'included-cache'
            ? { input_tokens: 30000, cache_read_input_tokens: 20000, output_tokens: 100 }
            : { input_tokens: 5000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000, output_tokens: 100 };
          return response(`reserve-${index}`, index === 1 || (mode === 'repeated' && index === 2) ? 'echo' : undefined,
            {}, 'claude-opus-4.8', usage);
        });
        const store = new ConversationStore(dir);
        const adapter = new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic',
          baseUrl: 'https://gateway.example/v1', apiKey: 'synthetic', models: [{ id: 'claude-opus-4.8',
            ...(manual ? { thinkingProtocol: 'anthropic' } : {}),
          }] }] });
        if (['included-cache', 'extra-body', 'extra-body-room'].includes(mode)) {
          const capture = adapter.captureRequest.bind(adapter);
          adapter.captureRequest = () => {
            const snapshot = capture();
            return { captureStream: async function* (params) {
              const request = mode.startsWith('extra-body') ? { ...params, extraBody: { max_tokens: 20000 } } : params;
              for await (const event of snapshot.captureStream(request)) yield event.type === 'usage' && mode === 'included-cache'
                ? { ...event, cacheTokensAreIncludedInInput: true } : event;
            } };
          };
        }
        engine = new Engine({ adapter, trace, config, yeaftDir: dir, conversationStore: store });
        engine.registerTool({ name: 'echo', description: 'Read evidence', parameters: { type: 'object' }, execute: async () => {
          if (mode === 'estimated') engine.refreshConfig({ ...config, modelInfo: { ...config.modelInfo, contextWindow: 22000 } });
          if (mode === 'exhausted') engine.refreshConfig({ ...config, modelInfo: { ...config.modelInfo, contextWindow: 30500 } });
          return mode === 'estimated' ? result : 'short evidence';
        } });
        const events = [];
        for await (const event of engine.query({ prompt: 'obtain evidence', sessionId: 'signed-reserve', userEffort: 'xhigh' })) {
          events.push(event);
          if (event.type === 'loop') loops.push(event);
        }
        expect(requests[0].max_tokens).toBe(manual ? Math.max(config.maxOutputTokens, 17408)
          : mode.startsWith('extra-body') ? 20000 : config.maxOutputTokens);
        const failed = ['exhausted', 'manual', 'manual-edge', 'extra-body'].includes(mode);
        if (failed) {
          expect(requests).toHaveLength(1);
          if (manual) expect(requests[0].thinking).toMatchObject({ type: 'enabled', budget_tokens: 16384 });
          expect(events.find(event => event.type === 'error').error.code).toBe('PROVIDER_STATE_INVALID');
        } else {
          expect(events.filter(event => event.type === 'error')).toEqual([]);
          expect(requests).toHaveLength(mode === 'repeated' ? 3 : 2);
          for (let index = 1; index < requests.length; index += 1) {
            const body = requests[index];
            expect(body.system).toBe(requests[0].system);
            expect(body.tools).toEqual(requests[0].tools);
            expect(body.messages.slice(0, requests[index - 1].messages.length)).toEqual(requests[index - 1].messages);
            expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
            if (hasRoom) {
              expect(body.max_tokens).toBe(manual ? 17408 : 20000);
              expect(body.thinking).toEqual(requests[0].thinking);
              continue;
            }
            expect(body.max_tokens).toBeLessThan(20000);
            const limit = mode === 'estimated' ? 22000 - loops[index].requestInputBreakdown.totalEstimatedTokens : 10000;
            expect(body.max_tokens).toBeLessThanOrEqual(limit);
          }
          if (mode === 'estimated') {
            expect(requests[1].messages.at(-1).content[0].content).toBe(result);
            expect(store.loadAllBySession('signed-reserve').find(row => row.role === 'tool').content).toBe(result);
          }
        }
        expect(events.filter(event => event.type === 'llm_retry')).toEqual([]);
        expect(events.filter(event => event.type === 'tool_end')).toHaveLength(mode === 'repeated' ? 2 : 1);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: failed ? 'error' : 'end_turn', terminal: true }),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(['preflight', 'provider'])('fails visibly rather than compacting active signed context on %s overflow', async overflow => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-overflow-'));
      const originalFetch = globalThis.fetch;
      const requests = [];
      const config = { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 };
      let engine;
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          if (requests.length > 1) return new Response('prompt is too long', { status: 400 });
          return response('overflow-tool', 'echo');
        });
        engine = new Engine({ adapter: router('claude-opus-4.8'), trace, config, yeaftDir: dir });
        engine.registerTool({ name: 'echo', description: 'echo', parameters: { type: 'object' }, execute: async () => {
          if (overflow === 'preflight') engine.refreshConfig({ ...config, modelInfo: { contextWindow: 2048 } });
          return 'new tool evidence '.repeat(2000);
        } });
        const events = [];
        for await (const event of engine.query({ prompt: 'obtain evidence', sessionId: 'signed-overflow' })) events.push(event);
        expect(requests).toHaveLength(overflow === 'preflight' ? 1 : 2);
        expect(events.filter(event => event.type === 'llm_retry')).toEqual([]);
        expect(events.find(event => event.type === 'error')).toMatchObject({ retryable: false, error: overflow === 'preflight' ? {
          code: 'PROVIDER_STATE_INVALID', message: expect.stringContaining('signed context cannot fit'),
        } : { name: 'LLMContextError' } });
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'error', terminal: true }),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('tool execution loop', () => {
    it('ends a tool handoff with one terminal event and no additional provider request', async () => {
      mockAdapter.pushResponse([
        { type: 'tool_call', id: 'handoff-call', name: 'handoff', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
      const engine = new Engine({
        adapter: mockAdapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
      });
      engine.registerTool({
        name: 'handoff', description: 'Yield control', parameters: {},
        execute: async (_input, ctx) => {
          ctx.requestEndTurn({ kind: 'test_handoff' });
          return 'Control transferred';
        },
      });
      const events = [];
      for await (const event of engine.query({ prompt: 'hand off this work' })) events.push(event);
      expect(mockAdapter.callLog).toHaveLength(1);
      expect(events.filter(event => event.type === 'tool_end')).toHaveLength(1);
      expect(events.filter(event => event.type === 'turn_end')).toEqual([
        expect.objectContaining({ terminal: true, stopReason: 'tool_handoff', detail: { kind: 'test_handoff' } }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'turn_close' });
    });

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

      // Check we got 2 loops under one stable parent-turn identity.
      const turnStarts = events.filter(e => e.type === 'turn_start');
      expect(turnStarts).toHaveLength(2);
      expect(turnStarts.map(event => event.turnNumber)).toEqual([1, 2]);
      expect(turnStarts[0].turnId).toEqual(expect.any(String));
      expect(turnStarts[0].turnId).not.toBe('');
      expect(turnStarts[1].turnId).toBe(turnStarts[0].turnId);
      expect(events.find(event => event.type === 'turn_close')?.turnId).toBe(turnStarts[0].turnId);

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
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
      ]);
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
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
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
  });

  describe('project document write review', () => {
    const call = (id, name, input = {}) => ({ type: 'tool_call', id, name, input });
    const toolStop = { type: 'stop', stopReason: 'tool_use' };
    const done = { type: 'stop', stopReason: 'end_turn' };
    const document = (coreHeading = 'Core') => `# Fixture
## ${coreHeading}
${'Stable instruction.\n'.repeat(520)}
## Agent
AGENT_BODY
## Web
WEB_BODY
## Work Center
WORK_CENTER_BODY
## Release
RELEASE_BODY`;

    async function runWithDoc(source, responses, tools, onRequest = () => {}) {
      const workDir = mkdtempSync(join(tmpdir(), 'yeaft-project-doc-gate-'));
      try {
        if (source != null) writeFileSync(join(workDir, 'CLAUDE.md'), source);
        const requests = [];
        const adapter = { async *stream(params) {
          requests.push(structuredClone({ system: params.system, messages: params.messages }));
          onRequest(requests.length, workDir);
          yield* responses[requests.length - 1];
        } };
        const engine = new Engine({ adapter, trace, config: { model: 'test-model', maxOutputTokens: 1024 } });
        for (const tool of tools) engine.registerTool(tool);
        const events = [];
        for await (const event of engine.query({ prompt: 'inspect repository', workDir })) events.push(event);
        return { events, requests };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }

    it('selects only concrete input paths and classifies workspace writes separately from lifecycle effects', () => {
      for (const name of ['EnterWorktree', 'ExitWorktree', 'CloseAgent', 'SpawnAgent', 'Agent', 'PromptAgent',
        'SendMessage', 'UpdateAgent', 'WaitAgent', 'AskUser', 'PresentResponse', 'CreateWorkItem', 'JsReplReset']) {
        expect(projectDocPathHintsFromToolCall(name, { path: 'web/component.js', cwd: 'agent' }), name).toEqual([]);
        expect(projectDocToolCallNeedsWriteReview(name, {}), name).toBe(false);
      }
      for (const command of ['pwd', 'pwd -P', 'git status', 'git status --short']) {
        expect(projectDocPathHintsFromToolCall('Bash', { command }), command).toEqual([]);
        expect(projectDocToolCallNeedsWriteReview('Bash', { command }), command).toBe(false);
      }
      expect(projectDocPathHintsFromToolCall('Bash', { command: 'echo web > server/output.js', cwd: 'agent' }))
        .toEqual(['agent']);
      expect(projectDocPathHintsFromToolCall('FileEdit', { file_path: 'web/view.js', new_string: 'agent/secret.js' }))
        .toEqual(['web/view.js']);
      expect(projectDocPathHintsFromToolCall('ApplyPatch', { patch: '--- a/web/deleted.js\n+++ /dev/null\n--- /dev/null\n+++ b/agent/added.js' }))
        .toEqual(['web/deleted.js', 'agent/added.js']);
      for (const command of ['pwd; touch x', 'git status --short > file', 'git status $(touch x)', 'node -e "write()"',
        'git status --short && rm file', 'pwd\necho x > file', 'git\nstatus']) {
        expect(projectDocToolCallNeedsWriteReview('Bash', { command }), command).toBe(true);
      }
      for (const name of ['FileEdit', 'FileWrite', 'ApplyPatch', 'JsRepl', 'mcp__custom__write']) {
        expect(projectDocToolCallNeedsWriteReview(name, {}), name).toBe(true);
      }
      expect(projectDocToolCallNeedsWriteReview('NotebookEdit', { action: 'read' })).toBe(false);
      expect(projectDocToolCallNeedsWriteReview('NotebookEdit', { action: 'delete' })).toBe(true);
      expect(projectDocToolCallNeedsWriteReview('ImageGeneration', { output_path: 'web/image.png' })).toBe(true);
    });

    it('executes pathless lifecycle calls and exact shell reads on their first request without loading unrelated scopes', async () => {
      const calls = [call('enter', 'EnterWorktree'), call('close', 'CloseAgent'),
        call('pwd', 'Bash', { command: 'pwd' }), call('status', 'Bash', { command: 'git status --short' })];
      const executed = [];
      const { events, requests } = await runWithDoc(document(), [[...calls, toolStop], [done]],
        ['EnterWorktree', 'CloseAgent', 'Bash'].map(name => ({ name, execute: async input => {
          executed.push([name, input]); return 'ok';
        } })));
      expect(executed).toHaveLength(4);
      expect(events.filter(event => event.type === 'tool_end')).toHaveLength(4);
      expect(events.filter(event => event.type === 'tool_end').every(event => !event.isError && !event.skipped)).toBe(true);
      expect(requests[0].system).toBe(requests[1].system);
      expect(String(requests[0].system)).not.toContain('WORK_CENTER_BODY');
    });

    it('does not manufacture a first-write rule change when matching core rules were already shown', async () => {
      let executions = 0;
      const source = document('Core Agent').replace('## Agent\nAGENT_BODY\n', '');
      expect(selectProjectDocContext(source).scoped).toBe(true);
      const { events, requests } = await runWithDoc(source,
        [[call('edit', 'FileEdit', { file_path: 'agent/file.js' }), toolStop], [done]],
        [{ name: 'FileEdit', execute: async () => { executions++; return 'ok'; } }]);
      expect(executions).toBe(1);
      expect(events.find(event => event.type === 'tool_end')).toMatchObject({ id: 'edit', isError: false });
      expect(requests[0].system).toBe(requests[1].system);
    });

    it('blocks real edits, deletion patches and opaque shell writes until newly loaded rules reach a fresh model request', async () => {
      for (const [name, input, body] of [
        ['FileEdit', { file_path: 'agent/file.js' }, 'AGENT_BODY'],
        ['FileWrite', { file_path: 'web/file.js' }, 'WEB_BODY'],
        ['ApplyPatch', { patch: '--- a/web/deleted.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' }, 'WEB_BODY'],
        ['Bash', { command: 'echo changed > web/file.js', cwd: 'agent' }, 'WEB_BODY'],
        ['Bash', { command: 'git status --short; echo changed > file' }, 'WORK_CENTER_BODY'],
      ]) {
        let executions = 0;
        const { events, requests } = await runWithDoc(document(), [
          [call('first', name, input), call('same-batch', name, input), toolStop],
          [call('retry', name, input), toolStop], [done],
        ], [{ name, execute: async () => { executions++; return 'ok'; } }]);
        expect(executions, name).toBe(1);
        expect(events.filter(event => event.type === 'tool_end').map(event => [event.id, event.isError, event.skipped]), name)
          .toEqual([['first', true, true], ['same-batch', true, true], ['retry', false, undefined]]);
        expect(String(requests[0].system), name).not.toContain(body);
        expect(String(requests[1].system), name).toContain(body);
        const notice = events.find(event => event.type === 'tool_end').output;
        expect(notice, name).not.toContain(input.command || 'impossible command marker');
        if (name === 'Bash' && !input.cwd) expect(notice).toContain('the Bash write');
      }
    });

    it('keeps same-response reads from retroactively authorizing writes but preloads rules for the next response', async () => {
      const executed = [];
      const { events, requests } = await runWithDoc(document(), [
        [call('read', 'FileRead', { file_path: 'web/file.js' }), call('edit', 'FileEdit', { file_path: 'web/file.js' }), toolStop],
        [call('retry', 'FileEdit', { file_path: 'web/file.js' }), toolStop], [done],
      ], [
        { name: 'FileRead', isReadOnly: () => true, execute: async () => { executed.push('read'); return 'ok'; } },
        { name: 'FileEdit', execute: async () => { executed.push('edit'); return 'ok'; } },
      ]);
      expect(executed).toEqual(['read', 'edit']);
      expect(events.find(event => event.type === 'tool_end' && event.id === 'edit')).toMatchObject({ isError: true, skipped: true });
      expect(String(requests[1].system)).toContain('WEB_BODY');

      let writes = 0;
      const preloaded = await runWithDoc(document(), [
        [call('read', 'FileRead', { file_path: 'web/file.js' }), toolStop],
        [call('edit', 'FileEdit', { file_path: 'web/file.js' }), toolStop], [done],
      ], [
        { name: 'FileRead', isReadOnly: () => true, execute: async () => 'ok' },
        { name: 'FileEdit', execute: async () => { writes++; return 'ok'; } },
      ]);
      expect(writes).toBe(1);
      expect(preloaded.events.filter(event => event.type === 'tool_end').every(event => !event.isError)).toBe(true);
    });

    it('still requires review when the document changes or first appears after the generating request', async () => {
      for (const source of [null, '# Initial rules\nOriginal policy']) {
        let executions = 0;
        const { events, requests } = await runWithDoc(source, [
          [call('first', 'FileEdit', { file_path: 'file.js' }), toolStop],
          [call('retry', 'FileEdit', { file_path: 'file.js' }), toolStop], [done],
        ], [{ name: 'FileEdit', execute: async () => { executions++; return 'ok'; } }], (n, workDir) => {
          if (n !== 1) return;
          const path = join(workDir, 'CLAUDE.md');
          writeFileSync(path, '# Changed rules\nNEW_POLICY');
          utimesSync(path, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
        });
        expect(executions).toBe(1);
        expect(events.find(event => event.type === 'tool_end')).toMatchObject({ id: 'first', skipped: true, isError: true });
        expect(String(requests[0].system)).not.toContain('NEW_POLICY');
        expect(String(requests[1].system)).toContain('NEW_POLICY');
      }
    });
  });

  describe('multiple tool calls in one turn', () => {
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
  });

  describe('adapter errors', () => {
    it('shrinks and retries provider context overflow without a compact LLM call', async () => {
      const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
      let streamCalls = 0;
      let summaryCalls = 0;
      const adapter = {
        async *stream() {
          streamCalls += 1;
          if (streamCalls === 1) throw new LLMContextError('context window exceeded');
          yield { type: 'text_delta', text: 'recovered' };
          yield { type: 'stop', stopReason: 'end_turn' };
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

      expect(streamCalls).toBe(2);
      expect(summaryCalls).toBe(0);
      expect(events.some(event => event.type === 'consolidate')).toBe(false);
      expect(events.filter(event => event.type === 'error')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'llm_retry', reason: 'context_overflow_recovery',
      }));
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
    });

    it('continues after partial output on context overflow without redisplaying it', async () => {
      const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
      const requests = [];
      const adapter = {
        async *stream(params) {
          requests.push(params);
          if (requests.length === 1) {
            yield { type: 'text_delta', text: 'partial answer' };
            throw new LLMContextError('context window exceeded after output');
          }
          yield { type: 'text_delta', text: ' resumed answer' };
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };
      const engine = new Engine({
        adapter,
        trace,
        config: { model: 'test-model', maxOutputTokens: 1024 },
        conversationStore: { append() { return null; } },
      });

      const events = [];
      for await (const event of engine.query({ prompt: 'hello' })) events.push(event);

      expect(requests).toHaveLength(2);
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text))
        .toEqual(['partial answer', ' resumed answer']);
      expect(requests[1].messages.filter(message =>
        message.role === 'assistant' && message.content === 'partial answer')).toHaveLength(1);
      expect(requests[1].messages.at(-1).role).toBe('user');
      expect(requests[1].messages.at(-1).content).not.toBe('hello');
      expect(events.filter(event => event.type === 'error')).toHaveLength(0);
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

    it('never executes, persists or retries rejected Anthropic tool batches and executes a complete batch in order', async () => {
      const { AnthropicAdapter } = await import('../../../agent/yeaft/llm/anthropic.js');
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-anthropic-tool-boundary-'));
      const originalFetch = global.fetch;
      const conversationStore = new ConversationStore(yeaftDir);
      const execute = vi.fn(async input => JSON.stringify(input));
      const registry = new ToolRegistry();
      registry.register(defineTool({ name: 'echo', description: 'echo', parameters: { type: 'object' }, execute }));
      const start = index => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: 'echo', input: {} } });
      const delta = (index, partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
      const blockStop = index => ({ type: 'content_block_stop', index });
      const messageStop = { type: 'message_stop' };
      const stop = stop_reason => ({ type: 'message_delta', delta: { stop_reason } });
      const firstTool = [start(0), delta(0, '{"value":1}'), blockStop(0)];
      const complete = [...firstTool, start(1), delta(1, '{"value":2}'), blockStop(1), stop('tool_use'), messageStop];
      const partial = [...firstTool, start(1), delta(1, '{"value":')];
      // Mix both legal SSE field forms, including no-space input/stop deltas.
      const encode = events => new TextEncoder().encode(events.map(e => `data:${e.type === 'content_block_delta' || e.type === 'message_delta' ? '' : ' '}${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
      const sse = events => new Response(encode(events));
      try {
        for (const [name, events] of [
          ['invalid-json', [...partial, blockStop(1), stop('tool_use'), messageStop]],
          ['open-sibling', [...partial, stop('tool_use'), messageStop]],
          ['done', [...partial, '[DONE]']],
          ['eof', partial],
          ['max-tokens', [...firstTool, stop('max_tokens'), messageStop]],
          ['idle', partial],
          ['abort', partial],
          ['complete', complete],
          ['no-retry', [...partial, blockStop(1), stop('tool_use'), messageStop]],
        ]) {
          execute.mockClear();
          const sessionId = `session-stream-${name}`;
          const ctrl = new AbortController();
          let requests = 0;
          const cancel = vi.fn();
          global.fetch = vi.fn(async () => {
            requests += 1;
            if (name === 'complete' && requests > 1) return sse([stop('end_turn'), messageStop]);
            if (name === 'no-retry' && requests > 1) return sse(complete);
            if (name === 'idle' || name === 'abort') return new Response(new ReadableStream({ start(controller) {
              controller.enqueue(encode(events));
            }, cancel }));
            return sse(events);
          });
          const policies = [];
          const engine = new Engine({ adapter: new AnthropicAdapter({ apiKey: 'synthetic', baseUrl: 'https://proxy.invalid', streamIdleTimeoutMs: 10 }), trace,
            toolRegistry: registry, conversationStore, yeaftDir,
            config: { model: 'claude-opus-4.8', modelEffort: 'high', projectDocMaxBytes: 0, maxOutputTokens: 1024,
              llmRetry: { maxRetries: name === 'no-retry' ? 1 : 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } } });
          const output = [];
          for await (const event of engine.query({ prompt: 'echo values', sessionId, signal: ctrl.signal, onProviderRequestStart: policy => policies.push(policy) })) {
            output.push(event);
            if (name === 'abort' && event.type === 'provider_activity') ctrl.abort();
          }
          expect(policies[0]).toEqual({ effort: 'xhigh', streamIdleTimeoutMs: 10 });
          const persisted = conversationStore.loadRecentBySession(sessionId, 50);
          if (name === 'complete') {
            expect(requests).toBe(2); // one tool batch and one tool-result continuation
            expect(execute.mock.calls.map(([input]) => input)).toEqual([{ value: 1 }, { value: 2 }]);
            expect(output.filter(e => e.type === 'llm_retry')).toHaveLength(0);
            expect(output.filter(e => e.type === 'tool_call')).toHaveLength(2);
            expect(persisted.flatMap(row => row.toolCalls || [])).toHaveLength(2);
            expect(persisted.filter(row => row.role === 'tool')).toHaveLength(2);
          } else {
            expect(requests).toBe(1);
            expect(execute).not.toHaveBeenCalled();
            expect(output.filter(e => e.type === 'tool_call' || e.type === 'tool_start')).toEqual([]);
            expect(persisted.flatMap(row => row.toolCalls || [])).toEqual([]);
            expect(persisted.filter(row => row.role === 'tool')).toEqual([]);
            expect(output.some(e => e.type === (name === 'abort' ? 'aborted' : 'error'))).toBe(true);
            expect(output.filter(e => e.type === 'llm_retry')).toHaveLength(0);
          }
          // Tool-loop boundaries are nonterminal; query owns exactly one terminal boundary.
          expect(output.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
            expect.objectContaining({ terminal: true, stopReason: name === 'complete' ? 'end_turn' : name === 'abort' ? 'aborted' : 'error' }),
          ]);
          if (name === 'idle' || name === 'abort') expect(cancel).toHaveBeenCalledTimes(1);
        }
      } finally {
        global.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
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
        await closeConversationHistoryIndexes();
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
      expect(turnEnds).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
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
      expect(events.filter(e => e.type === 'turn_end')).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
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
      expect(turnEnds).toEqual([expect.objectContaining({ stopReason: 'aborted', terminal: true })]);
    });
  });

  describe('tools passed to adapter', () => {
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
  });
});

describe('native Session response publication', () => {
  const input = { title: 'Verified result', summary: 'All three checks passed.', phase: 'final', blocks: [{ type: 'metrics', items: [{ label: 'Checks', value: '3' }] }] };
  const dirs = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeConversationHistoryIndexes();
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  });
  function fixture({ adapter: providerAdapter, config = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-presentation-')); dirs.push(dir);
    const store = new ConversationStore(dir);
    const requests = [];
    const responses = [];
    const adapter = { async *stream(params) {
      requests.push({ ...params, messages: structuredClone(params.messages), tools: structuredClone(params.tools) });
      const events = responses.shift();
      if (events instanceof Error) throw events;
      if (!events) throw new Error('Unexpected provider request');
      yield* events;
    } };
    const engine = new Engine({ adapter: providerAdapter || adapter, trace: new NullTrace(), config: { model: 'test-model', maxOutputTokens: 1024, maxRetries: 0, ...config }, conversationStore: store, yeaftDir: dir, vpId: 'vp-a', toolRegistry: createFullRegistry() });
    return { engine, store, dir, requests, responses };
  }
  const query = { prompt: 'Show the verified result', sessionId: 'session-a', vpTurnId: 'turn-a', threadId: 'main' };
  const call = (id = 'publish-a', payload = input) => ({ type: 'tool_call', id, name: 'PresentResponse', input: payload });
  const stop = stopReason => ({ type: 'stop', stopReason });
  async function collect(engine, params = query, callback = () => {}) { const events = []; for await (const event of engine.query(params)) { events.push(event); callback(event); } return events; }

  it.each([
    ['claude-sonnet-4', 'high', 'enabled'],
    ['claude-opus-4.6', 'high', 'adaptive'],
    ['claude-opus-4.8', 'high', 'adaptive'],
    ['claude-opus-4.8', undefined, undefined],
  ])('continues %s publications with native tool results, not an assistant prefill', async (model, effort, thinkingType) => {
    const progress = { ...input, phase: 'progress', summary: 'Checks are running.' };
    const native = [
      ...(thinkingType ? [
        { type: 'thinking', thinking: 'Check the evidence.', signature: 'opaque-presentation-signature' },
        { type: 'redacted_thinking', data: 'opaque-redacted-thinking' },
      ] : []),
      { type: 'tool_use', id: 'publish-progress', name: 'PresentResponse', input: progress },
      { type: 'tool_use', id: 'publish-final', name: 'PresentResponse', input },
    ];
    const requests = [];
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      // Match the native API's prefill rejection rather than allowing a mock
      // provider to accept an invalid post-publication request.
      if (body.messages.at(-1)?.role === 'assistant') {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Assistant prefill is not supported.' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: `response-${requests.length}`, model,
        content: requests.length === 1 ? native : requests.length === 2 ? [] : [{ type: 'text', text: 'Previous checks confirmed.' }],
        stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn',
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const f = fixture({ adapter: new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic',
        baseUrl: 'https://anthropic-gateway.invalid', apiKey: 'synthetic',
        models: [thinkingType === 'enabled' ? { id: model, thinkingProtocol: 'anthropic' } : model] }] }),
        config: { model: `gateway/${model}`, modelEffort: effort, projectDocMaxBytes: 0 } });
      const events = await collect(f.engine);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(requests).toHaveLength(2); // phase=final does not end the query.
      expect(requests[0].thinking?.type).toBe(thinkingType);
      const continuation = requests[1];
      expect(continuation.thinking).toEqual(requests[0].thinking);
      expect(continuation.messages).toEqual([
        ...requests[0].messages,
        { role: 'assistant', content: native },
        { role: 'user', content: [
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'publish-progress', is_error: false }),
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'publish-final', is_error: false }),
        ] },
      ]);
      for (const result of continuation.messages.at(-1).content) expect(JSON.parse(result.content).accepted).toBe(true);
      expect(events.filter(event => event.type === 'response_presentation')).toHaveLength(2);
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
      ]);
      const history = f.store.loadAllBySession(query.sessionId);
      const publications = history.filter(row => row.presentation);
      expect(publications.map(row => [row.content, row.presentation.phase, row.responseKind])).toEqual([
        [progress.summary, 'progress', 'progress'], [input.summary, 'final', 'progress'],
      ]);
      // Later turns still receive delivered summaries as ordinary history,
      // never rich UI metadata or a replay of the publication side effect.
      const next = await collect(f.engine, { ...query, prompt: 'What did the checks show?', vpTurnId: 'turn-b', messages: history });
      expect(next.filter(event => event.type === 'error')).toEqual([]);
      expect(next.filter(event => event.type === 'response_presentation')).toEqual([]);
      expect(requests).toHaveLength(3);
      for (const summary of [progress.summary, input.summary]) {
        expect(requests[2].messages.some(row => row.role === 'assistant' && JSON.stringify(row.content).includes(summary))).toBe(true);
      }
      expect(requests[2].messages.at(-1)).toMatchObject({ role: 'user', content: 'What did the checks show?' });
      expect(JSON.stringify(requests[2].messages)).not.toMatch(/presentationCallId|"presentation"/);
      expect(f.store.loadAllBySession(query.sessionId).filter(row => row.presentation)).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('fences cancellation before publication and keeps delivered snapshots as progress on failed turns', async () => {
    const f = fixture(); const controller = new AbortController();
    f.responses.push([call(), stop('tool_use')]);
    const events = await collect(f.engine, { ...query, signal: controller.signal }, event => { if (event.type === 'tool_exec') controller.abort(); });
    expect(events.filter(event => event.type === 'response_presentation')).toEqual([]);
    expect(f.store.loadAllBySession('session-a').filter(row => row.presentation)).toEqual([]);
    const g = fixture(); g.responses.push([call(), stop('tool_use')], [{ type: 'error', error: new Error('provider failed'), retryable: false }]);
    const failed = await collect(g.engine);
    expect(failed.filter(event => event.type === 'response_presentation')).toHaveLength(1);
    expect(g.store.loadAllBySession('session-a').find(row => row.presentation)).toMatchObject({ incomplete: true, stopReason: 'error', responseKind: 'progress' });
  });
});
