import { describe, it, expect } from 'vitest';
import { translateCopilotEvent, createNdjsonParser } from '../../../agent/providers/copilot.js';

describe('copilot driver — translateCopilotEvent', () => {
  const state = { sessionId: 'sess-123' };

  it('forwards text events as assistant text envelopes', () => {
    const out = translateCopilotEvent({ type: 'text', text: 'hi' }, state);
    expect(out).toEqual([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);
  });

  it('supports text_delta alias', () => {
    const out = translateCopilotEvent({ type: 'text_delta', delta: 'partial' }, state);
    expect(out[0].message.content[0].text).toBe('partial');
  });

  it('translates tool_call into Claude tool_use shape', () => {
    const out = translateCopilotEvent(
      { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      state,
    );
    expect(out[0].message.content[0]).toEqual({
      type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' },
    });
  });

  it('translates tool_result into user/tool_result shape', () => {
    const out = translateCopilotEvent(
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      state,
    );
    expect(out[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    });
  });

  it('emits a success result envelope on done', () => {
    const out = translateCopilotEvent({ type: 'done' }, state);
    expect(out[0]).toMatchObject({
      type: 'result', subtype: 'success', session_id: 'sess-123', is_error: false,
    });
  });

  it('emits error result envelope on error event', () => {
    const out = translateCopilotEvent({ type: 'error', message: 'boom' }, state);
    expect(out[0]).toMatchObject({ type: 'result', subtype: 'error', is_error: true, error: 'boom' });
  });

  it('drops unknown event types defensively', () => {
    const out = translateCopilotEvent({ type: 'totally_unknown' }, state);
    expect(out).toEqual([]);
  });
});

describe('copilot driver — NDJSON parser', () => {
  it('emits one event per line, drops blanks, survives partial chunks', () => {
    const events = [];
    const p = createNdjsonParser((e) => events.push(e));
    p.push('{"type":"text","text":"a"}\n\n{"type":"text",');
    p.push('"text":"b"}\n');
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('drops unparsable lines without throwing', () => {
    const events = [];
    const p = createNdjsonParser((e) => events.push(e));
    p.push('not-json\n{"type":"done"}\n');
    expect(events).toEqual([{ type: 'done' }]);
  });
});
