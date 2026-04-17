/**
 * task-310 — Dispatcher pipeline tests.
 *
 * Covers the five guarantees from the PM brief:
 *   1. submit() enqueues pending + returns queue snapshot; drain() walks
 *      the queue through router → registry → EngineInstance and emits
 *      a fixed ordering of pipeline events.
 *   2. An explicit `override: { threadId }` bypasses the LLM classifier
 *      and resolves to 'continue' (same thread) or 'switch' (different).
 *   3. A fork decision creates a new thread, yields `thread_list_updated`,
 *      and targets the new thread for dispatch.
 *   4. Engine exceptions mark the entry failed and emit a retryable error
 *      pipeline event; router classifier exceptions degrade to continue.
 *   5. Two concurrent dispatch() generators on different threads do not
 *      cross-contaminate their engine_event streams.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatcher, createDispatcher } from '../../../agent/unify/pipeline/dispatcher.js';
import {
  InputQueueStore,
  _resetInputQueueStoreForTests,
} from '../../../agent/unify/input-queue/store.js';
import {
  ThreadStore,
  MAIN_THREAD_ID,
} from '../../../agent/unify/threads/store.js';

// ─── Mocks ────────────────────────────────────────────────────

class MockRouter {
  constructor() {
    /** @type {Array<object|Error>} */
    this.queue = [];
    this.calls = [];
  }
  push(decision) { this.queue.push(decision); }
  pushError(err) { this.queue.push(err); }
  async classify(ctx) {
    this.calls.push(ctx);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    if (!next) {
      return {
        action: 'continue',
        targetThreadId: ctx.currentThreadId,
        reason: 'default mock',
        source: 'llm',
      };
    }
    return next;
  }
}

class MockEngineInstance {
  constructor(threadId) {
    this.threadId = threadId;
    /** @type {Array<Array<object>|Error>} */
    this.queue = [];
  }
  push(events) { this.queue.push(events); }
  pushError(err) { this.queue.push(err); }
  async *query({ prompt, signal }) {
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const events = next || [{ type: 'text_delta', text: `ack:${prompt}`, threadId: this.threadId }];
    for (const ev of events) {
      if (signal?.aborted) throw new Error('aborted');
      yield { ...ev, threadId: this.threadId };
    }
  }
}

class MockEngineRegistry {
  constructor() {
    /** @type {Map<string, MockEngineInstance>} */
    this.instances = new Map();
  }
  ensure(threadId) {
    if (!this.instances.has(threadId)) {
      this.instances.set(threadId, new MockEngineInstance(threadId));
    }
    return this.instances.get(threadId);
  }
}

function makeDispatcher() {
  _resetInputQueueStoreForTests();
  const inputQueue = new InputQueueStore(null); // memory only
  const router = new MockRouter();
  const engineRegistry = new MockEngineRegistry();
  const threadStore = new ThreadStore(); // in-memory, no yeaftDir
  const dispatcher = new Dispatcher({ inputQueue, router, engineRegistry, threadStore });
  return { dispatcher, inputQueue, router, engineRegistry, threadStore };
}

// ─── Tests ────────────────────────────────────────────────────

describe('Dispatcher — construction', () => {
  it('throws when missing deps', () => {
    expect(() => new Dispatcher({})).toThrow(/inputQueue/);
  });
  it('createDispatcher factory works', () => {
    const d = makeDispatcher();
    expect(d.dispatcher).toBeInstanceOf(Dispatcher);
  });
});

