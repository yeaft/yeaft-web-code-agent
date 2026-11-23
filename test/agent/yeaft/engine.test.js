import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'node:module';
import { SubAgentToolRegistry } from '../../../agent/yeaft/sub-agent/execution-control.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { withUsageAccounting } from '../../../agent/yeaft/llm/usage-accounting.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { loadPostCompact, postCompactPath, savePostCompact } from '../../../agent/yeaft/post-compact.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { _setMemCacheForTest } from '../../../agent/yeaft/llm/models-dev.js';
import { persistYeaftAttachments } from '../../../agent/yeaft/attachments.js';
import { imageDimensionsFromBase64 } from '../../../agent/yeaft/image-dimensions.js';
import { providerProjectionDigest } from '../../../agent/yeaft/llm/provider-state.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import viewImage from '../../../agent/yeaft/tools/view-image.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';

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

// Prefix/rollover assertions compare the prompt, not the movable cache
// markers. Normalize only the specific wire fields that carry those markers.
function anthropicWireWithoutCache(init) {
  const body = JSON.parse(init.body);
  const strip = ({ cache_control, ...block }) => block;
  const system = Array.isArray(body.system) ? body.system.map(strip) : body.system;
  const tools = Array.isArray(body.tools) ? body.tools.map(strip) : body.tools;
  const messages = body.messages.map(message => ({ ...message,
    content: Array.isArray(message.content) && message.role === 'user'
      ? message.content.map(strip) : message.content,
  }));
  // Single text blocks and the string shorthand are the same Anthropic input.
  const text = content => content?.length === 1 && content[0]?.type === 'text'
    && Object.keys(content[0]).length === 2 ? content[0].text : content;
  return { ...body, system: text(system), ...(tools === undefined ? {} : { tools }),
    messages: messages.map(message => message.role === 'user' ? { ...message, content: text(message.content) } : message) };
}

let trace;
let mockAdapter;

beforeEach(() => {
  trace = new NullTrace();
  mockAdapter = new MockAdapter();
});

