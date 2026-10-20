import { describe, expect, it } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { createBashTool } from '../../../agent/yeaft/tools/bash.js';
import fileReadTool from '../../../agent/yeaft/tools/file-read.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    yield* response(requests.length, params);
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

    const unavailable = setup(n => n <= 12 ? [call(`missing-${n}`, 'Unavailable'), stop]
      : [{ type: 'text_delta', text: 'Tool is unavailable; cannot proceed.' }, { type: 'stop', stopReason: 'end_turn' }]);
    const missingEvents = await consume(unavailable.engine);
    expect(unavailable.requests).toHaveLength(13);
    expect(missingEvents.filter(e => e.type === 'tool_end')).toHaveLength(12);
    expect(missingEvents.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ failedCalls: 12, toolExecutions: 0 });
    expect(missingEvents.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'no_progress' })]);
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
    for (const error of ['connection timeout after dispatch', 'schema migration timeout after dispatch',
      'validation request disconnected after dispatch']) {
      const { engine, requests } = setup(n => n <= 3 ? [call(`w${n}`, 'Send'), stop]
        : [{ type: 'text_delta', text: 'Need to verify delivery state.' }, { type: 'stop', stopReason: 'end_turn' }]);
      let executions = 0;
      engine.registerTool({ name: 'Send', execute: async () => { executions++; throw Error(error); } });
      const events = await consume(engine);
      expect(executions, error).toBe(1);
      expect(events.filter(e => e.type === 'tool_end')).toHaveLength(3);
      expect(events.filter(e => e.type === 'tool_end' && e.suppressed)).toHaveLength(2);
      expect(JSON.stringify(requests.at(-1).messages)).toContain('side effects may already have happened');
    }

    // A command may create the missing file before a later step fails. The
    // previously blocked read must execute to verify, but never replay the write.
    let exists = false;
    let readExecutions = 0;
    let writeExecutions = 0;
    const partial = setup(n => n <= 3 || n === 5
      ? [call(`read-${n}`, 'ReadMissing'), stop]
      : n === 4 || n === 6 ? [call(`create-${n}`, 'CreateThenFail'), stop]
        : [{ type: 'text_delta', text: 'Created state verified; write not retried.' }, { type: 'stop', stopReason: 'end_turn' }]);
    partial.engine.registerTool({ name: 'ReadMissing', isReadOnly: () => true, execute: async () => {
      readExecutions++;
      if (!exists) throw Error('ENOENT');
      return 'created content';
    } });
    partial.engine.registerTool({ name: 'CreateThenFail', execute: async () => {
      writeExecutions++;
      exists = true;
      throw Error('connection timeout after creating file');
    } });
    const partialEvents = await consume(partial.engine);
    expect(readExecutions).toBe(4);
    expect(writeExecutions).toBe(1);
    expect(partialEvents.filter(e => e.type === 'tool_end')).toHaveLength(6);
    expect(partial.rows.filter(r => r.role === 'tool').some(r => r.content === 'created content')).toBe(true);
  });

  it('reruns a confirmed nonzero Bash command after a successful repair', async () => {
    let repaired = false;
    let executions = 0;
    const { engine, requests } = setup(n => n === 1 || n === 3
      ? [call(`test-${n}`, 'Bash', { command: 'npm test' }), stop]
      : n === 2 ? [call('repair', 'FileEdit', { path: 'rfc' }), stop]
        : [{ type: 'text_delta', text: 'Tests passed after repair.' }, { type: 'stop', stopReason: 'end_turn' }]);
    engine.registerTool(createBashTool({ runProcessImpl: async () => {
      executions++;
      return { code: repaired ? 0 : 1, stdout: repaired ? 'PASS' : 'FAIL', stderr: '', timedOut: false };
    } }));
    engine.registerTool({ name: 'FileEdit', execute: async () => { repaired = true; return 'file repaired'; } });
    const events = await consume(engine);
    expect(executions).toBe(2);
    expect(requests).toHaveLength(4);
    expect(events.some(e => e.type === 'tool_end' && e.suppressed)).toBe(false);
    expect(events.filter(e => e.type === 'tool_end').at(-1)).toMatchObject({ output: 'PASS' });
  });

  it('treats distinct negative read observations as evidence, not repeated failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-schema-validation-forbidden-'));
    try {
      await writeFile(join(dir, 'candidate-20.json'), 'target evidence');
      const { engine, requests, rows } = setup(n => n <= 20
        ? [call(`candidate-${n}`, 'FileRead', { file_path: join(dir, `candidate-${n}.json`) }), stop]
        : [{ type: 'text_delta', text: 'Found target.' }, { type: 'stop', stopReason: 'end_turn' }]);
      engine.registerTool(fileReadTool);
      const events = await consume(engine);
      expect(requests).toHaveLength(21);
      expect(rows.some(row => row.role === 'tool' && row.content.includes('target evidence'))).toBe(true);
      expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({
        stage: 'running', repeatedCalls: 0, failedCalls: 19, stagnantBatches: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('consumes an owned completion accepted during reporting (another task pending: %s)', async remainingTask => {
    let engine;
    let delivered = false;
    const run = setup(n => {
      if (n === 1) return [call('start', 'Start'), stop];
      if (n <= 14) return [call(`read-${n}`, 'Read'), stop];
      if (n === 15) {
        delivered = engine.notifyAsyncTaskCompleted('owned', 'NEW_BACKGROUND_EVIDENCE');
      }
      if (n === 16 && remainingTask) {
        expect(engine.notifyAsyncTaskCompleted('other', 'SECOND_BACKGROUND_EVIDENCE')).toBe(true);
      }
      return [{ type: 'text_delta', text: n === 15 ? 'Paused.' : 'Consumed new evidence.' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    engine = run.engine;
    engine.registerTool({ name: 'Start', execute: async (_input, ctx) => {
      ctx.registerAsyncTask('owned');
      if (remainingTask) ctx.registerAsyncTask('other');
      return 'started';
    } });
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = await consume(engine);
    expect(delivered).toBe(true);
    expect(run.requests).toHaveLength(remainingTask ? 17 : 16);
    if (remainingTask) expect(JSON.stringify(run.requests[16].messages)).toContain('SECOND_BACKGROUND_EVIDENCE');
    expect(run.requests[14].tools).toBeUndefined();
    expect(run.requests[15].tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.requests[15].messages)).toContain('NEW_BACKGROUND_EVIDENCE');
    expect(events.some(e => e.type === 'tool_result_update' && e.taskId === 'owned')).toBe(true);
    expect(events.some(e => e.code === 'no_progress')).toBe(false);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
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

    // A normal tool-free stream drains input on a different path than reporting.
    let normal;
    let repaired = false;
    let reads = 0;
    normal = setup(n => {
      if (n <= 3 || n === 5) return [call(`permission-${n}`, 'Read'), stop];
      if (n === 4) {
        repaired = true;
        normal.engine.appendUserMessage('Permissions repaired; retry the read.');
      }
      return [{ type: 'text_delta', text: 'acknowledged' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    normal.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      reads++;
      if (!repaired) throw Error('EACCES');
      return 'verified recovered file';
    } });
    await consume(normal.engine);
    expect(reads).toBe(4);
    expect(normal.rows.some(row => row.content === 'verified recovered file')).toBe(true);

    // An owned async completion is a synchronization boundary even while parked
    // after a tool-free response; it must clear stale read-failure guards.
    repaired = false;
    reads = 0;
    const asyncWork = setup(n => n <= 3 || n === 6 ? [call(`async-read-${n}`, 'Read'), stop]
      : n === 4 ? [call('start-owned', 'Start'), stop]
        : [{ type: 'text_delta', text: 'waiting or finished' }, { type: 'stop', stopReason: 'end_turn' }]);
    asyncWork.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      reads++;
      if (!repaired) throw Error('EACCES');
      return 'async repaired file';
    } });
    asyncWork.engine.registerTool({ name: 'Start', isReadOnly: () => true, execute: async (_input, ctx) => {
      ctx.registerAsyncTask('owned-result');
      return 'background work started';
    } });
    for await (const event of asyncWork.engine.query({ prompt: 'verify repaired file', sessionId: 's' })) {
      if (event.type === 'async_task_wait_start') {
        repaired = true;
        expect(asyncWork.engine.notifyAsyncTaskCompleted('owned-result', 'permissions repaired')).toBe(true);
      }
    }
    expect(reads).toBe(4);
    expect(asyncWork.rows.some(row => row.content === 'async repaired file')).toBe(true);
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

    // Normal calls were already persisted before this new progress yield.
    // Aborting here must still synthesize every skipped tool result.
    const normalAbort = new AbortController();
    let dispatched = 0;
    const normal = setup(() => [call('paired-a', 'Read'), call('paired-b', 'Read'), stop]);
    normal.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => { dispatched++; return 'not expected'; } });
    const normalEvents = [];
    for await (const event of normal.engine.query({ prompt: 'cancel batch', sessionId: 's', signal: normalAbort.signal })) {
      normalEvents.push(event);
      if (event.type === 'query_progress') normalAbort.abort();
    }
    expect(dispatched).toBe(0);
    expect(normalEvents.filter(e => e.type === 'tool_end')).toHaveLength(2);
    expect(normal.rows.filter(row => row.role === 'tool')).toHaveLength(2);
    expect(normalEvents.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'aborted' })]);
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
