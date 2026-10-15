import { describe, expect, it } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

function setup(response) {
  const requests = [];
  const rows = [];
  const store = {
    append(row) { const saved = { ...row, id: `m${rows.length + 1}`, seq: rows.length + 1 }; rows.push(saved); return saved; },
    loadRecentBySession() { return []; },
    update(row, patch) { Object.assign(row, patch); return row; },
  };
  const adapter = { async *stream(params) {
    requests.push(structuredClone({ tools: params.tools, system: params.system, messages: params.messages }));
    yield* response(requests.length);
  } };
  const engine = new Engine({ adapter, trace: new NullTrace(), conversationStore: store,
    config: { model: 'test-model', maxOutputTokens: 1024 } });
  return { engine, requests, rows };
}
const call = (id, name, input = {}) => ({ type: 'tool_call', id, name, input });
const stop = { type: 'stop', stopReason: 'tool_use' };
async function consume(engine, extra = {}) {
  const events = [];
  for await (const event of engine.query({ prompt: 'modify the RFC, then verify', sessionId: 's', ...extra })) events.push(event);
  return events;
}

describe('query progress Engine boundaries', () => {
  it('pairs the complete batch then reserves one tool-free report; ignores unsolicited report tools', async () => {
    const { engine, requests, rows } = setup(n => n <= 13
      ? [{ type: 'text_delta', text: 'I will edit shortly.' }, call(`a${n}`, 'ReadA'), call(`b${n}`, 'ReadB'), stop]
      : [call('must-not-run', 'Write'), { type: 'stop', stopReason: 'max_tokens' }]);
    let executions = 0;
    for (const name of ['ReadA', 'ReadB']) engine.registerTool({ name, isReadOnly: () => true,
      execute: async () => { executions++; return `unchanged ${name}`; } });
    engine.registerTool({ name: 'Write', execute: async () => { throw Error('report must not execute'); } });
    const events = await consume(engine);
    expect(executions).toBe(26);
    expect(requests).toHaveLength(14);
    expect(requests.at(-1).tools).toBeUndefined();
    expect(events.filter(e => e.type === 'tool_end')).toHaveLength(26);
    expect(rows.filter(r => r.role === 'tool')).toHaveLength(26);
    expect(rows.some(r => r.content.includes('requested task is not confirmed complete'))).toBe(true);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
      expect.objectContaining({ stopReason: 'no_progress' }),
    ]);
    expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ stage: 'stopped', toolExecutions: 26 });
    // Reminders are model-only, and raw tool output is never replaced in persistence.
    expect(rows.filter(r => r.role === 'tool').every(r => r.content.startsWith('unchanged'))).toBe(true);
    expect(rows.some(r => r.content.startsWith('[system note] Query progress'))).toBe(false);
  });

  it('allows long fresh investigations, reports exact dispatch count and supplies durable history boundary', async () => {
    const { engine, requests } = setup(n => n <= 30
      ? [call(`r${n}`, 'Read', { offset: n }), stop]
      : [{ type: 'text_delta', text: 'verified output' }, { type: 'stop', stopReason: 'end_turn' }]);
    const contexts = [];
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async (input, ctx) => {
      contexts.push(ctx); return `page ${input.offset}`;
    } });
    const events = await consume(engine);
    expect(requests).toHaveLength(31);
    expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ stage: 'running', modelRequests: 31 });
    expect(contexts.every(ctx => ctx.historyBeforeSeq === 1 && typeof ctx.queryTurnId === 'string')).toBe(true);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)[0]).toMatchObject({ stopReason: 'end_turn' });
  });

  it('never replays an uncertain side effect and retains a result for every rejected tool call', async () => {
    const { engine, requests } = setup(n => n <= 3 ? [call(`w${n}`, 'Send'), stop]
      : [{ type: 'text_delta', text: 'Need to verify delivery state.' }, { type: 'stop', stopReason: 'end_turn' }]);
    let executions = 0;
    engine.registerTool({ name: 'Send', execute: async () => { executions++; throw Error('connection timeout after dispatch'); } });
    const events = await consume(engine);
    expect(executions).toBe(1);
    expect(events.filter(e => e.type === 'tool_end')).toHaveLength(3);
    expect(events.filter(e => e.type === 'tool_end' && e.suppressed)).toHaveLength(2);
    expect(JSON.stringify(requests.at(-1).messages)).toContain('side effects may already have happened');
  });

  it('preserves accepted user input arriving during the reporting stream', async () => {
    let engine;
    let closeAttempts = 0;
    const setupResult = setup(n => {
      if (n <= 13) return [call(`r${n}`, 'Read'), stop];
      if (n === 14) {
        engine.appendUserMessage('Use the existing RFC and apply the edit now.');
        return [{ type: 'text_delta', text: 'Paused investigation.' }, { type: 'stop', stopReason: 'end_turn' }];
      }
      return [{ type: 'text_delta', text: 'New instruction received.' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    engine = setupResult.engine;
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = await consume(engine, { closePendingUserInput: () => { closeAttempts++; return true; } });
    expect(setupResult.requests).toHaveLength(15);
    expect(JSON.stringify(setupResult.requests.at(-1).messages)).toContain('apply the edit now');
    expect(events.some(e => e.type === 'user_append')).toBe(true);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
    expect(closeAttempts).toBe(1);
  });

  it('honors abort at the report progress yield without publishing a fallback or no-progress error', async () => {
    const controller = new AbortController();
    const { engine, requests, rows } = setup(n => n <= 13 ? [call(`r${n}`, 'Read'), stop]
      : [{ type: 'stop', stopReason: 'end_turn' }]);
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = [];
    for await (const event of engine.query({ prompt: 'edit RFC', sessionId: 's', signal: controller.signal })) {
      events.push(event);
      if (event.type === 'query_progress' && requests.length === 14) controller.abort();
    }
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'aborted' })]);
    expect(events.some(e => e.code === 'no_progress')).toBe(false);
    expect(rows.some(r => String(r.content).includes('requested task is not confirmed complete'))).toBe(false);
  });

  it('keeps user abort authoritative without starting a recovery response', async () => {
    const controller = new AbortController();
    const { engine, requests } = setup(n => [call(`r${n}`, 'Read'), stop]);
    let count = 0;
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      if (++count === 6) controller.abort();
      return 'same';
    } });
    const events = await consume(engine, { signal: controller.signal });
    expect(requests).toHaveLength(6);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toHaveLength(1);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)[0].stopReason).not.toBe('no_progress');
  });
});