describe('Engine', () => {
  describe('simple query (no tools)', () => {
    it('retries the first image-heavy request by bytes without repeating transcript rows or sending historical image bytes', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-no-persist-duplicates-'));
      try {
        const conversationStore = new ConversationStore(yeaftDir);
        const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 413 }))
          .mockImplementation(async () => new Response(JSON.stringify({ stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'one reply' }], usage: { input_tokens: 100, output_tokens: 5 },
          }), { headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetch);
        const engine = new Engine({
          adapter: new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic',
            baseUrl: 'https://anthropic-gateway.invalid', apiKey: 'fixture-key', models: ['claude-opus-4.8'] }] }),
          trace,
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 },
          conversationStore,
          yeaftDir,
        });

        const sessionId = 'session-no-duplicates';
        const upload = (name, data) => persistYeaftAttachments([{ name, mimeType: 'image/gif', data, isImage: true }], { yeaftDir, sessionId });
        const old = upload('old-reference.gif', 'R0lGODlhAQABAAAA');
        const bytes = Buffer.alloc(220_000);
        bytes.write('GIF89a');
        bytes.writeUInt16LE(2, 6); bytes.writeUInt16LE(2, 8);
        const large = upload('large-fresh.gif', bytes.toString('base64'));
        const fresh = upload('fresh-reference.gif', 'R0lGODlhAgACAA==');
        const original = conversationStore.append({ role: 'user', sessionId, content: 'old prompt',
          attachments: old.promptAttachments });
        const events = [];
        for await (const event of engine.query({
          prompt: 'one prompt', promptParts: [{ type: 'text', text: 'one prompt' + large.promptSuffix + fresh.promptSuffix },
            ...large.promptParts, ...fresh.promptParts],
          sessionId: 'session-no-duplicates',
        })) events.push(event);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'end_turn', terminal: true }),
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'turn_close' });

        expect(old.promptAttachments).toHaveLength(1);
        expect(fresh.promptParts).toHaveLength(1);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'llm_retry')).toEqual([expect.objectContaining({
          reason: 'request_body_recovery', statusCode: 413,
        })]);
        expect(fetch).toHaveBeenCalledTimes(2);
        const [first, second] = fetch.mock.calls.map(([, init]) => init.body);
        expect(Buffer.byteLength(second)).toBeLessThan(Buffer.byteLength(first));
        expect(first).toContain(large.promptParts[0].source.data);
        expect(second).not.toContain(large.promptParts[0].source.data);
        expect(second).toContain('Image not sent');
        expect(second).toContain('large-fresh');
        const wire = first;
        expect(wire).toContain('old-reference.gif');
        expect(wire).toContain('ViewImage');
        const oldContent = JSON.parse(first).messages[0].content;
        expect(oldContent).toEqual(expect.arrayContaining([expect.objectContaining({
          text: expect.stringContaining(JSON.stringify(old.promptAttachments[0].path)),
        })]));
        expect(wire).not.toContain(old.promptParts[0].source.data);
        expect(first).toContain(fresh.promptParts[0].source.data);
        expect(second).toContain(fresh.promptParts[0].source.data);
        expect(conversationStore.loadRecentBySession(sessionId, 10).find(row => row.id === original.id).attachments).toEqual(old.promptAttachments);
        expect(conversationStore.loadRecentBySession(sessionId, 10).map(message => ({
          role: message.role,
          content: message.content,
        }))).toEqual([
          { role: 'user', content: 'old prompt' },
          { role: 'user', content: 'one prompt' },
          { role: 'assistant', content: 'one reply' },
        ]);
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(yeaftDir, { recursive: true, force: true });
      }
    });

    it('fences old disk and memory compaction, including a background summary finishing after deletion', async () => {
      const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-delete-compaction-'));
      const sessionId = 'session_deleted_compact';
      const artifact = postCompactPath(yeaftDir, { sessionId, vpId: 'omni', threadId: 'main' });
      const started = Promise.withResolvers();
      const completion = Promise.withResolvers();
      const conversationStore = new ConversationStore(yeaftDir);
      try {
        const deleted = conversationStore.append({ sessionId, role: 'user', content: 'ERASE_MARKER', userTurnId: 'delete-marker' });
        await savePostCompact(artifact, { summary: 'ERASE_MARKER old disk summary', sourceTurnId: 'different-turn' });
        mockAdapter.call = vi.fn(async () => {
          started.resolve();
          return completion.promise;
        });
        const engine = new Engine({ adapter: mockAdapter, trace, conversationStore, yeaftDir,
          config: { model: 'test-model', modelInfo: { contextWindow: 50000, maxOutput: 1024 }, maxOutputTokens: 1024 } });
        const run = async (target, prompt) => {
          const user = conversationStore.append({ sessionId, role: 'user', content: prompt, userAuthored: true });
          for await (const event of target.query({ sessionId, senderVpId: 'omni', prompt,
            userAlreadyPersisted: true, currentUserMessage: user, causalRootId: user.id })) {
            expect(event.type).not.toBe('error');
          }
        };
        mockAdapter.pushResponse([{ type: 'text_delta', text: 'safe reply' }, { type: 'usage', inputTokens: 41000, outputTokens: 10 },
          { type: 'stop', stopReason: 'end_turn' }]);
        await run(engine, 'trigger background compact');
        await started.promise;
        expect(mockAdapter.callLog[0].system).toContain('ERASE_MARKER old disk summary');
        conversationStore.deleteSessionTurn(sessionId, deleted.id);
        completion.resolve({ text: 'ERASE_MARKER late compact' });
        // Allow the detached completion to reach its write fence before any
        // later query can advance the in-memory revision on its own.
        await new Promise(resolve => setImmediate(resolve));
        expect((await loadPostCompact(artifact)).summary).toBe('ERASE_MARKER old disk summary');
        const reopened = new Engine({ adapter: mockAdapter, trace, conversationStore, yeaftDir,
          config: { model: 'test-model', maxOutputTokens: 1024 } });
        for (const target of [engine, reopened]) {
          mockAdapter.pushResponse([{ type: 'text_delta', text: 'retained' }, { type: 'stop', stopReason: 'end_turn' }]);
          await run(target, 'fresh request');
          expect(JSON.stringify(mockAdapter.callLog.at(-1))).not.toContain('ERASE_MARKER');
        }
      } finally {
        completion.resolve({ text: 'unused' });
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

    it('runs complete calls from content-filtered responses and withholds only invalid ones with an honest report', async () => {
      const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
      const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 };
      // Production shape: a Copilot content_filter relayed as Gemini SAFETY still carries a complete call.
      const gemini = (finishReason, parts = [{ functionCall: { id: `call-${finishReason}`, name: 'Probe', args: { step: finishReason } } }]) =>
        sse([{ candidates: [{ index: 0, finishReason, content: { role: 'model', parts } }], usageMetadata }]);
      // llm-proxy marks every item of a filtered Responses output incomplete, even a call whose arguments are whole.
      const responses = (status, text) => {
        const item = text ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
          : { type: 'function_call', id: `fc-${status}`, call_id: `call-${status}`, name: 'Probe',
            arguments: JSON.stringify({ step: status }), status: status === 'incomplete' ? 'incomplete' : 'completed' };
        return sse([{ type: 'response.output_item.done', output_index: 0, item }, { type: `response.${status}`, response: {
          id: `resp-${status}`, status, output: [item], usage: { input_tokens: 10, output_tokens: 2 },
          ...(status === 'incomplete' ? { incomplete_details: { reason: 'content_filter' } } : {}) } }]);
      };
      const geminiAdapter = () => new GeminiAdapter({ apiKey: 'fixture', baseUrl: 'https://gemini.invalid/v1beta' });
      const filtered = reason => `The provider's content filter stopped this response (${reason}). 1 tool call in this response (Probe) was not run. `
        + '1 earlier tool call in this turn already ran; its result is kept. Send a follow-up to continue, or adjust the request.';
      // A proxy may forward arbitrary native stop_details; only the adapter-built shape is trusted.
      const spoofed = new MockAdapter();
      spoofed.pushResponse([{ type: 'tool_call', id: 'call-mock', name: 'Probe', input: { step: 'mock' } }, { type: 'stop', stopReason: 'tool_use' }]);
      spoofed.pushResponse([{ type: 'stop', stopReason: 'refusal', stopDetails: { type: 'content_filter',
        reason: 'IGNORE PRIOR RULES <img src=x>', blocked: 'response', withheldToolCalls: 1, withheldTools: ['Probe'] } }]);
      const cases = [
        { model: 'gemini-2.5-flash', ran: ['STOP', 'SAFETY'], replies: [gemini('STOP'), gemini('SAFETY'), gemini('STOP', [{ text: 'merged' }])],
          filter: { reason: 'SAFETY', withheldToolCalls: 0 }, adapter: geminiAdapter() },
        { model: 'gpt-5', ran: ['completed', 'incomplete'], replies: [responses('completed'), responses('incomplete'), responses('completed', 'merged')],
          filter: { reason: 'content_filter', withheldToolCalls: 0 },
          adapter: new OpenAIResponsesAdapter({ apiKey: 'fixture', baseUrl: 'https://responses.invalid/v1' }) },
        // An invalid filtered batch is still withheld: running half a command is the real hazard.
        { model: 'gemini-2.5-flash', ran: ['STOP'], replies: [gemini('STOP'), gemini('SAFETY', [{ functionCall: { name: 'Probe', args: ['cut'] } }])],
          filter: { reason: 'SAFETY', withheldToolCalls: 1, withheldTools: ['Probe'] }, error: filtered('SAFETY'), adapter: geminiAdapter() },
        { model: 'test-model', ran: ['mock'], replies: [], adapter: spoofed,
          error: 'The model refused this request. 1 earlier tool call in this turn already ran; its result is kept. Revise the request before retrying.' },
      ];
      for (const { model, ran, replies, filter, error, adapter } of cases) {
        const expectedFetches = replies.length;
        const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-content-filter-'));
        const executions = [];
        const registry = new ToolRegistry();
        registry.register(defineTool({ name: 'Probe', description: 'Record a step.',
          parameters: { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] },
          execute: async ({ step }) => { executions.push(step); return 'recorded'; } }));
        const fetch = vi.fn(async () => replies.shift());
        vi.stubGlobal('fetch', fetch);
        try {
          const engine = new Engine({ adapter, trace, toolRegistry: registry, conversationStore: new ConversationStore(yeaftDir), yeaftDir,
            config: { model, maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
          const events = [];
          for await (const event of engine.query({ prompt: 'merge when ready', sessionId: `filter-${model}` })) events.push(event);
          expect(fetch).toHaveBeenCalledTimes(expectedFetches);
          expect(executions).toEqual(ran);
          const rows = new ConversationStore(yeaftDir).loadRecentBySession(`filter-${model}`, 20);
          const flagged = rows.find(row => row.providerMetadata?.stopDetails);
          if (error) {
            expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ code: 'refusal', retryable: false, error })]);
            expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({ stopReason: 'refusal', terminal: true });
            expect(flagged).toMatchObject({ stopReason: 'refusal', incomplete: true, providerMetadata: { stopReason: 'refusal' } });
            expect(flagged.toolCalls).toBeUndefined();
          } else {
            // The filtered call ran, its result went back to the model and the turn finished normally.
            expect(events.filter(event => event.type === 'error')).toEqual([]);
            expect(events.filter(event => event.type === 'turn_end').at(-1)).toMatchObject({ stopReason: 'end_turn', terminal: true });
            expect(flagged).toMatchObject({ stopReason: 'tool_use', toolCalls: [expect.objectContaining({ name: 'Probe', input: { step: ran.at(-1) } })] });
          }
          if (filter) expect(flagged.providerMetadata.stopDetails).toEqual({ type: 'content_filter', blocked: 'response', ...filter });
        } finally {
          vi.unstubAllGlobals();
          await closeConversationHistoryIndexes();
          rmSync(yeaftDir, { recursive: true, force: true });
        }
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

    it('continues catalog 1M Opus/Fable and unknown default requests past 200K with signed prefixes intact', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-qualified-million-'));
      const originalFetch = globalThis.fetch;
      const ids = ['claude-opus-5-5', 'claude-fable-5-2'];
      _setMemCacheForTest({ anthropic: { models: Object.fromEntries(ids.map(id => [id, { limit: { context: 1000000, output: 128000 } }])) } });
      try {
        for (const id of [...ids, 'claude-unknown-capability']) {
          const requests = [];
          globalThis.fetch = vi.fn(async (_url, init) => {
            requests.push(anthropicWireWithoutCache(init));
            return response('million-' + requests.length, requests.length === 1 ? 'echo' : undefined, {}, id,
              { input_tokens: 210000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
          });
          const engine = new Engine({ adapter: router(id), trace, yeaftDir: dir,
            config: { model: 'gateway/' + id, ...(ids.includes(id) ? { maxContextTokens: 200000 } : {}), maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
          engine.registerTool({ name: 'echo', description: 'Read evidence', parameters: { type: 'object' }, execute: async () => 'new evidence' });
          const events = [];
          for await (const event of engine.query({ prompt: 'known prompt '.repeat(4000), sessionId: 'million-' + id })) events.push(event);
          expect(events.filter(event => event.type === 'error')).toEqual([]);
          expect(requests).toHaveLength(2);
          expect(requests.every(body => body.model === id)).toBe(true);
          expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
          expect(requests[1].messages.flatMap(row => row.content).some(block => block?.signature === 'signature-million-1')).toBe(true);
          expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        }
      } finally {
        globalThis.fetch = originalFetch;
        _setMemCacheForTest(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([false, true])('does not send an unbudgeted cache fallback when reporting=%s', async reporting => {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-child-cache-cap-'));
      const child = { budget: { max_llm_calls: 1 }, usage: { llmCalls: reporting ? 1 : 0 }, execution: { toolCalls: 0, recentCalls: [] } };
      const registry = new SubAgentToolRegistry({ agent: child });
      const fetch = vi.fn(async () => new Response(JSON.stringify({ error: {
        message: 'system.0.text.cache_control: Extra inputs are not permitted',
      } }), { status: 400 }));
      vi.stubGlobal('fetch', fetch);
      try {
        const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, toolRegistry: registry, yeaftDir: dir,
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        const events = [];
        for await (const event of engine.query({ prompt: 'Summarize the available evidence.', sessionId: 'child-cache-cap',
          isSubAgent: true, vpPersona: { vpId: 'child', subAgent: true } })) events.push(event);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetch.mock.lastCall[1].body).system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(child.usage.llmCalls).toBe(reporting ? 2 : 1);
        expect(child.usage.reportingLlmCalls).toBe(reporting ? 1 : undefined);
        expect(events.find(event => event.type === 'error')?.error?.message).toMatch(reporting
          ? /reporting request already used/ : /max_llm_calls.*reached before dispatch/);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    async function verifyImageLimitContinuation(mode) {
      const signed = mode !== 'unsigned';
      const gatewayRejects = mode === 'stricter-gateway';
      // C1: a real 3840x1080 screenshot after 20 signed images. A route-sized
      // preview must fit it without rebuilding the context.
      const realPreview = mode === 'signed-preview';
      let realScreenshot;
      if (realPreview) {
        let sharp;
        try { sharp = createRequire(new URL('../../../agent/package.json', import.meta.url))('sharp'); }
        catch (err) {
          if (err.code !== 'MODULE_NOT_FOUND' && !/Could not load the .sharp. module/.test(err.message)) throw err;
          return; // Optional native encoder.
        }
        realScreenshot = await sharp({ create: { width: 3840, height: 1080, channels: 3, background: '#1b2a3a' } }).png().toBuffer();
        expect(realScreenshot.length).toBeLessThan(200 * 1024); // Below the model-preview target: only the route fitter can shrink it.
      }
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-active-image-limit-'));
      const store = new ConversationStore(dir);
      const model = 'claude-opus-4.8';
      const requests = [], summaries = [], executions = [];
      const makeGif = (index, edge) => {
        const bytes = Buffer.alloc(24);
        bytes.write('GIF89a'); bytes.writeUInt16LE(edge, 6); bytes.writeUInt16LE(912, 8);
        bytes.writeUInt32LE(index, 12);
        return bytes.toString('base64');
      };
      // The tool retention policy caps replay independently. Use uploads to
      // exercise the provider-specific many-image limit despite that cap.
      const screenshots = Array.from({ length: 20 }, (_, index) => makeGif(index, 1200));
      const newest = realPreview ? realScreenshot.toString('base64') : makeGif(20, gatewayRejects ? 2000 : 3303);
      const photos = screenshots.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/gif', data } }));
      const path = n => `screenshot-${n}.gif`;
      const flatten = content => Array.isArray(content) ? content.flatMap(part => part.type === 'tool_result'
        ? [part, ...flatten(part.content)] : [part]) : [];
      const imageData = req => req.messages.flatMap(row => flatten(row.content))
        .filter(part => part.type === 'image').map(part => part.source.data);
      const json = (content, stop_reason = 'end_turn') => new Response(JSON.stringify({ content, stop_reason,
        usage: { input_tokens: 500, output_tokens: 10 } }), { headers: { 'content-type': 'application/json' } });
      try {
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
          const request = anthropicWireWithoutCache(init);
          if (!request.stream) {
            summaries.push(request);
            expect(request.messages[0].content).toContain(path(0));
            expect(request.messages[0].content).not.toContain(newest);
            return json([{ type: 'text', text: 'Images reviewed; finish the comparison.' }]);
          }
          const images = imageData(request);
          requests.push({ request, images });
          expect(images.length > 20 && images.includes(newest) && !gatewayRejects).toBe(false);
          if (gatewayRejects && images.length === 21 && executions.length === 1) {
            return new Response(JSON.stringify({ error: {
              message: 'At least one of the image dimensions exceed max allowed size for many-image requests: 1500 pixels',
            } }), { status: 400 });
          }
          const index = executions.length;
          const id = `shot-${index}`;
          if (signed) return response(id, index === 0 ? 'ViewImage' : undefined, { file_path: path(index) }, model,
            { input_tokens: 500 + index * 2000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
          return index === 0 ? json([{ type: 'tool_use', id, name: 'ViewImage', input: { file_path: path(index) } }], 'tool_use')
            : json([{ type: 'text', text: 'Finished safely.' }]);
        }));
        const usage = vi.fn();
        const engine = new Engine({ adapter: withUsageAccounting(router(model), usage), trace, yeaftDir: dir, conversationStore: store,
          config: { model: 'gateway/' + model, maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        engine.registerTool({ name: 'ViewImage', description: 'Read a screenshot', parameters: { type: 'object' }, execute: async input => {
          executions.push(input.file_path);
          return JSON.stringify({ path: input.file_path, image: `data:image/${realPreview ? 'png' : 'gif'};base64,` + newest });
        } });
        const events = [];
        for await (const event of engine.query({ prompt: 'Compare the screenshots.', sessionId: 'image-limit',
          promptParts: [{ type: 'text', text: 'Compare the screenshots.' }, ...photos], })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        expect(executions).toEqual([path(0)]);
        expect(store.loadAllBySession('image-limit').filter(row => row.role === 'tool')).toHaveLength(1);
        const final = requests.at(-1);
        expect(summaries).toHaveLength(signed && !realPreview ? 1 : 0);
        expect(requests).toHaveLength(gatewayRejects ? 3 : 2);
        if (realPreview) {
          expect(events.filter(event => event.type === 'llm_retry')).toEqual([]);
          expect(final.request.messages.length).toBeGreaterThan(1);
          expect(final.images.slice(0, 20)).toEqual(screenshots);
          expect(final.images).toHaveLength(21);
          expect(imageDimensionsFromBase64(final.images[20]).width).toBeLessThanOrEqual(3000);
          expect(JSON.stringify(final.request)).toContain('Image preview sent to fit the model route');
          return;
        }
        expect(final.images).toContain(newest);
        if (signed && !gatewayRejects) {
          expect(requests[0].images).toEqual(screenshots);
          expect(final.images.length).toBeLessThanOrEqual(19);
          expect(final.request.messages).toHaveLength(1);
          expect(JSON.stringify(final.request)).not.toContain('signature-shot-');
          expect(JSON.stringify(final.request)).toContain(path(0));
          expect(events.find(event => event.type === 'llm_retry')).toMatchObject({ reason: 'context_rollover', errorName: 'LLMImageLimitError' });
        } else if (gatewayRejects) {
          expect(events.find(event => event.type === 'llm_retry')).toMatchObject({ reason: 'request_image_recovery', statusCode: 400 });
          expect(final.images.length).toBeLessThanOrEqual(19);
        } else {
          expect(final.images).toEqual([...screenshots.slice(1), newest]);
          expect(JSON.stringify(final.request)).toContain(path(0));
          expect(JSON.stringify(final.request)).toContain('Image not sent: model route image limit');
        }
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    async function verifyRoutePreviewDeduplication() {
      const require = createRequire(new URL('../../../agent/package.json', import.meta.url));
      let sharp;
      try { sharp = require('sharp'); }
      catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND' && !/Could not load the .sharp. module/.test(err.message)) throw err;
        return; // Optional native encoder: the protocol test covers the non-encoder path.
      }
      const create = { width: 8100, height: 100, channels: 3, background: '#243b53' };
      // Route-only previews: enough pixels to require downsizing, but neither
      // original crosses the proactive size threshold. Both render identically.
      const first = await sharp({ create }).png({ compressionLevel: 6 }).toBuffer();
      const samePixels = await sharp({ create }).png({ compressionLevel: 1 }).toBuffer();
      expect(first.equals(samePixels)).toBe(false);
      expect(Math.max(first.length, samePixels.length)).toBeLessThan(200 * 1024);
      const originals = [first, first, samePixels];
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-image-preview-dedup-'));
      const requests = [];
      const models = [];
      const usage = { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const imagesIn = content => !Array.isArray(content) ? []
        : content.flatMap(block => block.type === 'image' ? [block.source] : imagesIn(block.content));
      try {
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
          const body = anthropicWireWithoutCache(init);
          expect(body.stream).toBe(true);
          const step = requests.length;
          requests.push(body);
          return response(`preview-${step}`, step < originals.length ? 'ViewImage' : undefined,
            { file_path: `preview-${step}.png` }, 'claude-opus-4.8', usage);
        }));
        const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, yeaftDir: dir,
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        engine.registerTool({ name: 'ViewImage', description: 'Read image evidence', parameters: { type: 'object' },
          execute: async ({ file_path }) => {
            const data = originals[models.length].toString('base64');
            models.push(file_path);
            return JSON.stringify({ path: file_path, image: 'data:image/png;base64,' + data });
          } });
        const events = [];
        for await (const event of engine.query({ prompt: 'Inspect the wide screenshots', sessionId: 'preview-dedup' })) events.push(event);
        expect(events.filter(event => event.type === 'error' || event.type === 'llm_retry')).toEqual([]);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        expect(models).toEqual(['preview-0.png', 'preview-1.png', 'preview-2.png']);
        expect(requests).toHaveLength(originals.length + 1);
        const sentImages = requests.map(request => request.messages.flatMap(row => imagesIn(row.content)));
        expect(sentImages[0]).toEqual([]);
        expect(sentImages[1]).toEqual([expect.objectContaining({ media_type: 'image/webp' })]);
        expect(sentImages[2]).toEqual(sentImages[1]);
        expect(sentImages[3]).toEqual(sentImages[1]);
        expect(JSON.stringify(requests[3].messages)).toContain('duplicate content');
        expect(JSON.stringify(requests[3].messages)).toContain('preview-2.png');
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    async function assertLongImageLoop() {
      const originalFetch = globalThis.fetch;
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-long-image-loop-'));
      let step = 0, summaries = 0;
      const toolRuns = [], requests = [];
      const usage = { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const imageFor = index => {
        const data = Buffer.alloc(16, index);
        data.write('GIF89a');
        data.writeUInt16LE(index === 30 ? 3303 : 1200, 6);
        data.writeUInt16LE(912, 8);
        return data.toString('base64');
      };
      const imagesIn = content => !Array.isArray(content) ? []
        : content.flatMap(block => block.type === 'image' ? [block.source.data] : imagesIn(block.content));
      try {
        globalThis.fetch = vi.fn(async (_url, init) => {
          const body = anthropicWireWithoutCache(init);
          if (!body.stream) {
            expect(JSON.stringify(body.messages)).not.toContain(imageFor(30));
            summaries++;
            return new Response(JSON.stringify({ stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Screenshots collected so far; continue without repeating tools.' }], usage,
            }), { headers: { 'content-type': 'application/json' } });
          }
          const images = body.messages.flatMap(row => imagesIn(row.content));
          requests.push({ images, seed: body.messages.length === 1 ? JSON.stringify(body.messages[0].content) : null });
          // Duplicate responses or a late rollover would grow the wire tape.
          expect(images.length).toBeLessThanOrEqual(12); // the last segment's evidence counts too
          expect(new Set(images).size).toBe(images.length);
          const n = step++;
          return response(`long-image-${n}`, n < 31 ? 'ViewImage' : undefined,
            n < 31 ? { file_path: `fixture-${n}.gif` } : {}, 'claude-opus-4.8', usage);
        });
        const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, yeaftDir: dir,
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        engine.registerTool({ name: 'ViewImage', description: 'Read image evidence', parameters: { type: 'object' },
          execute: async ({ file_path }) => {
            const n = Number(file_path.match(/\d+/)[0]);
            toolRuns.push(n);
            // A repeated read under a different path, followed by distinct images.
            return JSON.stringify({ path: file_path, image: 'data:image/gif;base64,' + imageFor(n === 1 ? 0 : n) });
          } });
        const events = [];
        for await (const event of engine.query({ prompt: 'Inspect thirty-one screenshots', sessionId: 'long-image-loop' })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        expect(summaries).toBe(2);
        expect(requests).toHaveLength(32);
        expect(requests[2].images).toEqual([imageFor(0)]);
        expect(requests.at(-1).images).toContain(imageFor(30));
        expect(requests.at(-1).images).not.toContain(imageFor(0));
        expect(requests.filter(r => r.seed?.includes('Image evidence from completed tool result'))).toHaveLength(2);
        expect(toolRuns).toEqual(Array.from({ length: 31 }, (_, n) => n));
      } finally {
        globalThis.fetch = originalFetch;
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // A PNG screenshot saved as .jpg is sent with its real type (previewed when
    // large) instead of failing the turn on the gateway's type check.
    async function verifyMisnamedScreenshot() {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-misnamed-image-'));
      const requests = [], files = [], toolRuns = [];
      const usage = { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const imagesIn = content => !Array.isArray(content) ? []
        : content.flatMap(block => block.type === 'image' ? [block.source] : imagesIn(block.content));
      // The gateway's own check, independent of the Agent's sniffer.
      const sniff = data => {
        const head = Buffer.from(data.slice(0, 16), 'base64');
        if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
        if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
        return head.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : 'unknown';
      };
      const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64');
      writeFileSync(join(dir, 'pixel.jpg'), pixel);
      files.push('pixel.jpg');
      let sharp;
      try { sharp = createRequire(new URL('../../../agent/package.json', import.meta.url))('sharp'); }
      catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND' && !/Could not load the .sharp. module/.test(err.message)) throw err;
      }
      if (sharp) {
        // Uncompressed, so the original exceeds the 200 KiB model-image target.
        const large = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#101820' } })
          .png({ compressionLevel: 0 }).toBuffer();
        expect(large.length).toBeGreaterThan(200 * 1024);
        writeFileSync(join(dir, 'detail-dark-before.jpg'), large);
        files.push('detail-dark-before.jpg');
      }
      try {
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
          const body = anthropicWireWithoutCache(init);
          requests.push(body);
          const wrong = body.messages.flatMap(row => imagesIn(row.content)).find(source => source.media_type !== sniff(source.data));
          if (wrong) {
            return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
              message: `The image was specified using the ${wrong.media_type} media type, but the image appears to be a ${sniff(wrong.data)} image` } }),
            { status: 400, headers: { 'content-type': 'application/json' } });
          }
          const step = requests.length - 1;
          return response(`misnamed-${step}`, step < files.length ? 'ViewImage' : undefined,
            { file_path: files[step] }, 'claude-opus-4.8', usage);
        }));
        const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, yeaftDir: dir,
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0 } });
        engine.registerTool({ name: 'ViewImage', description: 'Read image evidence', parameters: { type: 'object' },
          execute: input => { toolRuns.push(input.file_path); return viewImage.execute(input, { cwd: dir }); } });
        const events = [];
        for await (const event of engine.query({ prompt: 'Inspect the screenshots', sessionId: 'misnamed-image' })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        expect(toolRuns).toEqual(files);
        expect(requests).toHaveLength(files.length + 1);
        const sent = requests.at(-1).messages.flatMap(row => imagesIn(row.content));
        expect(sent.map(source => source.media_type)).toEqual(sharp ? ['image/png', 'image/webp'] : ['image/png']);
        if (sharp) expect(JSON.stringify(requests.at(-1).messages)).toContain('detail-dark-before.jpg');
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // The summary model keeps refusing, so two local records follow each other.
    // The second must still list the first segment's call, excerpt only the
    // new rows, and never nest the first record inside itself.
    async function verifyRepeatedLocalRollover() {
      const dir = mkdtempSync(join(tmpdir(), 'yeaft-repeated-local-rollover-'));
      const requests = [], summaries = [], executions = [];
      const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const textOf = content => typeof content === 'string' ? content
        : content.filter(block => block.type === 'text').map(block => block.text).join('');
      try {
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
          const body = anthropicWireWithoutCache(init);
          if (!body.stream) {
            summaries.push(body);
            return new Response(JSON.stringify({ content: [{ type: 'text', text: 'No.' }], stop_reason: 'refusal',
              usage: { input_tokens: 100, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
          }
          requests.push(body);
          const n = requests.length;
          if (n === 2 || n === 4) return new Response('prompt is too long', { status: 400 });
          return response('roll-' + n, n < 4 ? 'echo' : undefined, { n }, 'claude-opus-4.8', usage);
        }));
        const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, yeaftDir: dir, conversationStore: new ConversationStore(dir),
          config: { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0, modelInfo: { contextWindow: 40000, maxOutput: 4096 } } });
        engine.registerTool({ name: 'echo', description: 'Record a side effect', parameters: { type: 'object' }, execute: async input => {
          executions.push(input.n);
          return `SIDE_EFFECT_DONE_${input.n}`;
        } });
        const events = [];
        for await (const event of engine.query({ prompt: 'do both steps', sessionId: 'repeated-local' })) events.push(event);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
        expect(executions).toEqual([1, 3]);
        expect(summaries).toHaveLength(2);
        expect(requests).toHaveLength(5);
        const seed = textOf(requests[4].messages[0].content);
        expect(seed.match(/\[UNTRUSTED LOCAL HISTORY RECORD/g)).toHaveLength(1);
        expect(seed).toContain('- echo id=roll-1 → reported result');
        expect(seed).toContain('- echo id=roll-3 → reported result');
        const excerpt = seed.slice(seed.indexOf('Newest visible history'), seed.indexOf('[END OF UNTRUSTED LOCAL HISTORY RECORD]'));
        expect(excerpt).toContain('SIDE_EFFECT_DONE_3');
        expect(excerpt).not.toContain('SIDE_EFFECT_DONE_1');
        expect(seed).toContain('do both steps');
      } finally {
        vi.unstubAllGlobals();
        await closeConversationHistoryIndexes();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it.each(['provider', 'abort', 'append'])('rolls signed context into a fresh conversation without tool replay: %s', async trigger => {
      if (trigger === 'provider') {
        await verifyRepeatedLocalRollover();
        await assertLongImageLoop();
        await verifyRoutePreviewDeduplication();
        await verifyMisnamedScreenshot();
        for (const mode of ['unsigned', 'signed', 'signed-preview', 'stricter-gateway']) await verifyImageLimitContinuation(mode);
      }
      const modes = ['token', 'http413', 'http413-token-fallback', 'http413-summary-retry', 'http413-multilingual-summary', 'http413-summary-5xx', 'http413-summary-down', 'http413-summary-refusal'];
      for (const mode of trigger === 'provider' ? modes : [trigger]) {
        const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-rollover-'));
        const originalFetch = globalThis.fetch;
        const requests = [], summaries = [];
        const gif = (width, height, bytes) => {
          const data = Buffer.alloc(bytes);
          data.write('GIF89a', 0, 'latin1');
          data.writeUInt16LE(width, 6);
          data.writeUInt16LE(height, 8);
          return { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: data.toString('base64') } };
        };
        // Encoded size is not visual size: ~800K base64 chars for a 16x16
        // frame. A 4424x4424 frame (158x158 patches) puts the seed at ~27K: it
        // fits the window and the 80% threshold (32K), but leaves less than half
        // of that budget (16K) for new work, so it would roll over again.
        const reference = gif(16, 16, 600_000);
        const oversized = mode === 'append' ? [gif(4424, 4424, 64)] : [];
        // A signed provider rejects this particular batch by bytes, not tokens.
        // It should keep the newly read image, shed the earlier large upload,
        // and use the persisted tool evidence without invoking the tool again.
        const screenshot = mode === 'http413-token-fallback' ? gif(4424, 4424, 300_000) : gif(16, 16, 300_000);
        const tooLarge = mode.startsWith('http413');
        const retrySummary = mode === 'http413-summary-retry';
        const multilingual = mode === 'http413-multilingual-summary';
        // The gateway fails one summary step the way loki did in production,
        // or keeps failing past the retry budget.
        const summaryOutage = mode === 'http413-summary-5xx';
        const summaryDown = mode === 'http413-summary-down';
        const summaryRetries = summaryOutage ? 1 : summaryDown ? 3 : 0;
        // The summary model declines, as it did for C1: the task continues on a local record.
        const summaryRefused = mode === 'http413-summary-refusal';
        const localHandoff = summaryDown || summaryRefused;
        const handoff = 'COMPLETE_EVIDENCE: ' + '已核对图像证据。'.repeat(200) + '保留最后的证据。';
        const imagePath = 'fixture image.gif';
        const toolName = tooLarge ? 'ViewImage' : 'echo';
        const requestBytes = [];
        const isReference = block => block?.type === 'image' && block.source?.data === reference.source.data;
        const textOf = content => typeof content === 'string' ? content
          : content.filter(block => block.type === 'text').map(block => block.text).join('');
        const config = { model: 'gateway/claude-opus-4.8', maxOutputTokens: 1024, projectDocMaxBytes: 0,
          modelInfo: { contextWindow: 40000, maxOutput: 4096 }, ...(summaryRetries ? { llmRetry: { baseDelayMs: 0 } } : {}) };
        const control = new AbortController();
        let executions = 0;
        const inbox = [];
        try {
          globalThis.fetch = vi.fn(async (_url, init) => {
            const body = anthropicWireWithoutCache(init);
            if (body.stream !== true) {
              if (body.system.startsWith('Summarize the supplied')) summaries.push(body);
              expect(body.tools).toBeUndefined();
              expect(JSON.stringify(body)).not.toContain('signature-');
              expect(body.messages[0].content).toContain('COMPLETE_EVIDENCE');
              if (body.system.startsWith('Summarize the supplied') && mode === 'abort') { control.abort(); throw new DOMException('cancelled', 'AbortError'); }
              if (body.system.startsWith('Summarize the supplied') && summaries.length <= summaryRetries + (summaryDown ? 1 : 0)) {
                return new Response('{"error":"Internal Server Error"}', { status: 500 });
              }
              if (summaryRefused) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'I can not summarize this.' }], stop_reason: 'refusal', usage: { input_tokens: 1234, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
              let draft = 'COMPLETE_EVIDENCE. Tool completed successfully, do not repeat it. Continue unfinished answer.';
              if (multilingual) draft = handoff;
              if (retrySummary && summaries.length === 1) draft = 'Rejected draft. ' + '细'.repeat(6000);
              return new Response(JSON.stringify({ content: [{ type: 'text', text: draft }], stop_reason: 'end_turn', usage: { input_tokens: 1234, output_tokens: multilingual ? 2000 : 20 } }), { headers: { 'content-type': 'application/json' } });
            }
            requests.push(body);
            requestBytes.push(Buffer.byteLength(init.body));
            if (tooLarge && requests.length === 2) {
              expect(body.messages[0]).toEqual(requests[0].messages[0]);
              expect(JSON.stringify(body)).toContain('signature-roll-1');
              expect(JSON.stringify(body)).toContain(screenshot.source.data);
              return new Response(null, { status: 413 });
            }
            if (mode === 'token' && requests.length === 2) return new Response('prompt is too long', { status: 400 });
            const tool = requests.length === 1 ? toolName : undefined;
            return response('roll-' + requests.length, tool, tooLarge ? { file_path: imagePath } : { n: requests.length }, 'claude-opus-4.8', {
              input_tokens: trigger === 'provider' ? 1000 : 39500,
              output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            });
          });
          const store = new ConversationStore(dir);
          const engine = new Engine({ adapter: router('claude-opus-4.8'), trace, config, yeaftDir: dir, conversationStore: store });
          engine.registerTool({ name: toolName, description: 'Read evidence', parameters: { type: 'object' }, execute: async () => {
            executions++;
            if (mode === 'append') inbox.push({ content: 'LATEST_CORRECTION: DO NOT DEPLOY', internal: false });
            return tooLarge ? JSON.stringify({ text: 'COMPLETE_EVIDENCE: completed side effect', path: imagePath,
              image: 'data:image/gif;base64,' + screenshot.source.data }) : 'COMPLETE_EVIDENCE: completed side effect ' + executions;
          } });
          const events = [];
          for await (const event of engine.query({ prompt: 'obtain evidence and finish', sessionId: 'signed-rollover', signal: control.signal,
            promptParts: [reference, ...oversized, { type: 'text', text: 'obtain evidence and finish' }],
            drainPendingUserMessages: () => inbox.splice(0),
          })) {
            events.push(event);
          }
          expect(executions).toBe(1);
          expect(summaries).toHaveLength(retrySummary ? 2 : 1 + summaryRetries);
          if (retrySummary) {
            expect(summaries[1].messages).toEqual(summaries[0].messages);
            expect(summaries[1].system).not.toBe(summaries[0].system);
          }
          // A failed step is sent again unchanged, announced like any retry.
          for (const repeated of summaries.slice(1, 1 + summaryRetries)) expect(repeated).toEqual(summaries[0]);
          expect(events.filter(event => event.type === 'llm_retry' && event.reason === 'transient_backoff'))
            .toEqual(Array.from({ length: summaryRetries }, (_, index) => expect.objectContaining({
              attempt: index + 1, maxRetries: 3, statusCode: 500, errorName: 'LLMServerError', recoveryMode: 'continue' })));
          // Budgeted by pixels, the reference image reaches the model whole.
          expect(requests[0].messages[0].content.some(isReference)).toBe(true);
          if (mode !== 'abort') {
            expect(events.filter(event => event.type === 'error')).toEqual([]);
            const fresh = requests.at(-1);
            expect(fresh.messages).toHaveLength(1);
            expect(fresh.messages[0].role).toBe('user');
            const seed = fresh.messages[0].content;
            expect(textOf(seed)).toContain('COMPLETE_EVIDENCE');
            expect(textOf(seed)).toContain('obtain evidence and finish');
            expect(textOf(seed)).not.toContain('Rejected draft.');
            // Out of retries or refused, the summary is skipped, not the task:
            // a local record names the completed call so it is not repeated.
            expect(textOf(seed).includes('UNTRUSTED LOCAL HISTORY RECORD')).toBe(localHandoff);
            if (localHandoff) {
              expect(textOf(seed)).toContain('- ViewImage id=roll-1 → reported result');
              expect(textOf(seed)).not.toContain('I can not summarize this.');
            }
            // Only a real summary becomes the cached history for later turns.
            const cached = await loadPostCompact(postCompactPath(dir, { sessionId: 'signed-rollover' }));
            if (localHandoff) expect(cached).toBeNull();
            else expect(cached?.summary).toContain('COMPLETE_EVIDENCE');
            if (multilingual) {
              expect(Buffer.byteLength(handoff)).toBeGreaterThan(summaries[0].max_tokens);
              expect(textOf(seed)).toContain(handoff);
            }
            // Uploads stay native image parts, never base64 inside text.
            expect(textOf(seed)).not.toContain(reference.source.data.slice(0, 64));
            if (mode === 'append') {
              expect(textOf(seed)).toContain('LATEST_CORRECTION: DO NOT DEPLOY');
              // Uploads that would re-trigger rollover are swapped for markers.
              expect(seed).toEqual(expect.any(String));
              expect(seed.match(/\[image\/gif attachment omitted from the compacted context\]/g)).toHaveLength(2);
            } else if (tooLarge) {
              expect(events.find(event => event.type === 'llm_retry')).toMatchObject({ statusCode: 413, reason: 'context_rollover' });
              expect(requests).toHaveLength(3);
              expect(requestBytes[2]).toBeLessThanOrEqual(Math.floor(requestBytes[1] * 0.8));
              expect(textOf(seed)).toContain('ViewImage(file_path=' + JSON.stringify(imagePath) + ')');
              if (mode === 'http413-token-fallback') {
                expect(seed).toEqual(expect.any(String));
                expect(seed).not.toContain(screenshot.source.data);
              } else {
                expect(seed.filter(isReference)).toHaveLength(0);
                expect(seed.filter(part => part.type === 'image')).toEqual([screenshot]);
                expect(textOf(seed)).toContain('Image not sent');
              }
            } else {
              expect(seed.filter(isReference)).toHaveLength(1);
            }
            expect(JSON.stringify(fresh)).not.toContain('signature-');
          }
          const rows = store.loadAllBySession('signed-rollover');
          expect(rows.filter(row => row.role === 'user' && row.userAuthored !== false)).toHaveLength(mode === 'append' ? 2 : 1);
          expect(rows.filter(row => row.role === 'tool')).toHaveLength(executions);
          expect(rows.some(row => row.providerState?.items?.some(item => item.signature))).toBe(true);
          expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toEqual([
            expect.objectContaining({ stopReason: mode === 'abort' ? 'aborted' : 'end_turn', terminal: true }),
          ]);
        } finally {
          globalThis.fetch = originalFetch;
          await closeConversationHistoryIndexes();
          rmSync(dir, { recursive: true, force: true });
        }
      }
      // One case runs about a dozen end-to-end scenarios (the suite is capped at
      // 200 cases), several with real image encodes in child processes: ~8 s idle,
      // ~27 s on a loaded desktop. Leave room for slow CI instead of flaking.
    }, 60_000);
  });

  describe('tool execution loop', () => {
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

  describe('LLM retry policy', () => {
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
        await closeConversationHistoryIndexes();
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
        await closeConversationHistoryIndexes();
        rmSync(boundaryDir, { recursive: true, force: true });
      }
      const errorDir = mkdtempSync(join(tmpdir(), 'yeaft-engine-retry-final-partial-'));
      const terminalFailureFetch = globalThis.fetch;
      try {
        const conversationStore = new ConversationStore(errorDir);
        let attempts = 0;
        globalThis.fetch = async () => {
          attempts += 1;
          const events = [
            ...(attempts === 1 ? [{ type: 'response.output_text.delta', delta: 'visible partial before failure' }] : []),
            { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'temporary upstream failure' } } },
          ];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } });
        };
        const engine = new Engine({
          adapter: new OpenAIResponsesAdapter({ apiKey: 'fixture', baseUrl: 'https://responses.invalid/v1' }),
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
        expect(events.filter(event => event.type === 'llm_retry').map(event => event.attempt)).toEqual([1, 2]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true,
          error: expect.objectContaining({ code: 'server_error', message: 'temporary upstream failure' }) }));
        expect(events.filter(event => event.type === 'turn_end' && event.terminal))
          .toEqual([expect.objectContaining({ stopReason: 'error' })]);
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
        globalThis.fetch = terminalFailureFetch;
        await closeConversationHistoryIndexes();
        rmSync(errorDir, { recursive: true, force: true });
      }
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
