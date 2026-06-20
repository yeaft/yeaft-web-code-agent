import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';

const originalFetch = global.fetch;

function anthropicJsonResponse(text = 'ok') {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    text: async () => text,
  };
}

describe('AnthropicAdapter empty-content sanitization', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('drops empty user and assistant messages before sending to Anthropic', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return anthropicJsonResponse();
    });

    const adapter = new AnthropicAdapter({ baseUrl: 'https://anthropic.test', apiKey: 'k' });
    await adapter.call({
      model: 'claude-sonnet-4.5',
      system: '',
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '  \n\t  ' },
        { role: 'user', content: 'real question' },
        { role: 'assistant', content: 'real answer' },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages).toEqual([
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
    ]);
  });

  it('filters empty text parts while preserving non-text user content', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return anthropicJsonResponse();
    });

    const imagePart = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    };
    const adapter = new AnthropicAdapter({ baseUrl: 'https://anthropic.test', apiKey: 'k' });
    await adapter.call({
      model: 'claude-sonnet-4.5',
      system: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '  ' }] },
        { role: 'user', content: [{ type: 'text', text: '' }, imagePart] },
        { role: 'user', content: [{ type: 'text', text: 'caption' }, imagePart] },
      ],
    });

    expect(calls[0].body.messages).toEqual([
      { role: 'user', content: [imagePart] },
      { role: 'user', content: [{ type: 'text', text: 'caption' }, imagePart] },
    ]);
  });

  it('keeps assistant tool_use blocks even when assistant text is empty', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return anthropicJsonResponse();
    });

    const adapter = new AnthropicAdapter({ baseUrl: 'https://anthropic.test', apiKey: 'k' });
    await adapter.call({
      model: 'claude-sonnet-4.5',
      system: '',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_1', name: 'ListDir', input: { path: '.' } }],
        },
        { role: 'tool', toolCallId: 'toolu_1', content: '', isError: false },
      ],
    });

    expect(calls[0].body.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'ListDir', input: { path: '.' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '', is_error: false }],
      },
    ]);
  });
});
