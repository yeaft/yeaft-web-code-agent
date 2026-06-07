/**
 * persist-recent-turns-config.test.js — pins the configurable
 * cold-start replay window (`recentTurnsLimit`) and the per-session
 * warn-once gate that fires when the slice truncates real history with
 * no compact summary to cover the dropped turns.
 *
 * Contract:
 *   1. `setDefaultRecentTurnsLimit(n)` overrides the default (turn-count
 *      slice used by `loadRecentBySession`).
 *   2. Invalid input is rejected with a `console.warn` (silent failure
 *      would let a hand-edited config like `"twenty"` fall back to 20
 *      with no signal).
 *   3. `__resetTruncationWarned()` exists for tests so the warn-once
 *      gate doesn't silently suppress later cases in the same module.
 *   4. `loadRecentBySession` warns ONCE per (sessionId, storeDir) when
 *      it truncates AND no compact summary exists.
 *   5. It does NOT warn when compact summary exists (older context is
 *      already covered).
 *   6. It does NOT warn when slice returns the full history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationStore,
  setDefaultRecentTurnsLimit,
  getDefaultRecentTurnsLimit,
  __resetTruncationWarned,
} from '../../../agent/yeaft/conversation/persist.js';

let originalLimit;
beforeEach(() => {
  originalLimit = getDefaultRecentTurnsLimit();
  __resetTruncationWarned();
});
afterEach(() => {
  // Restore so other test files don't observe a leaked override.
  setDefaultRecentTurnsLimit(originalLimit);
  __resetTruncationWarned();
});

function seedTurns(store, sessionId, turnCount) {
  for (let i = 0; i < turnCount; i++) {
    store.append({ role: 'user', content: `prompt ${i}`, sessionId });
    store.append({ role: 'assistant', content: `reply ${i}`, sessionId });
  }
}

describe('setDefaultRecentTurnsLimit', () => {
  it('overrides the default turn-count slice used by loadRecentBySession', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-recent-cfg-'));
    try {
      const store = new ConversationStore(dir);
      seedTurns(store, 'grp_cfg', 10);

      setDefaultRecentTurnsLimit(3);
      const recent = store.loadRecentBySession('grp_cfg');
      // 3 turns × 2 rows per turn = 6
      expect(recent.length).toBe(6);
      expect(recent[0].content).toBe('prompt 7');
      expect(recent[recent.length - 1].content).toBe('reply 9');

      // Explicit override on the call wins over the default.
      const explicit = store.loadRecentBySession('grp_cfg', 1);
      expect(explicit.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid input with a console.warn (no silent failure)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = getDefaultRecentTurnsLimit();
      setDefaultRecentTurnsLimit('twenty');
      setDefaultRecentTurnsLimit(NaN);
      setDefaultRecentTurnsLimit(0);
      setDefaultRecentTurnsLimit(-5);
      setDefaultRecentTurnsLimit(null);
      setDefaultRecentTurnsLimit(undefined);
      expect(getDefaultRecentTurnsLimit()).toBe(before);
      // One warn per bad call — proves we're not silent.
      expect(warn).toHaveBeenCalledTimes(6);
      for (const call of warn.mock.calls) {
        expect(call[0]).toMatch(/setDefaultRecentTurnsLimit/);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts positive numbers (incl. floors fractional input)', () => {
    setDefaultRecentTurnsLimit(7.9);
    expect(getDefaultRecentTurnsLimit()).toBe(7);
    setDefaultRecentTurnsLimit('15');
    expect(getDefaultRecentTurnsLimit()).toBe(15);
  });
});

describe('maybeWarnHistoryTruncated — warn-once per (sessionId, storeDir)', () => {
  it('warns once when slice drops turns and no compact summary exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-recent-warn-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new ConversationStore(dir);
      seedTurns(store, 'grp_warn', 10);
      setDefaultRecentTurnsLimit(3);

      store.loadRecentBySession('grp_warn');
      store.loadRecentBySession('grp_warn');
      store.loadRecentBySession('grp_warn');

      const truncWarns = warn.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('history for session grp_warn truncated')
      );
      expect(truncWarns).toHaveLength(1);
      expect(truncWarns[0][0]).toContain('to 3 of 10 turns');
      expect(truncWarns[0][0]).toContain('recentTurnsLimit=3');
      expect(truncWarns[0][0]).toContain('yeaft.recentTurnsLimit');
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT warn when a compact summary covers the dropped turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-recent-warn-compact-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new ConversationStore(dir);
      seedTurns(store, 'grp_compact', 10);
      setDefaultRecentTurnsLimit(3);

      // Drop a compact summary file for this session — any vpId works;
      // hasAnyCompactSummaryForSession only checks existence.
      const compactDir = join(dir, 'groups', 'grp_compact', 'conversation', 'compact');
      mkdirSync(compactDir, { recursive: true });
      writeFileSync(
        join(compactDir, 'vp-default.md'),
        '---\nsessionId: grp_compact\nvpId: vp-default\n---\nsummary\n',
        'utf8'
      );

      store.loadRecentBySession('grp_compact');

      const truncWarns = warn.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('history for session grp_compact truncated')
      );
      expect(truncWarns).toHaveLength(0);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT warn when slice returns the full history (no truncation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-recent-warn-full-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new ConversationStore(dir);
      seedTurns(store, 'grp_full', 2);
      setDefaultRecentTurnsLimit(10);

      store.loadRecentBySession('grp_full');

      const truncWarns = warn.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('history for session grp_full truncated')
      );
      expect(truncWarns).toHaveLength(0);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('__resetTruncationWarned re-arms the gate (per-test isolation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-recent-warn-reset-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new ConversationStore(dir);
      seedTurns(store, 'grp_reset', 10);
      setDefaultRecentTurnsLimit(3);

      store.loadRecentBySession('grp_reset');
      expect(
        warn.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('truncated')).length
      ).toBe(1);

      __resetTruncationWarned();

      store.loadRecentBySession('grp_reset');
      expect(
        warn.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('truncated')).length
      ).toBe(2);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
