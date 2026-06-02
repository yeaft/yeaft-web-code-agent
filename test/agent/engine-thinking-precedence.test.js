/**
 * engine-thinking-precedence.test.js — Phase 8 PR-C wire-up.
 *
 * Asserts that resolveThinking is on the live engine path:
 *   T-a  VP default 'max' upgrades a chat-scenario 'high' to 'max'
 *   T-b  priorPlan.thinking = 'max' on a previous assistant message
 *        carries forward to the next adapter call
 *   T-c  no VP persona ⇒ effort follows pickEffort (scenario only)
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/yeaft/engine.js';
import { NullTrace } from '../../agent/yeaft/debug-trace.js';

// recall-r6 was deleted in GC.1 follow-up; engine now recalls via FTS5
// pre-flow only when memoryIndex is wired (it isn't here), so no mock
// needed.

class CapturingAdapter {
  constructor() { this.calls = []; }
  async *stream(params) {
    this.calls.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

function mkEngine(adapter, opts = {}) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      _readOnly: true,
      language: 'en',
      ...opts.config,
    },
  });
}

describe('T-a VP default thinking upgrades scenario effort', () => {
  it('vpPersona.thinking="max" overrides scenario chat=high', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      scenario: 'chat',
      vpPersona: { vpId: 'vp-eng', displayName: 'Lin', thinking: 'max' },
    })) { /* drain */ }

    expect(adapter.calls[0].effort).toBe('max');
  });
});

describe('T-b priorPlan thinking carries forward', () => {
  it('priorPlan.thinking="max" on prev assistant ⇒ effort=max next turn', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    const seeded = [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: 'b',
        _meta: { routerPlan: { vpId: 'vp-eng', thinking: 'max' } },
      },
    ];

    for await (const _ of engine.query({
      prompt: 'next',
      messages: seeded,
      scenario: 'chat',
      vpPersona: { vpId: 'vp-eng', displayName: 'Lin' },
    })) { /* drain */ }

    expect(adapter.calls[0].effort).toBe('max');
  });
});

describe('T-c no VP persona ⇒ scenario effort untouched', () => {
  it('chat scenario without vpPersona uses scenario default max', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      scenario: 'chat',
    })) { /* drain */ }

    expect(adapter.calls[0].effort).toBe('max');
  });
});

describe('T-d live routerPlan.thinking wins over vpDefault', () => {
  it('vpPlan.thinking="max" with matching vpId overrides vpDefault="high"', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      scenario: 'chat',
      vpPersona: { vpId: 'vp-eng', displayName: 'Lin', thinking: 'high' },
      vpPlan: { vpId: 'vp-eng', thinking: 'max', thinkingReason: 'router escalated' },
    })) { /* drain */ }

    expect(adapter.calls[0].effort).toBe('max');
  });

  it('vpPlan.thinking="max" with mismatched vpId is ignored', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      scenario: 'chat',
      vpPersona: { vpId: 'vp-eng', displayName: 'Lin' },
      vpPlan: { vpId: 'vp-other', thinking: 'max' },
    })) { /* drain */ }

    // Falls through to scenario chat default 'max'.
    expect(adapter.calls[0].effort).toBe('max');
  });
});
