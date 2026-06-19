import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

/**
 * Adapter that yields a queued response per stream() call. Tests push
 * adapter behaviour per loop iteration; the engine pulls them in order.
 */
class QueueAdapter {
  constructor() {
    this.responses = [];
    this.streamCalls = [];
  }
  pushResponse(events) { this.responses.push(events); }
  async *stream(params) {
    this.streamCalls.push({
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    const events = this.responses.shift();
    if (!events) throw new Error('QueueAdapter: no more responses queued');
    for (const ev of events) yield ev;
  }
  async call() { return { text: 'ok', usage: {} }; }
}

function endTurn(text = 'done') {
  return [
    { type: 'text_delta', text },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

function buildEngine() {
  const adapter = new QueueAdapter();
  const engine = new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
  });
  return { engine, adapter };
}

async function drainEvents(it) {
  const events = [];
  for await (const ev of it) events.push(ev);
  return events;
}

describe('engine — same-turn background task wait', () => {
  let engine, adapter;

  beforeEach(() => {
    ({ engine, adapter } = buildEngine());
  });

  it('end_turn waits for terminal task event, then resumes for one more loop', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-xyz');
        return 'Started background task task-xyz.';
      },
    });

    // Loop 1: model calls fakeBgTool. Tool returns immediately and
    // registers the async task with the engine.
    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Loop 2: model says end_turn. With our fix, engine should park
    // because task-xyz is still pending — NOT emit turn_end.
    a.pushResponse(endTurn('launched, awaiting result'));
    // Loop 3 (after we deliver the task result): model says end_turn
    // for real.
    a.pushResponse(endTurn('handled task result'));

    // Run query() in the background so we can deliver the task result
    // mid-flight from the test driver.
    const events = [];
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do the thing',
        messages: [],
      })) {
        events.push(ev);
        // The moment we see async_task_wait_start, deliver the task
        // result. This is exactly what web-bridge's task event sink
        // does in production.
        if (ev.type === 'async_task_wait_start') {
          const accepted = e.notifyAsyncTaskCompleted(
            'task-xyz',
            '<task-result id="task-xyz" status="succeeded">all good</task-result>',
            { preview: 'task succeeded' },
          );
          expect(accepted).toBe(true);
        }
      }
    })();

    await queryPromise;

    // Verify the adapter was called three times — one for the initial
    // turn, one for the parked end_turn, one for the post-injection loop.
    expect(a.streamCalls.length).toBe(3);

    // Verify a user-role message containing the task result was on
    // the wire for the third call (the post-injection loop).
    const lastCallMessages = a.streamCalls[2].messages;
    const lastMessageText = JSON.stringify(lastCallMessages);
    expect(lastMessageText).toContain('task-xyz');
    expect(lastMessageText).toContain('all good');

    // Engine should have emitted both wait_start and wait_end, plus
    // user_append for the synthetic task result, plus a final turn_end.
    const waitStart = events.find(ev => ev.type === 'async_task_wait_start');
    const waitEnd = events.find(ev => ev.type === 'async_task_wait_end');
    const userAppend = events.find(ev => ev.type === 'user_append');
    const finalTurnEnd = events.filter(ev => ev.type === 'turn_end').pop();

    expect(waitStart).toBeTruthy();
    expect(waitStart.pendingTaskIds).toContain('task-xyz');
    expect(waitEnd).toBeTruthy();
    expect(waitEnd.aborted).toBe(false);
    expect(userAppend).toBeTruthy();
    expect(userAppend.internal).toBe(true);
    expect(userAppend.taskId).toBe('task-xyz');
    expect(finalTurnEnd).toBeTruthy();
    expect(finalTurnEnd.stopReason).toBe('end_turn');

    // After query() returns, the engine must no longer claim ownership.
    expect(e.hasPendingAsyncTasks()).toBe(false);
    expect(e.ownsPendingAsyncTask('task-xyz')).toBe(false);
  });

  it('user append during the wait splices the user message and continues without dropping the still-pending task', async () => {
    const e = engine;
    const a = adapter;

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-slow');
        return 'Started background task task-slow.';
      },
    });

    // Loop 1: tool_use.
    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Loop 2: end_turn → parks.
    a.pushResponse(endTurn('parked'));
    // Loop 3: after user append, model says end_turn (no tool calls).
    // The task is still pending so this should park again.
    a.pushResponse(endTurn('replied to user, task still pending'));
    // Loop 4: after task result, model says end_turn for real.
    a.pushResponse(endTurn('all done'));

    const events = [];
    let userAppended = false;
    let taskCompleted = false;
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do it',
        messages: [],
      })) {
        events.push(ev);
        if (ev.type === 'async_task_wait_start' && !userAppended) {
          // Simulate the user typing into the same turn.
          userAppended = true;
          const ok = e.appendUserMessage('also tell me what you launched');
          expect(ok).toBe(true);
        } else if (ev.type === 'async_task_wait_start' && userAppended && !taskCompleted) {
          // Second time we park, the task is still in flight. Now
          // deliver its terminal event.
          taskCompleted = true;
          e.notifyAsyncTaskCompleted(
            'task-slow',
            '<task-result id="task-slow" status="succeeded">finally done</task-result>',
            { preview: 'slow task done' },
          );
        }
      }
    })();

    await queryPromise;

    // We expect FOUR adapter calls:
    //   1. initial tool_use
    //   2. end_turn → park
    //   3. after user_append injection → end_turn → park again (task still pending)
    //   4. after task result injection → final end_turn
    expect(a.streamCalls.length).toBe(4);

    const wireRound3 = JSON.stringify(a.streamCalls[2].messages);
    expect(wireRound3).toContain('also tell me what you launched');
    // The task hadn't completed before round 3, so the synthetic
    // `<task-result>` injection must NOT have been on the wire yet.
    // (The pre-existing tool_result row from loop 1 mentions the task
    // id verbatim — that's expected — so assert on the synthetic
    // wrapper instead.)
    expect(wireRound3).not.toContain('<task-result');

    const wireRound4 = JSON.stringify(a.streamCalls[3].messages);
    expect(wireRound4).toContain('finally done');

    // The user append before the task should NOT be tagged internal=true.
    const userAppendEvts = events.filter(ev => ev.type === 'user_append');
    expect(userAppendEvts.length).toBe(2);
    expect(userAppendEvts[0].internal).toBe(false);
    expect(userAppendEvts[0].preview).toContain('also tell me');
    expect(userAppendEvts[1].internal).toBe(true);
    expect(userAppendEvts[1].taskId).toBe('task-slow');

    // Two wait starts, two wait ends.
    expect(events.filter(ev => ev.type === 'async_task_wait_start').length).toBe(2);
    expect(events.filter(ev => ev.type === 'async_task_wait_end').length).toBe(2);
  });

  it('abort during wait exits the wait loop and finalizes the turn instead of hanging', async () => {
    const e = engine;
    const a = adapter;
    const ctrl = new AbortController();

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-never');
        return 'Started background task task-never.';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));

    const events = [];
    const queryPromise = (async () => {
      for await (const ev of e.query({
        prompt: 'do it',
        messages: [],
        signal: ctrl.signal,
      })) {
        events.push(ev);
        if (ev.type === 'async_task_wait_start') {
          // Abort the turn instead of completing the task.
          ctrl.abort();
        }
      }
    })();

    // Bounded wait so a regression doesn't hang the test runner forever.
    await Promise.race([
      queryPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('query hung after abort')), 2000)),
    ]);

    const waitEnd = events.find(ev => ev.type === 'async_task_wait_end');
    expect(waitEnd).toBeTruthy();
    expect(waitEnd.aborted).toBe(true);

    // After abort the engine should have cleared ownership.
    expect(e.hasPendingAsyncTasks()).toBe(false);
  });

  it('end_turn with no pending async tasks finalizes immediately (legacy behaviour unchanged)', async () => {
    const e = engine;
    const a = adapter;

    a.pushResponse(endTurn('quick reply'));

    const events = await drainEvents(e.query({
      prompt: 'hi',
      messages: [],
    }));

    expect(a.streamCalls.length).toBe(1);
    expect(events.find(ev => ev.type === 'async_task_wait_start')).toBeUndefined();
    const finalTurnEnd = events.filter(ev => ev.type === 'turn_end').pop();
    expect(finalTurnEnd.stopReason).toBe('end_turn');
  });

  it('coordinator onRegister / onUnregister is invoked for the full task lifecycle', async () => {
    const e = engine;
    const a = adapter;

    const registered = [];
    const unregistered = [];
    e.setAsyncTaskCoordinator({
      onRegister(taskId) { registered.push(taskId); },
      onUnregister(taskId) { unregistered.push(taskId); },
    });

    e.registerTool({
      name: 'fakeBgTool',
      description: 'launches a fake background task',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.registerAsyncTask('task-coord');
        return 'started';
      },
    });

    a.pushResponse([
      { type: 'tool_call', id: 'call-1', name: 'fakeBgTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    a.pushResponse(endTurn('parking'));
    a.pushResponse(endTurn('done'));

    const queryPromise = (async () => {
      for await (const ev of e.query({ prompt: 'do', messages: [] })) {
        if (ev.type === 'async_task_wait_start') {
          e.notifyAsyncTaskCompleted('task-coord', '<task-result>ok</task-result>');
        }
      }
    })();
    await queryPromise;

    expect(registered).toEqual(['task-coord']);
    expect(unregistered).toEqual(['task-coord']);
  });

  it('ownsPendingAsyncTask returns false for unknown taskId', () => {
    const e = engine;
    expect(e.ownsPendingAsyncTask('nope')).toBe(false);
    expect(e.notifyAsyncTaskCompleted('nope', 'irrelevant')).toBe(false);
  });
});
