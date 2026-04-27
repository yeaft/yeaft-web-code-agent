/**
 * Phase 4 — append-only task decisions log (DESIGN.md §9.1).
 *
 * Two parallel VPs writing to the same task must produce a chronological
 * record without clobbering each other. Atomic appendFile + JSON-lines
 * is the implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendDecision,
  readDecisions,
  decisionsLogPath,
} from '../../../../agent/unify/compact/decisions-log.js';

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'decisions-log-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('decisionsLogPath', () => {
  it('builds the canonical path', () => {
    expect(decisionsLogPath('/r', 't_42')).toBe('/r/tasks/t_42/decisions.jsonl');
  });
  it('throws on missing args', () => {
    expect(() => decisionsLogPath('', 't')).toThrow();
    expect(() => decisionsLogPath('/r', '')).toThrow();
  });
});

describe('appendDecision / readDecisions', () => {
  it('round-trips a single row', async () => {
    await appendDecision({ root, taskId: 't_1', vpId: 'linus', kind: 'plan', text: 'roll forward' });
    const rows = await readDecisions({ root, taskId: 't_1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vpId: 'linus', kind: 'plan', text: 'roll forward' });
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves chronological order across many appends', async () => {
    for (let i = 0; i < 20; i += 1) {
      await appendDecision({
        root, taskId: 't_2', vpId: i % 2 ? 'grace' : 'linus',
        kind: 'note', text: `n${i}`, ts: `2026-04-27T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
    const rows = await readDecisions({ root, taskId: 't_2' });
    expect(rows).toHaveLength(20);
    expect(rows.map(r => r.text)).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`));
  });

  it('readDecisions returns [] when log missing', async () => {
    expect(await readDecisions({ root, taskId: 'never' })).toEqual([]);
  });

  it('skips unparseable lines (torn last write)', async () => {
    const path = decisionsLogPath(root, 't_3');
    const { mkdirSync } = await import('fs');
    mkdirSync(join(root, 'tasks/t_3'), { recursive: true });
    writeFileSync(path,
      `${JSON.stringify({ ts: 'now', vpId: 'a', kind: 'k', text: 'good' })}\n` +
      `{not valid json\n`,
    );
    // Suppress expected warning noise.
    const warn = console.warn;
    console.warn = () => {};
    try {
      const rows = await readDecisions({ root, taskId: 't_3' });
      expect(rows).toHaveLength(1);
      expect(rows[0].text).toBe('good');
    } finally {
      console.warn = warn;
    }
  });

  it('throws on missing vpId or kind', async () => {
    await expect(appendDecision({ root, taskId: 't', kind: 'k', text: '' }))
      .rejects.toThrow(/vpId required/);
    await expect(appendDecision({ root, taskId: 't', vpId: 'v', text: '' }))
      .rejects.toThrow(/kind required/);
  });

  it('parallel appends all land (no clobber)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      appendDecision({ root, taskId: 't_4', vpId: 'v', kind: 'k', text: `r${i}` }),
    ));
    const rows = await readDecisions({ root, taskId: 't_4' });
    expect(rows).toHaveLength(10);
    expect(rows.map(r => r.text).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${i}`).sort(),
    );
  });
});
