/**
 * task-327d: AnthropicAdapter must (a) collect thinking + signature from
 * the SSE stream into a `thinking_block_end` event, and (b) translate an
 * assistant message's `thinkingBlocks` back into Anthropic's required
 * content[] order on the next request (thinking BEFORE text + tool_use).
 *
 * If either side is broken, Anthropic 400s the follow-up turn with
 * "content[].thinking in the thinking mode must be passed back to the API".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../../../agent/unify/llm/anthropic.js';

// ─── SSE fixture builder ────────────────────────────────────────

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Build a fake fetch that returns an SSE Response with the given chunks.
 * Body uses the Web Streams API (ReadableStream) — same shape as fetch's
 * real response.body in Node 20+.
 */
function fakeFetchSSE(chunks) {
  return async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      body: stream,
    };
  };
}

describe('task-327d: SSE → thinking_block_end event', () => {
  let origFlag, origFetch;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
    globalThis.fetch = origFetch;
  });

  it('emits thinking_block_end with full text + signature, before text_delta', async () => {
    globalThis.fetch = fakeFetchSSE([
      sseChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      // thinking block opens
      sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
      sseChunk({ type: 'content_block_stop', index: 0 }),
      // text block follows
      sseChunk({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      sseChunk({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
      sseChunk({ type: 'content_block_stop', index: 1 }),
      sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    ]);

    const adapter = new AnthropicAdapter({ apiKey: 'test', baseUrl: 'https://stub' });
    const events = [];
    for await (const ev of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    const types = events.map(e => e.type);
    const tbeIdx = types.indexOf('thinking_block_end');
    const txtIdx = types.indexOf('text_delta');
    expect(tbeIdx).toBeGreaterThanOrEqual(0);
    expect(txtIdx).toBeGreaterThan(tbeIdx);

    const tbe = events[tbeIdx];
    expect(tbe.thinking).toBe('hmm let me think');
    expect(tbe.signature).toBe('sig-abc');
  });

  it('emits thinking_block_end with empty signature when none was sent (engine will warn-and-drop)', async () => {
    globalThis.fetch = fakeFetchSSE([
      sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'unsigned' } }),
      sseChunk({ type: 'content_block_stop', index: 0 }),
      sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 't', baseUrl: 'https://stub' });
    const events = [];
    for await (const ev of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })) events.push(ev);
    const tbe = events.find(e => e.type === 'thinking_block_end');
    expect(tbe).toBeDefined();
    expect(tbe.thinking).toBe('unsigned');
    expect(tbe.signature).toBe('');
  });
});

// ─── translateMessages — thinking blocks emitted first ─────────

describe('task-327d: assistant.thinkingBlocks → Anthropic content[] order', () => {
  let origFlag, captured;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
    captured = null;
    globalThis.fetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return { ok: false, status: 500, text: async () => 'stub' };
    };
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  async function drain(gen) {
    try { for await (const _ of gen) { /* noop */ } } catch { /* expected */ }
  }

  it('thinking blocks appear before text and tool_use', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 't', baseUrl: 'https://stub' });
    await drain(adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'hello',
          thinkingBlocks: [{ thinking: 'first thought', signature: 'sig-1' }],
          toolCalls: [{ id: 'tc1', name: 'foo', input: { a: 1 } }],
        },
        { role: 'tool', toolCallId: 'tc1', content: 'ok' },
      ],
    }));
    const asst = captured.messages.find(m => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(asst.content[0].type).toBe('thinking');
    expect(asst.content[0].thinking).toBe('first thought');
    expect(asst.content[0].signature).toBe('sig-1');
    expect(asst.content[1].type).toBe('text');
    expect(asst.content[2].type).toBe('tool_use');
  });

  it('skips thinking blocks without signature (would 400 on replay)', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 't', baseUrl: 'https://stub' });
    await drain(adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'hello',
          thinkingBlocks: [
            { thinking: 'unsigned', signature: '' },
            { thinking: 'signed', signature: 'sig-ok' },
          ],
        },
      ],
    }));
    const asst = captured.messages.find(m => m.role === 'assistant');
    const thinkingBlocks = asst.content.filter(c => c.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0].thinking).toBe('signed');
  });

  it('omits thinking blocks entirely when assistant message has none', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 't', baseUrl: 'https://stub' });
    await drain(adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    }));
    const asst = captured.messages.find(m => m.role === 'assistant');
    expect(asst.content.some(c => c.type === 'thinking')).toBe(false);
  });
});
