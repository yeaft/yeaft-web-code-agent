/**
 * routing.test.js — task-334d tests for @-forward dispatch.
 *
 * Layers covered:
 *   - ids.isValidVpId / validateVpId / InvalidVpIdError
 *   - roster.addVp integrates validateVpId
 *   - loop-guard chain-depth + rate throttle
 *   - router self-reject, roster-gate, causedBy chain, fanout passthrough,
 *     task.members forwarding
 *   - route-forward tool contract (ctx wiring, JSON return shape)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createGroup,
  createCoordinator,
  isValidVpId,
  validateVpId,
  InvalidVpIdError,
  addVp,
} from '../../../../agent/unify/groups/index.js';
import {
  createLoopGuard,
  extendCausedBy,
  createRouter,
  MAX_CHAIN_DEPTH,
} from '../../../../agent/unify/routing/index.js';
import routeForwardTool from '../../../../agent/unify/tools/route-forward.js';

let root;
let groupsRoot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '334d-'));
  groupsRoot = join(root, 'groups');
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function makeGroup(roster = ['alice', 'bob', 'carol'], defaultVpId = 'alice') {
  return createGroup(groupsRoot, { id: 'grp_a', roster, defaultVpId });
}

// ─── isValidVpId / validateVpId ──────────────────────────────

describe('isValidVpId', () => {
  it('accepts plain alnum and hyphen names', () => {
    for (const id of ['alice', 'bob', 'CamelCase', 'a1', 'role-x', 'v1p', 'A-B-C']) {
      expect(isValidVpId(id)).toBe(true);
    }
  });

  it('rejects empty, non-string, overlong', () => {
    expect(isValidVpId('')).toBe(false);
    expect(isValidVpId(null)).toBe(false);
    expect(isValidVpId(undefined)).toBe(false);
    expect(isValidVpId(42)).toBe(false);
    expect(isValidVpId('x'.repeat(41))).toBe(false);
  });

  it('rejects illegal characters', () => {
    for (const id of ['alice!', 'al ice', 'a.b', 'a/b', 'a@b', 'a+b']) {
      expect(isValidVpId(id)).toBe(false);
    }
  });

  it('rejects underscore-prefixed (reserved for system roles, per prev-1 nit #1)', () => {
    expect(validateVpId('_system').reason).toBe('underscore_prefix_reserved');
    expect(isValidVpId('_secret_role')).toBe(false);
    // NON-leading underscore is fine — only the prefix is blocked.
    expect(isValidVpId('a_b_c')).toBe(true);
    expect(isValidVpId('role_x')).toBe(true);
  });

  it('rejects pure digits', () => {
    expect(validateVpId('12345').reason).toBe('pure_digits');
    expect(isValidVpId('00000')).toBe(false);
    // Alphanum mix is fine.
    expect(isValidVpId('v1')).toBe(true);
  });

  it('rejects reserved vpIds (ALL/user/system/everyone, case-insensitive)', () => {
    expect(validateVpId('all').reason).toBe('reserved');
    expect(validateVpId('USER').reason).toBe('reserved');
    expect(validateVpId('System').reason).toBe('reserved');
  });

  it('roster.addVp surfaces InvalidVpIdError on shape violations', () => {
    const base = { id: 'grp_a', roster: [], defaultVpId: null };
    expect(() => addVp(base, '_secret')).toThrow(InvalidVpIdError);
    expect(() => addVp(base, '42')).toThrow(/invalid/);
    expect(() => addVp(base, 'has space')).toThrow(InvalidVpIdError);
    // Non-reserved valid id still succeeds.
    expect(addVp(base, 'architect').roster).toEqual(['architect']);
  });
});

// ─── loop-guard ───────────────────────────────────────────────

describe('loop-guard', () => {
  it('check ok by default, record advances the hit counter', () => {
    const g = createLoopGuard();
    expect(g.check({ groupId: 'g', targetVpId: 'alice' }).ok).toBe(true);
    g.record({ groupId: 'g', targetVpId: 'alice' });
    expect(g.snapshot().hits['g::alice']).toHaveLength(1);
  });

  it('chain depth exceeded at exactly MAX_CHAIN_DEPTH', () => {
    const g = createLoopGuard();
    const okChain = new Array(MAX_CHAIN_DEPTH - 1).fill('msg_x');
    expect(g.check({ groupId: 'g', targetVpId: 'alice', chain: okChain }).ok).toBe(true);
    const badChain = new Array(MAX_CHAIN_DEPTH).fill('msg_x');
    const verdict = g.check({ groupId: 'g', targetVpId: 'alice', chain: badChain });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('chain_depth_exceeded');
    expect(verdict.detail.depth).toBe(MAX_CHAIN_DEPTH);
  });

  it('throttles after maxHitsPerWindow and recovers after window', () => {
    let t = 1000;
    const g = createLoopGuard({ maxHitsPerWindow: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(g.check({ groupId: 'g', targetVpId: 'alice' }).ok).toBe(true);
      g.record({ groupId: 'g', targetVpId: 'alice' });
    }
    const throttled = g.check({ groupId: 'g', targetVpId: 'alice' });
    expect(throttled.ok).toBe(false);
    expect(throttled.reason).toBe('throttled');
    expect(throttled.detail.hits).toBe(3);
    // Advance past window — counter drains.
    t += 1500;
    expect(g.check({ groupId: 'g', targetVpId: 'alice' }).ok).toBe(true);
  });

  it('scopes hits per (groupId, vpId) independently', () => {
    let t = 1000;
    const g = createLoopGuard({ maxHitsPerWindow: 2, windowMs: 1000, now: () => t });
    g.record({ groupId: 'g1', targetVpId: 'alice' });
    g.record({ groupId: 'g1', targetVpId: 'alice' });
    expect(g.check({ groupId: 'g1', targetVpId: 'alice' }).ok).toBe(false);
    // Different group, same target — independent counter.
    expect(g.check({ groupId: 'g2', targetVpId: 'alice' }).ok).toBe(true);
    // Same group, different target — independent counter.
    expect(g.check({ groupId: 'g1', targetVpId: 'bob' }).ok).toBe(true);
  });

  it('extendCausedBy builds/extends the chain without mutation', () => {
    const env = { msg: { id: 'msg_1', meta: { causedBy: ['msg_root'] } } };
    const chain = extendCausedBy(env, 'msg_2');
    expect(chain).toEqual(['msg_root', 'msg_1', 'msg_2']);
    expect(env.msg.meta.causedBy).toEqual(['msg_root']); // untouched
  });

  it('extendCausedBy tolerates missing envelope / meta', () => {
    expect(extendCausedBy(null, 'msg_x')).toEqual(['msg_x']);
    expect(extendCausedBy({}, 'msg_x')).toEqual(['msg_x']);
    expect(extendCausedBy({ msg: { id: 'msg_i' } }, null)).toEqual(['msg_i']);
  });
});

// ─── router ───────────────────────────────────────────────────

describe('router.forward', () => {
  function makeRouter(delivered = []) {
    const g = makeGroup();
    const coord = createCoordinator(g, { deliver: (v, env) => delivered.push([v, env.trigger]) });
    const router = createRouter({ coordinator: coord });
    return { g, coord, router };
  }

  it('self-forward is rejected without touching coordinator', () => {
    const delivered = [];
    const { router } = makeRouter(delivered);
    const r = router.forward({ from: 'alice', to: 'alice', text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('self_forward_rejected');
    expect(delivered).toEqual([]);
  });

  it('route_forward from user is rejected (VP-only tool)', () => {
    const { router } = makeRouter([]);
    const r = router.forward({ from: 'user', to: 'alice', text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('route_forward_is_vp_only');
  });

  it('target_not_in_roster short-circuits before dispatch', () => {
    const delivered = [];
    const { router } = makeRouter(delivered);
    const r = router.forward({ from: 'alice', to: 'stranger', text: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('target_not_in_roster');
    expect(delivered).toEqual([]);
  });

  it('valid mention forwards via Coordinator and stamps causedBy', () => {
    const delivered = [];
    const { g, router } = makeRouter(delivered);
    const r = router.forward({
      from: 'alice',
      to: 'bob',
      text: 'can you handle this',
      reason: 'out of my lane',
      inboundEnvelope: { msg: { id: 'msg_inbound', meta: { causedBy: ['msg_root'] } } },
    });
    expect(r.ok).toBe(true);
    expect(r.dispatched).toEqual(['bob']);
    expect(delivered).toEqual([['bob', 'mention']]);
    // The synthetic message is persisted with causedBy + injectedBy meta.
    const stored = Array.from(g.streamMessages());
    expect(stored).toHaveLength(1);
    expect(stored[0].meta.injectedBy).toBe('route_forward');
    expect(stored[0].meta.reason).toBe('out of my lane');
    expect(stored[0].meta.causedBy).toEqual(['msg_root', 'msg_inbound']);
    expect(stored[0].from).toBe('alice');
  });

  it('@all broadcast routes through Coordinator, skipping the sender', () => {
    const delivered = [];
    const { router } = makeRouter(delivered);
    const r = router.forward({ from: 'alice', to: 'all', text: 'ping' });
    expect(r.ok).toBe(true);
    // Coordinator's @all filters out the sender.
    expect(r.dispatched.sort()).toEqual(['bob', 'carol']);
    expect(r.report.broadcast).toBe(true);
    expect(delivered.map(([v]) => v).sort()).toEqual(['bob', 'carol']);
  });

  it('task.members filters forward just like user-initiated routing', () => {
    const delivered = [];
    const { router } = makeRouter(delivered);
    const r = router.forward(
      { from: 'alice', to: 'bob', text: 'hi', taskId: 'task_1' },
      { taskMembers: ['alice', 'carol'] },  // bob NOT a task member
    );
    expect(r.ok).toBe(true);
    expect(r.dispatched).toEqual([]);
    expect(r.report.errors[0].error).toBe('not_in_task_members');
  });

  it('chain depth exceeded → router refuses, nothing delivered', () => {
    const delivered = [];
    const { router } = makeRouter(delivered);
    // Build an inbound envelope whose causedBy already has MAX_CHAIN_DEPTH-1
    // entries, then .msg.id pushes it to the limit inside extendCausedBy.
    const causedBy = new Array(MAX_CHAIN_DEPTH - 1).fill('msg_x').map((_, i) => `msg_${i}`);
    const inboundEnvelope = { msg: { id: 'msg_last', meta: { causedBy } } };
    const r = router.forward({ from: 'alice', to: 'bob', text: 'x', inboundEnvelope });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('chain_depth_exceeded');
    expect(delivered).toEqual([]);
  });

  it('rate throttle kicks in after N hits within window', () => {
    const delivered = [];
    const g = makeGroup();
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    let t = 1000;
    const guard = createLoopGuard({ maxHitsPerWindow: 2, windowMs: 1000, now: () => t });
    const router = createRouter({ coordinator: coord, guard });
    expect(router.forward({ from: 'alice', to: 'bob', text: 'm1' }).ok).toBe(true);
    expect(router.forward({ from: 'alice', to: 'bob', text: 'm2' }).ok).toBe(true);
    const third = router.forward({ from: 'alice', to: 'bob', text: 'm3' });
    expect(third.ok).toBe(false);
    expect(third.error).toBe('throttled');
    expect(delivered).toEqual(['bob', 'bob']);
  });

  it('validates argument shape', () => {
    const { router } = makeRouter([]);
    expect(router.forward({ to: 'bob', text: 'x' }).error).toBe('from_required');
    expect(router.forward({ from: 'alice', text: 'x' }).error).toBe('to_required');
    expect(router.forward({ from: 'alice', to: 'bob' }).error).toBe('text_required');
    expect(router.forward({ from: 'alice', to: 'bob', text: '' }).error).toBe('text_required');
  });
});

// ─── route-forward tool ──────────────────────────────────────

describe('route_forward tool', () => {
  it('defines Tool name + schema including "to", "text", optional "reason"', () => {
    expect(routeForwardTool.name).toBe('RouteForward');
    const props = routeForwardTool.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(['reason', 'text', 'to']);
    expect(routeForwardTool.parameters.required).toEqual(['to', 'text']);
    expect(routeForwardTool.isReadOnly()).toBe(false);
    expect(routeForwardTool.isConcurrencySafe()).toBe(false);
  });

  it('forwards via ctx.router and returns ok JSON with dispatched list', async () => {
    const delivered = [];
    const g = makeGroup();
    const coord = createCoordinator(g, { deliver: (v) => delivered.push(v) });
    const router = createRouter({ coordinator: coord });
    const out = await routeForwardTool.execute(
      { to: 'bob', text: 'hey', reason: 'needs your skill' },
      { router, senderVpId: 'alice' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dispatched).toEqual(['bob']);
    expect(delivered).toEqual(['bob']);
  });

  it('returns ok=false JSON on self-forward (does not throw)', async () => {
    const g = makeGroup();
    const coord = createCoordinator(g);
    const router = createRouter({ coordinator: coord });
    const out = await routeForwardTool.execute(
      { to: 'alice', text: 'talking to myself' },
      { router, senderVpId: 'alice' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('self_forward_rejected');
  });

  it('returns ok=false on missing ctx.router / ctx.senderVpId', async () => {
    const out1 = JSON.parse(await routeForwardTool.execute({ to: 'bob', text: 'x' }, {}));
    expect(out1.error).toBe('router_unavailable');
    const g = makeGroup();
    const coord = createCoordinator(g);
    const router = createRouter({ coordinator: coord });
    const out2 = JSON.parse(await routeForwardTool.execute({ to: 'bob', text: 'x' }, { router }));
    expect(out2.error).toBe('sender_unknown');
  });

  it('returns ok=false on missing required args (no throw, JSON error)', async () => {
    const g = makeGroup();
    const coord = createCoordinator(g);
    const router = createRouter({ coordinator: coord });
    const ctx = { router, senderVpId: 'alice' };
    expect(JSON.parse(await routeForwardTool.execute({ text: 'x' }, ctx)).error).toBe('to_required');
    expect(JSON.parse(await routeForwardTool.execute({ to: 'bob' }, ctx)).error).toBe('text_required');
  });

  it('is registered in createFullRegistry()', async () => {
    const { createFullRegistry } = await import('../../../../agent/unify/tools/index.js');
    const reg = createFullRegistry();
    expect(reg.has('RouteForward')).toBe(true);
  });
});
