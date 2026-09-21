import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { bootInitEmptyGroups, createV2DreamScheduler } from '../../../agent/yeaft/dream/session-wiring.js';

const roots = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeConfig(value) {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-toggle-'));
  roots.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify(value));
  return loadConfig({ dir: root });
}

function makeSession(enabled) {
  return {
    config: { dream: { enabled }, serverMode: false },
    yeaftDir: mkdtempSync(join(tmpdir(), 'yeaft-dream-session-')),
    trace: { event() {} },
    memoryIndex: null,
  };
}

describe('Agent Dream toggle', () => {
  it('keeps Dream off even when an old client persisted an enabled toggle', () => {
    expect(makeConfig({}).dream.enabled).toBe(false);
    expect(makeConfig({ dream: { enabled: false } }).dream.enabled).toBe(false);
    expect(makeConfig({ dream: { enabled: true } }).dream.enabled).toBe(false);
  });

  it('stops automatic scheduling without disabling manual Dream triggers', async () => {
    vi.useFakeTimers();
    const session = makeSession(false);
    roots.push(session.yeaftDir);
    const scheduler = createV2DreamScheduler(session);

    expect(scheduler.enabled).toBe(false);
    expect(await scheduler.catchUpNudge()).toMatchObject({ skipped: true, skippedReason: 'disabled' });

    scheduler.setEnabled(true);
    expect(scheduler.enabled).toBe(true);
    scheduler.setEnabled(false);
    expect(scheduler.enabled).toBe(false);

    const manual = await scheduler.triggerDreamNow();
    expect(manual).toBeTruthy();
    expect(manual.trigger).toBe('manual');
    scheduler.shutdown();
  });

  it('does not use the manual scoped trigger for disabled boot initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-dream-boot-toggle-'));
    roots.push(root);
    const sessionId = 'session_with_messages';
    const sessionDir = join(root, 'sessions', sessionId);
    const messagesDir = join(sessionDir, 'messages');
    mkdirSync(messagesDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: sessionId,
      name: 'Dream toggle regression',
      roster: ['omni'],
      defaultVpId: 'omni',
    }));
    writeFileSync(join(messagesDir, '000001.jsonl'), `${JSON.stringify({
      id: 'msg-1',
      from: 'user',
      role: 'user',
      text: 'Persist this later',
    })}\n`);

    const triggerDreamForScopes = vi.fn().mockResolvedValue({ trigger: 'manual' });
    const args = {
      yeaftDir: root,
      memoryIndex: { listByScope: vi.fn(() => []) },
      dreamScheduler: { triggerDreamForScopes },
    };

    expect(await bootInitEmptyGroups({
      ...args,
      config: { dream: { enabled: false } },
    })).toEqual({ triggered: [] });
    expect(triggerDreamForScopes).not.toHaveBeenCalled();

    expect(await bootInitEmptyGroups({
      ...args,
      config: { dream: { enabled: true } },
    })).toEqual({ triggered: [`sessions/${sessionId}`] });
    expect(triggerDreamForScopes).toHaveBeenCalledWith([`sessions/${sessionId}`]);
  });
});
