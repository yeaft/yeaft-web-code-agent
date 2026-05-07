/**
 * router-pair-sanitize.test.js — task-715
 *
 * Bug: Anthropic 400 "Each tool_use block must have a corresponding
 * tool_result block in the next message" was hitting users in group
 * mode after a partial tool batch (some succeeded, some aborted) left
 * orphan `tool_use` IDs without matching `tool_result` follow-ups in
 * the messages array sent to the LLM.
 *
 * Fix: defensive `pairSanitize` at the router — the single choke point
 * through which every adapter.stream / adapter.call flows. Idempotent
 * and a no-op when input is already well-formed; only drops blocks
 * when the upstream slicing/mutation produced an orphan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AdapterRouter,
  sanitizeMessagesForWire,
} from '../../../../agent/unify/llm/router.js';

const ANTHROPIC_PROVIDER = {
  name: 'anthropic-direct',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  models: ['claude-sonnet-4-20250514'],
};

describe('sanitizeMessagesForWire — pure unit', () => {
  it('passes through well-formed messages unchanged (same reference)', () => {
    const params = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't_1', name: 'x', input: {} }] },
        { role: 'tool', toolCallId: 't_1', content: 'ok' },
      ],
    };
    const out = sanitizeMessagesForWire(params);
    expect(out).toBe(params); // no allocation when well-formed
  });

  it('drops an assistant tool_use that has no matching tool_result', () => {
    const params = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 't_kept', name: 'x', input: {} },
          { id: 't_orphan', name: 'y', input: {} },
        ] },
        { role: 'tool', toolCallId: 't_kept', content: 'kept-result' },
        // t_orphan has no tool_result — Anthropic would 400
      ],
    };
    const out = sanitizeMessagesForWire(params);
    expect(out).not.toBe(params);
    const asst = out.messages.find(m => m.role === 'assistant');
    expect(asst.toolCalls.map(tc => tc.id)).toEqual(['t_kept']);
    expect(out.messages.some(m => m.role === 'tool' && m.toolCallId === 't_kept')).toBe(true);
  });

  it('drops an orphan tool_result whose tool_use is not in the slice', () => {
    const params = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        // No assistant tool_use here — the tool message below is an orphan
        { role: 'user', content: 'continue' },
        { role: 'tool', toolCallId: 't_orphan', content: 'leftover' },
        { role: 'user', content: 'now actually go' },
      ],
    };
    const out = sanitizeMessagesForWire(params);
    expect(out).not.toBe(params);
    expect(out.messages.some(m => m.role === 'tool')).toBe(false);
    // Both user messages preserved.
    expect(out.messages.filter(m => m.role === 'user')).toHaveLength(2);
  });

  it('handles missing/null messages array as a no-op', () => {
    expect(sanitizeMessagesForWire({})).toEqual({});
    expect(sanitizeMessagesForWire({ messages: null })).toEqual({ messages: null });
    expect(sanitizeMessagesForWire(null)).toBe(null);
  });

  it('handles empty messages array as a no-op (same reference)', () => {
    const params = { model: 'claude-sonnet-4-20250514', messages: [] };
    expect(sanitizeMessagesForWire(params)).toBe(params);
  });

  it('is idempotent — sanitize(clean) returns same reference, second call is also a no-op', () => {
    // Real idempotence contract: once an orphan has been dropped, the
    // result is well-formed, so a second sanitize must return the SAME
    // reference (no re-allocation). This exercises the no-allocation
    // contract that `sliceUnchanged` exists to guarantee.
    const params = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 't_kept', name: 'x', input: {} },
          { id: 't_orphan', name: 'y', input: {} },
        ] },
        { role: 'tool', toolCallId: 't_kept', content: 'ok' },
      ],
    };
    const once = sanitizeMessagesForWire(params);
    expect(once).not.toBe(params); // first call dropped the orphan
    const twice = sanitizeMessagesForWire(once);
    expect(twice).toBe(once); // second call is a true no-op
  });
});

describe('AdapterRouter — wire-level guard (integration)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('strips orphan tool_use before the request body reaches Anthropic', async () => {
    const router = new AdapterRouter({ providers: [ANTHROPIC_PROVIDER] });

    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = opts?.body ? JSON.parse(opts.body) : null;
      return {
        ok: false, status: 401, headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try {
      await router.call({
        model: 'claude-sonnet-4-20250514',
        system: 'sys',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [
            { id: 't_kept', name: 'x', input: {} },
            { id: 't_orphan', name: 'y', input: {} },
          ] },
          { role: 'tool', toolCallId: 't_kept', content: 'ok' },
          // t_orphan never got a result — would 400 without the guard
        ],
      });
    } catch { /* 401 from mock fetch — we only care about the body */ }

    expect(capturedBody).not.toBeNull();
    // Walk every assistant message in the wire body. Every tool_use block
    // must have a matching tool_result block by id.
    const wireMsgs = capturedBody.messages || [];
    const toolResultIds = new Set();
    for (const m of wireMsgs) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
    const toolUseIds = [];
    for (const m of wireMsgs) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === 'tool_use' && block.id) {
          toolUseIds.push(block.id);
        }
      }
    }
    expect(toolUseIds).toEqual(['t_kept']);
    expect(toolResultIds.has('t_kept')).toBe(true);
    expect(toolUseIds.includes('t_orphan')).toBe(false);
  });

  it('strips orphan tool_use before the request body reaches Anthropic via stream()', async () => {
    const router = new AdapterRouter({ providers: [ANTHROPIC_PROVIDER] });

    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = opts?.body ? JSON.parse(opts.body) : null;
      return {
        ok: false, status: 401, headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try {
      const gen = router.stream({
        model: 'claude-sonnet-4-20250514',
        system: 'sys',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [
            { id: 't_kept', name: 'x', input: {} },
            { id: 't_orphan', name: 'y', input: {} },
          ] },
          { role: 'tool', toolCallId: 't_kept', content: 'ok' },
        ],
      });
      // Drain the generator — fetch is invoked lazily on first yield.
      // eslint-disable-next-line no-unused-vars
      for await (const _evt of gen) { /* drain */ }
    } catch { /* 401 from mock fetch — we only care about the body */ }

    expect(capturedBody).not.toBeNull();
    const wireMsgs = capturedBody.messages || [];
    const toolUseIds = [];
    const toolResultIds = new Set();
    for (const m of wireMsgs) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === 'tool_use' && block.id) toolUseIds.push(block.id);
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
    expect(toolUseIds).toEqual(['t_kept']);
    expect(toolResultIds.has('t_kept')).toBe(true);
    expect(toolUseIds.includes('t_orphan')).toBe(false);
  });
});
