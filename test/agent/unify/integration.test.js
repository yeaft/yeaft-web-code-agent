import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLLMServer } from './mock-llm-server.js';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace, DebugTrace } from '../../../agent/unify/debug-trace.js';
import { loadConfig } from '../../../agent/unify/config.js';
import { createLLMAdapter, LLMAuthError, LLMRateLimitError, LLMServerError } from '../../../agent/unify/llm/adapter.js';

// ─── Shared test infrastructure ──────────────────────────────

const TEST_DIR = join(tmpdir(), `yeaft-integration-${Date.now()}`);
let mockServer;

beforeAll(async () => {
  mkdirSync(TEST_DIR, { recursive: true });
  mockServer = createMockLLMServer();
  await mockServer.start(0);
});

afterAll(async () => {
  await mockServer.stop();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockServer.clearRequests();
  mockServer.clearError();
  // Clean env vars
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
  delete process.env.YEAFT_MODEL;
  delete process.env.YEAFT_ADAPTER;
  delete process.env.YEAFT_BASE_URL;
  delete process.env.YEAFT_DEBUG;
  delete process.env.YEAFT_DIR;
  delete process.env.YEAFT_FALLBACK_MODEL;
  delete process.env.YEAFT_MAX_CONTEXT;
});

afterEach(() => {
  // Cleanup env vars that loadEnvFile() may have set
  delete process.env.YEAFT_API_KEY;
  delete process.env.YEAFT_OPENAI_API_KEY;
  delete process.env.YEAFT_PROXY_URL;
  delete process.env.YEAFT_MODEL;
  delete process.env.YEAFT_ADAPTER;
  delete process.env.YEAFT_BASE_URL;
  delete process.env.YEAFT_DEBUG;
  delete process.env.YEAFT_DIR;
  delete process.env.YEAFT_FALLBACK_MODEL;
  delete process.env.YEAFT_MAX_CONTEXT;
});

// ─── Integration: Engine + Real Adapters + Mock Server ───────

describe('Integration: Engine + ChatCompletionsAdapter + Mock Server', () => {
  it('should complete a simple text query', async () => {
    mockServer.setResponse([
      { type: 'text', text: 'Hello from mock LLM!' },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    const events = [];
    for await (const event of engine.query({ prompt: 'hello' })) {
      events.push(event);
    }

    // Check we got text
    const textEvents = events.filter(e => e.type === 'text_delta');
    expect(textEvents.length).toBeGreaterThan(0);
    const fullText = textEvents.map(e => e.text).join('');
    expect(fullText).toBe('Hello from mock LLM!');

    // Check turn lifecycle
    expect(events.find(e => e.type === 'turn_start')).toBeTruthy();
    expect(events.find(e => e.type === 'turn_end')).toBeTruthy();
    expect(events.find(e => e.type === 'turn_end').stopReason).toBe('end_turn');

    // Check the mock server received the request
    expect(mockServer.requests).toHaveLength(1);
    expect(mockServer.requests[0].body.model).toBe('gpt-5');
    expect(mockServer.requests[0].body.stream).toBe(true);
  });

  it('should handle tool calls end-to-end', async () => {
    // First response: model wants to call a tool
    mockServer.setResponse([
      { type: 'text', text: 'Let me search for that.' },
      { type: 'tool_call', id: 'call_123', name: 'web_search', input: { query: 'yeaft' } },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    engine.registerTool({
      name: 'web_search',
      description: 'Search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async (input) => {
        // After tool executes, mock server should return final answer
        mockServer.setResponse([
          { type: 'text', text: `Found results for: ${input.query}` },
        ]);
        return `Results for ${input.query}: Yeaft is an AI agent framework.`;
      },
    });

    const events = [];
    for await (const event of engine.query({ prompt: 'what is yeaft?' })) {
      events.push(event);
    }

    // Should have 2 turns
    const turnStarts = events.filter(e => e.type === 'turn_start');
    expect(turnStarts).toHaveLength(2);

    // Should have tool execution
    const toolStarts = events.filter(e => e.type === 'tool_start');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].name).toBe('web_search');

    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].isError).toBe(false);
    expect(toolEnds[0].output).toContain('Yeaft is an AI agent framework');

    // Second call should have tool result in messages
    expect(mockServer.requests).toHaveLength(2);
    const secondRequest = mockServer.requests[1].body;
    const toolMsg = secondRequest.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content).toContain('Yeaft is an AI agent framework');
  });

  it('should pass usage information through', async () => {
    mockServer.setResponse([
      { type: 'text', text: 'Usage test.' },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-4.1-mini',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    const events = [];
    for await (const event of engine.query({ prompt: 'test' })) {
      events.push(event);
    }

    const usageEvents = events.filter(e => e.type === 'usage');
    expect(usageEvents.length).toBeGreaterThan(0);
    // Mock server sends 50 prompt tokens + 25 completion tokens
    const totalInput = usageEvents.reduce((sum, e) => sum + e.inputTokens, 0);
    const totalOutput = usageEvents.reduce((sum, e) => sum + e.outputTokens, 0);
    expect(totalInput).toBeGreaterThan(0);
    expect(totalOutput).toBeGreaterThan(0);
  });
});

