/**
 * dream-v2/runner.test.js — §13 end-to-end orchestration with stubbed
 * LLM and message-store hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDream } from '../../../../agent/yeaft/dream-v2/runner.js';
import { readGroupState, writeGroupState } from '../../../../agent/yeaft/dream-v2/state.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-run-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeLlm(spec = {}) {
  return async ({ pass, prompt }) => {
    if (pass === 'triage-pass1') {
      return JSON.stringify(spec.pass1 || { user_profile_signals: false, topics: [], trivial_only: true });
    }
    if (pass === 'triage-pass2') {
      return JSON.stringify(spec.pass2 || { decision: 'none' });
    }
    if (pass === 'update' || pass === 'create') {
      return JSON.stringify({
        memory_md: `<!-- written by ${pass} -->\nfor: ${extractScope(prompt)}\n`,
        summary_md: `summary for ${extractScope(prompt)}`,
      });
    }
    throw new Error(`unexpected pass ${pass}`);
  };
}
function extractScope(prompt) {
  const m = /Scope(?: path)?:\s*(\S+)/.exec(prompt);
  return m ? m[1] : '?';
}

describe('runDream — happy path', () => {
  it('skips groups below the new-message threshold', async () => {
    const events = [];
    const r = await runDream({
      root,
      llm: makeLlm(),
      listGroups: async () => ['g-eng', 'g-quiet'],
      countMessages: async (g) => g === 'g-eng' ? 50 : 5,
      loadGroupDiff: async (g) => g === 'g-eng'
        ? Array.from({ length: 50 }, (_, i) => ({ id: `e${i + 1}`, role: 'user', body: 'hi' }))
        : [],
      loadOverlapPreamble: async () => [],
      onProgress: e => events.push(e),
    });
    const skipped = r.groups.find(x => x.groupId === 'g-quiet');
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe('below-threshold');

    const eng = r.groups.find(x => x.groupId === 'g-eng');
    expect(eng.status).toBe('triaged');
    expect(eng.actions).toBeGreaterThan(0); // hard rules at least
  });

  it('manual trigger ignores the threshold but skips zero-new', async () => {
    const r = await runDream({
      root,
      manual: true,
      llm: makeLlm(),
      listGroups: async () => ['g-eng', 'g-empty'],
      countMessages: async (g) => g === 'g-eng' ? 5 : 0,
      loadGroupDiff: async (g) => g === 'g-eng'
        ? [{ id: 'e1', role: 'user', body: 'hi' }]
        : [],
      loadOverlapPreamble: async () => [],
    });
    expect(r.groups.find(x => x.groupId === 'g-eng').status).toBe('triaged');
    expect(r.groups.find(x => x.groupId === 'g-empty').status).toBe('skipped');
    expect(r.groups.find(x => x.groupId === 'g-empty').reason).toBe('no-new-messages');
  });

  it('runs apply and bookkeeps lastDreamMessageId', async () => {
    const diffMessages = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i + 1}`, role: i % 2 ? 'assistant' : 'user', vpId: 'zhang-san', body: `msg ${i + 1}`,
    }));
    await runDream({
      root,
      llm: makeLlm(),
      listGroups: async () => ['g-eng'],
      countMessages: async () => diffMessages.length,
      loadGroupDiff: async () => diffMessages,
      loadOverlapPreamble: async () => [],
      nowIso: () => '2026-04-28T03:07:00Z',
    });
    // user/memory.md was created by Apply.
    const userMem = readFileSync(join(root, 'user', 'memory.md'), 'utf8');
    expect(userMem).toContain('written by update');
    expect(userMem).toContain('lastDreamAt: 2026-04-28T03:07:00Z');
    // group/g-eng was also written.
    expect(existsSync(join(root, 'group', 'g-eng', 'memory.md'))).toBe(true);
    // vp/zhang-san was written via the assistant-vp hard rule.
    expect(existsSync(join(root, 'vp', 'zhang-san', 'memory.md'))).toBe(true);
    // Bookkeeping: g-eng's lastDreamMessageId advanced to the tail.
    const state = await readGroupState(root, 'g-eng');
    expect(state.lastDreamMessageId).toBe('m25');
    expect(state.messageCount).toBe(25);
    expect(state.lastDreamAt).toBe('2026-04-28T03:07:00Z');
  });

  it('uses overlap preamble when prior dream cursor exists', async () => {
    await writeGroupState(root, 'g', { lastDreamMessageId: 'old-tail', lastDreamAt: '2026-01-01', messageCount: 100 });
    const newMessages = Array.from({ length: 25 }, (_, i) => ({ id: `n${i + 1}`, role: 'user', body: 'hi' }));
    const overlap = [
      { id: 'o1', role: 'user', body: 'overlap-1' },
      { id: 'o2', role: 'assistant', body: 'overlap-2' },
      { id: 'o3', role: 'user', body: 'overlap-3' },
    ];
    let preambleCalls = 0;
    let pass1Prompt = '';
    const llm = async ({ pass, prompt }) => {
      if (pass === 'triage-pass1') pass1Prompt = prompt;
      return JSON.stringify(pass === 'triage-pass1'
        ? { user_profile_signals: false, topics: [], trivial_only: true }
        : { memory_md: 'x', summary_md: 'y' });
    };
    await runDream({
      root,
      llm,
      listGroups: async () => ['g'],
      countMessages: async () => 125,
      loadGroupDiff: async () => newMessages,
      loadOverlapPreamble: async (gid, before, n) => {
        preambleCalls += 1;
        expect(before).toBe('old-tail');
        expect(n).toBe(3);
        return overlap;
      },
      nowIso: () => '2026-04-28T03:07:00Z',
    });
    expect(preambleCalls).toBe(1);
    // Overlap messages were marked.
    expect(pass1Prompt).toContain('already processed');
    expect(pass1Prompt).toContain('overlap-1');
  });

  it('does not advance bookkeeping when all applies error', async () => {
    const llm = async ({ pass }) => {
      if (pass.startsWith('triage')) {
        return JSON.stringify(pass === 'triage-pass1' ? { topics: [] } : { decision: 'none' });
      }
      throw new Error('llm exploded');
    };
    const before = await readGroupState(root, 'g-fail');
    expect(before.lastDreamMessageId).toBe(null);

    const r = await runDream({
      root,
      llm,
      listGroups: async () => ['g-fail'],
      countMessages: async () => 25,
      loadGroupDiff: async () => Array.from({ length: 25 }, (_, i) => ({ id: `f${i + 1}`, role: 'user', body: 'x' })),
      loadOverlapPreamble: async () => [],
    });
    // Every apply errored.
    expect(r.targets.every(t => t.status === 'error')).toBe(true);
    // Cursor not advanced.
    const after = await readGroupState(root, 'g-fail');
    expect(after.lastDreamMessageId).toBe(null);
  });

  it('respects scopeFilter', async () => {
    const r = await runDream({
      root,
      manual: true,
      scopeFilter: ['user'],
      llm: makeLlm(),
      listGroups: async () => ['g'],
      countMessages: async () => 1,
      loadGroupDiff: async () => [{ id: 'm1', role: 'user', body: 'hi' }],
      loadOverlapPreamble: async () => [],
    });
    // Only the 'user' target should appear in targets[].
    const targets = r.targets.map(t => t.target);
    expect(targets).toEqual(['user']);
  });

  it('uses group scopeFilter to process only the selected group while bypassing the manual threshold', async () => {
    const calls = [];
    const r = await runDream({
      root,
      manual: true,
      scopeFilter: ['group/g-current'],
      llm: makeLlm(),
      listGroups: async () => ['g-current', 'g-other'],
      countMessages: async (g) => {
        calls.push(`count:${g}`);
        return 1;
      },
      loadGroupDiff: async (g) => {
        calls.push(`diff:${g}`);
        return [{ id: `${g}-m1`, role: 'user', body: 'hi' }];
      },
      loadOverlapPreamble: async () => [],
    });

    expect(calls).toEqual(['count:g-current', 'diff:g-current']);
    expect(r.groups.find(x => x.groupId === 'g-current').status).toBe('triaged');
    expect(r.groups.find(x => x.groupId === 'g-other')).toMatchObject({
      status: 'skipped',
      reason: 'scope-filtered',
    });
    const targets = r.targets.map(t => t.target).sort();
    expect(targets).toEqual(['group/g-current', 'user']);
  });

  it('reruns scoped manual group dreams over prior messages and persists memory summaries', async () => {
    const priorMessages = [
      { id: 'm1', role: 'user', body: 'Dream should remember that the operator prefers concise release notes.' },
      { id: 'm2', role: 'assistant', vpId: 'linus', body: 'We should keep the fix small and tested.' },
    ];
    const calls = [];
    await writeGroupState(root, 'g-current', {
      lastDreamMessageId: 'm2',
      lastDreamAt: '2026-05-17T00:00:00Z',
      messageCount: priorMessages.length,
    });

    const r = await runDream({
      root,
      manual: true,
      scopeFilter: ['group/g-current'],
      llm: makeLlm(),
      listGroups: async () => ['g-current', 'g-other'],
      countMessages: async (g) => {
        calls.push(`count:${g}`);
        return g === 'g-current' ? priorMessages.length : 99;
      },
      loadGroupDiff: async (g, sinceId) => {
        calls.push(`diff:${g}:${sinceId ?? '<all>'}`);
        return g === 'g-current' ? priorMessages : [];
      },
      loadOverlapPreamble: async () => {
        calls.push('overlap');
        return [];
      },
      nowIso: () => '2026-05-18T06:00:00Z',
    });

    expect(calls).toEqual(['count:g-current', 'diff:g-current:<all>']);
    expect(r.groups.find(x => x.groupId === 'g-current')).toMatchObject({
      status: 'triaged',
      new: 0,
      rerun: true,
    });
    expect(r.groups.find(x => x.groupId === 'g-other')).toMatchObject({
      status: 'skipped',
      reason: 'scope-filtered',
    });
    expect(r.targets.map(t => t.target).sort()).toEqual(['group/g-current', 'user', 'vp/linus']);

    const groupMem = readFileSync(join(root, 'group', 'g-current', 'memory.md'), 'utf8');
    const groupSummary = readFileSync(join(root, 'group', 'g-current', 'summary.md'), 'utf8');
    expect(groupMem).toContain('written by update');
    expect(groupMem).toContain('lastDreamAt: 2026-05-18T06:00:00Z');
    expect(groupSummary.trimEnd()).toBe('summary for group/g-current');

    const state = await readGroupState(root, 'g-current');
    expect(state.lastDreamMessageId).toBe('m2');
    expect(state.messageCount).toBe(priorMessages.length);
    expect(state.lastDreamAt).toBe('2026-05-18T06:00:00Z');
  });

  it('returns empty-diff skipped reason for manual current-group runs when no messages can be loaded', async () => {
    const r = await runDream({
      root,
      manual: true,
      scopeFilter: ['group/g-current'],
      llm: makeLlm(),
      listGroups: async () => ['g-current', 'g-other'],
      countMessages: async () => 1,
      loadGroupDiff: async () => [],
      loadOverlapPreamble: async () => [],
    });

    expect(r.groups.find(x => x.groupId === 'g-current')).toMatchObject({
      status: 'skipped',
      reason: 'empty-diff',
    });
    expect(r.targets).toEqual([]);
  });

  it('emits dream_progress lifecycle events', async () => {
    const events = [];
    await runDream({
      root,
      llm: makeLlm(),
      listGroups: async () => ['g'],
      countMessages: async () => 25,
      loadGroupDiff: async () => Array.from({ length: 25 }, (_, i) => ({ id: `m${i + 1}`, role: 'user', body: 'x' })),
      loadOverlapPreamble: async () => [],
      onProgress: e => events.push(e),
    });
    const phases = new Set(events.map(e => e.phase));
    expect(phases.has('start')).toBe(true);
    expect(phases.has('triage')).toBe(true);
    expect(phases.has('merge')).toBe(true);
    expect(phases.has('apply')).toBe(true);
    expect(phases.has('done')).toBe(true);
  });
});
