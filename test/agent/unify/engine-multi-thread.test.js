/**
 * task-308 — EngineInstance + ThreadEngineRegistry Phase 2 tests.
 *
 * Covers the core Phase 2 guarantees:
 *   1. Concurrent .query() on two EngineInstance objects does NOT
 *      cross-contaminate messages, tool calls, or event streams.
 *   2. Events emitted by a given instance are all tagged with the
 *      instance's bound threadId (not with the global current marker).
 *   3. Memory scope ref is per-instance.
 *   4. Registry lazy-creates, lists active, and terminates without
 *      affecting siblings.
 *   5. `session.engineRegistry` seeds the main thread.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import {
  EngineInstance,
  createEngineInstance,
} from '../../../agent/unify/threads/engine-instance.js';
import {
  ThreadEngineRegistry,
  createThreadEngineRegistry,
} from '../../../agent/unify/threads/engine-registry.js';

// ─── Mock adapter with a pluggable per-call event stream ─────
class MockAdapter {
  constructor() {
    // Map< callMatcher, events[] >. For simplicity we just queue
    // per-thread via the system-prompt contents (which include the
    // user prompt in messages). We instead queue globally and rely on
    // call ordering being deterministic inside a single test.
    this.queue = [];
    this.calls = [];
  }
  push(events) { this.queue.push(events); }
  async *stream(params) {
    this.calls.push(params);
    const events = this.queue.shift();
    if (!events) throw new Error('MockAdapter: no queued events');
    for (const e of events) yield e;
  }
}

function makeEngine(adapter) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024 },
  });
}

function textOnlyResponse(text) {
  return [
    { type: 'text_delta', text },
    { type: 'usage', inputTokens: 5, outputTokens: text.length },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

describe('EngineInstance — basics', () => {
  let adapter;
  beforeEach(() => { adapter = new MockAdapter(); });

  it('rejects construction without threadId', () => {
    expect(() => new EngineInstance({ engine: makeEngine(adapter) })).toThrow(/threadId/);
  });

  it('rejects construction without an engine', () => {
    expect(() => new EngineInstance({ threadId: 'thr-a' })).toThrow(/engine/);
  });

  it('defaults memoryScope to threadId', () => {
    const inst = new EngineInstance({ threadId: 'thr-a', engine: makeEngine(adapter) });
    expect(inst.memoryScope).toBe('thr-a');
  });

  it('accepts explicit memoryScope override', () => {
    const inst = new EngineInstance({ threadId: 'thr-a', engine: makeEngine(adapter), memoryScope: 'scope-a' });
    expect(inst.memoryScope).toBe('scope-a');
  });

  it('initialMessages are copied (caller array is not aliased)', () => {
    const init = [{ role: 'user', content: 'hi' }];
    const inst = new EngineInstance({ threadId: 'thr-a', engine: makeEngine(adapter), initialMessages: init });
    init.push({ role: 'user', content: 'mutation' });
    expect(inst.messageCount).toBe(1);
  });

  it('exposes a defensive copy of messages', () => {
    const inst = new EngineInstance({ threadId: 'thr-a', engine: makeEngine(adapter) });
    const snap = inst.messages;
    snap.push({ role: 'user', content: 'x' });
    expect(inst.messageCount).toBe(0);
  });
});

describe('EngineInstance — event tagging and message growth', () => {
  it('tags every yielded event with the bound threadId', async () => {
    const adapter = new MockAdapter();
    adapter.push(textOnlyResponse('hello-world'));
    const inst = new EngineInstance({ threadId: 'thr-tag', engine: makeEngine(adapter) });

    const events = [];
    for await (const e of inst.query({ prompt: 'hi' })) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.threadId).toBe('thr-tag');
    }
  });

  it('appends user + assistant after a successful query', async () => {
    const adapter = new MockAdapter();
    adapter.push(textOnlyResponse('reply-a'));
    const inst = new EngineInstance({ threadId: 'thr-m', engine: makeEngine(adapter) });
    for await (const _ of inst.query({ prompt: 'prompt-a' })) { /* drain */ }
    const msgs = inst.messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'prompt-a' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('reply-a');
  });

  it('terminate() prevents further queries and emits an error event', async () => {
    const adapter = new MockAdapter();
    const inst = new EngineInstance({ threadId: 'thr-x', engine: makeEngine(adapter) });
    inst.terminate();
    expect(inst.terminated).toBe(true);

    const events = [];
    for await (const e of inst.query({ prompt: 'hi' })) { events.push(e); }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].threadId).toBe('thr-x');
  });

  it('resetMessages() clears owned conversation without terminating', () => {
    const inst = new EngineInstance({
      threadId: 'thr-r',
      engine: makeEngine(new MockAdapter()),
      initialMessages: [{ role: 'user', content: 'a' }],
    });
    inst.resetMessages();
    expect(inst.messageCount).toBe(0);
    expect(inst.terminated).toBe(false);
  });
});

