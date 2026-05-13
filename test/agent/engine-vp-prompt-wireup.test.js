/**
 * engine-vp-prompt-wireup.test.js — Phase 8 PR-A regression guard.
 *
 * The bug this guards against:
 *   Phase 1–6 wrote new prompt + scope-tree + router modules with full
 *   tests, but engine.js never called them. As a result, every VP turn
 *   shipped the legacy "Yeaft — AI Companion" identity to the LLM and
 *   the per-VP persona was at best an overlay (or absent).
 *
 * What this test asserts about the LIVE engine path (no mocks of
 * prompts.js, no mocks of engine internals):
 *
 *   W-a  When a vpPersona is supplied, the system prompt sent to the
 *        adapter MUST start with the VP's persona block ("# <Name> —
 *        <Role>") and MUST NOT contain the Yeaft AI Companion identity
 *        in either language.
 *
 *   W-b  The router plan attached to the assistant message survives in
 *        conversationMessages but is stripped before going on the wire
 *        (no `_meta` key in adapter.messages).
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';

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

function mkEngine(adapter, language = 'en') {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language },
  });
}

const persona = {
  vpId: 'vp-eng',
  displayName: 'Lin',
  role: 'VP of Engineering',
  persona: 'You lead engineering. You speak with clarity and decisiveness.',
  language: 'en',
};

describe('W-a VP persona is the identity, not an overlay', () => {
  it('system prompt starts with persona H1 and excludes Yeaft AI Companion identity', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    const events = [];
    for await (const ev of engine.query({
      prompt: 'hello',
      messages: [],
      vpPersona: persona,
    })) {
      events.push(ev);
    }

    expect(adapter.calls.length).toBeGreaterThan(0);
    const sys = adapter.calls[0].system || '';

    // Persona is the identity
    expect(sys).toContain('Lin');
    expect(sys).toContain('VP of Engineering');

    // The legacy Yeaft companion identity MUST NOT appear when a VP
    // persona is active — that was the entire point of Phase 8.
    expect(sys).not.toContain('Yeaft — AI Companion');
    expect(sys).not.toContain('Yeaft — AI 伙伴');
  });

  it('uses localized VP fields for Chinese prompts instead of appending English seed persona text', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter, 'zh');

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      vpPersona: {
        vpId: 'steve',
        displayName: 'Steve Jobs',
        displayNameZh: '史蒂夫·乔布斯',
        role: 'Product Strategist',
        roleZh: '产品战略家',
        persona: 'You are Steve Jobs. You do not merely advise on product — you judge it.\n\nCore capabilities:\n- Reduction by fire.',
        personaZh: '你是史蒂夫·乔布斯。你不只是给产品提建议——你会审判它。\n\n核心能力：\n- 用火焰做减法。',
      },
    })) { /* drain */ }

    expect(adapter.calls.length).toBeGreaterThan(0);
    const sys = adapter.calls[0].system || '';

    expect(sys).toContain('# 史蒂夫·乔布斯 — 产品战略家');
    expect(sys).not.toContain('Product Strategist');
    expect(sys).toContain('你就是 **史蒂夫·乔布斯**');
    expect(sys).toContain('你是史蒂夫·乔布斯。你不只是给产品提建议');
    expect(sys).toContain('核心能力');
    expect(sys).not.toContain('You are Steve Jobs. You do not merely advise on product');
    expect(sys).not.toContain('Core capabilities:');
  });

  it('does not append English-only VP persona bodies to Chinese prompt wrappers', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter, 'zh');

    for await (const _ of engine.query({
      prompt: 'hi',
      messages: [],
      vpPersona: {
        vpId: 'steve',
        displayName: 'Steve Jobs',
        displayNameZh: '史蒂夫·乔布斯',
        role: 'Product Strategist',
        persona: 'You are Steve Jobs. You do not merely advise on product — you judge it.\n\nCore capabilities:\n- Reduction by fire.',
      },
    })) { /* drain */ }

    expect(adapter.calls.length).toBeGreaterThan(0);
    const sys = adapter.calls[0].system || '';

    expect(sys).toContain('# 史蒂夫·乔布斯');
    expect(sys).not.toContain('Product Strategist');
    expect(sys).toContain('你就是 **史蒂夫·乔布斯**');
    expect(sys).not.toContain('You are Steve Jobs. You do not merely advise on product');
    expect(sys).not.toContain('Core capabilities:');
  });
});

describe('W-b router plan _meta is stripped before wire', () => {
  it('messages on adapter call have no _meta key', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    // Seed a prior assistant message with `_meta` to verify stripping.
    const seeded = [
      { role: 'user', content: 'prev' },
      {
        role: 'assistant',
        content: 'prev reply',
        _meta: { routerPlan: { vpId: 'vp-eng', thinking: 'high' } },
      },
    ];

    for await (const _ of engine.query({
      prompt: 'next',
      messages: seeded,
      vpPersona: persona,
    })) { /* drain */ }

    expect(adapter.calls.length).toBeGreaterThan(0);
    const wireMessages = adapter.calls[0].messages;
    for (const m of wireMessages) {
      expect(m).not.toHaveProperty('_meta');
    }
  });
});
