/**
 * routing-followup.integration.test.js — task-334d-followup.
 *
 * Two suites:
 *
 *   A. loop-guard LRU + TTL eviction (N1)
 *      - hits Map stays bounded under long-running traffic
 *      - TTL sweep drops stale keys; LRU cap drops oldest-used
 *      - 'all' sentinel still routes through the guard
 *      - now() injection + chain depth check are unchanged
 *
 *   B. route_forward end-to-end integration (N3)
 *      Wires a fake Engine that calls the route_forward tool →
 *      createRouter → GroupCoordinator.ingest → deliver callback pushing
 *      into RoleInstance.inputQueue → downstream Engine receives the
 *      envelope. Three scenarios:
 *        B1. Successful fan-out: alice @bob → bob's inputQueue gets msg
 *        B2. Non-member rejection: target_not_in_roster (no ingest, no queue)
 *        B3. @all broadcast capped at perGroupFanOut (truncated flag)
 *
 * Hard constraints (PM directive):
 *   - routing/router.js: NOT modified (test only)
 *   - groups/ids.js:     NOT modified
 *   - 334-ui-*:          not touched
 *   - Existing routing.test.js (344 lines): not edited
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createLoopGuard,
  createRouter,
  MAX_CHAIN_DEPTH,
  DEFAULT_MAX_KEYS,
  DEFAULT_TTL_MULTIPLIER,
} from '../../../../agent/unify/routing/index.js';
import {
  createGroup,
  createCoordinator,
} from '../../../../agent/unify/groups/index.js';
import { RoleInstance } from '../../../../agent/unify/vp/index.js';
import routeForwardTool from '../../../../agent/unify/tools/route-forward.js';

let root;
let groupsRoot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '334d-fu-'));
  groupsRoot = join(root, 'groups');
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function vp(id) {
  return {
    id, name: id, role: 'member', traits: [], modelHint: 'primary',
    persona: `You are ${id}.`, personaHash: id.padEnd(8, '0').slice(0, 8),
    dir: `/tmp/${id}`, memoryDir: `/tmp/${id}/memory`, mtimeMs: 1,
  };
}

// ─────────────────────────────────────────────────────────────
// A. LRU + TTL eviction (N1)
// ─────────────────────────────────────────────────────────────
describe('loop-guard LRU + TTL eviction (N1)', () => {
  it('evicts fully-expired keys on new-key insert (TTL sweep)', () => {
    let t = 1_000_000;
    const g = createLoopGuard({
      windowMs: 1000,
      ttlMultiplier: 2,           // expire after 2000ms idle
      now: () => t,
    });

    // Seed two old keys at t=1M.
    g.record({ groupId: 'g1', targetVpId: 'alice' });
    g.record({ groupId: 'g1', targetVpId: 'bob' });
    expect(g.snapshot().size).toBe(2);

    // Advance past the TTL (> 2 × windowMs = 2000ms).
    t += 3000;

    // A brand-new key triggers the sweep; the two stale ones are dropped.
    g.record({ groupId: 'g2', targetVpId: 'carol' });
    const s = g.snapshot();
    expect(s.size).toBe(1);
    expect(Object.keys(s.hits)).toEqual(['g2::carol']);
    expect(s.evictions).toBe(2);
  });

  it('enforces LRU cap by evicting oldest-used key', () => {
    let t = 0;
    const g = createLoopGuard({
      windowMs: 10_000,
      ttlMultiplier: 10,          // TTL is far — isolate LRU behaviour
      maxKeys: 3,
      now: () => (t += 1),        // each call bumps t by 1
    });

    // 4 distinct keys, all fresh.
    g.record({ groupId: 'g', targetVpId: 'a' });
    g.record({ groupId: 'g', targetVpId: 'b' });
    g.record({ groupId: 'g', targetVpId: 'c' });
    g.record({ groupId: 'g', targetVpId: 'd' });   // triggers eviction of 'a'

    const s = g.snapshot();
    expect(s.size).toBe(3);
    expect(Object.keys(s.hits)).toEqual(['g::b', 'g::c', 'g::d']);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
  });

  it('check() refreshes LRU recency so repeatedly-probed key survives', () => {
    let t = 0;
    const g = createLoopGuard({
      windowMs: 10_000, ttlMultiplier: 10, maxKeys: 2,
      now: () => (t += 1),
    });

    g.record({ groupId: 'g', targetVpId: 'a' });  // a
    g.record({ groupId: 'g', targetVpId: 'b' });  // a, b

    // Probe 'a' → touch moves it to tail.
    g.check({ groupId: 'g', targetVpId: 'a', chain: [] });

    // Insert 'c' → should evict the oldest, which is now 'b' (not 'a').
    g.record({ groupId: 'g', targetVpId: 'c' });

    const s = g.snapshot();
    expect(Object.keys(s.hits).sort()).toEqual(['g::a', 'g::c']);
  });

  it('long-running fuzz (1500 distinct keys) stays at maxKeys cap', () => {
    let t = 0;
    const g = createLoopGuard({
      windowMs: 1000, ttlMultiplier: 2, maxKeys: 100,
      now: () => (t += 1),
    });
    for (let i = 0; i < 1500; i += 1) {
      g.record({ groupId: 'g', targetVpId: `vp_${i}` });
    }
    expect(g.snapshot().size).toBeLessThanOrEqual(100);
    expect(g.snapshot().evictions).toBeGreaterThan(1000);
  });

  it('preserves "all" broadcast sentinel keying after eviction', () => {
    let t = 1_000_000;
    const g = createLoopGuard({
      windowMs: 1000, ttlMultiplier: 2, maxKeys: 5,
      now: () => t,
    });

    // Warm up other keys, then record 'all'.
    for (let i = 0; i < 3; i += 1) g.record({ groupId: 'g', targetVpId: `v${i}` });
    g.record({ groupId: 'g', targetVpId: 'all' });

    // Still checkable; 'all' is just a string key from the guard's POV.
    const v = g.check({ groupId: 'g', targetVpId: 'all', chain: [] });
    expect(v.ok).toBe(true);
    // Hit it 8 times → throttled (default maxHits=8, we already have 1).
    for (let i = 0; i < 7; i += 1) g.record({ groupId: 'g', targetVpId: 'all' });
    const blocked = g.check({ groupId: 'g', targetVpId: 'all', chain: [] });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('throttled');
  });

  it('preserves chain_depth check (independent of Map eviction)', () => {
    const g = createLoopGuard({ maxKeys: 2 });
    const chain = new Array(MAX_CHAIN_DEPTH).fill('msg');
    const v = g.check({ groupId: 'g', targetVpId: 'x', chain });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('chain_depth_exceeded');
  });

  it('preserves now() injection path after LRU refactor', () => {
    const clock = { t: 42 };
    const g = createLoopGuard({
      windowMs: 1000, now: () => clock.t,
    });
    g.record({ groupId: 'g', targetVpId: 'x' });
    expect(g.snapshot().hits['g::x']).toEqual([42]);
    clock.t = 2000;  // past windowMs
    g.check({ groupId: 'g', targetVpId: 'x', chain: [] }); // trims expired
    expect(g.snapshot().hits['g::x']).toEqual([]);
  });

  it('exposes DEFAULT_MAX_KEYS + DEFAULT_TTL_MULTIPLIER', () => {
    expect(DEFAULT_MAX_KEYS).toBe(1000);
    expect(DEFAULT_TTL_MULTIPLIER).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// B. route_forward end-to-end (N3)
// ─────────────────────────────────────────────────────────────
describe('route_forward Engine ↔ Coordinator ↔ RoleInstance wiring (N3)', () => {
  /**
   * Build the full stack: group + coordinator + router + 3 RoleInstances.
   * `deliver` is the hook Coordinator calls per target; we push into the
   * matching RoleInstance's inputQueue, exactly as 334b's contract says
   * 334c consumes.
   */
  function makeStack(roster = ['alice', 'bob', 'carol']) {
    const group = createGroup(groupsRoot, {
      id: 'grp_int', roster, defaultVpId: 'alice',
    });

    const instances = new Map();
    for (const id of roster) {
      instances.set(id, new RoleInstance({ vp: vp(id), groupId: 'grp_int' }));
    }

    const coordinator = createCoordinator(group, {
      perGroupFanOut: 2,
      deliver: (vpId, envelope) => {
        instances.get(vpId)?.enqueue(envelope);
      },
    });

    const router = createRouter({ coordinator });

    return { group, coordinator, router, instances };
  }

  /**
   * Fake Engine that, during its turn, calls the route_forward tool.
   * Returns the tool result so assertions can inspect success/error.
   */
  async function engineCallsRouteForward({ router, senderVpId, args, inboundEnvelope = null, taskMembers }) {
    const ctx = {
      router,
      senderVpId,
      inboundEnvelope,
      taskId: args.taskId ?? null,
      taskMembers,
    };
    const raw = await routeForwardTool.execute(args, ctx);
    return JSON.parse(raw);
  }

  it('B1: successful @bob fan-out — bob\'s inputQueue receives the envelope', async () => {
    const { router, instances } = makeStack();

    const result = await engineCallsRouteForward({
      router,
      senderVpId: 'alice',
      args: { to: 'bob', text: 'Can you review?', reason: 'needs rubber stamp' },
    });

    expect(result.ok).toBe(true);
    expect(result.dispatched).toEqual(['bob']);

    const bob = instances.get('bob');
    expect(bob.inputQueue).toHaveLength(1);
    expect(bob.state).toBe('queued');
    const env = bob.inputQueue[0];
    expect(env.groupId).toBe('grp_int');
    expect(env.trigger).toBe('mention');
    expect(env.msg.text).toMatch(/^@bob Can you review\?$/);
    // Provenance on the stored message: synthetic + injectedBy + senderVpId.
    expect(env.msg.meta.synthetic).toBe(true);
    expect(env.msg.meta.injectedBy).toBe('route_forward');
    expect(env.msg.meta.senderVpId).toBe('alice');
    expect(env.msg.meta.reason).toBe('needs rubber stamp');

    // Non-targets untouched.
    expect(instances.get('alice').inputQueue).toHaveLength(0);
    expect(instances.get('carol').inputQueue).toHaveLength(0);
  });

  it('B2: non-member target → target_not_in_roster, nothing dispatched', async () => {
    const { router, instances } = makeStack();

    const result = await engineCallsRouteForward({
      router,
      senderVpId: 'alice',
      args: { to: 'mallory', text: 'hi there' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('target_not_in_roster');
    for (const id of ['alice', 'bob', 'carol']) {
      expect(instances.get(id).inputQueue).toHaveLength(0);
    }
  });

  it('B3: @all broadcast truncates at perGroupFanOut cap', async () => {
    // roster = 5, cap = 2 → sender (alice) excluded → first 2 of [bob, carol, dave, eve]
    const { router, instances } = makeStack(['alice', 'bob', 'carol', 'dave', 'eve']);

    const result = await engineCallsRouteForward({
      router,
      senderVpId: 'alice',
      args: { to: 'all', text: 'standup in 5' },
    });

    expect(result.ok).toBe(true);
    expect(result.broadcast).toBe(true);
    expect(result.truncatedAtFanOutCap).toBe(true);
    expect(result.dispatched).toEqual(['bob', 'carol']);

    expect(instances.get('bob').inputQueue).toHaveLength(1);
    expect(instances.get('carol').inputQueue).toHaveLength(1);
    expect(instances.get('dave').inputQueue).toHaveLength(0);
    expect(instances.get('eve').inputQueue).toHaveLength(0);
    // sender not self-dispatched.
    expect(instances.get('alice').inputQueue).toHaveLength(0);
  });
});
