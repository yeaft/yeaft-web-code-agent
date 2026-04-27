/**
 * Phase 5 — tool-result archive (DESIGN.md §4.3).
 *
 * Pin: turn_age + length thresholds, stub format preserves
 * tool_call_id pairing, body retrievable via archive read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeTurnAges,
  archiveOne,
  archiveToolResults,
  readArchivedTool,
  toolArchivePath,
} from '../../../../agent/unify/archive/tool-results.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tool-archive-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('toolArchivePath', () => {
  it('builds canonical path', () => {
    expect(toolArchivePath({ root: '/r', scopeDir: 'groups/eng', toolCallId: 'tc_1' }))
      .toBe('/r/groups/eng/archive/tool-results/tc_1.md');
  });
  it('throws on missing args', () => {
    expect(() => toolArchivePath({ root: '/r', scopeDir: '', toolCallId: 't' })).toThrow();
  });
});

describe('computeTurnAges', () => {
  it('counts how many user messages appear AFTER each tool message', () => {
    const messages = [
      { role: 'user' },              // 0
      { role: 'assistant' },         // 1
      { role: 'tool', toolCallId: 'a', content: 'x' },  // 2 — 3 users after
      { role: 'user' },              // 3
      { role: 'tool', toolCallId: 'b', content: 'y' },  // 4 — 2 users after
      { role: 'user' },              // 5
      { role: 'assistant' },         // 6
      { role: 'tool', toolCallId: 'c', content: 'z' },  // 7 — 1 user after
      { role: 'user' },              // 8
      { role: 'tool', toolCallId: 'd', content: 'w' },  // 9 — 0 users after
    ];
    const ages = computeTurnAges(messages);
    expect(ages[2]).toBe(3);
    expect(ages[4]).toBe(2);
    expect(ages[7]).toBe(1);
    expect(ages[9]).toBe(0);
    // Non-tool entries report 0.
    expect(ages[0]).toBe(0);
    expect(ages[1]).toBe(0);
  });

  it('handles empty / non-array', () => {
    expect(computeTurnAges([])).toEqual([]);
    expect(computeTurnAges(null)).toEqual([]);
  });
});

describe('archiveOne / readArchivedTool', () => {
  it('writes the body and returns a stub that preserves toolCallId', async () => {
    const body = 'X'.repeat(5000);
    const r = await archiveOne({
      root, scopeDir: 'groups/eng',
      message: { role: 'tool', toolCallId: 'tc_42', content: body, isError: false },
    });
    expect(r.archivedBytes).toBe(5000);
    expect(r.stub.role).toBe('tool');
    expect(r.stub.toolCallId).toBe('tc_42');
    expect(r.stub.content).toMatch(/^\[archived: 4\.9KB; preview: "/);
    expect(r.stub.content).toMatch(/tool_trace\("tc_42"\)/);
    // Body retrievable.
    const back = await readArchivedTool({ root, scopeDir: 'groups/eng', toolCallId: 'tc_42' });
    expect(back).toBe(body);
  });

  it('readArchivedTool returns null when missing', async () => {
    expect(await readArchivedTool({ root, scopeDir: 'groups/eng', toolCallId: 'never' })).toBeNull();
  });

  it('throws on non-tool message', async () => {
    await expect(archiveOne({
      root, scopeDir: 'groups/eng',
      message: { role: 'user', content: 'q' },
    })).rejects.toThrow(/tool message required/);
  });
});

describe('archiveToolResults sweep', () => {
  const buildLog = () => {
    // Five turns; the first three tools are old AND big, the last two are
    // either too young or too small.
    const big = 'A'.repeat(3000);
    const small = 'tiny';
    return [
      { role: 'user', content: 'q1' },
      { role: 'assistant', toolCalls: [{ id: 'tc_old_big' }] },
      { role: 'tool', toolCallId: 'tc_old_big', content: big },
      { role: 'user', content: 'q2' },
      { role: 'assistant', toolCalls: [{ id: 'tc_old_small' }] },
      { role: 'tool', toolCallId: 'tc_old_small', content: small },
      { role: 'user', content: 'q3' },
      { role: 'assistant', toolCalls: [{ id: 'tc_mid_big' }] },
      { role: 'tool', toolCallId: 'tc_mid_big', content: big },
      { role: 'user', content: 'q4' },
      { role: 'user', content: 'q5' },
      { role: 'user', content: 'q6' },
      { role: 'user', content: 'q7' },
      { role: 'assistant', toolCalls: [{ id: 'tc_recent_big' }] },
      { role: 'tool', toolCallId: 'tc_recent_big', content: big },
      { role: 'user', content: 'q8' },
    ];
  };

  it('archives only tool messages older than turnAgeMin AND bigger than lengthMin', async () => {
    const messages = buildLog();
    // Default thresholds: age > 5 AND length > 2000.
    // tc_old_big idx=2 — age 7, big → archive.
    // tc_old_small idx=5 — age 6, small → skip.
    // tc_mid_big idx=8 — age 5 (NOT > 5) → skip.
    // tc_recent_big idx=14 — age 1 → skip.
    const out = await archiveToolResults({ root, scopeDir: 'groups/eng', messages });
    expect(out.archivedCount).toBe(1);
    expect(out.nextMessages[2].content).toMatch(/^\[archived/);
    // Other tool messages kept verbatim.
    expect(out.nextMessages[5].content).toBe('tiny');
    expect(out.nextMessages[8].content).toMatch(/^A+$/);
    expect(out.nextMessages[14].content).toMatch(/^A+$/);
  });

  it('returns the same array reference when nothing is archived', async () => {
    const messages = [{ role: 'user', content: 'q' }];
    const out = await archiveToolResults({ root, scopeDir: 'groups/eng', messages });
    expect(out.nextMessages).toBe(messages);
    expect(out.archivedCount).toBe(0);
  });

  it('skips already-archived stubs on second pass', async () => {
    const messages = buildLog();
    const first = await archiveToolResults({ root, scopeDir: 'groups/eng', messages });
    const second = await archiveToolResults({ root, scopeDir: 'groups/eng', messages: first.nextMessages });
    expect(second.archivedCount).toBe(0);
    expect(second.nextMessages).toBe(first.nextMessages);
  });

  it('thresholds are configurable', async () => {
    const messages = buildLog();
    const out = await archiveToolResults({
      root, scopeDir: 'groups/eng', messages,
      turnAgeMin: 0, lengthMin: 10,
    });
    // Now also the "recent_big" qualifies (age > 0 means everything but
    // the last turn's tools archives).
    expect(out.archivedCount).toBeGreaterThanOrEqual(3);
  });
});
