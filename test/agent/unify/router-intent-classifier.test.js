/**
 * task-309 — IntentClassifier tests.
 *
 * Covers:
 *   1. Explicit signals: @thread-xxx + @task-NNN prefixes bypass the LLM.
 *   2. 4 intents (continue / interrupt / fork / switch) — 2 fixtures each
 *      via a mocked adapter returning pre-built JSON decisions.
 *   3. Unknown thread in @prefix → degrade to continue.
 *   4. Classifier failure (stream throws / bad JSON) → continue + trace.
 *   5. override() API round-trip (one-shot, consumed on read).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntentClassifier,
  createIntentClassifier,
  parseLLMDecision,
} from '../../../agent/unify/router/intent-classifier.js';

// ─── Mock adapter + trace ─────────────────────────────────────
class MockAdapter {
  constructor() {
    /** @type {Array<Array<object>|Error>} */
    this.queue = [];
    this.calls = [];
  }
  pushDecision(decision) {
    const raw = typeof decision === 'string' ? decision : JSON.stringify(decision);
    this.queue.push([
      { type: 'text_delta', text: raw },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
  }
  pushRaw(events) { this.queue.push(events); }
  pushError(err) { this.queue.push(err); }
  async *stream(params) {
    this.calls.push(params);
    const next = this.queue.shift();
    if (!next) throw new Error('MockAdapter: no queued response');
    if (next instanceof Error) throw next;
    for (const ev of next) yield ev;
  }
}

class MockTrace {
  constructor() { this.events = []; }
  logEvent(info) { this.events.push(info); return 'evt'; }
  logTool() { return 'tool'; }
}

function makeClassifier({ adapter, trace, config } = {}) {
  return new IntentClassifier({
    adapter: adapter || new MockAdapter(),
    trace: trace || new MockTrace(),
    config: config || { primaryModel: 'test-provider/test-model' },
  });
}

// ─── Constructor & override API ──────────────────────────────

describe('IntentClassifier — construction', () => {
  it('requires an adapter with .stream()', () => {
    expect(() => new IntentClassifier({ config: {} })).toThrow(/adapter/);
    expect(() => new IntentClassifier({ adapter: {}, config: {} })).toThrow(/adapter/);
  });
  it('requires config', () => {
    expect(() => new IntentClassifier({ adapter: new MockAdapter() })).toThrow(/config/);
  });
  it('createIntentClassifier factory works', () => {
    const c = createIntentClassifier({ adapter: new MockAdapter(), config: { primaryModel: 'm' } });
    expect(c).toBeInstanceOf(IntentClassifier);
  });
});

describe('IntentClassifier — override API', () => {
  let c;
  beforeEach(() => { c = makeClassifier(); });

  it('rejects invalid override inputs', () => {
    expect(() => c.override('', { action: 'continue', targetThreadId: 't' })).toThrow();
    expect(() => c.override('m1', { action: 'bogus', targetThreadId: 't' })).toThrow(/invalid action/);
    expect(() => c.override('m1', { action: 'continue' })).toThrow(/targetThreadId/);
  });

  it('stored override wins over LLM and is consumed (one-shot)', async () => {
    const adapter = new MockAdapter();
    // Classifier would be 'continue' but we expect the override to be used
    // BEFORE the adapter is ever consulted, so we don't queue anything yet.
    const cc = makeClassifier({ adapter });

    cc.override('msg-1', { action: 'switch', targetThreadId: 'thread-b', reason: 'user says so' });
    expect(cc.hasOverride('msg-1')).toBe(true);

    const d = await cc.classify({
      userMessage: 'anything',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-b' }],
      messageId: 'msg-1',
    });
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('thread-b');
    expect(d.source).toBe('override');
    // Adapter was never consulted.
    expect(adapter.calls).toHaveLength(0);
    // Override consumed — second call with same id re-enters normal path.
    expect(cc.hasOverride('msg-1')).toBe(false);
  });

  it('clearOverrides removes all', () => {
    c.override('m1', { action: 'continue', targetThreadId: 'main' });
    c.override('m2', { action: 'continue', targetThreadId: 'main' });
    c.clearOverrides();
    expect(c.hasOverride('m1')).toBe(false);
    expect(c.hasOverride('m2')).toBe(false);
  });
});

// ─── Explicit signals ────────────────────────────────────────

describe('IntentClassifier — explicit @thread-xxx signals', () => {
  it('switches to the named thread without calling the LLM', async () => {
    const adapter = new MockAdapter();
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: '@thread-foo hi there',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-foo' }],
    });
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('thread-foo');
    expect(d.source).toBe('explicit');
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns continue when the @thread target IS the current thread', async () => {
    const c = makeClassifier();
    const d = await c.classify({
      userMessage: '@thread-main follow-up',
      currentThreadId: 'thread-main',
      allThreads: [{ id: 'thread-main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('thread-main');
    expect(d.source).toBe('explicit');
  });

  it('unknown @thread degrades to continue + traces failure', async () => {
    const trace = new MockTrace();
    const c = makeClassifier({ trace });
    const d = await c.classify({
      userMessage: '@thread-nope question',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('main');
    expect(d.source).toBe('fallback');
    expect(trace.events.length).toBe(1);
    expect(trace.events[0].eventType).toBe('router.failure');
  });
});

describe('IntentClassifier — explicit @task-NNN signals', () => {
  it('resolves a known task to its attached thread (switch)', async () => {
    const adapter = new MockAdapter();
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: '@task-309 progress?',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-task-309' }],
      pendingTasks: [{ id: 'task-309', threadId: 'thread-task-309' }],
    });
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('thread-task-309');
    expect(d.source).toBe('explicit');
    expect(adapter.calls).toHaveLength(0);
  });

  it('task attached to the CURRENT thread → continue', async () => {
    const c = makeClassifier();
    const d = await c.classify({
      userMessage: '@task-a update',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
      pendingTasks: [{ id: 'task-a', threadId: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('main');
    expect(d.source).toBe('explicit');
  });

  it('unknown task falls through to LLM path', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'continue', targetThreadId: 'main', reason: 'default' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: '@task-ghost what',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
      pendingTasks: [], // task-ghost not present
    });
    expect(adapter.calls).toHaveLength(1);
    expect(d.source).toBe('llm');
    expect(d.action).toBe('continue');
  });
});

// ─── LLM classification — 4 intents × ≥2 fixtures ────────────

describe('IntentClassifier — LLM path, action=continue (≥2 fixtures)', () => {
  it('fixture A: follow-up question lands continue', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'continue', targetThreadId: 'main', reason: 'follow-up' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'can you say more about that?',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('main');
    expect(d.source).toBe('llm');
  });
  it('fixture B: classifier tried non-current but coerced to current', async () => {
    // Even if the LLM wrongly emits a different target for 'continue', we
    // coerce it back to the current thread — continue is by definition local.
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'continue', targetThreadId: 'other', reason: 'oops' });
    const c = makeClassifier({
      adapter,
      config: { primaryModel: 'm' },
    });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'other' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('main');
  });
});

describe('IntentClassifier — LLM path, action=switch (≥2 fixtures)', () => {
  it('fixture A: "go back to thread X" switch', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'switch', targetThreadId: 'thread-x', reason: 're-focus' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'back to the refactor please',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-x' }],
    });
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('thread-x');
  });
  it('fixture B: switch to a sibling thread', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'switch', targetThreadId: 'sibling', reason: 's' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'on the other task…',
      currentThreadId: 'cur',
      allThreads: [{ id: 'cur' }, { id: 'sibling' }],
    });
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('sibling');
  });
});

