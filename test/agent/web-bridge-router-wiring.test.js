/**
 * web-bridge-router-wiring.test.js — pin the invariant that every Unify
 * turn carries a `router` in its query opts whenever a coordinator is
 * supplied. Bug history (visible as `router_unavailable` in the UI):
 *
 *   1. v0.1.598 wired `createRouter` into buildVpQueryOpts when a
 *      coordinator is supplied — but only the `unify_group_chat` path
 *      supplies one. Legacy `unify_chat` (no group) silently dropped
 *      ctx.router, and any `route_forward` call from a VP exploded with
 *      `router_unavailable`.
 *
 *   2. The product semantics are "Unify is a single conversation backed
 *      by grp_default" — there is no legitimate path where the user is
 *      in Unify but no group exists. So `route_forward` MUST always have
 *      a router to call into.
 *
 * These tests guard the buildVpQueryOpts contract directly. Frontend
 * always-send-with-grp_default and backend lazy-coordinator are covered
 * by their own integration tests; this file is the contract pin.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../agent/unify/vp/vp-crud.js', async (orig) => {
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

vi.mock('../../agent/unify/vp/vp-store.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    scanVpLibrary: vi.fn(() => [
      { vpId: 'linus', displayName: 'Linus', role: '', persona: '' },
      { vpId: 'grace', displayName: 'Grace', role: '', persona: '' },
    ]),
  };
});

import { buildVpQueryOpts } from '../../agent/unify/web-bridge.js';

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
    const out = buildVpQueryOpts({ vpId: 'linus', groupCoordinator: coord, groupId: 'grp_default' });
    expect(out).toBeDefined();
    expect(out.router).toBeDefined();
    expect(typeof out.router.forward).toBe('function');
  });

  it('no router is attached when no coordinator is supplied', () => {
    // This is the legacy path. The fix moves the responsibility for
    // ALWAYS supplying a coordinator into the caller (frontend ChatInput
    // always sends grp_default; backend handleUnifyChat builds a fallback
    // coordinator before reaching here).
    const out = buildVpQueryOpts({ vpId: 'linus' });
    expect(out).toBeDefined();
    expect(out.router).toBeUndefined();
  });

  it('does NOT throw when coordinator is structurally invalid', () => {
    // Defensive — createRouter throws on a coordinator without ingest().
    // buildVpQueryOpts must swallow it (router build failure is non-fatal).
    const broken = { ingest: 'not-a-function' };
    let out;
    expect(() => {
      out = buildVpQueryOpts({ vpId: 'linus', groupCoordinator: broken });
    }).not.toThrow();
    expect(out).toBeDefined();
    expect(out.router).toBeUndefined();
  });
});