describe('Integration: Engine + AnthropicAdapter + Mock Server', () => {
  it('should complete a simple text query via Anthropic API', async () => {
    mockServer.setResponse([
      { type: 'text', text: 'Hello from Anthropic mock!' },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'claude-sonnet-4-20250514',
      adapter: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: `http://127.0.0.1:${mockServer.port}`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    const events = [];
    for await (const event of engine.query({ prompt: 'hello' })) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text_delta');
    const fullText = textEvents.map(e => e.text).join('');
    expect(fullText).toBe('Hello from Anthropic mock!');

    // Verify Anthropic-specific request format
    expect(mockServer.requests).toHaveLength(1);
    const req = mockServer.requests[0];
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.body.model).toBe('claude-sonnet-4-20250514');
    expect(req.body.stream).toBe(true);
  });

  it('should handle tool calls via Anthropic API', async () => {
    mockServer.setResponse([
      { type: 'text', text: 'Searching...' },
      { type: 'tool_call', id: 'toolu_1', name: 'calculator', input: { expr: '2+2' } },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'claude-sonnet-4-20250514',
      adapter: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: `http://127.0.0.1:${mockServer.port}`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    engine.registerTool({
      name: 'calculator',
      description: 'Calculate math expressions',
      parameters: { type: 'object', properties: { expr: { type: 'string' } } },
      execute: async (input) => {
        mockServer.setResponse([
          { type: 'text', text: 'The answer is 4.' },
        ]);
        return '4';
      },
    });

    const events = [];
    for await (const event of engine.query({ prompt: 'what is 2+2?' })) {
      events.push(event);
    }

    const turnStarts = events.filter(e => e.type === 'turn_start');
    expect(turnStarts).toHaveLength(2);

    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].output).toBe('4');

    // Verify second request includes tool_result in Anthropic format
    expect(mockServer.requests).toHaveLength(2);
    const secondReq = mockServer.requests[1].body;
    // Anthropic sends tool results as user messages with tool_result content
    const toolResultMsg = secondReq.messages.find(m =>
      Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
    );
    expect(toolResultMsg).toBeTruthy();
  });
});

describe('Integration: Config + .env file', () => {
  it('should load API key from .env file', () => {
    const envDir = join(TEST_DIR, 'env-test');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, '.env'), 'YEAFT_API_KEY=sk-ant-from-dotenv\n');

    // Clear env to ensure .env is the source
    delete process.env.YEAFT_API_KEY;

    const config = loadConfig({ dir: envDir, model: 'unknown-custom-model' });
    expect(config.apiKey).toBe('sk-ant-from-dotenv');
    expect(config.adapter).toBe('anthropic');

    // Cleanup: remove from process.env since loadEnvFile sets it
    delete process.env.YEAFT_API_KEY;
  });

  it('should prefer shell env over .env file', () => {
    const envDir = join(TEST_DIR, 'env-test-priority');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, '.env'), 'YEAFT_API_KEY=from-dotenv\n');

    process.env.YEAFT_API_KEY = 'from-shell';

    const config = loadConfig({ dir: envDir, model: 'unknown-custom-model' });
    expect(config.apiKey).toBe('from-shell');

    delete process.env.YEAFT_API_KEY;
  });

  it('should handle .env with quotes and comments', () => {
    const envDir = join(TEST_DIR, 'env-test-quotes');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, '.env'), [
      '# This is a comment',
      'YEAFT_OPENAI_API_KEY="sk-quoted-key"',
      "YEAFT_MODEL='gpt-5'",
      '',
      '# Another comment',
      'YEAFT_DEBUG=1',
    ].join('\n'));

    delete process.env.YEAFT_OPENAI_API_KEY;
    delete process.env.YEAFT_MODEL;
    delete process.env.YEAFT_DEBUG;

    const config = loadConfig({ dir: envDir });
    expect(config.openaiApiKey).toBe('sk-quoted-key');
    expect(config.model).toBe('gpt-5');
    expect(config.debug).toBe(true);

    delete process.env.YEAFT_OPENAI_API_KEY;
    delete process.env.YEAFT_MODEL;
    delete process.env.YEAFT_DEBUG;
  });
});

