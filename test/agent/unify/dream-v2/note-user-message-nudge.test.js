/**
 * note-user-message-nudge.test.js — task-710 nudgeOnUserMessage trigger.
 *
 * `noteUserMessage` is exposed on the v2 dream scheduler. It increments
 * an internal counter and, when the count reaches DREAM_NUDGE_AFTER_MESSAGES
 * (default 50), fires a non-manual dream pass. This test verifies the
 * threshold and the in-flight guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV2DreamScheduler } from '../../../../agent/unify/dream-v2/session-wiring.js';
import { DREAM_NUDGE_AFTER_MESSAGES } from '../../../../agent/unify/dream-v2/limits.js';

let yeaftDir;
beforeEach(() => { yeaftDir = mkdtempSync(join(tmpdir(), 'nudge-')); });
afterEach(() => { rmSync(yeaftDir, { recursive: true, force: true }); });

function makeSession() {
  return {
    yeaftDir,
    adapter: { call: async () => ({ text: '{}' }) },
    config: { debug: false, fastModelId: 'm', model: 'm' },
  };
}

describe('noteUserMessage nudge', () => {
  it('does not fire below the threshold', async () => {
    const session = makeSession();
    const sched = createV2DreamScheduler(session);
    try {
      const fireSpy = vi.spyOn(sched._v2, '_fire');
      for (let i = 0; i < DREAM_NUDGE_AFTER_MESSAGES - 1; i++) {
        sched.noteUserMessage();
      }
      expect(fireSpy).not.toHaveBeenCalled();
    } finally {
      sched.shutdown();
    }
  });

  it('fires exactly once when the threshold is crossed', async () => {
    const session = makeSession();
    const sched = createV2DreamScheduler(session);
    try {
      const fireSpy = vi.spyOn(sched._v2, '_fire')
        .mockResolvedValue({ ok: true });
      for (let i = 0; i < DREAM_NUDGE_AFTER_MESSAGES; i++) {
        sched.noteUserMessage();
      }
      expect(fireSpy).toHaveBeenCalledTimes(1);
      expect(fireSpy).toHaveBeenCalledWith({ manual: false });
    } finally {
      sched.shutdown();
    }
  });

  it('rearms after a fire — second 50 fires a second pass', async () => {
    const session = makeSession();
    const sched = createV2DreamScheduler(session);
    try {
      const fireSpy = vi.spyOn(sched._v2, '_fire')
        .mockResolvedValue({ ok: true });
      for (let i = 0; i < DREAM_NUDGE_AFTER_MESSAGES * 2; i++) {
        sched.noteUserMessage();
      }
      expect(fireSpy).toHaveBeenCalledTimes(2);
    } finally {
      sched.shutdown();
    }
  });

  it('skips firing when v2 is already running', async () => {
    const session = makeSession();
    const sched = createV2DreamScheduler(session);
    try {
      vi.spyOn(sched._v2, 'isRunning').mockReturnValue(true);
      const fireSpy = vi.spyOn(sched._v2, '_fire');
      for (let i = 0; i < DREAM_NUDGE_AFTER_MESSAGES; i++) {
        sched.noteUserMessage();
      }
      expect(fireSpy).not.toHaveBeenCalled();
    } finally {
      sched.shutdown();
    }
  });
});
