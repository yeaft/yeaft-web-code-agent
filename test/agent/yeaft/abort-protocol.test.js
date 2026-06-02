/**
 * Abort command protocol tests — PR #797 multi-thread VP runtime variant.
 *
 * PR #797 keeps the legacy 1:1 `currentAbortCtrl`, but group VP runtime work
 * is now keyed by `(groupId, vpId, threadId)`. The wire protocol
 * (`yeaft_abort_thread`, `yeaft_abort_all`, `yeaft_aborted` ack) is preserved
 * for client back-compat, but `threadId` is meaningful again for group VP
 * thread aborts.
 *
 * Covers:
 *   1. wiring: message-router routes, server relay, session.abort() entry
 *      and the `yeaft_aborted` ack name (red line: name must not change)
 *   2. behaviour: { threadId } aborts only the targeted VP thread,
 *      { all:true } aborts every VP thread, and empty payload is a no-op.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  handleYeaftAbortThread,
  handleYeaftAbortAll,
  abortYeaftSession,
  __testSeedAbortController,
  __testSeedTurnAbortController,
  __testGetRegisteredThreadIds,
} from '../../../agent/yeaft/web-bridge.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const bridgeSrc = readFileSync(join(ROOT, 'agent/yeaft/web-bridge.js'), 'utf8');
const routerSrc = readFileSync(join(ROOT, 'agent/connection/message-router.js'), 'utf8');
const relaySrc = readFileSync(join(ROOT, 'server/handlers/client-conversation.js'), 'utf8');
const sessionSrc = readFileSync(join(ROOT, 'agent/yeaft/session.js'), 'utf8');

// ---- Reset registry between tests. ----
beforeEach(() => {
  handleYeaftAbortAll();
});

// --- 1. Protocol: message names + wiring ------------------------------------
describe('abort protocol — wire-level names (PM red lines)', () => {
  it('message-router routes yeaft_abort_thread → handleYeaftAbortThread', () => {
    expect(routerSrc).toMatch(/case\s+'yeaft_abort_thread'/);
    expect(routerSrc).toMatch(/handleYeaftAbortThread\(msg\)/);
  });

  it('message-router routes yeaft_abort_all → handleYeaftAbortAll', () => {
    expect(routerSrc).toMatch(/case\s+'yeaft_abort_all'/);
    expect(routerSrc).toMatch(/handleYeaftAbortAll\(\)/);
  });

  it('message-router imports both handlers from web-bridge', () => {
    expect(routerSrc).toMatch(/handleYeaftAbortThread/);
    expect(routerSrc).toMatch(/handleYeaftAbortAll/);
  });

  it('server client-conversation relays yeaft_abort_thread', () => {
    expect(relaySrc).toMatch(/case\s+'yeaft_abort_thread'/);
    expect(relaySrc).toMatch(/type:\s*'yeaft_abort_thread'/);
  });

  it('server client-conversation relays yeaft_abort_all with empty payload', () => {
    expect(relaySrc).toMatch(/case\s+'yeaft_abort_all'/);
    expect(relaySrc).toMatch(/forwardToAgent\([^,]+,\s*\{\s*type:\s*'yeaft_abort_all'\s*\}\)/);
  });

  it('session.abort({ threadId?, all? }) entry exists and delegates to web-bridge', () => {
    expect(sessionSrc).toMatch(/async\s+abort\s*\(\s*opts\s*=\s*\{\}\s*\)/);
    expect(sessionSrc).toMatch(/abortYeaftSession/);
  });

  it('web-bridge keeps legacy 1:1 abort plus per-VP thread abort maps', () => {
    expect(bridgeSrc).toMatch(/let\s+currentAbortCtrl\s*=\s*null/);
    expect(bridgeSrc).toMatch(/const\s+vpAborts\s*=\s*new\s+Map\(\)/);
    expect(bridgeSrc).toMatch(/const\s+turnAbortMeta\s*=\s*new\s+Map\(\)/);
    expect(bridgeSrc).not.toMatch(/const\s+abortByThread\s*=\s*new\s+Map\(\)/);
  });

  it('web-bridge emits `yeaft_aborted` (not the old `yeaft_cancelled`) ack', () => {
    expect(bridgeSrc).toMatch(/type:\s*'yeaft_aborted'/);
    expect(bridgeSrc).not.toMatch(/type:\s*'yeaft_cancelled'/);
  });
});

// --- 2. Behaviour: multi-thread VP runtime, three input shapes ---------------
describe('abort behaviour — multi-thread VP runtime', () => {
  it('(1) { threadId } aborts only the targeted VP runtime', () => {
    const target = new AbortController();
    const sibling = new AbortController();
    __testSeedAbortController('thread-a', target, 'group-1', 'ada');
    __testSeedAbortController('thread-b', sibling, 'group-1', 'ada');

    const result = handleYeaftAbortThread({ threadId: 'thread-a' });

    expect(result.all).toBe(false);
    expect(result.aborted).toEqual(['vp:group-1::ada::thread-a']);
    expect(target.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(false);
    expect(__testGetRegisteredThreadIds()).toEqual(['thread-b']);
  });

  it('targeted { threadId } abort does not abort sibling turn controllers', () => {
    const targetRuntime = new AbortController();
    const targetTurn = new AbortController();
    const siblingRuntime = new AbortController();
    const siblingTurn = new AbortController();

    __testSeedAbortController('thread-a', targetRuntime, 'group-1', 'ada');
    __testSeedTurnAbortController('turn-a', 'thread-a', targetTurn, 'group-1', 'ada');
    __testSeedAbortController('thread-b', siblingRuntime, 'group-1', 'ada');
    __testSeedTurnAbortController('turn-b', 'thread-b', siblingTurn, 'group-1', 'ada');

    const result = handleYeaftAbortThread({ threadId: 'thread-a' });

    expect(result.all).toBe(false);
    expect(result.aborted).toContain('vp:group-1::ada::thread-a');
    expect(result.aborted).toContain('turn-a');
    expect(result.aborted).not.toContain('vp:group-1::ada::thread-b');
    expect(result.aborted).not.toContain('turn-b');
    expect(targetRuntime.signal.aborted).toBe(true);
    expect(targetTurn.signal.aborted).toBe(true);
    expect(siblingRuntime.signal.aborted).toBe(false);
    expect(siblingTurn.signal.aborted).toBe(false);
    expect(__testGetRegisteredThreadIds()).toEqual(['thread-b']);
  });

  it('(2) { all: true } aborts every VP runtime and turn controller', () => {
    const runtimeA = new AbortController();
    const runtimeB = new AbortController();
    const turnA = new AbortController();
    const turnB = new AbortController();
    __testSeedAbortController('thread-a', runtimeA, 'group-1', 'ada');
    __testSeedAbortController('thread-b', runtimeB, 'group-1', 'linus');
    __testSeedTurnAbortController('turn-a', 'thread-a', turnA, 'group-1', 'ada');
    __testSeedTurnAbortController('turn-b', 'thread-b', turnB, 'group-1', 'linus');

    const result = handleYeaftAbortAll();

    expect(result.all).toBe(true);
    expect(result.aborted).toContain('turn-a');
    expect(result.aborted).toContain('turn-b');
    expect(result.aborted).toContain('vp:group-1::ada::thread-a');
    expect(result.aborted).toContain('vp:group-1::linus::thread-b');
    expect(runtimeA.signal.aborted).toBe(true);
    expect(runtimeB.signal.aborted).toBe(true);
    expect(turnA.signal.aborted).toBe(true);
    expect(turnB.signal.aborted).toBe(true);
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('(3) abort with unknown threadId is a silent no-op', () => {
    // Nothing seeded — registry empty.
    const result = handleYeaftAbortThread({ threadId: 'never-existed' });
    expect(result).toEqual({ aborted: [], all: false });
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('abortYeaftSession dispatches correctly on all three shapes', () => {
    // Shape A: { all:true }
    const ctrlA = new AbortController();
    __testSeedAbortController('thread-a', ctrlA, 'group-1', 'ada');
    expect(abortYeaftSession({ all: true }).all).toBe(true);
    expect(ctrlA.signal.aborted).toBe(true);

    // Shape B: { threadId } — only the matching VP thread
    const ctrlB = new AbortController();
    const ctrlC = new AbortController();
    __testSeedAbortController('thread-b', ctrlB, 'group-1', 'ada');
    __testSeedAbortController('thread-c', ctrlC, 'group-1', 'ada');
    const r = abortYeaftSession({ threadId: 'thread-b' });
    expect(r.all).toBe(false);
    expect(r.aborted).toEqual(['vp:group-1::ada::thread-b']);
    expect(ctrlB.signal.aborted).toBe(true);
    expect(ctrlC.signal.aborted).toBe(false);

    // Shape C: empty payload → conservative no-op (controller untouched)
    const ctrlD = new AbortController();
    __testSeedAbortController('thread-d', ctrlD, 'group-1', 'ada');
    const bare = abortYeaftSession({});
    expect(bare).toEqual({ aborted: [], all: false });
    expect(ctrlD.signal.aborted).toBe(false);
  });

  it('handleYeaftAbortAll on empty registry still emits ack (idempotent)', () => {
    const result = handleYeaftAbortAll();
    expect(result).toEqual({ aborted: [], all: true });
  });
});
