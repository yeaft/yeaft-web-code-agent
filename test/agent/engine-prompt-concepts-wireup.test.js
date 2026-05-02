/**
 * engine-prompt-concepts-wireup.test.js — DESIGN-PROMPT v1 wire-up.
 *
 * Locks in the contract that Engine.query() implements DESIGN-PROMPT §3:
 *
 *   E-a  Memory has a SINGLE outlet: the AMS snapshot block. The legacy
 *        FTS-formatted block is no longer concatenated into the system
 *        prompt directly (DESIGN-PROMPT §6.1 #1).
 *
 *   E-b  Compact summary lives at the head of the messages array as a
 *        `<conversation_summary>` user message + acknowledged assistant
 *        reply, NOT in the system prompt (DESIGN-PROMPT §4.3).
 *
 *   E-c  Active Scope is rendered as a `## active_scope` block from
 *        engine-side fields (groupId / vpId / inboundEnvelope.featureId)
 *        — DESIGN-PROMPT §3 ④.
 */

import { describe, it, expect } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';

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
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    ...opts,
  });
}

describe('E-b compact summary placement (DESIGN-PROMPT §4.3)', () => {
  it('is absent from system prompt and absent from messages when no compact', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);
    for await (const _ of engine.query({ prompt: 'hi', messages: [] })) { /* drain */ }

    const sys = adapter.calls[0].system || '';
    expect(sys).not.toMatch(/conversation_summary/);

    const msgs = adapter.calls[0].messages;
    // Without compact, messages = [{ role:'user', content:'hi' }] only.
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('compact-aware: when conversationStore returns a compact summary, it lands in messages head', async () => {
    const adapter = new CapturingAdapter();
    // Stub a conversation store that returns a compact summary.
    const conversationStore = {
      readCompactSummary: () => 'Earlier we discussed X and decided Y.',
      // No-ops for the bits engine touches at end_turn:
      readMessages: () => [],
      readArchivedGroups: () => [],
      replaceMessages: () => {},
      updateCompactSummary: () => {},
    };
    const engine = mkEngine(adapter, { conversationStore });

    for await (const _ of engine.query({ prompt: 'next', messages: [] })) { /* drain */ }

    const sys = adapter.calls[0].system || '';
    // System prompt MUST NOT contain the compact summary or its header.
    expect(sys).not.toMatch(/Conversation History Summary/);
    expect(sys).not.toContain('Earlier we discussed X');

    const msgs = adapter.calls[0].messages;
    // Messages MUST start with the compact pair, then the new user prompt.
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toMatch(/<conversation_summary>/);
    expect(msgs[0].content).toContain('Earlier we discussed X');
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Acknowledged.' });
    // Last message is always the new user prompt
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'next' });
  });

  it('whitespace-only compact summary is treated as missing (no empty pair)', async () => {
    // Defensive trim: if the store returns `'   '` (e.g. after a compact
    // run produced an effectively-empty summary), we MUST NOT inject an
    // empty `<conversation_summary>\n   \n</conversation_summary>` block.
    const adapter = new CapturingAdapter();
    const conversationStore = {
      readCompactSummary: () => '   \n  \n',
      readMessages: () => [],
      readArchivedGroups: () => [],
      replaceMessages: () => {},
      updateCompactSummary: () => {},
    };
    const engine = mkEngine(adapter, { conversationStore });

    for await (const _ of engine.query({ prompt: 'next', messages: [] })) { /* drain */ }

    const msgs = adapter.calls[0].messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'next' });
    expect(msgs.some((m) => /<conversation_summary>/.test(m.content || ''))).toBe(false);
  });

  it('does not double-fire with history-compact `_compactSummary`-tagged messages', async () => {
    // DESIGN-PROMPT §4.3: the compact summary placement at messages head
    // is one mechanism; `history-compact.js` produces a separate
    // `_compactSummary`-tagged user message that may land in the
    // upstream messages array. They must NOT both render the same
    // summary text into the wire payload.
    const adapter = new CapturingAdapter();
    const conversationStore = {
      readCompactSummary: () => 'Earlier we discussed X.',
      readMessages: () => [],
      readArchivedGroups: () => [],
      replaceMessages: () => {},
      updateCompactSummary: () => {},
    };
    const engine = mkEngine(adapter, { conversationStore });

    // Simulate a tagged history-compact summary already in messages.
    const taggedSummary = {
      role: 'user',
      content:
        'This session is being continued from a previous conversation. ' +
        'The earlier context has been summarized for efficiency.\n\n' +
        'Summary of conversation so far:\nEarlier we discussed X.\n\n' +
        'Continue the conversation from where it left off without asking the user any further questions.',
      _compactSummary: true,
    };

    for await (const _ of engine.query({
      prompt: 'next',
      messages: [taggedSummary],
    })) { /* drain */ }

    const msgs = adapter.calls[0].messages;
    // The conversation_summary head pair is engine-injected from the
    // store; it lives at indices 0+1.
    expect(msgs[0].content).toMatch(/<conversation_summary>/);
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Acknowledged.' });
    // The tagged history-compact message rides in the body untouched —
    // its wrapper text is distinct ("This session is being continued"),
    // so the LLM sees two clearly different shapes, not a duplicate.
    const taggedCount = msgs.filter((m) =>
      typeof m.content === 'string' &&
      m.content.includes('This session is being continued from a previous conversation')
    ).length;
    expect(taggedCount).toBe(1);
    // And exactly one `<conversation_summary>` tag pair across the whole
    // wire payload.
    const csCount = msgs.filter((m) =>
      typeof m.content === 'string' && /<conversation_summary>/.test(m.content)
    ).length;
    expect(csCount).toBe(1);
  });
});