describe('IntentClassifier — LLM path, action=fork (≥2 fixtures)', () => {
  it('fixture A: fork from current thread', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'fork', targetThreadId: 'main', reason: 'new tangent' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'unrelated — let me ask about payments',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('fork');
    expect(d.targetThreadId).toBe('main');
  });
  it('fixture B: fork parent is current thread even with siblings', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'fork', targetThreadId: 'cur', reason: 'branch' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'new topic: infra',
      currentThreadId: 'cur',
      allThreads: [{ id: 'cur' }, { id: 'other' }],
    });
    expect(d.action).toBe('fork');
    expect(d.targetThreadId).toBe('cur');
  });
});

describe('IntentClassifier — LLM path, action=interrupt (≥2 fixtures)', () => {
  it('fixture A: interrupt a different thread still streaming', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'interrupt', targetThreadId: 'thread-streaming', reason: 'answer' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'yes do it',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-streaming' }],
    });
    expect(d.action).toBe('interrupt');
    expect(d.targetThreadId).toBe('thread-streaming');
  });
  it('fixture B: interrupt answers a pending question', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'interrupt', targetThreadId: 'thread-asking', reason: 'reply' });
    const c = makeClassifier({ adapter });
    const d = await c.classify({
      userMessage: 'option 2',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }, { id: 'thread-asking' }],
    });
    expect(d.action).toBe('interrupt');
    expect(d.targetThreadId).toBe('thread-asking');
  });
});

