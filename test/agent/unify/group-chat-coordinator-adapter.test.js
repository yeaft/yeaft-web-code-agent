/**
 * task-338-F4 (re-dispatch) — coordinator adapter behavior.
 *
 * Exercises `createCoordinator` directly with a fake GroupHandle, mirroring
 * the exact wiring `handleUnifyGroupChat` uses in web-bridge.js. The adapter
 * layer lives in web-bridge; coordinator itself stays untouched per PM
 * red-line, so these tests lock the contract the adapter relies on:
 *
 *   1. user text with a valid @mention → coordinator dispatches only to that
 *      vpId (intersected with roster), not to the default VP.
 *   2. user text with no @mention → coordinator falls back to defaultVpId.
 *   3. user text with an unknown @mention and no default VP → report has
 *      dispatched:[] and fallback:null (adapter's fallback-path-#2 trigger).
 */
import { describe, it, expect } from 'vitest';
import { createCoordinator } from '../../../agent/unify/groups/coordinator.js';

function makeFakeHandle({ id = 'g1', roster = [], defaultVpId = null } = {}) {
  const log = [];
  return {
    getMeta: () => ({ id, roster, defaultVpId }),
    appendMessage: (msg) => {
      const stored = { ...msg, id: `m${log.length + 1}`, ts: new Date().toISOString() };
      log.push(stored);
      return stored;
    },
    _log: log,
  };
}

describe('task-338-F4 coordinator adapter contract', () => {
  it('@-mention in roster → dispatches only to that VP', () => {
    const handle = makeFakeHandle({ roster: ['einstein', 'newton'], defaultVpId: 'einstein' });
    const captured = [];
    const coord = createCoordinator(handle, {
      deliver: (vpId, env) => captured.push({ vpId, trigger: env.trigger }),
    });
    const report = coord.ingest({
      from: 'user', role: 'user', text: '@newton thoughts?', meta: { mentions: ['newton'] },
    });
    expect(report.dispatched).toEqual(['newton']);
    expect(report.fallback).toBeNull();
    expect(captured).toEqual([{ vpId: 'newton', trigger: 'mention' }]);
  });

  it('no @-mention → fallback to defaultVpId', () => {
    const handle = makeFakeHandle({ roster: ['einstein', 'newton'], defaultVpId: 'einstein' });
    const captured = [];
    const coord = createCoordinator(handle, {
      deliver: (vpId, env) => captured.push({ vpId, trigger: env.trigger }),
    });
    const report = coord.ingest({
      from: 'user', role: 'user', text: 'hello group', meta: { mentions: [] },
    });
    expect(report.dispatched).toEqual(['einstein']);
    expect(report.fallback).toBe('einstein');
    expect(captured).toEqual([{ vpId: 'einstein', trigger: 'fallback' }]);
  });

  it('unknown @-mention + no default VP → empty dispatch (adapter fallback-path-2)', () => {
    const handle = makeFakeHandle({ roster: ['einstein'], defaultVpId: null });
    const captured = [];
    const coord = createCoordinator(handle, {
      deliver: (vpId, env) => captured.push({ vpId, trigger: env.trigger }),
    });
    const report = coord.ingest({
      from: 'user', role: 'user', text: '@ghost ping', meta: { mentions: ['ghost'] },
    });
    expect(report.dispatched).toEqual([]);
    expect(report.fallback).toBeNull();
    expect(captured).toEqual([]);
    // This is the exact shape handleUnifyGroupChat checks before falling
    // back to handleUnifyChat (legacy single-agent).
    expect(report.dispatched.length === 0 && !report.fallback).toBe(true);
  });

  it('defaultVp silent rule: other roster members NOT notified on plain user message', () => {
    // Architecture §10 — default group chats with 12 VPs should not fan out
    // by default; only defaultVpId speaks unless explicitly @-mentioned.
    const handle = makeFakeHandle({
      roster: ['einstein', 'newton', 'darwin', 'curie'],
      defaultVpId: 'einstein',
    });
    const captured = [];
    const coord = createCoordinator(handle, {
      deliver: (vpId) => captured.push(vpId),
    });
    coord.ingest({ from: 'user', role: 'user', text: 'hi all', meta: { mentions: [] } });
    expect(captured).toEqual(['einstein']); // exactly one, NOT fan-out
  });

  it('@all broadcast fans out to the roster minus sender', () => {
    const handle = makeFakeHandle({
      roster: ['einstein', 'newton', 'darwin'],
      defaultVpId: 'einstein',
    });
    const captured = [];
    const coord = createCoordinator(handle, {
      deliver: (vpId) => captured.push(vpId),
    });
    const report = coord.ingest({
      from: 'user', role: 'user', text: '@all sync up', meta: { mentions: ['all'] },
    });
    expect(report.broadcast).toBe(true);
    expect(captured.sort()).toEqual(['darwin', 'einstein', 'newton']);
  });
});
