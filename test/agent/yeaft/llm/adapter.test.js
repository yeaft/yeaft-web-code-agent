import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LLMAdapter,
  LLMRateLimitError,
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  createLLMAdapter,
} from '../../../../agent/yeaft/llm/adapter.js';

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

  it('should throw Phase 7 removal error when only openaiApiKey is set', async () => {
    await expect(
      createLLMAdapter({ openaiApiKey: 'sk-test' })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
  });

  it('should throw Phase 7 removal error for proxy adapter', async () => {
    await expect(
      createLLMAdapter({ adapter: 'proxy', proxyUrl: 'http://localhost:6628' })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
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

  it('should throw Phase 7 removal error for openai adapter', async () => {
    await expect(
      createLLMAdapter({ adapter: 'openai', openaiApiKey: 'sk-test' })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
  });
});

describe('createLLMAdapter — adapter alias', () => {
  it('should throw Phase 7 removal error for chat-completions alias', async () => {
    await expect(
      createLLMAdapter({
        adapter: 'chat-completions',
        openaiApiKey: 'test-key',
        baseUrl: 'http://localhost:1234/v1',
      })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
  });

  it('should throw Phase 7 removal error for openai adapter even with baseUrl', async () => {
    await expect(
      createLLMAdapter({
        adapter: 'openai',
        openaiApiKey: 'test-key',
        baseUrl: 'http://custom-server:8080/v1',
      })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
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
        { name: 'oai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', protocol: 'openai-responses', models: ['gpt-5'] },
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

  it('should throw Phase 7 removal error in legacy fallback for openai-only env', async () => {
    await expect(
      createLLMAdapter({
        providers: null,
        openaiApiKey: 'sk-test',
      })
    ).rejects.toThrow(/chat-completions adapter was removed in Phase 7/);
  });
});

describe('Mock stream test — Anthropic', () => {
  it('should handle Anthropic SSE stream with tool_use', async () => {
    const { AnthropicAdapter } = await import('../../../../agent/yeaft/llm/anthropic.js');

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
