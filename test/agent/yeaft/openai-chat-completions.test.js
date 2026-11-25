import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIChatCompletionsAdapter } from '../../../agent/yeaft/llm/openai-chat-completions.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import {
  createLLMAdapter,
  createModelFetchDispatcher,
  fetchWithHeadersTimeout,
  classifyFetchError,
  LLMToolInputError,
  LLMContextError,
  LLMHeadersTimeoutError,
  LLMStreamIdleTimeoutError,
  LLMServerError,
} from '../../../agent/yeaft/llm/adapter.js';
import fileWriteTool from '../../../agent/yeaft/tools/file-write.js';
import {
  createProviderContext,
  createProviderState,
  replayProviderState,
  bindProviderState,
} from '../../../agent/yeaft/llm/provider-state.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { updateLlmConfig, getLlmConfig } from '../../../agent/yeaft/config-api.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { addOrUpdateProvider } from '../../../agent/llm-config-cli.js';
import { getModelEffortOptions } from '../../../agent/yeaft/models.js';
import { stepDownRetryEffort, enforceSubAgentEffortPayload } from '../../../agent/yeaft/effort.js';

const identity = {
  instanceScope: 'fixture-instance',
  ownerScope: 'fixture-owner',
  sessionId: 'session_chat_comp',
  vpId: 'vp',
  threadId: 'main',
};

const json = body => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
});

