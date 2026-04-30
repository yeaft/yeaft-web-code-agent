/**
 * Tests for the in-memory Unify history compactor.
 *
 * Background: `agent/unify/web-bridge.js`'s flat `conversationMessages`
 * array grew unbounded — every fan-out turn snapshotted the whole thing
 * and fed it to every VP. The fix introduces token+turn-count triggers
 * (>20 turns OR >80K tokens) and a Claude-Code-style compact: replace
 * the prefix with a single user-role summary message, keep the last N
 * user→assistant arcs intact.
 *
 * These tests cover:
 *   - trigger evaluation (turn count, token count, neither, both)
 *   - turn / token counting helpers
 *   - cut-index calculation with `keepRecent`
 *   - summarizer-input cleaning (drops tool, drops _compactSummary,
 *     elides toolCalls)
 *   - the wrap format (matches the canonical Claude Code phrase that
 *     existing frontend filters look for)
 *   - end-to-end compactHistory: produces shorter array, preserves tail,
 *     summary lands as a single user-role message at the head
 *   - no-op path when below thresholds
 *   - no-op path when too few turns to fold while preserving keepRecent
 *   - summarizer failure leaves history untouched
 *   - leading orphan tool messages in the tail are dropped (would 400
 *     the chat-completions adapter otherwise)
 *   - DEFAULTS match the user-stated policy (20 turns / 80K tokens)
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TURN_LIMIT,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_KEEP_RECENT_TURNS,
  estimateMessageTokens,
  estimateMessagesTokens,
  countTurns,
  shouldCompactHistory,
  buildSummarizerInput,
  findCutIndex,
  wrapSummaryAsUserMessage,
  buildSummaryPrompt,
  compactHistory,
} from '../../../../agent/unify/history-compact.js';

// ─── Default policy ─────────────────────────────────────────────────

describe('defaults match the user-stated policy', () => {
  it('turn limit is 20', () => {
    expect(DEFAULT_TURN_LIMIT).toBe(20);
  });
  it('token limit is 80,000', () => {
    expect(DEFAULT_TOKEN_LIMIT).toBe(80_000);
  });
  it('keepRecent is 2 user→assistant pairs by default', () => {
    expect(DEFAULT_KEEP_RECENT_TURNS).toBe(2);
  });
});

// ─── Token / turn counting ──────────────────────────────────────────

describe('estimateMessageTokens', () => {
  it('counts content + role framing', () => {
    const m = { role: 'user', content: 'a'.repeat(40) }; // 10 tokens for content + 2 framing
    expect(estimateMessageTokens(m)).toBe(12);
  });

  it('counts toolCalls input + name', () => {
    const m = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'bash', input: { command: 'echo hi' } }],
    };
    // 2 framing + 4 tool framing + ceil(JSON.stringify(input).length/4) + ceil('bash'.length/4)
    const inputLen = JSON.stringify({ command: 'echo hi' }).length;
    expect(estimateMessageTokens(m)).toBe(2 + 4 + Math.ceil(inputLen / 4) + Math.ceil('bash'.length / 4));
  });

  it('handles null / undefined / non-object input', () => {
    expect(estimateMessageTokens(null)).toBe(0);
    expect(estimateMessageTokens(undefined)).toBe(0);
    expect(estimateMessageTokens('not a message')).toBe(0);
  });

  it('handles tool messages with toolCallId', () => {
    const m = { role: 'tool', toolCallId: 't1', content: 'result body' };
    // 2 role + ceil(11/4)=3 + 2 toolCallId
    expect(estimateMessageTokens(m)).toBe(2 + 3 + 2);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums across all messages', () => {
    const ms = [
      { role: 'user', content: 'aaaa' },          // 2 + 1
      { role: 'assistant', content: 'bbbb' },     // 2 + 1
    ];
    expect(estimateMessagesTokens(ms)).toBe(6);
  });
  it('returns 0 for empty / non-array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
    expect(estimateMessagesTokens(null)).toBe(0);
  });
});

describe('countTurns', () => {
  it('counts user-role messages only', () => {
    const ms = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'x' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'sure' },
    ];
    expect(countTurns(ms)).toBe(2);
  });
  it('returns 0 for empty / non-array', () => {
    expect(countTurns([])).toBe(0);
    expect(countTurns(null)).toBe(0);
  });
});

// ─── Trigger evaluation ─────────────────────────────────────────────

describe('shouldCompactHistory', () => {
  it('returns trigger=false on a small, fresh conversation', () => {
    const ms = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const r = shouldCompactHistory(ms);
    expect(r.trigger).toBe(false);
    expect(r.reason).toBe(null);
    expect(r.turnCount).toBe(1);
  });

  it('fires on turn_count when user messages exceed turnLimit', () => {
    const ms = [];
    for (let i = 0; i < 22; i++) {
      ms.push({ role: 'user', content: `q${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    const r = shouldCompactHistory(ms);
    expect(r.trigger).toBe(true);
    expect(r.reason).toBe('turn_count');
    expect(r.turnCount).toBe(22);
  });

  it('fires on token_threshold even with few turns', () => {
    // One huge user message
    const big = 'x'.repeat(81_000 * 4); // ~81K tokens at 4 chars/token
    const ms = [{ role: 'user', content: big }];
    const r = shouldCompactHistory(ms);
    expect(r.trigger).toBe(true);
    expect(r.reason).toBe('token_threshold');
    expect(r.tokenCount).toBeGreaterThan(80_000);
  });

  it('respects override thresholds', () => {
    const ms = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'sure' },
    ];
    const r = shouldCompactHistory(ms, { turnLimit: 1 });
    expect(r.trigger).toBe(true);
    expect(r.reason).toBe('turn_count');
  });

  it('reports turn_count first when both triggers fire', () => {
    const ms = [];
    for (let i = 0; i < 25; i++) {
      ms.push({ role: 'user', content: 'x'.repeat(20_000) });
    }
    const r = shouldCompactHistory(ms);
    expect(r.trigger).toBe(true);
    // Both fire, but turn_count is checked first.
    expect(r.reason).toBe('turn_count');
  });
});

// ─── Cut index ──────────────────────────────────────────────────────

describe('findCutIndex', () => {
  it('returns -1 on empty', () => {
    expect(findCutIndex([], 2)).toBe(-1);
  });

  it('returns -1 when fewer user messages than keepRecent', () => {
    const ms = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply' },
    ];
    expect(findCutIndex(ms, 2)).toBe(-1);
  });

  it('returns the index of the (keepRecent)th-from-end user message', () => {
    const ms = [
      { role: 'user', content: 'u0' },         // 0
      { role: 'assistant', content: 'a0' },    // 1
      { role: 'user', content: 'u1' },         // 2
      { role: 'assistant', content: 'a1' },    // 3
      { role: 'user', content: 'u2' },         // 4 ← keep window starts here for keepRecent=2 (u2, u3)... wait, only 3 users total. keepRecent=2 means keep last 2 users.
      { role: 'assistant', content: 'a2' },    // 5
    ];
    // last 2 users from end are u2 (idx 4) and u1 (idx 2). Cut starts at idx 2.
    expect(findCutIndex(ms, 2)).toBe(2);
  });

  it('returns 0 when keepRecent equals total users (nothing to fold)', () => {
    const ms = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    // The "2nd from end" user is u0 at idx 0 → caller treats 0 as no-op.
    expect(findCutIndex(ms, 2)).toBe(0);
  });

  it('keepRecent=0 folds everything', () => {
    const ms = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
    ];
    expect(findCutIndex(ms, 0)).toBe(2);
  });
});

// ─── Summarizer input cleaning ──────────────────────────────────────

describe('buildSummarizerInput', () => {
  it('drops role:tool messages', () => {
    const ms = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', toolCallId: 't1', content: 'huge raw output' },
      { role: 'assistant', content: 'done' },
    ];
    const out = buildSummarizerInput(ms);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('drops messages tagged _compactSummary (no double-summarising)', () => {
    const ms = [
      { role: 'user', content: 'old summary', _compactSummary: true },
      { role: 'user', content: 'new question' },
    ];
    const out = buildSummarizerInput(ms);
    expect(out).toEqual([{ role: 'user', content: 'new question' }]);
  });

  it('elides toolCalls into a tag line on assistant messages', () => {
    const ms = [
      {
        role: 'assistant',
        content: 'running it',
        toolCalls: [{ id: 't1', name: 'bash', input: { command: 'ls' } }],
      },
    ];
    const out = buildSummarizerInput(ms);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('running it');
    expect(out[0].content).toContain('[tool bash:');
    expect(out[0].content).toContain('"command":"ls"');
  });

  it('truncates long tool inputs', () => {
    const longInput = { command: 'a'.repeat(500) };
    const ms = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'bash', input: longInput }] },
    ];
    const out = buildSummarizerInput(ms);
    expect(out[0].content).toContain('…');
    expect(out[0].content.length).toBeLessThan(200);
  });

  it('drops messages whose effective content is empty', () => {
    const ms = [
      { role: 'assistant', content: '' }, // no toolCalls either
      { role: 'user', content: 'real' },
    ];
    const out = buildSummarizerInput(ms);
    expect(out).toEqual([{ role: 'user', content: 'real' }]);
  });
});

// ─── Wrap format ────────────────────────────────────────────────────

describe('wrapSummaryAsUserMessage', () => {
  it('produces a user-role message tagged _compactSummary', () => {
    const m = wrapSummaryAsUserMessage('decisions: A, B');
    expect(m.role).toBe('user');
    expect(m._compactSummary).toBe(true);
  });

  it('uses the canonical Claude-Code phrase that frontend filters look for', () => {
    const m = wrapSummaryAsUserMessage('x');
    // Existing filters in web/stores/helpers/claudeOutput.js and
    // server/db/message-db.js match on this exact substring.
    expect(m.content).toContain('This session is being continued from a previous conversation');
  });

  it('ends with the recovery directive', () => {
    const m = wrapSummaryAsUserMessage('x');
    expect(m.content).toMatch(/Continue the conversation from where it left off/);
  });

  it('includes the summary body verbatim', () => {
    const m = wrapSummaryAsUserMessage('decisions: A, B, C');
    expect(m.content).toContain('decisions: A, B, C');
  });

  it('handles empty summary gracefully', () => {
    const m = wrapSummaryAsUserMessage('');
    expect(m.content).toContain('(no summary produced)');
  });
});

describe('buildSummaryPrompt', () => {
  it('produces a system+prompt pair', () => {
    const out = buildSummaryPrompt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out.system).toMatch(/summarizer/i);
    expect(out.prompt).toContain('hi');
    expect(out.prompt).toContain('ok');
  });
});

// ─── End-to-end compact ─────────────────────────────────────────────

describe('compactHistory (end-to-end)', () => {
  it('no-op when below thresholds', async () => {
    const ms = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const summarize = async () => 'should not be called';
    const r = await compactHistory(ms, { summarize });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(ms); // same reference, untouched
  });

  it('throws on missing summarize fn', async () => {
    await expect(compactHistory([], {})).rejects.toThrow(/summarize/);
  });

  it('compacts when turn count exceeds limit', async () => {
    // Build 22 user→assistant arcs.
    const ms = [];
    for (let i = 0; i < 22; i++) {
      ms.push({ role: 'user', content: `q${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    let summarizeCalls = 0;
    const summarize = async ({ system, prompt }) => {
      summarizeCalls++;
      expect(system).toMatch(/summarizer/i);
      expect(prompt).toContain('q0');
      return '- decisions made\n- facts learned';
    };
    const r = await compactHistory(ms, { summarize });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe('turn_count');
    expect(summarizeCalls).toBe(1);
    // Tail = last 2 user→assistant pairs = 4 messages, plus summary = 5
    expect(r.messages.length).toBe(5);
    expect(r.messages[0]._compactSummary).toBe(true);
    expect(r.messages[0].role).toBe('user');
    // Recent tail preserved verbatim
    expect(r.messages[1]).toEqual({ role: 'user', content: 'q20' });
    expect(r.messages[2]).toEqual({ role: 'assistant', content: 'a20' });
    expect(r.messages[3]).toEqual({ role: 'user', content: 'q21' });
    expect(r.messages[4]).toEqual({ role: 'assistant', content: 'a21' });
    expect(r.archivedCount).toBe(40); // 0..39 folded
    expect(r.afterTurns).toBeLessThan(r.beforeTurns);
  });

  it('compacts when token count exceeds limit', async () => {
    // 5 turns but each huge.
    const ms = [];
    const big = 'x'.repeat(20_000 * 4); // 20K tokens each
    for (let i = 0; i < 5; i++) {
      ms.push({ role: 'user', content: big });
      ms.push({ role: 'assistant', content: big });
    }
    const summarize = async () => 'compact summary';
    const r = await compactHistory(ms, { summarize });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe('token_threshold');
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
  });

  it('summarizer failure leaves history untouched (returns error field)', async () => {
    const ms = [];
    for (let i = 0; i < 22; i++) {
      ms.push({ role: 'user', content: `q${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    const summarize = async () => { throw new Error('LLM down'); };
    const r = await compactHistory(ms, { summarize });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(ms);
    expect(r.error).toBe('LLM down');
  });

  it('drops orphan tool messages at the head of the tail', async () => {
    // Construct: user, assistant+toolCall, tool, user, assistant, ... [tail]
    // After folding the first arc, the tail would start with `tool` if we
    // weren't careful — that orphan would 400 the next adapter call.
    const ms = [
      { role: 'user', content: 'q0' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', toolCallId: 't1', content: 'output' },
    ];
    // Pad with 21 more turns so trigger fires.
    for (let i = 1; i < 22; i++) {
      ms.push({ role: 'user', content: `u${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    const summarize = async () => 'summary';
    const r = await compactHistory(ms, { summarize });
    expect(r.compacted).toBe(true);
    // First message after summary must NOT be tool-role.
    expect(r.messages[0]._compactSummary).toBe(true);
    expect(r.messages[1].role).not.toBe('tool');
  });

  it('does not mutate the input array', async () => {
    const ms = [];
    for (let i = 0; i < 22; i++) {
      ms.push({ role: 'user', content: `q${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    const original = [...ms];
    const summarize = async () => 'summary';
    await compactHistory(ms, { summarize });
    expect(ms).toEqual(original);
  });

  it('respects custom keepRecent', async () => {
    const ms = [];
    for (let i = 0; i < 22; i++) {
      ms.push({ role: 'user', content: `q${i}` });
      ms.push({ role: 'assistant', content: `a${i}` });
    }
    const summarize = async () => 'summary';
    const r = await compactHistory(ms, { summarize, keepRecent: 1 });
    expect(r.compacted).toBe(true);
    // Tail = last 1 user→assistant pair = 2 messages, plus summary = 3
    expect(r.messages.length).toBe(3);
    expect(r.messages[1]).toEqual({ role: 'user', content: 'q21' });
    expect(r.messages[2]).toEqual({ role: 'assistant', content: 'a21' });
  });

  it('no-op when triggered but too few turns to fold while keeping the window', async () => {
    // Force trigger via low turnLimit, but keepRecent equals total users.
    const ms = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const summarize = async () => 'summary';
    const r = await compactHistory(ms, { summarize, turnLimit: 1, keepRecent: 2 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(ms);
    expect(r.reason).toBe('turn_count');
  });
});
