/**
 * task-334h — VP live-diff unit tests.
 *
 * Covers:
 *   - classifyUpdateReason pure classifier (persona / traits / manual)
 *   - _broadcastChangeForTest fans out per-vp events to every subscriber
 *   - reason payload correctness for added / updated / removed vpIds
 *   - back-compat: `vp_snapshot` shape is unchanged; `reason` is absent on it
 *   - unsubscribe fn returned by handleVpSubscribe stops further fan-out
 *   - registry.updateVpInPlace mirrors personaHash (PR #549/#550 nit)
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { Registry } from '../../agent/unify/vp/registry.js';
import {
  buildVpSnapshot,
  serializeVpForWire,
  classifyUpdateReason,
  handleVpSubscribe,
  _resetVpBridgeForTest,
  _broadcastChangeForTest,
  _seedPrevStateForTest,
} from '../../agent/unify/vp/vp-bridge.js';

function mkVp(id, overrides = {}) {
  return {
    id,
    name: overrides.name || id.toUpperCase(),
    role: overrides.role || 'dev',
    traits: overrides.traits || [],
    modelHint: overrides.modelHint ?? null,
    persona: overrides.persona ?? `persona of ${id}`,
    personaHash: overrides.personaHash ?? `h-${id}`,
    mtimeMs: overrides.mtimeMs ?? 1,
    dir: overrides.dir || `/tmp/${id}`,
  };
}

// ─── classifyUpdateReason ────────────────────────────────────────

describe('classifyUpdateReason', () => {
  it('missing prev → manual.reload', () => {
    expect(classifyUpdateReason(undefined, { persona: 'x', traits: [] })).toBe('manual.reload');
  });

  it('persona body changed → persona.edit', () => {
    const prev = { persona: 'old', traits: ['a'] };
    const next = { persona: 'new', traits: ['a'] };
    expect(classifyUpdateReason(prev, next)).toBe('persona.edit');
  });

  it('traits differ but persona identical → traits.edit', () => {
    const prev = { persona: 'same', traits: ['a'] };
    const next = { persona: 'same', traits: ['a', 'b'] };
    expect(classifyUpdateReason(prev, next)).toBe('traits.edit');
  });

  it('neither persona nor traits differ → manual.reload', () => {
    const prev = { persona: 'same', traits: ['a'] };
    const next = { persona: 'same', traits: ['a'] };
    expect(classifyUpdateReason(prev, next)).toBe('manual.reload');
  });

  it('persona-change takes precedence over traits-change', () => {
    const prev = { persona: 'old', traits: ['a'] };
    const next = { persona: 'new', traits: ['a', 'b'] };
    expect(classifyUpdateReason(prev, next)).toBe('persona.edit');
  });
});

// ─── Broadcast fan-out ───────────────────────────────────────────

describe('vp-bridge live-diff broadcast', () => {
  let registry;
  let events;
  let send;

  beforeEach(() => {
    _resetVpBridgeForTest();
    registry = new Registry();
    events = [];
    send = (e) => events.push(e);
  });

  it('snapshot on subscribe carries NO reason field (back-compat)', () => {
    registry.setVp(mkVp('a'));
    handleVpSubscribe(send, registry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('vp_snapshot');
    expect(events[0].reason).toBeUndefined();
    expect(events[0].vps[0].vpId).toBe('a');
    // vp_snapshot field contract unchanged.
    expect(events[0]).toEqual({
      type: 'vp_snapshot',
      vps: [serializeVpForWire(registry.getVp('a'))],
      emptyLibrary: false,
    });
  });

  it('added vpIds fan out as vp_updated with reason=manual.reload', () => {
    handleVpSubscribe(send, registry);
    events.length = 0;

    registry.setVp(mkVp('b'));
    _broadcastChangeForTest({ added: ['b'], updated: [], removed: [] }, registry);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'vp_updated',
      vpId: 'b',
      reason: 'manual.reload',
    });
    expect(events[0].vp.vpId).toBe('b');
  });

  it('removed vpIds fan out as vp_removed with reason=file.removed', () => {
    registry.setVp(mkVp('c'));
    handleVpSubscribe(send, registry);
    events.length = 0;

    registry.removeVp('c');
    _broadcastChangeForTest({ added: [], updated: [], removed: ['c'] }, registry);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'vp_removed',
      vpId: 'c',
      reason: 'file.removed',
    });
  });

  it('updated vpId with persona change emits reason=persona.edit', () => {
    registry.setVp(mkVp('d', { persona: 'v1' }));
    handleVpSubscribe(send, registry);
    _seedPrevStateForTest(registry);
    events.length = 0;

    // Simulate in-place update (registry identity preserved).
    registry.updateVpInPlace(mkVp('d', { persona: 'v2' }));
    _broadcastChangeForTest({ added: [], updated: ['d'], removed: [] }, registry);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'vp_updated',
      vpId: 'd',
      reason: 'persona.edit',
    });
  });

  it('updated vpId with only traits change emits reason=traits.edit', () => {
    registry.setVp(mkVp('e', { persona: 'same', traits: ['x'] }));
    handleVpSubscribe(send, registry);
    _seedPrevStateForTest(registry);
    events.length = 0;

    registry.updateVpInPlace(mkVp('e', { persona: 'same', traits: ['x', 'y'] }));
    _broadcastChangeForTest({ added: [], updated: ['e'], removed: [] }, registry);

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('traits.edit');
  });

  it('fan-out reaches every active subscriber', () => {
    const a = [];
    const b = [];
    handleVpSubscribe((e) => a.push(e), registry);
    handleVpSubscribe((e) => b.push(e), registry);
    // Flush snapshots.
    a.length = 0;
    b.length = 0;

    registry.setVp(mkVp('f'));
    _broadcastChangeForTest({ added: ['f'], updated: [], removed: [] }, registry);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].vpId).toBe('f');
    expect(b[0].vpId).toBe('f');
  });

  it('unsubscribe() stops further events', () => {
    const unsub = handleVpSubscribe(send, registry);
    events.length = 0;
    unsub();

    registry.setVp(mkVp('g'));
    _broadcastChangeForTest({ added: ['g'], updated: [], removed: [] }, registry);

    expect(events).toHaveLength(0);
  });

  it('subscriber errors do not break fan-out to other subscribers', () => {
    const good = [];
    handleVpSubscribe(() => { throw new Error('boom'); }, registry);
    handleVpSubscribe((e) => good.push(e), registry);
    good.length = 0;

    registry.setVp(mkVp('h'));
    expect(() => {
      _broadcastChangeForTest({ added: ['h'], updated: [], removed: [] }, registry);
    }).not.toThrow();
    expect(good).toHaveLength(1);
  });

  it('removed event carries no serialised vp payload', () => {
    registry.setVp(mkVp('i'));
    handleVpSubscribe(send, registry);
    events.length = 0;

    registry.removeVp('i');
    _broadcastChangeForTest({ added: [], updated: [], removed: ['i'] }, registry);

    expect(events[0].vp).toBeUndefined();
    expect(events[0].vpId).toBe('i');
  });

  it('reason classifier consults the previous state, not the post-update vp', () => {
    // Seed registry with v1, snapshot state, then two consecutive updates:
    // first changes persona, second changes traits. Each must classify
    // against the cached *previous* state only — not against v1 forever.
    registry.setVp(mkVp('j', { persona: 'v1', traits: ['a'] }));
    handleVpSubscribe(send, registry);
    _seedPrevStateForTest(registry);
    events.length = 0;

    // First update: persona change.
    registry.updateVpInPlace(mkVp('j', { persona: 'v2', traits: ['a'] }));
    _broadcastChangeForTest({ added: [], updated: ['j'], removed: [] }, registry);
    expect(events[events.length - 1].reason).toBe('persona.edit');

    // Second update: traits-only change (persona v2 unchanged).
    registry.updateVpInPlace(mkVp('j', { persona: 'v2', traits: ['a', 'b'] }));
    _broadcastChangeForTest({ added: [], updated: ['j'], removed: [] }, registry);
    expect(events[events.length - 1].reason).toBe('traits.edit');
  });
});

// ─── Registry.updateVpInPlace personaHash mirror (PR #549/#550 nit) ───

describe('registry.updateVpInPlace — personaHash mirror', () => {
  it('copies personaHash from the incoming VP', () => {
    const reg = new Registry();
    reg.setVp(mkVp('k', { personaHash: 'h-old' }));
    const kept = reg.updateVpInPlace(mkVp('k', { personaHash: 'h-new' }));
    expect(kept.personaHash).toBe('h-new');
    expect(reg.getVp('k').personaHash).toBe('h-new');
  });

  it('preserves VP object identity (RoleInstance.vp ref stays stable)', () => {
    const reg = new Registry();
    reg.setVp(mkVp('m', { personaHash: 'h1' }));
    const before = reg.getVp('m');
    reg.updateVpInPlace(mkVp('m', { personaHash: 'h2' }));
    expect(reg.getVp('m')).toBe(before);
  });
});

// ─── Wire-format back-compat ─────────────────────────────────────

describe('wire-format back-compat (task-334h)', () => {
  it('vp_snapshot keys unchanged from 334-ui-a', () => {
    const reg = new Registry();
    reg.setVp(mkVp('n'));
    const snap = buildVpSnapshot(reg);
    const keys = Object.keys(snap).sort();
    expect(keys).toEqual(['emptyLibrary', 'type', 'vps']);
  });

  it('serializeVpForWire keys unchanged from 334-ui-a', () => {
    const wire = serializeVpForWire(mkVp('o'));
    const keys = Object.keys(wire).sort();
    expect(keys).toEqual([
      'displayName',
      'modelHint',
      'personaHash',
      'role',
      'subtitle',
      'traits',
      'vpId',
    ]);
  });
});
