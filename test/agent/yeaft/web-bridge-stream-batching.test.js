import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { __testHandleEngineEvent } = await import('../../../agent/yeaft/web-bridge.js');

function makeHandlerCtx(overrides = {}) {
  return {
    assistantTextParts: [],
    toolCallsAccum: [],
    toolResultsAccum: [],
    thinkingBlocksAccum: [],
    resetQueryTimer: vi.fn(),
    sessionId: 'session-1',
    vpId: 'vp-a',
    turnId: 'turn-a',
    threadId: 'main',
    ...overrides,
  };
}

function assistantFrames() {
  return sent.filter((msg) => msg.type === 'yeaft_output' && msg.data?.type === 'assistant');
}

function assistantTextFrames() {
  return assistantFrames()
    .map((msg) => {
      const content = Array.isArray(msg.data?.message?.content) ? msg.data.message.content : [];
      const text = content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text || '')
        .join('');
      return text ? { msg, text } : null;
    })
    .filter(Boolean);
}

describe('Yeaft web bridge stream text batching', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    sent.length = 0;
  });

  it('flushes the first text delta immediately and batches later small deltas by time', () => {
    const hctx = makeHandlerCtx();

    __testHandleEngineEvent({ type: 'text_delta', text: 'A' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'C' }, hctx);

    expect(assistantTextFrames().map((frame) => frame.text)).toEqual(['A']);
    expect(hctx.assistantTextParts.join('')).toBe('ABC');

    vi.advanceTimersByTime(199);
    expect(assistantTextFrames().map((frame) => frame.text)).toEqual(['A']);

    vi.advanceTimersByTime(1);
    expect(assistantTextFrames().map((frame) => frame.text)).toEqual(['A', 'BC']);
  });

  it('flushes buffered text immediately when the character threshold is reached', () => {
    const hctx = makeHandlerCtx();
    const left = 'a'.repeat(100);
    const right = 'b'.repeat(100);

    __testHandleEngineEvent({ type: 'text_delta', text: 'x' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: left }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: right }, hctx);

    expect(assistantTextFrames().map((frame) => frame.text)).toEqual(['x', `${left}${right}`]);
    expect(hctx.assistantTextParts.join('')).toBe(`x${left}${right}`);

    vi.advanceTimersByTime(200);
    expect(assistantTextFrames().map((frame) => frame.text)).toEqual(['x', `${left}${right}`]);
  });

  it('flushes text before tool frames and starts a fresh text segment after the tool boundary', () => {
    const hctx = makeHandlerCtx();

    __testHandleEngineEvent({ type: 'text_delta', text: 'A' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B' }, hctx);
    __testHandleEngineEvent({ type: 'tool_call', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'C' }, hctx);

    const frames = assistantFrames();
    expect(frames.map((frame) => frame.data.message.content)).toEqual([
      [{ type: 'text', text: 'A' }],
      [{ type: 'text', text: 'B' }],
      [],
      [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }],
      [{ type: 'text', text: 'C' }],
    ]);
    expect(hctx.toolCallsAccum).toEqual([{ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }]);
    expect(hctx.assistantTextParts.join('')).toBe('ABC');
  });

  it('keeps buffered text isolated by handler context so concurrent VP turns cannot merge', () => {
    const ctxA = makeHandlerCtx({ vpId: 'vp-a', turnId: 'turn-a' });
    const ctxB = makeHandlerCtx({ vpId: 'vp-b', turnId: 'turn-b' });

    __testHandleEngineEvent({ type: 'text_delta', text: 'A1' }, ctxA);
    __testHandleEngineEvent({ type: 'text_delta', text: 'A2' }, ctxA);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B1' }, ctxB);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B2' }, ctxB);

    expect(assistantTextFrames().map((frame) => [frame.msg.turnId, frame.text])).toEqual([
      ['turn-a', 'A1'],
      ['turn-b', 'B1'],
    ]);

    __testHandleEngineEvent({ type: 'turn_end', stopReason: 'end_turn' }, ctxA);
    expect(assistantTextFrames().map((frame) => [frame.msg.turnId, frame.text])).toEqual([
      ['turn-a', 'A1'],
      ['turn-b', 'B1'],
      ['turn-a', 'A2'],
    ]);

    __testHandleEngineEvent({ type: 'turn_end', stopReason: 'end_turn' }, ctxB);
    expect(assistantTextFrames().map((frame) => [frame.msg.turnId, frame.text])).toEqual([
      ['turn-a', 'A1'],
      ['turn-b', 'B1'],
      ['turn-a', 'A2'],
      ['turn-b', 'B2'],
    ]);
    expect(ctxA.assistantTextParts.join('')).toBe('A1A2');
    expect(ctxB.assistantTextParts.join('')).toBe('B1B2');
  });

  it('flushes buffered text before metadata events so wire order stays deterministic', () => {
    const hctx = makeHandlerCtx();

    __testHandleEngineEvent({ type: 'text_delta', text: 'A' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B' }, hctx);
    __testHandleEngineEvent({ type: 'usage', inputTokens: 3, outputTokens: 5 }, hctx);

    const textAndEvents = sent.map((msg) => {
      const content = Array.isArray(msg.data?.message?.content) ? msg.data.message.content : [];
      const text = content.find((part) => part?.type === 'text')?.text;
      if (text) return `text:${text}`;
      if (msg.event?.type) return `event:${msg.event.type}`;
      return 'other';
    });

    expect(textAndEvents).toEqual(['text:A', 'text:B', 'event:context_usage']);
  });

  it('flushes buffered text before error metadata and the visible error message', () => {
    const hctx = makeHandlerCtx();
    const err = new Error('provider exploded');

    __testHandleEngineEvent({ type: 'text_delta', text: 'A' }, hctx);
    __testHandleEngineEvent({ type: 'text_delta', text: 'B' }, hctx);
    __testHandleEngineEvent({ type: 'error', error: err, retryable: false }, hctx);

    const wireOrder = sent.map((msg) => {
      const content = Array.isArray(msg.data?.message?.content) ? msg.data.message.content : [];
      const text = content.find((part) => part?.type === 'text')?.text;
      if (text) return `text:${text}`;
      if (msg.event?.type) return `event:${msg.event.type}`;
      return 'other';
    });

    expect(wireOrder).toEqual([
      'text:A',
      'text:B',
      'event:error',
      'text:⚠️ Error: provider exploded',
    ]);
  });
});
