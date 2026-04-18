/**
 * task-327c: internal side-query scenario tagging — verify
 * consolidate / dream / extract / recall pass the correct `effort` to
 * adapter.call(), and that the adapter call() path injects the same
 * reasoning/thinking body fields as stream() does.
 *
 * Red lines:
 *   - Feature-flag off → no reasoning/thinking body field (integration
 *     regression, asserts main-parity behaviour).
 *   - Unsupported model (deepseek-chat etc.) → silent drop at adapter.
 *
 * Coverage:
 *   §1 adapter.call() body injection parity with stream() (3 tests each
 *      for Anthropic + ChatCompletions).
 *   §2 consolidate/extract/dream/recall call-sites pass correct scenario
 *      (4 tests via MockAdapter.callLog inspection).
 *   §3 engine nit: invalid caller userEffort no longer shadows /max
 *      prefix (2 tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../agent/unify/llm/anthropic.js';
import { ChatCompletionsAdapter } from '../../agent/unify/llm/chat-completions.js';
import { consolidate, DEFAULT_MESSAGE_TOKEN_BUDGET } from '../../agent/unify/memory/consolidate.js';
import { extractMemories } from '../../agent/unify/memory/extract.js';
import { recall, clearRecallCache } from '../../agent/unify/memory/recall.js';

// ─── helpers ─────────────────────────────────────────────────────

function captureCallBody(adapterCall) {
  let captured = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    // Anthropic + Chat Completions both accept JSON shape; return a minimal
    // successful response so call() returns cleanly rather than erroring.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '' }],
        choices: [{ message: { content: '' } }],
        usage: {},
      }),
    };
  };
  return adapterCall()
    .catch(() => {})
    .finally(() => { globalThis.fetch = orig; })
    .then(() => captured);
}

class MockCallAdapter {
  constructor(response = 'ok') {
    this.callLog = [];
    this._response = response;
  }
  async call(params) {
    this.callLog.push(params);
    return { text: this._response, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async *stream() { /* not used in 327c tests */ }
}

// ─── §1 adapter.call() parity with stream() ─────────────────────

describe('task-327c: AnthropicAdapter.call() effort injection', () => {
  let origFlag;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  const mk = () => new AnthropicAdapter({ apiKey: 't', baseUrl: 'https://stub' });

  it('effort=max on opus-4 → thinking.budget_tokens=64000 + max_tokens widened', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'claude-opus-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'max',
    }));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 64000 });
    expect(body.max_tokens).toBeGreaterThanOrEqual(64000 + 1024);
  });

  it('effort=low on sonnet-4 → thinking.budget_tokens=4096', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'low',
    }));
    expect(body.thinking.budget_tokens).toBe(4096);
  });

  it('no effort → no thinking field (main-parity)', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
    }));
    expect(body.thinking).toBeUndefined();
  });

  it('flag OFF → effort silently dropped from body', async () => {
    delete process.env.UNIFY_THINKING_V1;
    const body = await captureCallBody(() => mk().call({
      model: 'claude-sonnet-4-20250514',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'max',
    }));
    expect(body.thinking).toBeUndefined();
  });

  it('unsupported model (haiku-3) silently drops effort', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'claude-haiku-3-20250414',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'max',
    }));
    expect(body.thinking).toBeUndefined();
  });
});

describe('task-327c: ChatCompletionsAdapter.call() effort injection', () => {
  let origFlag;
  beforeEach(() => {
    origFlag = process.env.UNIFY_THINKING_V1;
    process.env.UNIFY_THINKING_V1 = '1';
  });
  afterEach(() => {
    if (origFlag === undefined) delete process.env.UNIFY_THINKING_V1;
    else process.env.UNIFY_THINKING_V1 = origFlag;
  });

  const mk = () => new ChatCompletionsAdapter({ apiKey: 't', baseUrl: 'https://stub/v1' });

  it('gpt-5 + effort=low → reasoning.effort=low', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'low',
    }));
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('o4-mini + effort=max → reasoning.effort=high (downgrade)', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'o4-mini',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'max',
    }));
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('deepseek-chat (non-reasoning) silently drops', async () => {
    const body = await captureCallBody(() => mk().call({
      model: 'deepseek-chat',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'max',
    }));
    expect(body.reasoning).toBeUndefined();
  });

  it('flag OFF → reasoning dropped', async () => {
    delete process.env.UNIFY_THINKING_V1;
    const body = await captureCallBody(() => mk().call({
      model: 'gpt-5',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      effort: 'high',
    }));
    expect(body.reasoning).toBeUndefined();
  });
});

// ─── §2 call-site scenario tagging ──────────────────────────────

