import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Engine } from '../../agent/yeaft/engine.js';
import { DebugTrace } from '../../agent/yeaft/debug-trace.js';
import { AnthropicAdapter } from '../../agent/yeaft/llm/anthropic.js';

class MockAdapter {
  constructor(events) {
    this.events = events;
  }

  async *stream() {
    for (const event of this.events) yield event;
  }
}

const tempPaths = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-cache-debug-'));
  tempPaths.push(dir);
  return join(dir, 'debug.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Yeaft cache token debug accounting', () => {
  it('preserves Anthropic cache read/write usage from stream events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":17,"output_tokens":0,"cache_read_input_tokens":12000,"cache_creation_input_tokens":3000}}}',
          '',
          'data: {"type":"message_delta","usage":{"output_tokens":42},"delta":{"stop_reason":"end_turn"}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const adapter = new AnthropicAdapter({ apiKey: 'test-key', baseUrl: 'https://anthropic.test' });
    const events = [];
    for await (const event of adapter.stream({
      model: 'claude-opus-4.8',
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 17,
      outputTokens: 0,
      cacheReadTokens: 12000,
      cacheWriteTokens: 3000,
    });
  });

  it('aggregates cache read/write tokens into live loop and persisted debug totals', async () => {
    const trace = new DebugTrace(tempDbPath());
    try {
      const engine = new Engine({
        adapter: new MockAdapter([
          { type: 'usage', inputTokens: 20, outputTokens: 7, cacheReadTokens: 1000, cacheWriteTokens: 200 },
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]),
        trace,
        config: { model: 'claude-opus-4.8', maxOutputTokens: 1024, _readOnly: true },
      });

      const loops = [];
      for await (const event of engine.query({ prompt: 'hello', sessionId: 's-cache' })) {
        if (event.type === 'loop') loops.push(event);
      }

      expect(loops).toHaveLength(1);
      expect(loops[0].usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        totalInputTokens: 1220,
        totalTokens: 1227,
      });

      const history = await trace.fetchRecentDebugHistory({ limit: 10 });
      expect(history.loops).toHaveLength(1);
      expect(history.loops[0].usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        totalInputTokens: 1220,
        totalTokens: 1227,
      });
      expect(history.turns[0].totalTokens).toBe(1227);
    } finally {
      await trace.close();
    }
  });

  it('does not double count OpenAI cached tokens because they are included in input_tokens', async () => {
    const trace = new DebugTrace(tempDbPath());
    try {
      const engine = new Engine({
        adapter: new MockAdapter([
          { type: 'usage', inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 0, cacheTokensAreIncludedInInput: true },
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]),
        trace,
        config: { model: 'gpt-5.5', maxOutputTokens: 1024, _readOnly: true },
      });

      const loops = [];
      for await (const event of engine.query({ prompt: 'hello', sessionId: 's-openai-cache' })) {
        if (event.type === 'loop') loops.push(event);
      }

      expect(loops[0].usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalInputTokens: 100,
        totalTokens: 125,
      });

      const history = await trace.fetchRecentDebugHistory({ limit: 10 });
      expect(history.loops).toHaveLength(1);
      expect(history.loops[0].usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalInputTokens: 100,
        totalTokens: 125,
      });
      expect(history.turns[0].totalTokens).toBe(125);
    } finally {
      await trace.close();
    }
  });

  it('keeps non-cached OpenAI-style usage totals unchanged', async () => {
    const trace = new DebugTrace(tempDbPath());
    try {
      const engine = new Engine({
        adapter: new MockAdapter([
          { type: 'usage', inputTokens: 100, outputTokens: 25 },
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ]),
        trace,
        config: { model: 'gpt-5.5', maxOutputTokens: 1024, _readOnly: true },
      });

      const loops = [];
      for await (const event of engine.query({ prompt: 'hello', sessionId: 's-openai' })) {
        if (event.type === 'loop') loops.push(event);
      }

      expect(loops[0].usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalInputTokens: 100,
        totalTokens: 125,
      });
    } finally {
      await trace.close();
    }
  });


  it('reports whether older debug history exists', async () => {
    const trace = new DebugTrace(tempDbPath());
    try {
      for (let i = 0; i < 3; i += 1) {
        const turnId = trace.startTurn({ traceId: `trace-${i}`, userPrompt: `prompt ${i}` });
        trace.endTurn(turnId, {
          model: 'test-model',
          inputTokens: i + 1,
          outputTokens: i + 2,
          usage: { inputTokens: i + 1, outputTokens: i + 2, totalTokens: i + 3 },
        });
      }

      const firstPage = await trace.fetchRecentDebugHistory({ limit: 2 });
      expect(firstPage.loops).toHaveLength(2);
      expect(firstPage.turns).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.limit).toBe(2);

      const fullPage = await trace.fetchRecentDebugHistory({ limit: 3 });
      expect(fullPage.loops).toHaveLength(3);
      expect(fullPage.hasMore).toBe(false);
    } finally {
      await trace.close();
    }
  });
});
