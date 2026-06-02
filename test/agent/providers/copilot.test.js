import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
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

describe('copilot driver — sendInput end-to-end (mocked spawn)', () => {
  it('synthesizes an error result envelope when child exits nonzero with no stdout', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = ctxMod.default.CONFIG || {};

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    vi.doMock('child_process', () => ({ spawn: () => child }));
    const copilot = await import('../../../agent/providers/copilot.js?fresh=1');

    const state = await copilot.start({ conversationId: 'c1', workDir: '/tmp' });
    const pending = copilot.sendInput(state, 'hi', { conversationId: 'c1' });
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('boom'));
      child.emit('close', 1);
    });
    await pending;

    const result = sent.find((m) => m.type === 'claude_output' && m.data?.type === 'result');
    expect(result).toBeTruthy();
    expect(result.data.is_error).toBe(true);
    expect(result.data.error).toContain('boom');
    const turn = sent.find((m) => m.type === 'turn_completed');
    expect(turn).toBeTruthy();
    vi.doUnmock('child_process');
  });
});
