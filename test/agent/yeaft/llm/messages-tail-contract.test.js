/**
 * messages-tail-contract.test.js — protect against the "assistant prefill"
 * 400 from the Anthropic Messages API.
 *
 * The Messages API requires the messages array to end with a user message
 * before each assistant turn — otherwise it rejects with:
 *   "model does not support assistant message prefill. The conversation
 *    must end with a user message."
 *
 * Historically this regressed when the T1 in-turn reflection collapsed a
 * BATCH-tool arc into a SINGLE assistant message and that arc happened to
 * be the tail of conversationMessages. The next adapter.stream() call then
 * saw user → assistant(reflection) and the upstream API 400'd.
 *
 * This file is a contract test: it drives the engine through the T1
 * trigger and asserts that EVERY adapter.stream() invocation receives
 * a messages array whose last entry has role === 'user'. The assertion
 * runs across all calls — including the post-collapse one — so any future
 * change that puts an assistant message at the tail is caught immediately.
 *
 * The test deliberately does NOT mock anthropic.js itself; it sits one
 * level above (the unified UnifiedMessage[] layer) because that's where
 * the constraint is enforceable end-to-end without coupling to wire
 * format.
 *
 * BATCH = TOOL_BATCH_SIZE constant (was 13; raised to 30 on 2026-05-15).
 */
import { describe, it, expect } from 'vitest';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { TOOL_BATCH_SIZE } from '../../../../agent/yeaft/tool-folding/index.js';

class TailRecordingAdapter {
  constructor({ toolUseTurns = TOOL_BATCH_SIZE } = {}) {
    this.toolUseTurns = toolUseTurns;
    this.tailRoles = []; // role of last message at every stream() call
    this.allLastMessages = [];
    this._counter = 0;
  }
  async *stream(params) {
    const msgs = Array.isArray(params.messages) ? params.messages : [];
    const last = msgs[msgs.length - 1];
    this.tailRoles.push(last && last.role);
    this.allLastMessages.push(last ? JSON.parse(JSON.stringify(last)) : null);
    if (this._counter < this.toolUseTurns) {
      this._counter += 1;
      const id = `tc-${this._counter}`;
      yield { type: 'tool_call', id, name: 'echo', input: { i: this._counter } };
      yield { type: 'stop', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
  }
  async call() {
    // Reflector output — minimal canonical markdown so the engine treats
    // it as a successful T1 reflection.
    return {
      text: '## What was attempted\nx\n## Key findings\nx\n## Direction check\nx\n## Suggested next direction\nx\n## Tool execution log\necho × N',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

class EchoTool {
  constructor() {
    this.name = 'echo';
    this.description = 'echo';
    this.parameters = { type: 'object', properties: {} };
  }
  async execute(input) { return `echo:${JSON.stringify(input)}`; }
}

function mkEngine(adapter) {
  const engine = new Engine({
    adapter,
    trace: new NullTrace(),
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      _readOnly: true,
      language: 'en',
    },
  });
  engine.registerTool(new EchoTool());
  return engine;
}

describe('messages-tail contract — Anthropic API requires user-tail', () => {
  it('every adapter.stream() call sees messages ending with role=user (no T1)', async () => {
    // 4 tool calls → no reflection, no collapse, plain loop.
    const adapter = new TailRecordingAdapter({ toolUseTurns: 4 });
    const engine = mkEngine(adapter);
    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    expect(adapter.tailRoles.length).toBeGreaterThan(0);
    for (const role of adapter.tailRoles) {
      // The unified message layer represents tool_results as role='tool';
      // the Anthropic adapter merges them into a user content block. So
      // 'user' OR 'tool' at this layer are both valid (they map to user
      // role on the wire). We forbid 'assistant' or 'system'.
      expect(['user', 'tool']).toContain(role);
    }
  });

  it('after T1 collapse the reflection lands as user-role (so the next stream sees user-tail)', async () => {
    // BATCH tool calls trips T1. Critical assertion: the post-collapse
    // stream() call (the (BATCH+1)-th) MUST see role='user' at the tail.
    const adapter = new TailRecordingAdapter({ toolUseTurns: TOOL_BATCH_SIZE });
    const engine = mkEngine(adapter);
    for await (const _ of engine.query({ prompt: 'go', messages: [] })) { /* drain */ }

    // We expect BATCH+1 stream() invocations: BATCH that issued tool_use +
    // 1 that produced end_turn after the rewrite.
    expect(adapter.tailRoles).toHaveLength(TOOL_BATCH_SIZE + 1);

    // The post-collapse stream call must see a user-tail. This is the
    // exact regression we are guarding.
    const postCollapseTail = adapter.tailRoles[TOOL_BATCH_SIZE];
    expect(postCollapseTail).toBe('user');

    // And the synthetic reflection should be tagged so we can tell it
    // apart from a real user prompt during debugging.
    const postCollapseLastMsg = adapter.allLastMessages[TOOL_BATCH_SIZE];
    expect(postCollapseLastMsg._reflection).toBe(true);
    expect(postCollapseLastMsg.content).toMatch(/folded for context efficiency/);

    // The earlier BATCH stream calls (during the tool loop) all end with
    // either user (the original prompt, on call 0) or tool (tool_results
    // for the prior tool_use, on calls 1..BATCH-1).
    for (let i = 0; i < TOOL_BATCH_SIZE; i += 1) {
      expect(['user', 'tool']).toContain(adapter.tailRoles[i]);
    }
  });
});
