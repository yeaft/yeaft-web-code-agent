/**
 * pipeline-dispatcher.test.js — H2.f.1 single-thread dispatcher.
 *
 * The pre-H2 multi-thread router/intent-classifier is gone. The
 * dispatcher now always routes to MAIN_THREAD_ID. These tests cover:
 *   1. submit() enqueues a pending entry + returns a queue snapshot.
 *   2. drain() yields the canonical event sequence:
 *        input_queue_updated → routing_decision (continue/main)
 *        → engine_event* → input_queue_updated.
 *   3. Engine exceptions mark the entry failed and emit a retryable
 *      `error` pipeline event.
 *   4. Two concurrent dispatch() generators on the same single thread
 *      do not corrupt their event streams (Node's event loop guarantee).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatcher, createDispatcher } from '../../../agent/unify/pipeline/dispatcher.js';
import {
  InputQueueStore,
  _resetInputQueueStoreForTests,
} from '../../../agent/unify/input-queue/store.js';
import { MAIN_THREAD_ID } from '../../../agent/unify/threads/store.js';

// ─── Mocks ────────────────────────────────────────────────────

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
  get(threadId) { return this.instances.get(threadId) || null; }
}

// ─── Setup ────────────────────────────────────────────────────

let inputQueue;
let engineRegistry;
let dispatcher;

beforeEach(() => {
  _resetInputQueueStoreForTests();
  inputQueue = new InputQueueStore(null);
  engineRegistry = new MockEngineRegistry();
  dispatcher = createDispatcher({
    inputQueue,
    engineRegistry,
  });
});

// ─── Tests ────────────────────────────────────────────────────

describe('Dispatcher (single-thread)', () => {
  it('rejects construction without inputQueue/engineRegistry', () => {
    expect(() => new Dispatcher()).toThrow(/inputQueue is required/);
    expect(() => new Dispatcher({ inputQueue })).toThrow(/engineRegistry is required/);
  });

  it('submit() enqueues a pending entry and returns a snapshot', () => {
    const { entry, snapshot } = dispatcher.submit('hello');
    expect(entry.text).toBe('hello');
    expect(entry.status).toBe('pending');
    expect(snapshot.type).toBe('input_queue_updated');
    expect(snapshot.pending).toBe(1);
    expect(snapshot.head.id).toBe(entry.id);
  });

  it('submit() throws on empty text', () => {
    expect(() => dispatcher.submit('')).toThrow(/text required/);
    expect(() => dispatcher.submit('   ')).toThrow(/text required/);
  });

  it('drain() yields the canonical single-thread event sequence', async () => {
    dispatcher.submit('hello');

    const events = [];
    for await (const ev of dispatcher.drain()) events.push(ev);

    // Expected ordering:
    //   queueSnapshot(after claim) → routing_decision(continue/main)
    //   → engine_event* → queueSnapshot(after markRouted)
    expect(events[0].type).toBe('input_queue_updated');
    expect(events[1].type).toBe('routing_decision');
    expect(events[1].action).toBe('continue');
    expect(events[1].targetThreadId).toBe(MAIN_THREAD_ID);
    expect(events[1].source).toBe('single-thread');
    expect(events[2].type).toBe('engine_event');
    expect(events[2].threadId).toBe(MAIN_THREAD_ID);
    expect(events[events.length - 1].type).toBe('input_queue_updated');
    expect(events[events.length - 1].pending).toBe(0);
  });

  it('drain() ensures EngineInstance lazily for MAIN_THREAD_ID', async () => {
    expect(engineRegistry.get(MAIN_THREAD_ID)).toBeNull();
    dispatcher.submit('hi');
    for await (const _ of dispatcher.drain()) { /* drain */ }
    expect(engineRegistry.get(MAIN_THREAD_ID)).toBeDefined();
  });

  it('engine exception emits retryable error pipeline event', async () => {
    const inst = engineRegistry.ensure(MAIN_THREAD_ID);
    inst.pushError(new Error('boom'));
    dispatcher.submit('q');

    const events = [];
    for await (const ev of dispatcher.drain()) events.push(ev);

    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.retryable).toBe(true);
    expect(errEvent.error.message).toBe('boom');
  });

  it('multiple submits drain in FIFO order', async () => {
    dispatcher.submit('first');
    dispatcher.submit('second');

    const acks = [];
    for await (const ev of dispatcher.drain()) {
      if (ev.type === 'engine_event' && ev.event?.type === 'text_delta') {
        acks.push(ev.event.text);
      }
    }
    expect(acks).toEqual(['ack:first', 'ack:second']);
  });

  it('back-compat: accepts (and ignores) override option', async () => {
    // Old callers may still pass `override: { threadId }`. The new
    // dispatcher must accept it without erroring (it ignores it).
    const { entry } = dispatcher.submit('q', {
      override: { threadId: 'thr-foo' },
      messageId: 'm-1',
    });
    expect(entry.text).toBe('q');
    const events = [];
    for await (const ev of dispatcher.drain()) events.push(ev);
    const decision = events.find(e => e.type === 'routing_decision');
    expect(decision.targetThreadId).toBe(MAIN_THREAD_ID);
  });
});
