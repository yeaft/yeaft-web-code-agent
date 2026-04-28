/**
 * memory/recall-v2.test.js — DESIGN-v2 Part II.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recallV2, stripDreamMarker, formatRecallV2, scopeLabel,
} from '../../../agent/unify/memory/recall-v2.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'recall-v2-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seed(rel, body) {
  const abs = join(root, rel);
  mkdirSync(abs.substring(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, body);
}

describe('stripDreamMarker', () => {
  it('removes the trailing marker block', () => {
    const body = 'real content\n\n<!-- dream-state -->\nlastDreamAt: 2026-04-28\n<!-- /dream-state -->\n';
    expect(stripDreamMarker(body)).toBe('real content');
  });
  it('passes through input without a marker', () => {
    expect(stripDreamMarker('plain body\n')).toBe('plain body');
  });
  it('handles empty / non-string', () => {
    expect(stripDreamMarker('')).toBe('');
    expect(stripDreamMarker(null)).toBe('');
  });
});

describe('scopeLabel', () => {
  it('formats each kind correctly', () => {
    expect(scopeLabel({ kind: 'user' })).toBe('user');
    expect(scopeLabel({ kind: 'group', id: 'g-eng' })).toBe('group/g-eng');
    expect(scopeLabel({ kind: 'vp', id: 'zhang-san' })).toBe('vp/zhang-san');
    expect(scopeLabel({ kind: 'feature', id: 'abc' })).toBe('feature/abc');
    expect(scopeLabel({ kind: 'topic', path: ['science', 'physics'] })).toBe('topic/science/physics');
  });
});

describe('formatRecallV2', () => {
  it('returns empty string for no sections', () => {
    expect(formatRecallV2([])).toBe('');
  });
  it('renders sections with summary + memory', () => {
    const out = formatRecallV2([
      { scope: 'user', kind: 'user', memory: 'mem body', summary: 'sum body' },
    ]);
    expect(out).toContain('## Recalled Memory (v2)');
    expect(out).toContain('### user');
    expect(out).toContain('**Summary**');
    expect(out).toContain('sum body');
    expect(out).toContain('**Memory**');
    expect(out).toContain('mem body');
  });
  it('skips empty sections', () => {
    expect(formatRecallV2([
      { scope: 'user', kind: 'user', memory: '', summary: '' },
    ])).toBe('');
  });
});

describe('recallV2', () => {
  it('always includes user when present', async () => {
    seed('user/memory.md', 'user mem');
    seed('user/summary.md', 'user sum');
    const r = await recallV2({ prompt: 'hello', root });
    expect(r.sections.length).toBe(1);
    expect(r.sections[0].scope).toBe('user');
    expect(r.sections[0].memory).toBe('user mem');
    expect(r.sections[0].summary).toBe('user sum');
  });

  it('omits user when both files missing', async () => {
    const r = await recallV2({ prompt: 'hi', root });
    expect(r.sections).toEqual([]);
  });

  it('includes group when groupId is provided', async () => {
    seed('user/memory.md', 'u');
    seed('group/g-eng/memory.md', 'group eng mem');
    const r = await recallV2({ prompt: 'x', root, groupId: 'g-eng' });
    expect(r.sections.map(s => s.scope)).toContain('group/g-eng');
  });

  it('skips group _no-group sentinel', async () => {
    seed('group/_no-group/memory.md', 'should not appear');
    const r = await recallV2({ prompt: 'x', root, groupId: '_no-group' });
    expect(r.sections.map(s => s.scope)).not.toContain('group/_no-group');
  });

  it('includes vp/<id> when vpId provided', async () => {
    seed('vp/zhang-san/memory.md', 'vp mem');
    const r = await recallV2({ prompt: 'x', root, vpId: 'zhang-san' });
    expect(r.sections.map(s => s.scope)).toContain('vp/zhang-san');
  });

  it('respects currentVpId ACL on vp scopes', async () => {
    seed('vp/li-si/memory.md', 'foreign vp');
    // Asking for vp/li-si while currentVpId=zhang-san triggers store-v2 ACL,
    // which throws inside readMemory; recall-v2 swallows it and skips.
    const r = await recallV2({ prompt: 'x', root, vpId: 'li-si', currentVpId: 'zhang-san' });
    expect(r.sections.map(s => s.scope)).not.toContain('vp/li-si');
  });

  it('includes feature when featureId provided', async () => {
    seed('feature/abc/memory.md', 'feat');
    const r = await recallV2({ prompt: 'x', root, featureId: 'abc' });
    expect(r.sections.map(s => s.scope)).toContain('feature/abc');
  });

  it('ranks topics by keyword overlap on summary', async () => {
    seed('topic/science/physics/summary.md', 'quantum mechanics physics talks');
    seed('topic/science/physics/memory.md', 'phys mem');
    seed('topic/life/cooking/summary.md', 'recipes and food');
    seed('topic/life/cooking/memory.md', 'cook mem');
    const r = await recallV2({
      prompt: 'tell me about quantum mechanics',
      root,
      topicLimit: 1,
    });
    const labels = r.sections.map(s => s.scope);
    expect(labels).toContain('topic/science/physics');
    expect(labels).not.toContain('topic/life/cooking');
  });

  it('strips dream-state marker from injected memory', async () => {
    seed('user/memory.md', 'real\n<!-- dream-state -->\nlastDreamAt: 2026-04-28\n<!-- /dream-state -->\n');
    const r = await recallV2({ prompt: 'x', root });
    expect(r.sections[0].memory).toBe('real');
    expect(r.formatted).not.toContain('dream-state');
  });

  it('returns empty bundle on empty root', async () => {
    const r = await recallV2({ prompt: 'x', root });
    expect(r.sections).toEqual([]);
    expect(r.formatted).toBe('');
  });

  it('topicLimit=0 disables topic recall', async () => {
    seed('topic/science/physics/summary.md', 'physics talks');
    const r = await recallV2({ prompt: 'physics', root, topicLimit: 0 });
    expect(r.sections.map(s => s.scope)).not.toContain('topic/science/physics');
  });

  it('orders sections: user → group → vp → feature → topic', async () => {
    seed('user/memory.md', 'u');
    seed('group/g/memory.md', 'g');
    seed('vp/v/memory.md', 'vmem');
    seed('feature/f/memory.md', 'fmem');
    seed('topic/t/summary.md', 'physics');
    seed('topic/t/memory.md', 'tmem');
    const r = await recallV2({
      prompt: 'physics',
      root,
      groupId: 'g', vpId: 'v', featureId: 'f',
    });
    expect(r.sections.map(s => s.kind)).toEqual(['user', 'group', 'vp', 'feature', 'topic']);
  });
});
