/**
 * Abort command protocol tests — H2.f.2 single-controller variant.
 *
 * Pre-H2.f.2 the bridge held a Map<threadId, AbortController>. Post-H2.f.2
 * the bridge is collapsed to a single in-flight `currentAbortCtrl`. The
 * wire protocol (`unify_abort_thread`, `unify_abort_all`, `unify_aborted`
 * ack) is preserved for client back-compat — the threadId field on
 * `unify_abort_thread` is simply ignored, since there is only one
 * conversation to abort.
 *
 * Covers:
 *   1. wiring: message-router routes, server relay, session.abort() entry
 *      and the `unify_aborted` ack name (red line: name must not change)
 *   2. behaviour: { threadId } / { all:true } / no-op shapes against the
 *      single controller.
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

// ---- Reset registry between tests (single controller). ----
beforeEach(() => {
  // Clear the in-flight controller without aborting anything live.
  __testSeedAbortController(undefined, null);
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

  it('server client-conversation relays unify_abort_thread', () => {
    expect(relaySrc).toMatch(/case\s+'unify_abort_thread'/);
    expect(relaySrc).toMatch(/type:\s*'unify_abort_thread'/);
  });

  it('server client-conversation relays unify_abort_all with empty payload', () => {
    expect(relaySrc).toMatch(/case\s+'unify_abort_all'/);
    expect(relaySrc).toMatch(/forwardToAgent\([^,]+,\s*\{\s*type:\s*'unify_abort_all'\s*\}\)/);
  });

  it('session.abort({ threadId?, all? }) entry exists and delegates to web-bridge', () => {
    expect(sessionSrc).toMatch(/async\s+abort\s*\(\s*opts\s*=\s*\{\}\s*\)/);
    expect(sessionSrc).toMatch(/abortUnifySession/);
  });

  it('web-bridge holds a single in-flight AbortController (red line)', () => {
    // Post-H2.f.2: state collapsed from `abortByThread = new Map()` to a
    // single `currentAbortCtrl` ref.
    expect(bridgeSrc).toMatch(/let\s+currentAbortCtrl\s*=\s*null/);
    expect(bridgeSrc).not.toMatch(/const\s+abortByThread\s*=\s*new\s+Map\(\)/);
  });

  it('web-bridge emits `unify_aborted` (not the old `unify_cancelled`) ack', () => {
    expect(bridgeSrc).toMatch(/type:\s*'unify_aborted'/);
    expect(bridgeSrc).not.toMatch(/type:\s*'unify_cancelled'/);
  });
});

// --- 2. Behaviour: single controller, three input shapes --------------------
describe('abort behaviour — single controller', () => {
  it('(1) { threadId } aborts the in-flight controller (threadId is ignored)', () => {
    const ctrl = new AbortController();
    __testSeedAbortController('ignored', ctrl);

    const result = handleUnifyAbortThread({ threadId: 'whatever' });

    expect(result.all).toBe(false);
    expect(result.aborted).toEqual(['main']);
    expect(ctrl.signal.aborted).toBe(true);
    // Registry drained
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('(2) { all: true } aborts the single live controller', () => {
    const ctrl = new AbortController();
    __testSeedAbortController(undefined, ctrl);

    const result = handleUnifyAbortAll();

    expect(result.all).toBe(true);
    expect(result.aborted).toEqual(['main']);
    expect(ctrl.signal.aborted).toBe(true);
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('(3) abort with no in-flight controller is a silent no-op', () => {
    // Nothing seeded — registry empty.
    const result = handleUnifyAbortThread({ threadId: 'never-existed' });
    expect(result).toEqual({ aborted: [], all: false });
    expect(__testGetRegisteredThreadIds()).toEqual([]);
  });

  it('abortUnifySession dispatches correctly on all three shapes', () => {
    // Shape A: { all:true }
    const ctrlA = new AbortController();
    __testSeedAbortController(undefined, ctrlA);
    expect(abortUnifySession({ all: true }).all).toBe(true);
    expect(ctrlA.signal.aborted).toBe(true);

    // Shape B: { threadId } — also aborts the (now single) controller
    const ctrlB = new AbortController();
    __testSeedAbortController(undefined, ctrlB);
    const r = abortUnifySession({ threadId: 'whatever' });
    expect(r.all).toBe(false);
    expect(r.aborted).toEqual(['main']);
    expect(ctrlB.signal.aborted).toBe(true);

    // Shape C: empty payload → conservative no-op (controller untouched)
    const ctrlC = new AbortController();
    __testSeedAbortController(undefined, ctrlC);
    const bare = abortUnifySession({});
    expect(bare).toEqual({ aborted: [], all: false });
    expect(ctrlC.signal.aborted).toBe(false);
  });

  it('handleUnifyAbortAll on empty registry still emits ack (idempotent)', () => {
    const result = handleUnifyAbortAll();
    expect(result).toEqual({ aborted: [], all: true });
  });
});
