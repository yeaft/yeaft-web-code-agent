/**
 * task-325c — Abort command protocol tests.
 *
 * Covers the three input combinations declared in the spec:
 *
 *   1. { threadId: 'foo' }  → aborts that thread's controller only
 *   2. { all: true }        → aborts every registered controller
 *   3. no registered thread → silent no-op (still emits ack)
 *
 * Plus the surrounding wiring: message-router route, server relay,
 * session.abort() entry, and the `thread_list_updated` / `unify_aborted`
 * event names (red line: names must not change).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  handleUnifyAbortThread,
  handleUnifyAbortAll,
  abortUnifySession,
  __testSeedAbortController,
  __testGetRegisteredThreadIds,
} from '../../../agent/unify/web-bridge.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const bridgeSrc = readFileSync(join(ROOT, 'agent/unify/web-bridge.js'), 'utf8');
const routerSrc = readFileSync(join(ROOT, 'agent/connection/message-router.js'), 'utf8');
const relaySrc = readFileSync(join(ROOT, 'server/handlers/client-conversation.js'), 'utf8');
const sessionSrc = readFileSync(join(ROOT, 'agent/unify/session.js'), 'utf8');

// ---- Reset registry between tests (module-level singleton). ----
beforeEach(() => {
  for (const id of __testGetRegisteredThreadIds()) {
    // Drain without aborting — we seed fresh controllers per test.
    handleUnifyAbortThread({ threadId: id });
  }
});

// --- 1. Protocol: message names + wiring ------------------------------------
describe('abort protocol — wire-level names (PM red lines)', () => {
  it('message-router routes unify_abort_thread → handleUnifyAbortThread', () => {
    expect(routerSrc).toMatch(/case\s+'unify_abort_thread'/);
    expect(routerSrc).toMatch(/handleUnifyAbortThread\(msg\)/);
  });

  it('message-router routes unify_abort_all → handleUnifyAbortAll', () => {
    expect(routerSrc).toMatch(/case\s+'unify_abort_all'/);
    expect(routerSrc).toMatch(/handleUnifyAbortAll\(\)/);
  });

  it('message-router imports both handlers from web-bridge', () => {
    expect(routerSrc).toMatch(/handleUnifyAbortThread/);
    expect(routerSrc).toMatch(/handleUnifyAbortAll/);
  });

  it('server client-conversation relays unify_abort_thread with threadId only', () => {
    expect(relaySrc).toMatch(/case\s+'unify_abort_thread'/);
    expect(relaySrc).toMatch(/type:\s*'unify_abort_thread',\s*\n\s*threadId:\s*msg\.threadId/);
  });

  it('server client-conversation relays unify_abort_all with empty payload', () => {
    expect(relaySrc).toMatch(/case\s+'unify_abort_all'/);
    expect(relaySrc).toMatch(/forwardToAgent\([^,]+,\s*\{\s*type:\s*'unify_abort_all'\s*\}\)/);
  });

  it('session.abort({ threadId?, all? }) entry exists and delegates to web-bridge', () => {
    expect(sessionSrc).toMatch(/async\s+abort\s*\(\s*opts\s*=\s*\{\}\s*\)/);
    expect(sessionSrc).toMatch(/abortUnifySession/);
  });

  it('web-bridge preserves existing `thread_list_updated` event name (red line)', () => {
    expect(bridgeSrc).toMatch(/type:\s*'thread_list_updated'/);
  });

  it('web-bridge does NOT rename `abortByThread` Map key shape', () => {
    // Registry must still be keyed by threadId (string). Sanity check.
    expect(bridgeSrc).toMatch(/const\s+abortByThread\s*=\s*new\s+Map\(\)/);
  });

  it('web-bridge emits `unify_aborted` (not the old `unify_cancelled`) ack', () => {
    expect(bridgeSrc).toMatch(/type:\s*'unify_aborted'/);
    expect(bridgeSrc).not.toMatch(/type:\s*'unify_cancelled'/);
  });
});

// --- 2. Behaviour: three input combinations ---------------------------------
describe('abort behaviour — three input combinations', () => {
  it('(1) { threadId } aborts the matching controller only', () => {
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    __testSeedAbortController('t-a', ctrlA);
    __testSeedAbortController('t-b', ctrlB);

    const result = handleUnifyAbortThread({ threadId: 't-a' });

    expect(result).toEqual({ aborted: ['t-a'], all: false });
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
    // Registry pruned for 't-a' only
    expect(__testGetRegisteredThreadIds()).toEqual(['t-b']);
  });

  it('(2) { all: true } aborts every registered controller', () => {
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const ctrlC = new AbortController();
    __testSeedAbortController('t-a', ctrlA);
    __testSeedAbortController('t-b', ctrlB);
    __testSeedAbortController('t-c', ctrlC);

    const result = handleUnifyAbortAll();

    expect(result.all).toBe(true);
    expect(result.aborted.sort()).toEqual(['t-a', 't-b', 't-c']);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
    expect(ctrlC.signal.aborted).toBe(true);
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('(3) { threadId } on unregistered thread is a silent no-op', () => {
    // Nothing seeded — registry empty.
    const result = handleUnifyAbortThread({ threadId: 'never-existed' });
    expect(result).toEqual({ aborted: [], all: false });
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('abortUnifySession dispatches correctly on all three shapes', () => {
    const ctrlA = new AbortController();
    __testSeedAbortController('t-a', ctrlA);
    // Shape A: { all:true }
    expect(abortUnifySession({ all: true }).all).toBe(true);
    expect(ctrlA.signal.aborted).toBe(true);

    // Shape B: { threadId }
    const ctrlB = new AbortController();
    __testSeedAbortController('t-b', ctrlB);
    expect(abortUnifySession({ threadId: 't-b' })).toEqual({ aborted: ['t-b'], all: false });
    expect(ctrlB.signal.aborted).toBe(true);

    // Shape C: empty payload → conservative no-op
    const ctrlC = new AbortController();
    __testSeedAbortController('t-c', ctrlC);
    const bare = abortUnifySession({});
    expect(bare).toEqual({ aborted: [], all: false });
    expect(ctrlC.signal.aborted).toBe(false);  // untouched
  });

  it('handleUnifyAbortThread with missing threadId is a silent no-op', () => {
    const ctrl = new AbortController();
    __testSeedAbortController('t-x', ctrl);
    const result = handleUnifyAbortThread({});
    expect(result).toEqual({ aborted: [], all: false });
    expect(ctrl.signal.aborted).toBe(false);
    expect(__testGetRegisteredThreadIds()).toEqual(['t-x']);
  });

  it('handleUnifyAbortAll on empty registry still emits ack (idempotent)', () => {
    const result = handleUnifyAbortAll();
    expect(result).toEqual({ aborted: [], all: true });
  });
});
