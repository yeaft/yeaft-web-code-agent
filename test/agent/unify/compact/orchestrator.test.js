/**
 * Phase 4 — compact orchestrator (DESIGN.md §4.2).
 *
 * Pin the 3-track sequence: messages compaction (always), task summary
 * refresh (when taskId), memory extraction (always). Hooks are
 * injected so the test never touches LLMs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCompact } from '../../../../agent/unify/compact/orchestrator.js';

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'compact-orch-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const buildMessages = (turnCount) => {
  const out = [];
  for (let i = 0; i < turnCount; i += 1) {
    out.push({ role: 'user', content: `q${i}` });
    out.push({ role: 'assistant', content: `a${i}` });
  }
  return out;
};

describe('runCompact', () => {
  it('throws on bad inputs', async () => {
    await expect(runCompact({})).rejects.toThrow(/messages array required/);
    await expect(runCompact({ messages: [] })).rejects.toThrow(/hooks required/);
    await expect(runCompact({ messages: [], hooks: {} })).rejects.toThrow(/summarise required/);
    await expect(runCompact({ messages: [], hooks: { summarise: () => {} } }))
      .rejects.toThrow(/archive required/);
  });

  it('returns a no-op result when nothing is cooling', async () => {
    const messages = buildMessages(3);
    const hooks = {
      summarise: vi.fn(),
      archive: vi.fn(),
    };
    const out = await runCompact({ messages, keepHot: 10, hooks });
    expect(out.archivedGroups).toBe(0);
    expect(out.archivedMessages).toBe(0);
    expect(out.nextMessages).toBe(messages);
    expect(hooks.summarise).not.toHaveBeenCalled();
    expect(hooks.archive).not.toHaveBeenCalled();
  });

  it('compacts cooling groups and replaces them with a single placeholder', async () => {
    const messages = buildMessages(15);  // 30 messages, 15 groups
    const hooks = {
      summarise: vi.fn(async () => 'SUMMARY'),
      archive: vi.fn(async (i) => ({ turnId: `turn_${i}` })),
    };
    const out = await runCompact({ messages, keepHot: 5, hooks });
    expect(out.archivedGroups).toBe(10);
    expect(out.archivedMessages).toBe(20);
    expect(out.compactSummary).toBe('SUMMARY');
    // First message is the placeholder, then the 5 hot groups (10 messages).
    expect(out.nextMessages[0]).toMatchObject({ role: 'system', kind: 'compact_summary', content: 'SUMMARY' });
    expect(out.nextMessages.length).toBe(11);
    expect(out.nextMessages[1]).toEqual({ role: 'user', content: 'q10' });
    // Original messages array untouched.
    expect(messages.length).toBe(30);
  });

  it('archives each cooling group exactly once', async () => {
    const messages = buildMessages(8);
    const seen = [];
    const hooks = {
      summarise: async () => 'S',
      archive: async (i, msgs) => {
        seen.push({ i, count: msgs.length, firstUser: msgs[0].content });
        return { turnId: `t_${i}` };
      },
    };
    await runCompact({ messages, keepHot: 3, hooks });
    expect(seen).toEqual([
      { i: 0, count: 2, firstUser: 'q0' },
      { i: 1, count: 2, firstUser: 'q1' },
      { i: 2, count: 2, firstUser: 'q2' },
      { i: 3, count: 2, firstUser: 'q3' },
      { i: 4, count: 2, firstUser: 'q4' },
    ]);
  });

  it('keeps tool-call triples atomic (assistant + tool archived together)', async () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'use tool', toolCalls: [{ id: 'tc_1' }] },
      { role: 'tool', toolCallId: 'tc_1', content: 'result' },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const seen = [];
    const hooks = {
      summarise: async () => 'S',
      archive: async (i, msgs) => { seen.push(msgs.map(m => m.role)); return { turnId: `t_${i}` }; },
    };
    const out = await runCompact({ messages, keepHot: 1, hooks });
    expect(seen).toEqual([['user', 'assistant', 'tool', 'assistant']]);
    // Hot remainder: just the second user-assistant pair.
    expect(out.nextMessages.slice(1).map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('refreshes task summary when taskId + root + hook present', async () => {
    const messages = buildMessages(8);
    const hooks = {
      summarise: async () => 'S',
      archive: async () => ({ turnId: 't' }),
      refreshTaskSummary: async (cooling, prior) => `prior=${prior};turns=${cooling.length}`,
      readPriorTaskSummary: async () => 'PREV',
    };
    const out = await runCompact({ messages, keepHot: 3, taskId: 't_42', root, hooks });
    expect(out.taskSummaryRefreshed).toBe(true);
    const summaryFile = join(root, 'tasks/t_42/summary.md');
    expect(existsSync(summaryFile)).toBe(true);
    const content = readFileSync(summaryFile, 'utf8');
    expect(content).toContain('prior=PREV;turns=10');
  });

  it('skips task summary track when taskId missing', async () => {
    const messages = buildMessages(8);
    const refresh = vi.fn();
    const hooks = {
      summarise: async () => 'S',
      archive: async () => ({ turnId: 't' }),
      refreshTaskSummary: refresh,
    };
    const out = await runCompact({ messages, keepHot: 3, hooks });
    expect(out.taskSummaryRefreshed).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('runs extract track when hook present, reports written count', async () => {
    const messages = buildMessages(6);
    const hooks = {
      summarise: async () => 'S',
      archive: async () => ({ turnId: 't' }),
      extract: async (cooling) => ({ written: cooling.length }),
    };
    const out = await runCompact({ messages, keepHot: 2, hooks });
    expect(out.extractedCount).toBe(8);  // 4 cooling groups × 2 messages each
  });

  it('does not write task summary when hook returns empty', async () => {
    const messages = buildMessages(8);
    const hooks = {
      summarise: async () => 'S',
      archive: async () => ({ turnId: 't' }),
      refreshTaskSummary: async () => '   ',
    };
    const out = await runCompact({ messages, keepHot: 3, taskId: 't', root, hooks });
    expect(out.taskSummaryRefreshed).toBe(false);
    expect(existsSync(join(root, 'tasks/t/summary.md'))).toBe(false);
  });
});
