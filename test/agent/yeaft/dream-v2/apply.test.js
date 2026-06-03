/**
 * dream-v2/apply.test.js — §16 + §17.2
 *
 * applyMergedTarget runs UPDATE/CREATE, batching when needed, snapshot
 * pre-call, atomic write post-call, and stamps the dream-state marker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMergedTarget,
  buildUpdatePrompt,
  buildCreatePrompt,
  targetToScope,
} from '../../../../agent/yeaft/dream-v2/apply.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-apply-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('targetToScope', () => {
  it('maps scope strings', () => {
    expect(targetToScope('user')).toEqual({ kind: 'user' });
    expect(targetToScope('group/g1')).toEqual({ kind: 'group', id: 'g1' });
    expect(targetToScope('group/g1/user')).toEqual({ kind: 'group-user', sessionId: 'g1' });
    expect(targetToScope('group/g1/vp/zhang')).toEqual({ kind: 'group-vp', sessionId: 'g1', id: 'zhang' });
    expect(targetToScope('group/g1/feature/f1')).toEqual({ kind: 'group-feature', sessionId: 'g1', id: 'f1' });
    expect(targetToScope('group/g1/topic/sci/phys'))
      .toEqual({ kind: 'group-topic', sessionId: 'g1', path: ['sci', 'phys'] });
  });
  it('rejects legacy root scopes', () => {
    expect(() => targetToScope('vp/zhang')).toThrow(/legacy/);
    expect(() => targetToScope('feature/f1')).toThrow(/legacy/);
    expect(() => targetToScope('topic/sci')).toThrow(/legacy/);
  });
  it('throws on garbage', () => {
    expect(() => targetToScope('mystery/x')).toThrow();
  });
});

describe('UPDATE path', () => {
  it('runs once when content fits, writes both files atomically', async () => {
    // Pre-existing user/memory.md + summary.md
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(join(root, 'user', 'memory.md'), '# user\n\noriginal body\n');
    writeFileSync(join(root, 'user', 'summary.md'), 'old summary\n');

    const llm = async ({ pass }) => {
      expect(pass).toBe('update');
      return JSON.stringify({
        memory_md: '# user\n\nnew rewritten body\n',
        summary_md: 'new summary',
      });
    };
    const merged = {
      target: 'user',
      kind: 'update',
      sources: [{ sessionId: 'g-eng', diff: [{ role: 'user', body: 'hi' }] }],
    };
    const events = [];
    const r = await applyMergedTarget(merged, {
      root, ts: 'TS-1', llm, nowIso: () => '2026-04-28T03:07:00Z',
      onProgress: (e) => events.push(e),
    });
    expect(r.batches).toBe(1);
    expect(r.target).toBe('user');

    const mem = readFileSync(join(root, 'user', 'memory.md'), 'utf8');
    expect(mem).toContain('new rewritten body');
    expect(mem).toContain('lastDreamAt: 2026-04-28T03:07:00Z');

    const sum = readFileSync(join(root, 'user', 'summary.md'), 'utf8');
    expect(sum.trim()).toBe('new summary');

    // Snapshot of original content was taken before mutation.
    const bak = join(root, '.dream-bak', 'TS-1', 'user', 'memory.md');
    expect(existsSync(bak)).toBe(true);
    expect(readFileSync(bak, 'utf8')).toContain('original body');

    // No leftover .tmp files.
    for (const f of ['memory.md', 'summary.md']) {
      const list = require('fs').readdirSync(join(root, 'user'));
      for (const n of list) expect(n.includes('.tmp.')).toBe(false);
    }
    // Progress emitted snapshot, llm, done.
    const phases = events.map(e => `${e.phase}/${e.status || ''}`);
    expect(phases).toContain('apply/snapshot');
    expect(phases).toContain('apply/done');

    // feat-dream-debug-detail: the done event carries previews of what
    // was written so the debug panel can show generated segments.
    const done = events.find(e => e.phase === 'apply' && e.status === 'done');
    expect(done.kind).toBe('update');
    expect(done.memoryMdPreview).toContain('new rewritten body');
    expect(done.summaryMdPreview).toBe('new summary');
    expect(done.memoryMdLength).toBeGreaterThan(0);
    expect(done.summaryMdLength).toBe('new summary'.length);
  });

  it('batches when sources exceed cap, threading memory between batches', async () => {
    mkdirSync(join(root, 'group', 'g'), { recursive: true });
    writeFileSync(join(root, 'group', 'g', 'memory.md'), 'M0\n');
    writeFileSync(join(root, 'group', 'g', 'summary.md'), 'S0\n');

    let calls = 0;
    const llm = async ({ prompt }) => {
      calls += 1;
      // Confirm prompt declares its batch position.
      expect(prompt).toMatch(/batch \d+ of \d+/);
      return JSON.stringify({
        memory_md: `M${calls}\n`,
        summary_md: `S${calls}`,
      });
    };
    const big = (id) => ({ sessionId: id, diff: [{ role: 'user', body: 'x'.repeat(2000) }] });
    const merged = {
      target: 'group/g',
      kind: 'update',
      sources: [big('g1'), big('g2'), big('g3')],
    };
    const r = await applyMergedTarget(merged, {
      root, ts: 'TS-2', llm, limits: { MAX_APPLY_TOKENS: 100 },
      nowIso: () => '2026-04-28T03:07:00Z',
    });
    expect(r.batches).toBeGreaterThan(1);
    // Final memory.md is the last batch's output.
    const mem = readFileSync(join(root, 'group', 'g', 'memory.md'), 'utf8');
    expect(mem).toContain(`M${calls}`);
  });

  it('throws on malformed JSON', async () => {
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(join(root, 'user', 'memory.md'), 'x');
    writeFileSync(join(root, 'user', 'summary.md'), 'y');
    const llm = async () => 'not even close to JSON';
    await expect(applyMergedTarget(
      { target: 'user', kind: 'update', sources: [{ sessionId: 'g', diff: [] }] },
      { root, ts: 'TS-3', llm },
    )).rejects.toThrow(/malformed JSON/);
  });
});

describe('CREATE path', () => {
  it('writes new files for a non-existent topic scope', async () => {
    const llm = async ({ pass }) => {
      expect(pass).toBe('create');
      return JSON.stringify({
        memory_md: '# physics\n\nbody.\n',
        summary_md: 'Physics chats.',
      });
    };
    const r = await applyMergedTarget(
      {
        target: 'group/g-eng/topic/science/physics',
        kind: 'create',
        sources: [{ sessionId: 'g-eng', diff: [{ role: 'user', body: 'hi' }] }],
      },
      { root, ts: 'TS-4', llm, nowIso: () => '2026-04-28T03:07:00Z' },
    );
    expect(r.kind).toBe('create');
    const mem = readFileSync(join(root, 'group', 'g-eng', 'topic', 'science', 'physics', 'memory.md'), 'utf8');
    expect(mem).toContain('# physics');
    expect(mem).toContain('lastDreamAt: 2026-04-28T03:07:00Z');
  });

  it('downgrades CREATE to UPDATE when files already exist', async () => {
    mkdirSync(join(root, 'group', 'g', 'topic', 'science', 'physics'), { recursive: true });
    writeFileSync(join(root, 'group', 'g', 'topic', 'science', 'physics', 'memory.md'), 'PRESERVED\n');
    writeFileSync(join(root, 'group', 'g', 'topic', 'science', 'physics', 'summary.md'), 'old\n');
    const llm = async ({ pass }) => {
      expect(pass).toBe('update');
      return JSON.stringify({ memory_md: 'NEW\n', summary_md: 'new' });
    };
    await applyMergedTarget(
      { target: 'group/g/topic/science/physics', kind: 'create', sources: [{ sessionId: 'g', diff: [] }] },
      { root, ts: 'TS-5', llm },
    );
    expect(readFileSync(join(root, 'group', 'g', 'topic', 'science', 'physics', 'memory.md'), 'utf8'))
      .toContain('NEW');
  });
});

describe('prompt builders', () => {
  it('UPDATE prompt includes the current memory and source diffs', () => {
    const p = buildUpdatePrompt({
      target: 'user',
      memoryMd: 'OLD MEM',
      summaryMd: 'OLD SUM',
      sources: [{ sessionId: 'g-eng', diff: [{ role: 'user', body: 'HELLO' }] }],
    });
    expect(p).toContain('Scope: user');
    expect(p).toContain('OLD MEM');
    expect(p).toContain('OLD SUM');
    expect(p).toContain('[group/g-eng]');
    expect(p).toContain('HELLO');
    expect(p).toMatch(/Reply with strict JSON/);
  });
  it('UPDATE prompt mentions batch index when batched', () => {
    const p = buildUpdatePrompt({
      target: 'user', memoryMd: '', summaryMd: '', sources: [],
      batchInfo: { index: 2, total: 3 },
    });
    expect(p).toContain('batch 2 of 3');
  });
  it('CREATE prompt includes path + sources', () => {
    const p = buildCreatePrompt({
      target: 'topic/x/y',
      sources: [{ sessionId: 'g', diff: [{ role: 'user', body: 'HI' }] }],
      siblingTopics: [{ path: 'x/z', summary: 'sib' }],
    });
    expect(p).toContain('topic/x/y');
    expect(p).toContain('[group/g]');
    expect(p).toContain('HI');
    expect(p).toContain('x/z');
  });
});