describe('Integration: Config + Model Registry auto-detection', () => {
  it('should auto-detect OpenAI adapter for gpt-5 model', async () => {
    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    expect(config.adapter).toBe('openai');

    // Should be able to create adapter and make a call
    const adapter = await createLLMAdapter(config);
    expect(adapter.constructor.name).toBe('ChatCompletionsAdapter');

    mockServer.setResponse([{ type: 'text', text: 'OK' }]);
    const result = await adapter.call({
      model: 'gpt-5',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('OK');
  });

  it('should auto-detect Anthropic adapter for Claude model', async () => {
    const config = loadConfig({
      dir: TEST_DIR,
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test',
      baseUrl: `http://127.0.0.1:${mockServer.port}`,
    });

    expect(config.adapter).toBe('anthropic');

    const adapter = await createLLMAdapter(config);
    expect(adapter.constructor.name).toBe('AnthropicAdapter');

    mockServer.setResponse([{ type: 'text', text: 'Bonjour' }]);
    const result = await adapter.call({
      model: 'claude-sonnet-4-20250514',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('Bonjour');
  });

  it('should auto-detect DeepSeek endpoint for deepseek-chat', () => {
    const config = loadConfig({
      dir: TEST_DIR,
      model: 'deepseek-chat',
      openaiApiKey: 'test-key',
    });

    expect(config.adapter).toBe('openai');
    expect(config.baseUrl).toBe('https://api.deepseek.com');
    expect(config.maxContextTokens).toBe(131072);
  });
});

describe('Integration: Debug trace recording', () => {
  it('should record full turn lifecycle in debug trace', async () => {
    const dbPath = join(TEST_DIR, `trace-integration-${Date.now()}.db`);

    mockServer.setResponse([
      { type: 'text', text: 'Traced response.' },
    ]);

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const trace = new DebugTrace(dbPath);
    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace, config });

    for await (const _event of engine.query({ prompt: 'trace test' })) {
      // consume
    }

    // Verify trace was recorded
    const stats = trace.stats();
    expect(stats.turnCount).toBe(1);

    const recent = trace.queryRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].model).toBe('gpt-5');
    expect(recent[0].response_text).toBe('Traced response.');
    expect(recent[0].stop_reason).toBe('end_turn');
    expect(recent[0].latency_ms).toBeGreaterThan(0);
    expect(recent[0].input_tokens).toBeGreaterThan(0);

    trace.close();

    // Cleanup DB files
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) rmSync(p);
    }
  });
});

// ─── Integration: Error handling via Mock Server ──────────────

describe('Integration: Error handling via Mock Server', () => {
  it('should throw LLMAuthError for 401 from ChatCompletions', async () => {
    mockServer.setError(401, { error: { message: 'Invalid API key' } });

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'bad-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);

    await expect(
      adapter.call({
        model: 'gpt-5',
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow(LLMAuthError);
  });

  it('should throw LLMRateLimitError for 429 from ChatCompletions', async () => {
    mockServer.setError(429, { error: { message: 'Rate limit exceeded' } });

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);

    await expect(
      adapter.call({
        model: 'gpt-5',
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow(LLMRateLimitError);
  });

  it('should throw LLMServerError for 500 from ChatCompletions', async () => {
    mockServer.setError(500, { error: { message: 'Internal server error' } });

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);

    await expect(
      adapter.call({
        model: 'gpt-5',
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow(LLMServerError);
  });

  it('should throw LLMAuthError for 401 from Anthropic', async () => {
    mockServer.setError(401, { error: { message: 'Invalid API key' } });

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'claude-sonnet-4-20250514',
      adapter: 'anthropic',
      apiKey: 'bad-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}`,
    });

    const adapter = await createLLMAdapter(config);

    await expect(
      adapter.call({
        model: 'claude-sonnet-4-20250514',
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow(LLMAuthError);
  });

  it('should surface error through engine query loop', async () => {
    mockServer.setError(500, { error: { message: 'Server down' } });

    const config = loadConfig({
      dir: TEST_DIR,
      model: 'gpt-5',
      adapter: 'openai',
      openaiApiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    });

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace: new NullTrace(), config });

    const events = [];
    for await (const event of engine.query({ prompt: 'hello' })) {
      events.push(event);
    }

    // Engine should catch the adapter error and emit error + turn_end events
    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error).toBeInstanceOf(LLMServerError);
    expect(errorEvents[0].retryable).toBe(true);

    const turnEnds = events.filter(e => e.type === 'turn_end');
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].stopReason).toBe('error');
  });
});