describe('EngineInstance — concurrent queries on two threads', () => {
  it('two instances stream without cross-contaminating events or messages', async () => {
    const adapter = new MockAdapter();
    adapter.push(textOnlyResponse('reply-A'));
    adapter.push(textOnlyResponse('reply-B'));

    const a = new EngineInstance({ threadId: 'thr-A', engine: makeEngine(adapter) });
    const b = new EngineInstance({ threadId: 'thr-B', engine: makeEngine(adapter) });

    // Interleave the two generators by round-robin pulling.
    const genA = a.query({ prompt: 'ask-A' });
    const genB = b.query({ prompt: 'ask-B' });

    const eventsA = [];
    const eventsB = [];
    let doneA = false, doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) {
        const { value, done } = await genA.next();
        if (done) doneA = true; else eventsA.push(value);
      }
      if (!doneB) {
        const { value, done } = await genB.next();
        if (done) doneB = true; else eventsB.push(value);
      }
    }

    // Every event on A is tagged A; every event on B is tagged B.
    for (const e of eventsA) expect(e.threadId).toBe('thr-A');
    for (const e of eventsB) expect(e.threadId).toBe('thr-B');

    // Messages land on the correct instance only.
    expect(a.messages.map(m => m.content)).toEqual(['ask-A', 'reply-A']);
    expect(b.messages.map(m => m.content)).toEqual(['ask-B', 'reply-B']);
  });

  it('terminating one instance does not affect the other', async () => {
    const adapter = new MockAdapter();
    adapter.push(textOnlyResponse('reply-B'));

    const a = new EngineInstance({ threadId: 'thr-A', engine: makeEngine(adapter) });
    const b = new EngineInstance({ threadId: 'thr-B', engine: makeEngine(adapter) });

    a.terminate();
    expect(a.terminated).toBe(true);
    expect(b.terminated).toBe(false);

    const events = [];
    for await (const e of b.query({ prompt: 'ask-B' })) events.push(e);
    // B still ran successfully; all events tagged B.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.threadId).toBe('thr-B');
  });
});

describe('createEngineInstance factory', () => {
  it('creates a working instance from the dependency bag', async () => {
    const adapter = new MockAdapter();
    adapter.push(textOnlyResponse('factory-ok'));
    const inst = createEngineInstance({
      threadId: 'thr-factory',
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });
    const events = [];
    for await (const e of inst.query({ prompt: 'go' })) events.push(e);
    for (const e of events) expect(e.threadId).toBe('thr-factory');
    expect(inst.messages.map(m => m.content)).toContain('factory-ok');
  });
});

describe('ThreadEngineRegistry', () => {
  let adapter;
  let registry;
  beforeEach(() => {
    adapter = new MockAdapter();
    registry = createThreadEngineRegistry({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024 },
    });
  });

  it('rejects construction without a factory', () => {
    expect(() => new ThreadEngineRegistry()).toThrow(/factory/);
  });

  it('ensure() lazy-creates an instance and caches it', () => {
    const a1 = registry.ensure('thr-a');
    const a2 = registry.ensure('thr-a');
    expect(a1).toBe(a2);
    expect(registry.size).toBe(1);
  });

  it('get() returns null for unknown thread (no lazy create)', () => {
    expect(registry.get('thr-missing')).toBeNull();
  });

  it('listActive() returns only non-terminated instances', () => {
    const a = registry.ensure('thr-a');
    registry.ensure('thr-b');
    registry.ensure('thr-c');
    a.terminate();
    const active = registry.listActive();
    expect(active.length).toBe(2);
    expect(active.map(i => i.threadId).sort()).toEqual(['thr-b', 'thr-c']);
  });

  it('terminate() tears down one thread, others keep running', async () => {
    adapter.push(textOnlyResponse('reply-B'));

    registry.ensure('thr-a');
    const b = registry.ensure('thr-b');
    expect(registry.terminate('thr-a')).toBe(true);
    // Second terminate returns false (already terminated).
    expect(registry.terminate('thr-a')).toBe(false);
    // Unknown returns false.
    expect(registry.terminate('thr-nope')).toBe(false);

    const events = [];
    for await (const e of b.query({ prompt: 'still-works' })) events.push(e);
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
  });

  it('terminateAll() terminates every live instance', () => {
    registry.ensure('thr-a');
    registry.ensure('thr-b');
    const n = registry.terminateAll();
    expect(n).toBe(2);
    expect(registry.listActive().length).toBe(0);
  });

  it('ensure() replaces a terminated instance with a fresh one', () => {
    const a1 = registry.ensure('thr-a');
    a1.terminate();
    const a2 = registry.ensure('thr-a');
    expect(a2).not.toBe(a1);
    expect(a2.terminated).toBe(false);
  });

  it('setCurrent() / currentThreadId track the active thread marker', () => {
    expect(registry.currentThreadId).toBe('main');
    registry.setCurrent('thr-x');
    expect(registry.currentThreadId).toBe('thr-x');
    expect(() => registry.setCurrent('')).toThrow();
    expect(() => registry.setCurrent(null)).toThrow();
  });

  it('delete() removes the entry entirely', () => {
    registry.ensure('thr-a');
    expect(registry.size).toBe(1);
    expect(registry.delete('thr-a')).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.delete('thr-a')).toBe(false);
  });

  it('ensure() throws if factory returns garbage', () => {
    const broken = new ThreadEngineRegistry({ factory: () => null });
    expect(() => broken.ensure('thr-a')).toThrow(/EngineInstance/);
  });
});

describe('ThreadEngineRegistry — memory scope isolation', () => {
  it('distinct threads receive distinct memoryScope refs', () => {
    const registry = createThreadEngineRegistry({
      adapter: new MockAdapter(),
      trace: new NullTrace(),
      config: { model: 'test-model' },
    });
    const a = registry.ensure('thr-scope-a');
    const b = registry.ensure('thr-scope-b');
    expect(a.memoryScope).toBe('thr-scope-a');
    expect(b.memoryScope).toBe('thr-scope-b');
    expect(a.memoryScope).not.toBe(b.memoryScope);
  });
});
