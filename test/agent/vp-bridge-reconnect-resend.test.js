/**
 * vp-bridge-reconnect-resend.test.js — task-339-followup (C3)
 *
 * Regression scenario: a WebSocket reconnect causes the web client to
 * re-send `unify_vp_subscribe`. Each subscribe call registers a new
 * subscriber fn — if the bridge ever de-duped subscribers or treated
 * repeat calls as no-ops, the snapshot would not be redelivered and the
 * client would re-render with an empty VP list.
 *
 * Contract: every `handleVpSubscribe` call emits a fresh `vp_snapshot`
 * event synchronously on the provided sendUnifyEvent callback, regardless
 * of prior subscribes — so the UI always gets a current-truth payload on
 * reconnect.
 *
 * Contract: the unsubscribe fn returned by an earlier subscribe cleanly
 * removes that subscriber from the live-diff fan-out; subsequent
 * broadcasts must only reach the still-active subscriber.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleVpSubscribe,
  _resetVpBridgeForTest,
  _broadcastChangeForTest,
} from '../../agent/unify/vp/vp-bridge.js';
import { Registry } from '../../agent/unify/vp/registry.js';

function mkVp(id) {
  return {
    id,
    name: id.toUpperCase(),
    role: 'dev',
    traits: [],
    modelHint: null,
    persona: `p-${id}`,
    personaHash: `h-${id}`,
    dir: `/tmp/${id}`,
    memoryDir: `/tmp/${id}/memory`,
    mtimeMs: 1,
  };
}

describe('task-339-followup C3: WS reconnect resubscribe', () => {
  beforeEach(() => {
    _resetVpBridgeForTest();
  });

  afterEach(() => {
    _resetVpBridgeForTest();
  });

  it('every subscribe call emits a fresh vp_snapshot (no dedupe suppression)', () => {
    const registry = new Registry();

    const events = [];
    const send = (e) => events.push(e);

    const unsub1 = handleVpSubscribe(send, registry);
    const unsub2 = handleVpSubscribe(send, registry);
    const unsub3 = handleVpSubscribe(send, registry);

    // One snapshot per subscribe — three subscribes, three snapshots.
    const snapshots = events.filter(e => e.type === 'vp_snapshot');
    expect(snapshots).toHaveLength(3);
    for (const snap of snapshots) {
      expect(snap.type).toBe('vp_snapshot');
      expect(Array.isArray(snap.vps)).toBe(true);
      expect(typeof snap.emptyLibrary).toBe('boolean');
    }

    unsub1();
    unsub2();
    unsub3();
  });

  it('unsubscribed callback no longer receives live-diff events', () => {
    const registry = new Registry();
    registry.setVp(mkVp('__rc_alice2__'));

    const a = [];
    const b = [];
    const unsubA = handleVpSubscribe((e) => a.push(e), registry);
    const unsubB = handleVpSubscribe((e) => b.push(e), registry);
    a.length = 0;
    b.length = 0;

    // A disconnects (WS close → unsubscribe).
    unsubA();

    // A subsequent broadcast only reaches B.
    registry.setVp(mkVp('__rc_bob__'));
    _broadcastChangeForTest({ added: ['__rc_bob__'], updated: [], removed: [] }, registry);

    expect(a).toHaveLength(0);
    expect(b.some(e => e.type === 'vp_updated' && e.vpId === '__rc_bob__')).toBe(true);

    unsubB();
  });

  it('resubscribing after full disconnect yields a correct snapshot + live-diff wiring', () => {
    const registry = new Registry();
    registry.setVp(mkVp('__rc_alice3__'));

    // Initial connection.
    const first = [];
    const unsub1 = handleVpSubscribe((e) => first.push(e), registry);
    unsub1();

    // Full bridge teardown — simulates agent-side cleanup on long disconnect.
    _resetVpBridgeForTest();
    // Re-seed registry after reset (caller owns registry state; bridge only
    // owns loader/subscribers/prev-state caches).
    registry.setVp(mkVp('__rc_alice3__'));

    // Simulated WS reconnect — brand new callback.
    const second = [];
    const unsub2 = handleVpSubscribe((e) => second.push(e), registry);
    expect(second[0].type).toBe('vp_snapshot');
    expect(second[0].vps.map(v => v.vpId)).toContain('__rc_alice3__');
    second.length = 0;

    // Post-reconnect live-diff works.
    registry.setVp(mkVp('__rc_bob2__'));
    _broadcastChangeForTest({ added: ['__rc_bob2__'], updated: [], removed: [] }, registry);
    expect(second.some(e => e.type === 'vp_updated' && e.vpId === '__rc_bob2__')).toBe(true);

    unsub2();
  });
});