function sse(events) {
  const text = events
    .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream) {
  const out = [];
  for await (const event of stream) out.push(event);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('OpenAI Chat Completions protocol adapter & continuity', () => {
  it('routes explicit openai-chat-completions (including Gemini/Claude models) and normalizes legacy aliases', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return json({
        id: 'chatcmpl-1',
        model: 'gemini-4-neon',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 2 } },
      });
    }));

    const router = new AdapterRouter({
      providers: [
        {
          name: 'copilot',
          baseUrl: 'https://copilot.invalid/v1',
          apiKey: 'secret-key',
          protocol: 'openai-chat-completions',
          models: ['gemini-4-neon', 'claude-sonnet-4'],
        },
        {
          name: 'legacy',
          baseUrl: 'https://legacy.invalid/v1',
          apiKey: 'legacy-key',
          protocol: 'chat-completions',
          models: ['custom-model'],
        },
      ],
    });

    const geminiResult = await router.call({
      model: 'copilot/gemini-4-neon',
      system: 'Be concise.',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
      effortSource: 'user',
      requestIdentity: identity,
    });
    expect(geminiResult).toMatchObject({
      text: 'ok',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 8,
        reasoningTokens: 2,
        cacheTokensAreIncludedInInput: true,
      },
    });
    expect(requests[0].url).toBe('https://copilot.invalid/v1/chat/completions');
    expect(requests[0].body).toMatchObject({
      model: 'gemini-4-neon',
      max_completion_tokens: 4096,
      reasoning_effort: 'xhigh',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(requests[0].body.prompt_cache_key).toMatch(/^yeaft:[a-f0-9]{48}$/);

    // Explicit openai-chat-completions also works for Claude models and legacy alias
    await router.call({ model: 'copilot/claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] });
    expect(requests[1].url).toBe('https://copilot.invalid/v1/chat/completions');

    await router.call({ model: 'legacy/custom-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(requests[2].url).toBe('https://legacy.invalid/v1/chat/completions');

    // Direct factory supports openai-chat-completions
    const direct = await createLLMAdapter({ adapter: 'openai-chat-completions', apiKey: 'k', baseUrl: 'https://direct.invalid/v1' });
    expect(direct).toBeInstanceOf(OpenAIChatCompletionsAdapter);
  });

  it('sends literal Chat High for unary and streaming requests, and caps stale Carbon effort before fetch', async () => {
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    const protocol = 'openai-chat-completions';
    const model = 'gemini-4-carbon';
    const messages = [{ role: 'user', content: 'ok?' }];
    const adapter = new OpenAIChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://fixture.invalid/v1' });
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      // Reproduce the upstream contract in the screenshot without hitting Copilot.
      if (body.reasoning_effort && !['low', 'medium', 'high'].includes(body.reasoning_effort)) {
        return Response.json({ error: { code: 'invalid_reasoning_effort' } }, { status: 400 });
      }
      return body.stream ? sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])
        : json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    }));
    expect(getModelEffortOptions(model, { protocol })).toEqual(['medium', 'high']);
    expect(getModelEffortOptions('other-alias', { protocol })).toEqual(['medium', 'high', 'xhigh', 'max', 'ultra']);
    const decision = vi.fn();
    for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
      const params = { model, messages, effort, effortSource: 'user', onEffortDecision: decision };
      await adapter.call(params);
      await collect(adapter.stream(params));
      expect(bodies.slice(-2).map(body => body.reasoning_effort)).toEqual(['high', 'high']);
      expect(decision).toHaveBeenLastCalledWith(expect.objectContaining({ requested: effort, effective: 'high' }));
    }
    for (const [effort, effortContext, expected] of [
      ['xhigh', { effortOptions: ['medium'] }, 'medium'],
      ['high', { supportsEffort: false }, undefined],
      ['high', { effortOptions: ['xhigh'] }, undefined],
      [undefined, {}, undefined],
    ]) {
      await adapter.call({ model, messages, effort, effortContext, effortSource: 'user' });
      expect(bodies.at(-1).reasoning_effort).toBe(expected);
    }
    expect(stepDownRetryEffort('high', { model, protocol })).toBe('medium');
    const body = { reasoning_effort: 'max' };
    const child = enforceSubAgentEffortPayload(body, { model, protocol, effortConstraint: { targetEffort: 'high' } });
    expect([child.cap, child.effective, body.reasoning_effort]).toEqual(['high', 'high', 'high']);
  });

  it('streams reasoning_text and reasoning_opaque, persists signed providerState, and replays them verbatim across Engine tool loops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-chat-comp-loop-'));
    try {
      const requests = [];
      const execute = vi.fn(async () => 'file-content-ok');
      const registry = new ToolRegistry();
      registry.register(defineTool({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: true,
        execute,
      }));

      let callNum = 0;
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        callNum += 1;
        requests.push(JSON.parse(init.body));
        if (callNum === 1) {
          return sse([
            {
              id: 'chatcmpl-turn1',
              model: 'gemini-4-neon',
              choices: [{ index: 0, delta: { role: 'assistant', reasoning_text: 'Checking file first.' }, finish_reason: null }],
            },
            {
              id: 'chatcmpl-turn1',
              model: 'gemini-4-neon',
              choices: [{
                index: 0,
                delta: {
                  reasoning_opaque: 'OPAQUE-GEMINI-THOUGHT-SIGNATURE-1',
                  tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":' } }],
                },
                finish_reason: null,
              }],
            },
            {
              id: 'chatcmpl-turn1',
              model: 'gemini-4-neon',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }],
                },
                finish_reason: 'tool_calls',
              }],
            },
            {
              id: 'chatcmpl-turn1',
              model: 'gemini-4-neon',
              choices: [],
              usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, completion_tokens_details: { reasoning_tokens: 10 } },
            },
            '[DONE]',
          ]);
        }
        return sse([
          {
            id: 'chatcmpl-turn2',
            model: 'gemini-4-neon',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Done reading.' }, finish_reason: 'stop' }],
          },
          {
            id: 'chatcmpl-turn2',
            model: 'gemini-4-neon',
            choices: [],
            usage: { prompt_tokens: 140, completion_tokens: 10, total_tokens: 150, prompt_tokens_details: { cached_tokens: 95 } },
          },
          '[DONE]',
        ]);
      }));

      const provider = {
        name: 'copilot',
        baseUrl: 'https://copilot.invalid/v1',
        apiKey: 'PRIVATE-COPILOT-KEY',
        protocol: 'openai-chat-completions',
        models: ['gemini-4-neon'],
      };
      const store = new ConversationStore(dir);
      const engine = new Engine({
        adapter: new AdapterRouter({ providers: [provider] }),
        trace: new NullTrace(),
        toolRegistry: registry,
        conversationStore: store,
        yeaftDir: dir,
        vpId: 'vp',
        config: {
          model: 'copilot/gemini-4-neon',
          providers: [provider],
          maxOutputTokens: 4096,
          modelEffort: 'xhigh',
          projectDocMaxBytes: 0,
          llmRetry: { maxRetries: 0 },
        },
      });

      const events = await collect(engine.query({ prompt: 'Read README.md', sessionId: 'session_chat_comp', workDir: dir }));
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(events.some(e => e.type === 'thinking_delta' && e.text === 'Checking file first.')).toBe(true);
      expect(events.some(e => e.type === 'provider_activity')).toBe(true);
      expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe('Done reading.');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({ path: 'README.md' }, expect.anything());

      // Second request MUST replay reasoning_opaque & reasoning_text verbatim on the assistant message
      expect(requests).toHaveLength(2);
      const replayedAssistant = requests[1].messages.find(m => m.role === 'assistant');
      expect(replayedAssistant).toMatchObject({
        role: 'assistant',
        reasoning_opaque: 'OPAQUE-GEMINI-THOUGHT-SIGNATURE-1',
        reasoning_text: 'Checking file first.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } }],
      });
      const toolMsg = requests[1].messages.find(m => m.role === 'tool');
      expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
      expect(toolMsg.content).toContain('file-content-ok');

      // Persisted state survives restart and stays fenced to the owning VP
      const restarted = new ConversationStore(dir);
      const ownHistory = restarted.loadSessionHistoryForVp('session_chat_comp', 'vp');
      expect(ownHistory.some(row => row.providerState?.protocol === 'openai-chat-completions')).toBe(true);
      const otherVpHistory = restarted.loadSessionHistoryForVp('session_chat_comp', 'other-vp');
      expect(otherVpHistory.every(row => row.providerState === undefined)).toBe(true);
    } finally {
      await closeConversationHistoryIndexes();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fences signed Chat Completions providerState by owner, origin and projection', () => {
    const ctx = (overrides = {}) => createProviderContext({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://copilot.invalid/v1',
      providerId: 'copilot',
      staticApiKey: 'key-1',
      model: 'gemini-4-neon',
      ...overrides,
    });
    const items = [{
      type: 'assistant_message',
      content: 'checking',
      reasoning_opaque: 'OPAQUE-SIG',
      reasoning_text: 'thought',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }],
    }];
    const msg = {
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'tc1', name: 'Read', input: { path: 'a' } }],
    };
    msg.providerState = bindProviderState(createProviderState({ context: ctx(), identity, items }), msg);

    expect(replayProviderState(msg, ctx(), identity)).toEqual(items);
    expect(() => replayProviderState(msg, ctx({ model: 'gemini-4-carbon' }), identity)).toThrow(/origin changed/);
    expect(() => replayProviderState(msg, ctx(), { ...identity, sessionId: 'other' })).toThrow(/owner changed/);
    expect(() => replayProviderState({ ...msg, content: 'tampered' }, ctx(), identity)).toThrow(/projection changed/);
    expect(() => createProviderState({ context: ctx(), items })).toThrow(/request identity/);
  });

  it('handles multimodal tool results, prompt_cache_key fallback, control reentry, refusal, and rejects truncated/malformed tool batches', async () => {
    const requests = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      // 1st call rejects prompt_cache_key to test automatic single retry fallback
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: { message: 'Unknown parameter: prompt_cache_key', code: 'unknown_parameter', param: 'prompt_cache_key' },
        }), { status: 400 });
      }
      return json({
        id: 'chatcmpl-ok',
        choices: [{ index: 0, message: { role: 'assistant', content: 'saw image' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAIChatCompletionsAdapter({ apiKey: 'k', baseUrl: 'https://gateway.invalid/v1' });
    const events = await collect(adapter.stream({
      model: 'gemini-4-neon',
      requestIdentity: identity,
      controlReentry: true,
      messages: [
        { role: 'user', content: 'Inspect image' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'img_1', name: 'ViewImage', input: { path: 'a.png' } }] },
        {
          role: 'tool',
          toolCallId: 'img_1',
          content: [
            { type: 'text', text: 'Loaded a.png' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
        { role: 'assistant', content: 'Waiting on async result.' },
      ],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0].prompt_cache_key).toBeTruthy();
    expect(requests[1].prompt_cache_key).toBeUndefined();
    // Tool message stays text-only, followed by a user message carrying image_url, and trailing control reentry user note
    expect(requests[1].messages).toEqual([
      { role: 'user', content: 'Inspect image' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'img_1', type: 'function', function: { name: 'ViewImage', arguments: '{"path":"a.png"}' } }],
      },
      { role: 'tool', tool_call_id: 'img_1', content: 'Loaded a.png' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Attached media from tool result img_1]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
      { role: 'assistant', content: 'Waiting on async result.' },
      { role: 'user', content: '[system note] Continue the pending task using the updated context above.' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' });

    // Truncated / malformed / unsupported-type tool calls fail closed without publishing tool_call events
    for (const payload of [
      sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'Read', arguments: '{"bad' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']),
      sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'length' }] }, '[DONE]']),
      sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'custom', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => payload));
      const badEvents = await collect(adapter.stream({ model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] }));
      expect(badEvents.some(e => e.type === 'tool_call')).toBe(false);
      expect(badEvents.at(-1)).toMatchObject({ type: 'error', retryable: false, error: expect.any(LLMToolInputError) });
    }

    // Continuation tool_call delta omitting `index` attaches to the active slot instead of fragmenting,
    // and tool_call header deltas (id/name with empty arguments) emit provider_activity.
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ id: 'tc_noidx', type: 'function', function: { name: 'Read', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ])));
    const noIdxEvents = await collect(adapter.stream({ model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(noIdxEvents.filter(e => e.type === 'provider_activity')).toHaveLength(3);
    expect(noIdxEvents.filter(e => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'tc_noidx', name: 'Read', input: { path: 'a.txt' } },
    ]);

    // Explicit extraBody.reasoning_effort ('high' / 'low') is preserved rather than rewritten to 'xhigh'/'medium'
    let capturedEffortBody;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedEffortBody = JSON.parse(init.body);
      return json({ id: 'chatcmpl-effort', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }));
    await adapter.call({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], extraBody: { reasoning_effort: 'high' } });
    expect(capturedEffortBody.reasoning_effort).toBe('high');

    // controlReentry checks actual ID resolution, not just equal Set sizes
    let capturedReentryBody;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      capturedReentryBody = JSON.parse(init.body);
      return json({ id: 'chatcmpl-re', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }));
    await adapter.call({
      model: 'gemini-4-neon',
      controlReentry: true,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'tool', toolCallId: 'stray_orphan', content: 'old' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'open_call', name: 'Read', input: {} }] },
      ],
    });
    expect(capturedReentryBody.messages.at(-1).role).toBe('assistant');

    // Hosted tool JSON fallback parse failure carries replayUnsafe: true
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(collect(adapter.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      extraBody: { web_search_options: { search_context_size: 'low' } },
    }))).rejects.toMatchObject({ replayUnsafe: true });

    // Content filter refusal without complete calls stops as refusal; 504 upstream_headers_timeout classifies cleanly
    vi.stubGlobal('fetch', vi.fn(async () => json({
      id: 'chatcmpl-ref',
      choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'Cannot comply' }, finish_reason: 'stop' }],
    })));
    const refusalEvents = await collect(adapter.stream({ model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(refusalEvents.at(-1)).toEqual({ type: 'stop', stopReason: 'refusal' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'upstream_headers_timeout' } }), { status: 504 })));
    await expect(collect(adapter.stream({ model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] })))
      .rejects.toBeInstanceOf(LLMHeadersTimeoutError);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('context_length_exceeded', { status: 400 })));
    await expect(adapter.call({ model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(LLMContextError);
  });

  it('supports effort stepping, sub-agent effort capping, config-api persistence, and CLI validation', () => {
    expect(stepDownRetryEffort('xhigh', { model: 'gemini-4-neon', protocol: 'openai-chat-completions' })).toBe('high');
    expect(stepDownRetryEffort('max', { model: 'gemini-4-neon', protocol: 'openai-chat-completions' })).toBe('xhigh');

    const body = { model: 'gemini-4-neon', reasoning_effort: 'max', messages: [] };
    const decision = enforceSubAgentEffortPayload(body, {
      model: 'gemini-4-neon',
      protocol: 'openai-chat-completions',
      effortConstraint: { parentDecision: { effective: 'xhigh' } },
    });
    expect(decision.effective).toBe('medium');
    expect(body.reasoning_effort).toBe('medium');
    expect(body.reasoning).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), 'yeaft-chat-comp-cfg-'));
    try {
      const updated = updateLlmConfig({
        providers: [{
          name: 'copilot',
          baseUrl: 'https://copilot.invalid/v1',
          apiKey: 'k',
          protocol: 'openai-chat-completions',
          models: ['gemini-4-neon', 'gemini-4-carbon'],
        }],
        primaryModel: 'copilot/gemini-4-neon',
      }, dir);
      expect(updated.error).toBeUndefined();
      expect(updated.providers[0].protocol).toBe('openai-chat-completions');
      expect(getLlmConfig(dir).providers[0].protocol).toBe('openai-chat-completions');

      const loaded = loadConfig({ dir });
      const neon = loaded.availableModels.find(m => m.ref === 'copilot/gemini-4-neon');
      expect(neon).toMatchObject({
        protocol: 'openai-chat-completions',
        supportsEffort: true,
        effortProtocol: 'openai-reasoning',
      });

      const cliRes = addOrUpdateProvider({}, {
        name: 'my-chat',
        baseUrl: 'https://api.example/v1',
        apiKey: 'k',
        protocol: 'openai-chat-completions',
        models: 'gemini-4-neon',
      });
      expect(cliRes.provider.protocol).toBe('openai-chat-completions');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // FileWrite guidance encourages modular files and incremental FileEdit builds in both EN and ZH.
    expect(fileWriteTool.description.en).toMatch(/modular/i);
    expect(fileWriteTool.description.en).toMatch(/FileEdit/);
    expect(fileWriteTool.description.zh).toMatch(/模块/);
    expect(fileWriteTool.description.zh).toMatch(/FileEdit/);
  });

  it('disables Undici 300s bodyTimeout on model fetch and classifies upstream stream timeouts into step-down retries', async () => {
    // 1. Real local HTTP socket proves fetchWithHeadersTimeout attaches an explicit Undici dispatcher
    //    with bodyTimeout disabled (while a short dispatcher triggers UND_ERR_BODY_TIMEOUT -> LLMStreamIdleTimeoutError).
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const timer = setTimeout(() => res.end('data: ok\n\n'), 1250);
      res.on('close', () => clearTimeout(timer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const shortDispatcher = createModelFetchDispatcher({ bodyTimeout: 100 });
    try {
      const shortRes = await fetchWithHeadersTimeout(url, { dispatcher: shortDispatcher }, 5_000);
      let rawErr = null;
      try {
        await shortRes.text();
      } catch (err) {
        rawErr = err;
      }
      expect(rawErr).toBeTruthy();
      const classifiedBodyTimeout = classifyFetchError(rawErr, { providerLabel: 'Chat Completions' });
      expect(classifiedBodyTimeout).toBeInstanceOf(LLMStreamIdleTimeoutError);
      expect(classifiedBodyTimeout).toBeInstanceOf(LLMServerError);

      let seenDispatcher = null;
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn((u, init) => {
        seenDispatcher = init?.dispatcher;
        return realFetch(u, init);
      }));
      const okRes = await fetchWithHeadersTimeout(url, {}, 5_000);
      expect(seenDispatcher).toBeTruthy();
      expect(await okRes.text()).toBe('data: ok\n\n');
    } finally {
      vi.unstubAllGlobals();
      await shortDispatcher.close();
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }

    // 2. classifyFetchError maps UND_ERR_HEADERS_TIMEOUT and nested UND_ERR_BODY_TIMEOUT safely.
    const nestedBodyTimeout = new Error('outer', {
      cause: new TypeError('terminated', {
        cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }),
      }),
    });
    expect(classifyFetchError(nestedBodyTimeout)).toBeInstanceOf(LLMStreamIdleTimeoutError);
    const headersTimeout = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
    expect(classifyFetchError(headersTimeout)).toBeInstanceOf(LLMHeadersTimeoutError);

    // 3. Stream error classification across Chat Completions and Responses.
    const adapter = new OpenAIChatCompletionsAdapter({ baseUrl: 'https://proxy.invalid/v1', apiKey: 'k' });
    const streamFrame = payload => sse([payload]);

    vi.stubGlobal('fetch', vi.fn(async () => streamFrame({
      error: { message: 'Upstream stream timed out waiting for data.', type: 'upstream_error', code: 'upstream_stream_timeout' },
    })));
    const timeoutEvents = await collect(adapter.stream({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(timeoutEvents.at(-1).error).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(timeoutEvents.at(-1).error).toMatchObject({ upstream: true, reasonCode: 'upstream_stream_timeout', code: 'upstream_stream_timeout' });
    expect(timeoutEvents.at(-1).retryable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => streamFrame({
      error: { message: 'terminated', type: 'upstream_error', code: null },
    })));
    const legacyTerminated = await collect(adapter.stream({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(legacyTerminated.at(-1).error).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(legacyTerminated.at(-1).retryable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => streamFrame({
      error: { message: 'socket hang up', type: 'upstream_error', code: null },
    })));
    const genericUpstream = await collect(adapter.stream({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(genericUpstream.at(-1).error).toBeInstanceOf(LLMServerError);
    expect(genericUpstream.at(-1).error).not.toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(genericUpstream.at(-1).retryable).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => streamFrame({
      error: { message: 'terminated', type: 'upstream_error', code: 'invalid_request_error' },
    })));
    const explicit4xx = await collect(adapter.stream({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(explicit4xx.at(-1).error).not.toBeInstanceOf(LLMServerError);
    expect(explicit4xx.at(-1).retryable).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => streamFrame({
      error: { message: 'too long', type: 'upstream_error', code: 'context_length_exceeded' },
    })));
    const contextErr = await collect(adapter.stream({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hi' }] }));
    expect(contextErr.at(-1).error).toBeInstanceOf(LLMContextError);
    expect(contextErr.at(-1).retryable).toBe(false);

    const responsesAdapter = new OpenAIResponsesAdapter({ baseUrl: 'https://proxy.invalid/v1', apiKey: 'k' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response: { status: 'failed', error: { type: 'upstream_error', code: 'upstream_stream_timeout', message: 'Upstream stream timed out.' } },
      })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    const respEvents = await collect(responsesAdapter.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));
    expect(respEvents.at(-1).error).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(respEvents.at(-1).retryable).toBe(true);

    // 4. End-to-end Engine: upstream_stream_timeout and legacy terminated trigger effort step-down + older tool compaction.
    const bodies = [];
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      bodies.push(JSON.parse(init.body));
      callCount++;
      if (callCount === 1) {
        return sse([
          { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_old', type: 'function', function: { name: 'big_read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (callCount === 2) {
        return sse([
          { id: 'c2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_new', type: 'function', function: { name: 'big_read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      if (callCount === 3) {
        return streamFrame({
          error: { message: 'terminated', type: 'upstream_error', code: null },
        });
      }
      if (callCount === 4) {
        return streamFrame({
          error: { message: 'Upstream stream timed out waiting for data.', type: 'upstream_error', code: 'upstream_stream_timeout' },
        });
      }
      return sse([
        { id: 'c5', choices: [{ index: 0, delta: { content: 'Recovered after step-down.' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }));

    const router = new AdapterRouter({
      providers: [{
        name: 'copilot',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://proxy.invalid/v1',
        apiKey: 'k',
        models: ['gemini-4-neon'],
      }],
    });
    const tools = new ToolRegistry();
    tools.register(defineTool({
      name: 'big_read',
      description: 'returns large output',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'x'.repeat(24_000),
    }));
    const engine = new Engine({
      adapter: router,
      toolRegistry: tools,
      trace: new NullTrace(),
      config: {
        model: 'copilot/gemini-4-neon',
        modelEffort: 'xhigh',
        maxOutputTokens: 1024,
        projectDocMaxBytes: 0,
        llmRetry: { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      },
    });
    const engineEvents = [];
    for await (const event of engine.query({ prompt: 'Run multi-step task' })) {
      engineEvents.push(event);
    }
    expect(engineEvents.find(e => e.type === 'turn_end' && e.terminal)).toMatchObject({ stopReason: 'end_turn', terminal: true });
    // Loop 3 starts at xhigh -> legacy terminated steps down to high -> upstream_stream_timeout steps down to medium.
    expect(bodies.map(b => b.reasoning_effort)).toEqual(['xhigh', 'xhigh', 'xhigh', 'high', 'medium']);
    const retries = engineEvents.filter(e => e.type === 'llm_retry');
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ reason: 'stream_idle_timeout', effortFrom: 'xhigh', effortTo: 'high' });
    expect(retries[1]).toMatchObject({ reason: 'stream_idle_timeout', effortFrom: 'high', effortTo: 'medium' });
    // Older tool result (call_old) compacted on timeout retry while latest batch (call_new) stays lossless.
    const retryBodyTools = bodies[3].messages.filter(m => m.role === 'tool');
    expect(retryBodyTools.find(m => m.tool_call_id === 'call_old').content.length).toBeLessThan(10_000);
    expect(retryBodyTools.find(m => m.tool_call_id === 'call_new').content.length).toBe(24_000);
  });
});
