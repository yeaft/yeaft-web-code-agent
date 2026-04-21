/**
 * test/agent/vp-bridge-live-diff.test.js — task-334h
 *
 * Tests for the WS live-diff infrastructure in vp-bridge.js:
 *   - vp_updated broadcast on add/update
 *   - vp_removed broadcast on delete
 *   - personaHash mirror in serialized VP payload
 *   - reason classification (persona.edit / traits.edit / manual.reload / file.removed)
 *   - subscriber fan-out + crash isolation
 *   - serializeVpForWire field mapping
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from '../../agent/unify/vp/registry.js';
import {
  serializeVpForWire,
  classifyUpdateReason,
  handleVpSubscribe,
  buildVpSnapshot,
  _resetVpBridgeForTest,
  _broadcastChangeForTest,
  _seedPrevStateForTest,
} from '../../agent/unify/vp/vp-bridge.js';

function mockVp(id, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id.charAt(0).toUpperCase() + id.slice(1),
    role: overrides.role ?? 'Engineer',
    traits: overrides.traits ?? ['pragmatic'],
    modelHint: overrides.modelHint ?? null,
    persona: overrides.persona ?? 'I am ' + id,
    personaHash: 'personaHash' in overrides ? overrides.personaHash : 'hash_' + id,
    dir: overrides.dir ?? '/tmp/vp/' + id,
    memoryDir: overrides.memoryDir ?? '/tmp/vp/' + id + '/memory',
    mtimeMs: overrides.mtimeMs ?? Date.now(),
  };
}

describe('serializeVpForWire', () => {
  it('maps entity fields to wire-format (vpId, displayName, personaHash)', () => {
    const vp = mockVp('alice', { personaHash: 'abc123' });
    const wire = serializeVpForWire(vp);
    expect(wire.vpId).toBe('alice');
    expect(wire.displayName).toBe('Alice');
    expect(wire.role).toBe('Engineer');
    expect(wire.personaHash).toBe('abc123');
    expect(wire.traits).toEqual(['pragmatic']);
    expect(wire.id).toBeUndefined();
    expect(wire.name).toBeUndefined();
    expect(wire.persona).toBeUndefined();
    expect(wire.dir).toBeUndefined();
  });

  it('handles null/missing personaHash gracefully', () => {
    const vp = mockVp('bob', { personaHash: undefined });
    const wire = serializeVpForWire(vp);
    expect(wire.personaHash).toBeNull();
  });
});

describe('classifyUpdateReason', () => {
  it('returns persona.edit when persona text changed', () => {
    expect(classifyUpdateReason(
      { persona: 'old', traits: ['a'] },
      { persona: 'new', traits: ['a'] },
    )).toBe('persona.edit');
  });

  it('returns traits.edit when only traits changed', () => {
    expect(classifyUpdateReason(
      { persona: 'same', traits: ['a'] },
      { persona: 'same', traits: ['a', 'b'] },
    )).toBe('traits.edit');
  });

  it('returns manual.reload when neither changed', () => {
    expect(classifyUpdateReason(
      { persona: 'same', traits: ['a'] },
      { persona: 'same', traits: ['a'] },
    )).toBe('manual.reload');
  });

  it('returns manual.reload when prev is missing', () => {
    expect(classifyUpdateReason(undefined, { persona: 'x', traits: [] })).toBe('manual.reload');
  });
});

describe('broadcastChange (live diff)', () => {
  let registry;
  let events;

  beforeEach(() => {
    _resetVpBridgeForTest();
    registry = new Registry();
    events = [];
  });

  it('vp_updated for added VPs with reason=manual.reload + personaHash', () => {
    const alice = mockVp('alice');
    registry.setVp(alice);
    const unsub = handleVpSubscribe((evt) => events.push(evt), registry);
    events.length = 0; // skip initial snapshot

    const bob = mockVp('bob', { personaHash: 'hash_bob' });
    registry.setVp(bob);
    _broadcastChangeForTest({ added: ['bob'], updated: [], removed: [] }, registry);

    const addEvt = events.find(e => e.type === 'vp_updated' && e.vpId === 'bob');
    expect(addEvt).toBeTruthy();
    expect(addEvt.reason).toBe('manual.reload');
    expect(addEvt.vp.personaHash).toBe('hash_bob');
    expect(addEvt.vp.vpId).toBe('bob');
    unsub();
  });

  it('vp_removed with reason=file.removed when VP deleted', () => {
    const alice = mockVp('alice');
    registry.setVp(alice);
    const unsub = handleVpSubscribe((evt) => events.push(evt), registry);
    events.length = 0;

    registry.removeVp('alice');
    _broadcastChangeForTest({ added: [], updated: [], removed: ['alice'] }, registry);

    const rmEvt = events.find(e => e.type === 'vp_removed');
    expect(rmEvt).toBeTruthy();
    expect(rmEvt.vpId).toBe('alice');
    expect(rmEvt.reason).toBe('file.removed');
    unsub();
  });

  it('vp_updated with reason=persona.edit on persona change', () => {
    const alice = mockVp('alice', { persona: 'original' });
    registry.setVp(alice);
    const unsub = handleVpSubscribe((evt) => events.push(evt), registry);
    _seedPrevStateForTest(registry);
    events.length = 0;

    registry.updateVpInPlace({ ...alice, persona: 'updated', personaHash: 'new_hash' });
    _broadcastChangeForTest({ added: [], updated: ['alice'], removed: [] }, registry);

    const upEvt = events.find(e => e.type === 'vp_updated' && e.vpId === 'alice');
    expect(upEvt).toBeTruthy();
    expect(upEvt.reason).toBe('persona.edit');
    expect(upEvt.vp.personaHash).toBe('new_hash');
    unsub();
  });

  it('vp_updated with reason=traits.edit on traits change', () => {
    const alice = mockVp('alice', { traits: ['pragmatic'] });
    registry.setVp(alice);
    const unsub = handleVpSubscribe((evt) => events.push(evt), registry);
    _seedPrevStateForTest(registry);
    events.length = 0;

    registry.updateVpInPlace({ ...alice, traits: ['pragmatic', 'curious'] });
    _broadcastChangeForTest({ added: [], updated: ['alice'], removed: [] }, registry);

    const upEvt = events.find(e => e.type === 'vp_updated');
    expect(upEvt).toBeTruthy();
    expect(upEvt.reason).toBe('traits.edit');
    unsub();
  });

  it('subscriber crash does not prevent other subscribers from receiving', () => {
    const alice = mockVp('alice');
    registry.setVp(alice);

    const good = [];
    const unsub1 = handleVpSubscribe(() => { throw new Error('boom'); }, registry);
    const unsub2 = handleVpSubscribe((evt) => good.push(evt), registry);
    good.length = 0;

    const bob = mockVp('bob');
    registry.setVp(bob);
    _broadcastChangeForTest({ added: ['bob'], updated: [], removed: [] }, registry);

    expect(good.some(e => e.type === 'vp_updated' && e.vpId === 'bob')).toBe(true);
    unsub1();
    unsub2();
  });
});

describe('buildVpSnapshot', () => {
  it('includes personaHash in snapshot entries', () => {
    const registry = new Registry();
    registry.setVp(mockVp('alice', { personaHash: 'snap_hash' }));
    const snapshot = buildVpSnapshot(registry);
    expect(snapshot.type).toBe('vp_snapshot');
    expect(snapshot.vps[0].personaHash).toBe('snap_hash');
    expect(snapshot.vps[0].vpId).toBe('alice');
  });

  it('sets emptyLibrary when no VPs exist', () => {
    const registry = new Registry();
    const snapshot = buildVpSnapshot(registry);
    expect(snapshot.emptyLibrary).toBe(true);
    expect(snapshot.vps).toEqual([]);
  });
});
