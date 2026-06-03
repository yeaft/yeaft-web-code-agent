/**
 * web-bridge-router-wiring.test.js — pin the invariant that every Yeaft
 * turn carries a `router` in its query opts whenever a coordinator is
 * supplied. Bug history (visible as `router_unavailable` in the UI):
 *
 *   1. v0.1.598 wired `createRouter` into buildVpQueryOpts when a
 *      coordinator is supplied — but only the `yeaft_group_chat` path
 *      supplied one. The legacy `yeaft_chat` path (no group) silently
 *      dropped ctx.router, and any `route_forward` call from a VP
 *      exploded with `router_unavailable`.
 *
 *   2. The product semantics are "Yeaft is a single conversation backed
 *      by grp_default" — there is no legitimate path where the user is
 *      in Yeaft but no group exists. v0.1.671 ensured the frontend
 *      ALWAYS sends `yeaft_group_chat` with `grp_default`; v0.1.672 then
 *      deleted the `yeaft_chat` / `handleYeaftChat` legacy path entirely.
 *      So `route_forward` ALWAYS has a router to call into.
 *
 * These tests guard the buildVpQueryOpts contract directly.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../agent/yeaft/vp/vp-crud.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    readVp: vi.fn((vpId) => ({
      vpId,
      displayName: vpId,
      role: '',
      persona: `persona of ${vpId}`,
    })),
  };
});

vi.mock('../../agent/yeaft/vp/vp-store.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    scanVpLibrary: vi.fn(() => [
      { vpId: 'linus', displayName: 'Linus', role: '', persona: '' },
      { vpId: 'grace', displayName: 'Grace', role: '', persona: '' },
    ]),
  };
});

import { buildVpQueryOpts } from '../../agent/yeaft/web-bridge.js';

function makeCoordinator() {
  return {
    ingest: vi.fn(() => ({ dispatched: [], fallback: null })),
    group: {
      getMeta: () => ({ id: 'grp_default', defaultVpId: 'linus', roster: ['linus', 'grace'] }),
    },
  };
}

describe('buildVpQueryOpts — router wiring invariant', () => {
  it('attaches a router with .forward() when a coordinator is supplied', () => {
    const coord = makeCoordinator();
    const out = buildVpQueryOpts({ vpId: 'linus', sessionCoordinator: coord, sessionId: 'grp_default' });
    expect(out).toBeDefined();
    expect(out.router).toBeDefined();
    expect(typeof out.router.forward).toBe('function');
  });

  it('no router is attached when no coordinator is supplied', () => {
    // After v0.1.672 there is no production caller that omits a
    // coordinator — `handleYeaftSessionSend` always builds one and
    // there's no longer a `handleYeaftChat` entry point. This test
    // pins the buildVpQueryOpts function-level contract: given no
    // coordinator, no router. Defensive only.
    const out = buildVpQueryOpts({ vpId: 'linus' });
    expect(out).toBeDefined();
    expect(out.router).toBeUndefined();
  });

  it('does NOT throw when coordinator is structurally invalid', () => {
    // Defensive — buildVpQueryOpts must skip router wiring when the
    // coordinator doesn't expose `ingest` as a function. NOTE: this
    // exercises the outer `typeof === 'function'` guard, NOT the
    // try/catch around createRouter — that catch is belt-and-suspenders
    // for createRouter's own validation throw and isn't reachable from a
    // coordinator whose `ingest` already failed the typeof guard.
    const broken = { ingest: 'not-a-function' };
    let out;
    expect(() => {
      out = buildVpQueryOpts({ vpId: 'linus', sessionCoordinator: broken });
    }).not.toThrow();
    expect(out).toBeDefined();
    expect(out.router).toBeUndefined();
  });
});