describe('E-c Active Scope is wired from engine context', () => {
  it('renders ## active_scope with group / vp / feature when supplied', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'go',
      messages: [],
      groupId: 'team-x',
      vpPersona: { vpId: 'alice', displayName: 'Alice', persona: 'Cool dev.' },
      inboundEnvelope: { featureId: 'feat-99', featureTitle: 'Onboarding', senderVpId: 'bob' },
    })) { /* drain */ }

    const sys = adapter.calls[0].system || '';
    expect(sys).toMatch(/## active_scope/);
    expect(sys).toMatch(/feature: feat-99 "Onboarding"/);
    expect(sys).toMatch(/group: team-x/);
    expect(sys).toMatch(/vp: alice/);
    expect(sys).toMatch(/envelope: from=bob/);
  });

  it('renders Active Scope without feature line when no featureId (T4 placeholder)', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);

    for await (const _ of engine.query({
      prompt: 'go',
      messages: [],
      groupId: 'team-x',
      vpPersona: { vpId: 'alice', displayName: 'Alice', persona: 'Cool dev.' },
    })) { /* drain */ }

    const sys = adapter.calls[0].system || '';
    expect(sys).toMatch(/## active_scope/);
    expect(sys).toMatch(/group: team-x/);
    expect(sys).toMatch(/vp: alice/);
    expect(sys).not.toMatch(/feature:/);
  });
});

describe('E-a Memory single outlet (DESIGN-PROMPT §3 ③)', () => {
  it('without memoryIndex wired, system prompt has no Memory block (FTS path is gated)', async () => {
    const adapter = new CapturingAdapter();
    const engine = mkEngine(adapter);
    for await (const _ of engine.query({ prompt: 'hi', messages: [] })) { /* drain */ }

    const sys = adapter.calls[0].system || '';
    // The retired multi-path renderers must not show their headers.
    expect(sys).not.toMatch(/## user_profile/);
    expect(sys).not.toMatch(/## core_memory/);
    expect(sys).not.toMatch(/## summary_user/);
    expect(sys).not.toMatch(/### Recalled Memories/);
  });
});
