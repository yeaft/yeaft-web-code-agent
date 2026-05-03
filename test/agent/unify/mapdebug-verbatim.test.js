/**
 * mapdebug-verbatim.test.js — feat-openai-raw-exchange-parity follow-up.
 *
 * Pins the verbatim contract on `mapDebugMessage`. The whole point of the
 * Unify debug feature is byte-equality with what we sent to the LLM — a
 * truncated copy is misleading, not just less useful. Without a regression
 * test the next "huge debug payload broke a websocket frame" Slack message
 * could helpfully reintroduce a slice() call and silently corrupt the
 * feature again.
 *
 * Regression target: PR #702 deleted `content.slice(0, 50000)` and the
 * `JSON.stringify(input).slice(0, 10000)` for tool calls. This test
 * exercises both paths with payloads that previously would have been cut.
 */

import { describe, it, expect } from 'vitest';
import { mapDebugMessage } from '../../../agent/unify/engine.js';

describe('mapDebugMessage — verbatim contract', () => {
  it('passes string content through verbatim, even past 50_000 chars', () => {
    const big = 'x'.repeat(60_000);
    const out = mapDebugMessage({ role: 'assistant', content: big });
    expect(typeof out.content).toBe('string');
    expect(out.content.length).toBe(60_000);
    expect(out.content).toBe(big);
  });

  it('passes structured content through verbatim (no JSON-stringify-then-slice)', () => {
    // E.g. an assistant turn with array content (some adapters)
    const blocks = [
      { type: 'text', text: 'a'.repeat(15_000) },
      { type: 'text', text: 'b'.repeat(15_000) },
    ];
    const out = mapDebugMessage({ role: 'assistant', content: blocks });
    expect(out.content).toBe(blocks);
    expect(out.content[0].text.length).toBe(15_000);
    expect(out.content[1].text.length).toBe(15_000);
  });

  it('passes toolCall.input through verbatim (no JSON.stringify().slice(0,10000))', () => {
    const huge = { blob: 'y'.repeat(20_000), nested: { deep: 'z'.repeat(10_000) } };
    const out = mapDebugMessage({
      role: 'assistant',
      content: 'with a tool call',
      toolCalls: [{ id: 'call_1', name: 'do_thing', input: huge }],
    });
    expect(Array.isArray(out.toolCalls)).toBe(true);
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].input).toEqual(huge);
    expect(out.toolCalls[0].input.blob.length).toBe(20_000);
    // The shape on the call must be { id, name, input } only — no
    // accidentally-leaked extra fields like `inputJson`/`truncated`.
    expect(Object.keys(out.toolCalls[0]).sort()).toEqual(['id', 'input', 'name']);
  });

  it('preserves toolCallId + isError on tool messages', () => {
    const out = mapDebugMessage({
      role: 'tool',
      toolCallId: 'call_42',
      content: 'tool result body',
      isError: true,
    });
    expect(out.role).toBe('tool');
    expect(out.toolCallId).toBe('call_42');
    expect(out.content).toBe('tool result body');
    expect(out.isError).toBe(true);
  });

  it('does not mutate the input message (pure function)', () => {
    const input = {
      role: 'assistant',
      content: 'hi',
      toolCalls: [{ id: 'a', name: 'b', input: { x: 1 } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    mapDebugMessage(input);
    expect(input).toEqual(snapshot);
  });
});