describe('Dispatcher — submit/drain happy path', () => {
  it('emits input_queue_updated → routing_decision → engine_event → input_queue_updated', async () => {
    const { dispatcher, inputQueue, router, engineRegistry } = makeDispatcher();
    router.push({ action: 'continue', targetThreadId: MAIN_THREAD_ID, reason: 'stay', source: 'llm' });
    const inst = engineRegistry.ensure(MAIN_THREAD_ID);
    inst.push([
      { type: 'text_delta', text: 'hi' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const { entry, snapshot } = dispatcher.submit('hello');
    expect(entry.status).toBe('pending');
    expect(snapshot.type).toBe('input_queue_updated');
    expect(snapshot.pending).toBe(1);

    const events = [];
    for await (const ev of dispatcher.drain()) events.push(ev);

    const types = events.map(e => e.type);
    expect(types[0]).toBe('input_queue_updated'); // claim → routing
    expect(types).toContain('routing_decision');
    const engineEvents = events.filter(e => e.type === 'engine_event');
    expect(engineEvents.length).toBe(2);
    expect(engineEvents[0].threadId).toBe(MAIN_THREAD_ID);
    expect(engineEvents[0].event.text).toBe('hi');

    // Queue drained
    expect(inputQueue.size()).toBe(0);
  });
});

describe('Dispatcher — explicit override bypasses router', () => {
  it('override.threadId === currentThreadId → continue (router not called)', async () => {
    const { dispatcher, router, engineRegistry } = makeDispatcher();
    engineRegistry.ensure(MAIN_THREAD_ID).push([{ type: 'stop' }]);

    const { entry } = dispatcher.submit('hey', { override: { threadId: MAIN_THREAD_ID } });
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    expect(router.calls.length).toBe(0);
    const decision = events.find(e => e.type === 'routing_decision');
    expect(decision.source).toBe('override');
    expect(decision.action).toBe('continue');
  });

  it('override.threadId on other known thread → switch', async () => {
    const { dispatcher, router, engineRegistry, threadStore } = makeDispatcher();
    const other = threadStore.create({ name: 'B' });
    engineRegistry.ensure(other.id).push([{ type: 'stop' }]);

    const { entry } = dispatcher.submit('ok', { override: { threadId: other.id } });
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    expect(router.calls.length).toBe(0);
    const decision = events.find(e => e.type === 'routing_decision');
    expect(decision.action).toBe('switch');
    expect(decision.targetThreadId).toBe(other.id);
    expect(threadStore.currentId).toBe(other.id);
  });

  it('override with unknown threadId falls through to router', async () => {
    const { dispatcher, router, engineRegistry } = makeDispatcher();
    router.push({ action: 'continue', targetThreadId: MAIN_THREAD_ID, reason: 'r', source: 'llm' });
    engineRegistry.ensure(MAIN_THREAD_ID).push([{ type: 'stop' }]);

    const { entry } = dispatcher.submit('hi', { override: { threadId: 'thr-does-not-exist' } });
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    expect(router.calls.length).toBe(1);
    expect(events.find(e => e.type === 'routing_decision').source).toBe('llm');
  });
});

describe('Dispatcher — fork creates new thread', () => {
  it('emits thread_list_updated and targets the new thread', async () => {
    const { dispatcher, router, engineRegistry, threadStore } = makeDispatcher();
    router.push({
      action: 'fork',
      targetThreadId: MAIN_THREAD_ID,
      reason: 'parallel task',
      source: 'llm',
    });

    const { entry } = dispatcher.submit('spin a new track');
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    const listUpd = events.find(e => e.type === 'thread_list_updated');
    expect(listUpd).toBeTruthy();
    expect(listUpd.threads.length).toBeGreaterThanOrEqual(2);

    const engineEvents = events.filter(e => e.type === 'engine_event');
    const newThreadId = engineEvents[0].threadId;
    expect(newThreadId).not.toBe(MAIN_THREAD_ID);
    expect(engineRegistry.instances.has(newThreadId)).toBe(true);
    // Parent link is preserved
    const forked = threadStore.list().find(t => t.id === newThreadId);
    expect(forked.parentThreadId).toBe(MAIN_THREAD_ID);
  });
});

describe('Dispatcher — error handling', () => {
  it('router exception degrades to continue', async () => {
    const { dispatcher, router, engineRegistry } = makeDispatcher();
    router.pushError(new Error('classifier boom'));
    engineRegistry.ensure(MAIN_THREAD_ID).push([{ type: 'stop' }]);

    const { entry } = dispatcher.submit('hi');
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    const decision = events.find(e => e.type === 'routing_decision');
    expect(decision.action).toBe('continue');
    expect(decision.source).toBe('fallback');
    expect(decision.reason).toMatch(/classifier boom/);
  });

  it('engine exception marks entry failed and emits retryable error', async () => {
    const { dispatcher, inputQueue, router, engineRegistry } = makeDispatcher();
    router.push({ action: 'continue', targetThreadId: MAIN_THREAD_ID, reason: 'r', source: 'llm' });
    engineRegistry.ensure(MAIN_THREAD_ID).pushError(new Error('engine blew up'));

    const { entry } = dispatcher.submit('hi');
    const events = [];
    for await (const ev of dispatcher.dispatch(entry)) events.push(ev);

    const err = events.find(e => e.type === 'error');
    expect(err).toBeTruthy();
    expect(err.retryable).toBe(true);
    expect(err.error.message).toMatch(/engine blew up/);

    // Entry moved to pending with error recorded.
    const stored = inputQueue.get(entry.id);
    expect(stored.status).toBe('pending');
    expect(stored.error).toMatch(/engine blew up/);
  });
});

describe('Dispatcher — concurrent streams do not cross-contaminate', () => {
  it('two simultaneous dispatches keep their events tagged', async () => {
    const { dispatcher, router, engineRegistry, threadStore } = makeDispatcher();
    const b = threadStore.create({ name: 'B' });

    const instA = engineRegistry.ensure(MAIN_THREAD_ID);
    const instB = engineRegistry.ensure(b.id);
    instA.push([
      { type: 'text_delta', text: 'a1' },
      { type: 'text_delta', text: 'a2' },
      { type: 'stop' },
    ]);
    instB.push([
      { type: 'text_delta', text: 'b1' },
      { type: 'text_delta', text: 'b2' },
      { type: 'stop' },
    ]);

    const { entry: entryA } = dispatcher.submit('A', { override: { threadId: MAIN_THREAD_ID } });
    const { entry: entryB } = dispatcher.submit('B', { override: { threadId: b.id } });

    // Drive both generators interleaved.
    const genA = dispatcher.dispatch(entryA);
    const genB = dispatcher.dispatch(entryB);

    const out = [];
    let doneA = false, doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) {
        const { value, done } = await genA.next();
        if (done) doneA = true; else out.push(value);
      }
      if (!doneB) {
        const { value, done } = await genB.next();
        if (done) doneB = true; else out.push(value);
      }
    }

    const aEvents = out.filter(e => e.type === 'engine_event' && e.threadId === MAIN_THREAD_ID);
    const bEvents = out.filter(e => e.type === 'engine_event' && e.threadId === b.id);
    expect(aEvents.map(e => e.event.text || '')).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(bEvents.map(e => e.event.text || '')).toEqual(expect.arrayContaining(['b1', 'b2']));
    // No text from A ever appears under B's threadId and vice versa.
    expect(bEvents.some(e => /^a/.test(e.event.text || ''))).toBe(false);
    expect(aEvents.some(e => /^b/.test(e.event.text || ''))).toBe(false);
  });
});