// ─── Fallback behaviours ─────────────────────────────────────

describe('IntentClassifier — fallback to continue', () => {
  it('adapter stream throws → continue + trace', async () => {
    const adapter = new MockAdapter();
    adapter.pushError(new Error('upstream 500'));
    const trace = new MockTrace();
    const c = makeClassifier({ adapter, trace });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.targetThreadId).toBe('main');
    expect(d.source).toBe('fallback');
    expect(trace.events.length).toBe(1);
    expect(trace.events[0].eventType).toBe('router.failure');
    expect(trace.events[0].eventData.error).toMatch(/upstream 500/);
  });

  it('non-JSON response → continue + trace', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision('sorry I cannot help with that.');
    const trace = new MockTrace();
    const c = makeClassifier({ adapter, trace });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.source).toBe('fallback');
    expect(trace.events.length).toBe(1);
  });

  it('invalid action field → continue + trace', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'bogus', targetThreadId: 'main', reason: '' });
    const trace = new MockTrace();
    const c = makeClassifier({ adapter, trace });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.source).toBe('fallback');
    expect(trace.events[0].eventData.error).toMatch(/invalid action/);
  });

  it('targetThreadId references an unknown thread → continue + trace', async () => {
    const adapter = new MockAdapter();
    adapter.pushDecision({ action: 'switch', targetThreadId: 'ghost', reason: '' });
    const trace = new MockTrace();
    const c = makeClassifier({ adapter, trace });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.source).toBe('fallback');
    expect(trace.events[0].eventData.error).toMatch(/unknown targetThreadId/);
  });

  it('missing primaryModel + no model in config → fallback', async () => {
    const adapter = new MockAdapter();
    const trace = new MockTrace();
    const c = new IntentClassifier({ adapter, trace, config: {} });
    const d = await c.classify({
      userMessage: 'hi',
      currentThreadId: 'main',
      allThreads: [{ id: 'main' }],
    });
    expect(d.action).toBe('continue');
    expect(d.source).toBe('fallback');
  });
});

// ─── parseLLMDecision corner cases ───────────────────────────

describe('parseLLMDecision', () => {
  it('parses plain JSON', () => {
    const d = parseLLMDecision('{"action":"fork","targetThreadId":"main","reason":"x"}');
    expect(d.action).toBe('fork');
  });
  it('strips ```json fences', () => {
    const d = parseLLMDecision('```json\n{"action":"switch","targetThreadId":"t","reason":"r"}\n```');
    expect(d.action).toBe('switch');
    expect(d.targetThreadId).toBe('t');
  });
  it('handles surrounding prose by picking the first { ... } block', () => {
    const d = parseLLMDecision('Decision: {"action":"continue","targetThreadId":"main","reason":""}. Done.');
    expect(d.action).toBe('continue');
  });
  it('throws on non-JSON', () => {
    expect(() => parseLLMDecision('not json')).toThrow();
  });
  it('throws on empty', () => {
    expect(() => parseLLMDecision('')).toThrow();
  });
});
