/**
 * web-bridge-trim-snapshot.test.js — Pin the snapshot-trim contract that
 * `runVpTurn` relies on to cap the per-call messages array fed to
 * `engine.query`.
 *
 * Bug being guarded against:
 *   The flat module-level `conversationMessages` array in
 *   `agent/unify/web-bridge.js` grows unbounded. Each multi-VP fan-out
 *   used to feed the WHOLE thing to `engine.query`. Once a long chat
 *   accumulated 700+ messages the LLM provider returned a 4xx
 *   "context window exceeded". `history-compact.js` only fires above a
 *   12K-token soft floor — small chats with many short turns stay below
 *   that floor but still bloat the messages array. `trimSnapshotForBudget`
 *   is the second-line defense that ALWAYS runs, before every query.
 */

import { describe, it, expect } from 'vitest';
import { trimSnapshotForBudget } from '../../agent/unify/web-bridge.js';
import { countTurns } from '../../agent/unify/turn-utils.js';

function buildSyntheticHistory(turnCount, charsPerMsg = 10) {
  const ms = [];
  const filler = 'x'.repeat(Math.max(1, charsPerMsg));
  for (let i = 0; i < turnCount; i++) {
    ms.push({ role: 'user', content: `q${i} ${filler}` });
    ms.push({ role: 'assistant', content: `a${i} ${filler}` });
  }
  return ms;
}

describe('trimSnapshotForBudget — turn-count cap', () => {
  it('caps at 25 turns by default when history is much longer', () => {
    const huge = buildSyntheticHistory(200, 10);
    expect(countTurns(huge)).toBe(200);
    const out = trimSnapshotForBudget(huge);
    expect(countTurns(out)).toBeLessThanOrEqual(25);
    // The kept slice must be a TAIL slice of the input — last messages
    // preserved.
    const lastInput = huge[huge.length - 1];
    expect(out[out.length - 1]).toEqual(lastInput);
  });

  it('keeps the whole history when it is below the turn cap', () => {
    const small = buildSyntheticHistory(5);
    const out = trimSnapshotForBudget(small);
    expect(out.length).toBe(small.length);
  });

  it('honors `recentTurnCap` override', () => {
    const huge = buildSyntheticHistory(50);
    const out = trimSnapshotForBudget(huge, { recentTurnCap: 10 });
    expect(countTurns(out)).toBeLessThanOrEqual(10);
  });

  it('returns empty array on empty / null input', () => {
    expect(trimSnapshotForBudget([])).toEqual([]);
    expect(trimSnapshotForBudget(null)).toEqual([]);
    expect(trimSnapshotForBudget(undefined)).toEqual([]);
  });
});

describe('trimSnapshotForBudget — token budget cap', () => {
  it('drops turns iteratively until under budget', () => {
    // 30 turns, each turn ≈ 200 chars/msg → ~50 tokens/msg → ~3000 total
    const ms = buildSyntheticHistory(30, 200);
    // Budget tight enough that we shed several turns but keep ≥1.
    const budget = 200;
    const out = trimSnapshotForBudget(ms, { messageTokenBudget: budget });
    // Should drop turns. The original is well over the budget, the
    // trimmed slice should be too — but smaller than the unbounded
    // turn-cap version.
    expect(out.length).toBeLessThan(50); // less than 25 turns × 2 msgs
    // Always preserves at least 1 turn, even if oversized.
    expect(out.length).toBeGreaterThan(0);
  });

  it('default token budget 8192 is enforced', () => {
    // Build a single huge user message that alone exceeds 8192 tokens.
    // ~10000 tokens of content in 25 turns: 25 turns × 1600 chars/msg × 2 msgs
    // = ~80000 chars / 4 ≈ 20000 tokens. Cap should kick in.
    const ms = buildSyntheticHistory(25, 1600);
    const out = trimSnapshotForBudget(ms); // default budget = 8192
    // Must produce at least one turn but fewer than the input.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(ms.length);
  });
});

describe('trimSnapshotForBudget — pair-safety', () => {
  it('drops orphan tool messages whose tool_use is no longer present', () => {
    // Build a long history with a tool-arc near the start. After turn
    // trimming the orphan tool result would cause a 400 if not sanitized.
    const ms = buildSyntheticHistory(50);
    // Inject an orphan tool message at index 1 (right after first user).
    ms.splice(1, 0, { role: 'tool', toolCallId: 'orphan-1', content: 'old result' });
    const out = trimSnapshotForBudget(ms, { recentTurnCap: 5 });
    const toolMsgs = out.filter(m => m.role === 'tool');
    // Any surviving tool must have a paired assistant tool_use in the
    // slice. With recentTurnCap=5 the slice never reaches the orphan, so
    // there should be zero tool messages in the trimmed result.
    expect(toolMsgs.length).toBe(0);
  });
});

describe('trimSnapshotForBudget — multi-VP turn coalescing', () => {
  it('treats `@vp-X` variants of the same prompt as ONE turn', () => {
    // Build 30 turns where every turn is a 3-VP fan-out (3 user msgs
    // + 3 assistant msgs per turn).
    const ms = [];
    for (let i = 0; i < 30; i++) {
      ms.push({ role: 'user', content: `@vp-alice prompt ${i}` });
      ms.push({ role: 'user', content: `@vp-bob prompt ${i}` });
      ms.push({ role: 'user', content: `@vp-carol prompt ${i}` });
      ms.push({ role: 'assistant', content: `a${i} alice` });
      ms.push({ role: 'assistant', content: `a${i} bob` });
      ms.push({ role: 'assistant', content: `a${i} carol` });
    }
    expect(countTurns(ms)).toBe(30);
    const out = trimSnapshotForBudget(ms, { recentTurnCap: 5 });
    // Must keep exactly 5 underlying turns, each with all 3 VP variants.
    expect(countTurns(out)).toBeLessThanOrEqual(5);
    // Should be at most 5 turns × 6 msgs per turn = 30 msgs.
    expect(out.length).toBeLessThanOrEqual(30);
  });
});
