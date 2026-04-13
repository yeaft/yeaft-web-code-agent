import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LLMAdapter,
  LLMRateLimitError,
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  createLLMAdapter,
} from '../../../../agent/unify/llm/adapter.js';

// Clear env vars before/after each test
beforeEach(() => {
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
});

afterEach(() => {
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
});

describe('LLMAdapter base class', () => {
  it('should throw if stream() is not implemented', async () => {
    const adapter = new LLMAdapter();
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of adapter.stream({})) {
        // should not reach here
      }
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e.message).toContain('must be implemented');
    }
  });

  it('should throw if call() is not implemented', async () => {
    const adapter = new LLMAdapter();
    await expect(adapter.call({})).rejects.toThrow('must be implemented');
  });
});

describe('Error types', () => {
  it('LLMRateLimitError should have correct properties', () => {
    const err = new LLMRateLimitError('too fast', 429, 5000);
    expect(err.name).toBe('LLMRateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
    expect(err instanceof Error).toBe(true);
  });

  it('LLMAuthError should have correct properties', () => {
    const err = new LLMAuthError('bad key', 401);
    expect(err.name).toBe('LLMAuthError');
    expect(err.statusCode).toBe(401);
  });

  it('LLMContextError should have correct properties', () => {
    const err = new LLMContextError('too long');
    expect(err.name).toBe('LLMContextError');
  });

  it('LLMServerError should have correct properties', () => {
    const err = new LLMServerError('internal', 500);
    expect(err.name).toBe('LLMServerError');
    expect(err.statusCode).toBe(500);
  });

  it('LLMAbortError should have correct properties', () => {
    const err = new LLMAbortError();
    expect(err.name).toBe('LLMAbortError');
    expect(err.message).toBe('Request aborted');
  });
});

describe('createLLMAdapter factory', () => {
  it('should throw when no credentials configured', async () => {
    await expect(
      createLLMAdapter({ adapter: null, apiKey: null, openaiApiKey: null, proxyUrl: null })
    ).rejects.toThrow('No LLM adapter configured');
  });

  it('should create AnthropicAdapter when apiKey is set', async () => {
    const adapter = await createLLMAdapter({ apiKey: 'sk-ant-test' });
    expect(adapter.constructor.name).toBe('AnthropicAdapter');
  });

  it('should create ChatCompletionsAdapter when openaiApiKey is set', async () => {
    const adapter = await createLLMAdapter({ openaiApiKey: 'sk-test' });
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');
  });

  it('should create ChatCompletionsAdapter for proxy', async () => {
    const adapter = await createLLMAdapter({ adapter: 'proxy', proxyUrl: 'http://localhost:6628' });
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');
  });

  it('should prefer explicit adapter over auto-detect', async () => {
    const adapter = await createLLMAdapter({
      adapter: 'anthropic',
      apiKey: 'sk-ant-test',
      openaiApiKey: 'sk-test',
    });
    expect(adapter.constructor.name).toBe('AnthropicAdapter');
  });

  it('should throw for anthropic adapter without apiKey', async () => {
    await expect(
      createLLMAdapter({ adapter: 'anthropic' })
    ).rejects.toThrow('requires YEAFT_API_KEY');
  });

  it('should throw for openai adapter without openaiApiKey', async () => {
    await expect(
      createLLMAdapter({ adapter: 'openai' })
    ).rejects.toThrow('requires YEAFT_OPENAI_API_KEY');
  });
});

describe('createLLMAdapter — adapter alias', () => {
  it('should accept chat-completions as alias for openai', async () => {
    const adapter = await createLLMAdapter({
      adapter: 'chat-completions',
      openaiApiKey: 'test-key',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');
  });

  it('should use config.baseUrl for openai adapter when provided', async () => {
    const adapter = await createLLMAdapter({
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: 'http://custom-server:8080/v1',
    });
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');
  });

  it('should use config.baseUrl for anthropic adapter when provided', async () => {
    const adapter = await createLLMAdapter({
      adapter: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'http://custom-anthropic:9090',
    });
    expect(adapter.constructor.name).toBe('AnthropicAdapter');
  });
});

describe('createLLMAdapter — providers path', () => {
  it('should create AdapterRouter when providers are configured', async () => {
    const adapter = await createLLMAdapter({
      providers: [
        { name: 'proxy', baseUrl: 'http://localhost:6628/v1', apiKey: 'proxy', models: ['gpt-5'] },
      ],
    });
    expect(adapter.constructor.name).toBe('AdapterRouter');
  });

  it('should fall back to legacy when providers is empty', async () => {
    const adapter = await createLLMAdapter({
      providers: [],
      apiKey: 'sk-ant-test',
    });
    expect(adapter.constructor.name).toBe('AnthropicAdapter');
  });

  it('should fall back to legacy when providers is null', async () => {
    const adapter = await createLLMAdapter({
      providers: null,
      openaiApiKey: 'sk-test',
    });
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');
  });
});

describe('Mock stream test', () => {
  it('should handle a simulated stream with text and tool_calls', async () => {
    // This tests that the ChatCompletionsAdapter can parse SSE chunks correctly
    // by creating a mock ReadableStream that emits SSE events
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');

    // Mock fetch to return SSE stream
    const originalFetch = global.fetch;
    let capturedBody = null;
    const sseLines = [
      'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":"Hello"},"index":0}]}',
      'data: {"id":"1","choices":[{"delta":{"content":" world"},"index":0}]}',
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"index":0}]}',
      'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]},"index":0}]}',
      'data: {"id":"1","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}',
      'data: [DONE]',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line + '\n\n'));
        }
        controller.close();
      },
    });

    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        body: stream,
      };
    };

    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'http://localhost' });
      const events = [];
      for await (const event of adapter.stream({
        model: 'gpt-5',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      })) {
        events.push(event);
      }

      // gpt-5 is an OpenAI model → should use max_completion_tokens
      expect(capturedBody.max_completion_tokens).toBe(16384);
      expect(capturedBody.max_tokens).toBeUndefined();

      // Check text deltas
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].text).toBe('Hello');
      expect(textEvents[1].text).toBe(' world');

      // Check tool call (emitted on finish)
      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].id).toBe('call_1');
      expect(toolCallEvents[0].name).toBe('search');
      expect(toolCallEvents[0].input).toEqual({ q: 'test' });

      // Check stop event
      const stopEvents = events.filter(e => e.type === 'stop');
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0].stopReason).toBe('tool_use');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should send max_completion_tokens for OpenAI model in call()', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');

    const originalFetch = global.fetch;
    let capturedBody = null;

    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      };
    };

    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'http://localhost:1234' });
      await adapter.call({
        model: 'gpt-5',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 8192,
      });

      // gpt-5 is an OpenAI model → should use max_completion_tokens
      expect(capturedBody.max_completion_tokens).toBe(8192);
      expect(capturedBody.max_tokens).toBeUndefined();
      // Should NOT have stream set
      expect(capturedBody.stream).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('max_tokens parameter selection (model-based)', () => {
  const mockJsonResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });

  it('should send max_completion_tokens for gpt-5', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });
      await adapter.call({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_completion_tokens).toBe(1024);
      expect(body.max_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_completion_tokens for gpt-4.1', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });
      await adapter.call({ model: 'gpt-4.1-mini', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_completion_tokens).toBe(1024);
      expect(body.max_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_completion_tokens for o3', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });
      await adapter.call({ model: 'o3', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 2048 });
      expect(body.max_completion_tokens).toBe(2048);
      expect(body.max_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_completion_tokens for o4-mini', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'proxy', baseUrl: 'http://localhost:6628/v1' });
      await adapter.call({ model: 'o4-mini', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 });
      expect(body.max_completion_tokens).toBe(4096);
      expect(body.max_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_tokens for deepseek-chat', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' });
      await adapter.call({ model: 'deepseek-chat', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_tokens).toBe(1024);
      expect(body.max_completion_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_tokens for deepseek-reasoner', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' });
      await adapter.call({ model: 'deepseek-reasoner', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_tokens).toBe(1024);
      expect(body.max_completion_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_tokens for gemini models', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
      await adapter.call({ model: 'gemini-2.5-pro', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_tokens).toBe(1024);
      expect(body.max_completion_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_completion_tokens for GPT model even via CopilotProxy', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      // Through proxy but model is gpt → new param
      const adapter = new ChatCompletionsAdapter({ apiKey: 'proxy', baseUrl: 'http://localhost:6628/v1' });
      await adapter.call({ model: 'gpt-5.4', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_completion_tokens).toBe(1024);
      expect(body.max_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should send max_tokens for unknown/custom models', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'http://localhost:11434/v1' });
      await adapter.call({ model: 'llama-3.1-70b', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 });
      expect(body.max_tokens).toBe(1024);
      expect(body.max_completion_tokens).toBeUndefined();
    } finally { global.fetch = originalFetch; }
  });

  it('should allow extraBody to override max tokens parameter', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      // deepseek-chat would normally send max_tokens, but extraBody overrides
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://api.deepseek.com' });
      await adapter.call({ model: 'deepseek-chat', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024, extraBody: { max_completion_tokens: 2048, max_tokens: undefined } });
      expect(body.max_completion_tokens).toBe(2048);
    } finally { global.fetch = originalFetch; }
  });

  it('should allow extraBody to pass arbitrary parameters', async () => {
    const { ChatCompletionsAdapter } = await import('../../../../agent/unify/llm/chat-completions.js');
    const originalFetch = global.fetch;
    let body;
    global.fetch = async (_, opts) => { body = JSON.parse(opts.body); return mockJsonResponse(); };
    try {
      const adapter = new ChatCompletionsAdapter({ apiKey: 'test', baseUrl: 'https://api.openai.com/v1' });
      await adapter.call({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024, extraBody: { temperature: 0.7, response_format: { type: 'json_object' } } });
      expect(body.temperature).toBe(0.7);
      expect(body.response_format).toEqual({ type: 'json_object' });
    } finally { global.fetch = originalFetch; }
  });
});

describe('useNewMaxTokensParam — model ID detection', () => {
  let useNewMaxTokensParam;
  beforeEach(async () => {
    ({ useNewMaxTokensParam } = await import('../../../../agent/unify/llm/chat-completions.js'));
  });

  it('returns true for GPT models', () => {
    expect(useNewMaxTokensParam('gpt-5')).toBe(true);
    expect(useNewMaxTokensParam('gpt-5.4')).toBe(true);
    expect(useNewMaxTokensParam('gpt-4.1')).toBe(true);
    expect(useNewMaxTokensParam('gpt-4.1-mini')).toBe(true);
    expect(useNewMaxTokensParam('gpt-4.1-nano')).toBe(true);
  });

  it('returns true for o-series reasoning models', () => {
    expect(useNewMaxTokensParam('o1')).toBe(true);
    expect(useNewMaxTokensParam('o3')).toBe(true);
    expect(useNewMaxTokensParam('o4-mini')).toBe(true);
  });

  it('returns false for DeepSeek models', () => {
    expect(useNewMaxTokensParam('deepseek-chat')).toBe(false);
    expect(useNewMaxTokensParam('deepseek-reasoner')).toBe(false);
  });

  it('returns false for Gemini models', () => {
    expect(useNewMaxTokensParam('gemini-2.5-pro')).toBe(false);
    expect(useNewMaxTokensParam('gemini-2.5-flash')).toBe(false);
  });

  it('returns false for unknown/custom models', () => {
    expect(useNewMaxTokensParam('llama-3.1-70b')).toBe(false);
    expect(useNewMaxTokensParam('my-custom-model')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(useNewMaxTokensParam(null)).toBe(false);
    expect(useNewMaxTokensParam(undefined)).toBe(false);
    expect(useNewMaxTokensParam('')).toBe(false);
  });
});

describe('Mock stream test — Anthropic', () => {
  it('should handle Anthropic SSE stream with tool_use', async () => {
    const { AnthropicAdapter } = await import('../../../../agent/unify/llm/anthropic.js');

    const originalFetch = global.fetch;
    const sseLines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"test\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}',
      'data: [DONE]',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line + '\n\n'));
        }
        controller.close();
      },
    });

    global.fetch = async () => ({
      ok: true,
      status: 200,
      body: stream,
    });

    try {
      const adapter = new AnthropicAdapter({ apiKey: 'sk-ant-test' });
      const events = [];
      for await (const event of adapter.stream({
        model: 'claude-sonnet-4-20250514',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'search for test' }],
        tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
      })) {
        events.push(event);
      }

      // Text delta
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].text).toBe('Let me search.');

      // Usage
      const usageEvents = events.filter(e => e.type === 'usage');
      expect(usageEvents.length).toBeGreaterThan(0);
      expect(usageEvents[0].inputTokens).toBe(100);

      // Tool call
      const toolCallEvents = events.filter(e => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].id).toBe('toolu_1');
      expect(toolCallEvents[0].name).toBe('search');
      expect(toolCallEvents[0].input).toEqual({ q: 'test' });

      // Stop
      const stopEvents = events.filter(e => e.type === 'stop');
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0].stopReason).toBe('tool_use');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
