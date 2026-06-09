/**
 * dream/state.test.js — §11
 *
 * Per-group .dream-state read/write round-trip + per-scope memory.md
 * marker block insertion/replacement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readGroupState,
  writeGroupState,
  readScopeDreamMarker,
  withDreamMarker,
} from '../../../../agent/yeaft/dream/state.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dream-state-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('group .dream-state', () => {
  it('missing → defaults', async () => {
    const s = await readGroupState(root, 'g-eng');
    expect(s).toEqual({ lastDreamMessageId: null, lastDreamAt: null, messageCount: 0 });
  });
  it('write then read round-trip', async () => {
    await writeGroupState(root, 'g-eng', {
      lastDreamMessageId: 'm-1024', lastDreamAt: '2026-04-28T03:07:00Z', messageCount: 491,
    });
    expect(await readGroupState(root, 'g-eng')).toEqual({
      lastDreamMessageId: 'm-1024', lastDreamAt: '2026-04-28T03:07:00Z', messageCount: 491,
    });
  });
  it('null fields persist as empty strings, parsed back as null', async () => {
    await writeGroupState(root, 'g-x', { lastDreamMessageId: null, lastDreamAt: null, messageCount: 0 });
    const raw = readFileSync(join(root, 'group', 'g-x', '.dream-state'), 'utf8');
    expect(raw).toContain('lastDreamMessageId: ');
    expect(raw).toContain('lastDreamAt: ');
    expect(raw).toContain('messageCount: 0');
    expect(await readGroupState(root, 'g-x')).toEqual({
      lastDreamMessageId: null, lastDreamAt: null, messageCount: 0,
    });
  });
  it('tolerates malformed messageCount', async () => {
    mkdirSync(join(root, 'group', 'g-bad'), { recursive: true });
    writeFileSync(join(root, 'group', 'g-bad', '.dream-state'),
      'lastDreamMessageId: x\nlastDreamAt: 2026-01-01\nmessageCount: not-a-number\n');
    const s = await readGroupState(root, 'g-bad');
    expect(s.messageCount).toBe(0);
    expect(s.lastDreamMessageId).toBe('x');
  });
});

describe('per-scope dream marker (memory.md tail block)', () => {
  it('appends a fresh block when none exists', () => {
    const out = withDreamMarker('# user\n\nbody.\n', { lastDreamAt: '2026-04-28T03:07:00Z' });
    expect(out).toContain('<!-- dream-state -->\nlastDreamAt: 2026-04-28T03:07:00Z\n<!-- /dream-state -->\n');
    expect(out).toContain('# user');
    expect(out).toContain('body.');
  });

  it('replaces an existing block', () => {
    const before = '# x\n\n<!-- dream-state -->\nlastDreamAt: 2026-01-01T00:00:00Z\n<!-- /dream-state -->\n';
    const after = withDreamMarker(before, { lastDreamAt: '2026-04-28T03:07:00Z' });
    expect(after).toContain('lastDreamAt: 2026-04-28T03:07:00Z');
    expect(after).not.toContain('2026-01-01T00:00:00Z');
    // Only one block should remain.
    expect((after.match(/<!-- dream-state -->/g) || []).length).toBe(1);
  });

  it('handles empty input', () => {
    const out = withDreamMarker('', { lastDreamAt: '2026-04-28T03:07:00Z' });
    expect(out).toContain('lastDreamAt: 2026-04-28T03:07:00Z');
  });

  it('readScopeDreamMarker returns null for missing file', async () => {
    expect(await readScopeDreamMarker(join(root, 'no-such.md'))).toBe(null);
  });
  it('readScopeDreamMarker reads the timestamp', async () => {
    const p = join(root, 'memory.md');
    writeFileSync(p, '# x\n<!-- dream-state -->\nlastDreamAt: 2026-04-28T03:07:00Z\n<!-- /dream-state -->\n');
    expect(await readScopeDreamMarker(p)).toBe('2026-04-28T03:07:00Z');
  });
});