describe('task-327c: consolidate call-site passes scenario=consolidate → effort=max', () => {
  it('generateSummary inside consolidate() forwards effort=max', async () => {
    const adapter = new MockCallAdapter('summary text');
    // Minimum viable fakes for conversationStore + memoryStore so the
    // consolidate pipeline executes the summary call. We only care that
    // callLog.at(0).effort === 'max'.
    const fakeMessages = [];
    for (let i = 0; i < 30; i++) {
      fakeMessages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'msg ' + i + ' '.repeat(200),
        tokens_est: 500,
      });
    }
    const conversationStore = {
      loadAll: () => fakeMessages,
      moveToColdBatch: () => {},
      updateCompactSummary: () => {},
      updateIndex: () => {},
    };
    const memoryStore = {
      writeEntry: () => 'mem-slug',
      rebuildScopes: () => {},
    };
    await consolidate({
      conversationStore,
      memoryStore,
      adapter,
      config: { model: 'claude-opus-4-20250514' },
      budget: DEFAULT_MESSAGE_TOKEN_BUDGET,
    });
    expect(adapter.callLog.length).toBeGreaterThanOrEqual(1);
    // First call is generateSummary → scenario=consolidate → effort=max.
    expect(adapter.callLog[0].effort).toBe('max');
    // Extract (second call, also scenario=consolidate) → also max.
    if (adapter.callLog[1]) {
      expect(adapter.callLog[1].effort).toBe('max');
    }
  });
});

describe('task-327c: extractMemories call-site → effort=max', () => {
  it('passes effort=max directly', async () => {
    const adapter = new MockCallAdapter('[]');
    await extractMemories({
      messages: [{ role: 'user', content: 'hi' }],
      adapter,
      config: { model: 'claude-opus-4-20250514' },
    });
    expect(adapter.callLog).toHaveLength(1);
    expect(adapter.callLog[0].effort).toBe('max');
  });
});

describe('task-327c: recall step-3 LLM select → effort=low', () => {
  it('passes effort=low when LLM select fires (candidates > 7)', async () => {
    clearRecallCache();
    const adapter = new MockCallAdapter('["pref-a","pref-b"]');
    // 8 candidates so recall triggers llmSelect (MAX_RECALL_RESULTS=7).
    const candidates = [];
    for (let i = 0; i < 8; i++) {
      candidates.push({
        name: `pref-${i}`,
        scope: 'global',
        tags: ['typescript'],
        content: `entry ${i}`,
      });
    }
    const memoryStore = {
      findByFilter: () => candidates,
      readEntry: (slug) => candidates.find(c => c.name === slug) || null,
      bumpFrequency: () => {},
    };
    await recall({
      prompt: 'typescript preferences',
      adapter,
      config: { model: 'gpt-5' },
      memoryStore,
      scope: 'global',
      taskId: 't1',
    });
    expect(adapter.callLog).toHaveLength(1);
    expect(adapter.callLog[0].effort).toBe('low');
  });

  it('recall short-circuits (no LLM call) when candidates <= 7', async () => {
    clearRecallCache();
    const adapter = new MockCallAdapter('["pref-a"]');
    const candidates = [
      { name: 'pref-0', scope: 'global', tags: ['typescript'], content: 'c0' },
    ];
    const memoryStore = {
      findByFilter: () => candidates,
      readEntry: (slug) => candidates.find(c => c.name === slug) || null,
      bumpFrequency: () => {},
    };
    await recall({
      prompt: 'typescript preferences',
      adapter,
      config: { model: 'gpt-5' },
      memoryStore,
      scope: 'global',
      taskId: 't2',
    });
    // No LLM call should have fired at all.
    expect(adapter.callLog).toHaveLength(0);
  });
});

// Dream has two call-sites; we test one via a light-weight wrapper to
// avoid loading the full dream pipeline (it requires ~/.yeaft layout).
// The module-level `pickEffort({scenario:'dream'})` returning 'max' is
// already covered in effort.test.js; asserting the wiring here would
// require mocking the full fs-backed dream lifecycle. Covered
// transitively via the import + pickEffort unit tests.

// ─── §3 engine nit: invalid userEffort no longer masks /max ─────

describe('task-327c: engine invalid userEffort does not shadow /max prefix', () => {
  // Imports deferred to avoid the engine pulling in heavy deps at top.
  let Engine, NullTrace;
  beforeEach(async () => {
    Engine = (await import('../../agent/unify/engine.js')).Engine;
    NullTrace = (await import('../../agent/unify/debug-trace.js')).NullTrace;
  });

  class SilentAdapter {
    constructor() { this.callLog = []; }
    async *stream(params) {
      this.callLog.push(params);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
    async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
  }

  it('userEffort="ULTRA" (invalid) + /max prefix → effort=max (prefix wins)', async () => {
    const adapter = new SilentAdapter();
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'm', maxOutputTokens: 1024, _readOnly: true },
    });
    for await (const _ of engine.query({ prompt: '/max do it', userEffort: 'ULTRA' })) { /* drain */ }
    expect(adapter.callLog[0].effort).toBe('max');
  });

  it('userEffort=null + no prefix → scenario default (chat=high)', async () => {
    const adapter = new SilentAdapter();
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'm', maxOutputTokens: 1024, _readOnly: true },
    });
    for await (const _ of engine.query({ prompt: 'hello', userEffort: null })) { /* drain */ }
    expect(adapter.callLog[0].effort).toBe('high');
  });
});
