/**
 * Phase 5 — turn archive (DESIGN.md §4.2 + §4.4) and trace tools.
 *
 * Pin the archive file format, message_trace replays, _meta is preserved
 * (so tool-trace can reconstruct ACL context), ACL hard-block on
 * vp/<other>/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  archiveTurn,
  readArchivedTurn,
  turnArchivePath,
} from '../../../../agent/unify/archive/turn-archive.js';
import { archiveOne } from '../../../../agent/unify/archive/tool-results.js';
import { toolTrace, messageTrace } from '../../../../agent/unify/archive/trace.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'turn-archive-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('turnArchivePath', () => {
  it('builds canonical path', () => {
    expect(turnArchivePath({ root: '/r', scopeDir: 'groups/eng', turnId: 'tu_1' }))
      .toBe('/r/groups/eng/archive/tu_1.md');
  });
});

describe('archiveTurn / readArchivedTurn', () => {
  it('round-trips messages with _meta preserved', async () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', _meta: { routerPlan: { vpId: 'linus' } } },
    ];
    const r = await archiveTurn({
      root, scopeDir: 'groups/eng', turnId: 'tu_1', messages,
      archivedAt: '2026-04-27T12:00:00.000Z',
    });
    expect(existsSync(r.path)).toBe(true);
    const back = await readArchivedTurn({ root, scopeDir: 'groups/eng', turnId: 'tu_1' });
    expect(back.header.turnId).toBe('tu_1');
    expect(back.header.archivedAt).toBe('2026-04-27T12:00:00.000Z');
    expect(back.header.messageCount).toBe('2');
    expect(back.messages).toHaveLength(2);
    expect(back.messages[1]._meta.routerPlan.vpId).toBe('linus');
  });

  it('returns null when archive missing', async () => {
    expect(await readArchivedTurn({ root, scopeDir: 'groups/eng', turnId: 'never' })).toBeNull();
  });

  it('handles empty messages array', async () => {
    await archiveTurn({ root, scopeDir: 'groups/eng', turnId: 'empty', messages: [] });
    const back = await readArchivedTurn({ root, scopeDir: 'groups/eng', turnId: 'empty' });
    expect(back.messages).toEqual([]);
    expect(back.header.messageCount).toBe('0');
  });
});

describe('toolTrace', () => {
  it('returns archived body when present', async () => {
    await archiveOne({
      root, scopeDir: 'groups/eng',
      message: { role: 'tool', toolCallId: 'tc_1', content: 'BIG OUTPUT' },
    });
    const out = await toolTrace({ root, scopeDir: 'groups/eng', toolCallId: 'tc_1' });
    expect(out).toEqual({ ok: true, body: 'BIG OUTPUT' });
  });

  it('returns not_found when missing', async () => {
    const out = await toolTrace({ root, scopeDir: 'groups/eng', toolCallId: 'never' });
    expect(out).toEqual({ ok: false, error: 'not_found' });
  });

  it('rejects missing toolCallId', async () => {
    const out = await toolTrace({ root, scopeDir: 'groups/eng', toolCallId: '' });
    expect(out).toEqual({ ok: false, error: 'missing_toolCallId' });
  });

  it('hard-blocks cross-VP scope (acl_blocked)', async () => {
    await expect(toolTrace({
      root, scopeDir: 'vp/linus', toolCallId: 'tc_1', currentVpId: 'grace',
    })).rejects.toMatchObject({ code: 'acl_blocked' });
  });

  it('allows own-VP scope', async () => {
    await archiveOne({
      root, scopeDir: 'vp/grace',
      message: { role: 'tool', toolCallId: 'tc_2', content: 'mine' },
    });
    const out = await toolTrace({
      root, scopeDir: 'vp/grace', toolCallId: 'tc_2', currentVpId: 'grace',
    });
    expect(out.ok).toBe(true);
    expect(out.body).toBe('mine');
  });
});

describe('messageTrace', () => {
  it('returns the archived turn including _meta', async () => {
    await archiveTurn({
      root, scopeDir: 'groups/eng', turnId: 'tu_99',
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', _meta: { routerPlan: { vpId: 'linus' } }, content: 'a' }],
    });
    const out = await messageTrace({ root, scopeDir: 'groups/eng', turnId: 'tu_99' });
    expect(out.ok).toBe(true);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]._meta.routerPlan.vpId).toBe('linus');
  });

  it('returns not_found when missing', async () => {
    const out = await messageTrace({ root, scopeDir: 'groups/eng', turnId: 'never' });
    expect(out).toEqual({ ok: false, error: 'not_found' });
  });

  it('hard-blocks cross-VP scope', async () => {
    await expect(messageTrace({
      root, scopeDir: 'vp/linus', turnId: 'tu_1', currentVpId: 'grace',
    })).rejects.toMatchObject({ code: 'acl_blocked' });
  });
});
