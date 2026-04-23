/**
 * vp-bridge-session-ready-ordering.test.js — task-339-followup (C2)
 *
 * Regression scenario: on a page refresh the frontend re-sends
 * `session_ready` → `unify_vp_subscribe`. Each subscribe after a reset
 * (e.g. `_resetVpBridgeForTest` mimicking a process-local teardown) must
 * produce a correctly ordered `vp_snapshot` before any live-diff events
 * are delivered, so the web client can build its store cleanly.
 *
 * Contract:
 *   - Snapshot is emitted exactly once per subscribe call, synchronously.
 *   - Snapshot arrives BEFORE any subsequent vp_updated / vp_removed
 *     events the live-diff path may emit for the same subscriber.
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

describe('task-339-followup C2: session_ready → subscribe ordering', () => {
  beforeEach(() => {
    _resetVpBridgeForTest();
  });

  afterEach(() => {
    _resetVpBridgeForTest();
  });

  it('snapshot is emitted synchronously before any subsequent live-diff event', () => {
    const registry = new Registry();
    registry.setVp(mkVp('__ord_alice__'));

    const events = [];
    const unsub = handleVpSubscribe((e) => events.push(e), registry);

    // At this point exactly one event must have been delivered, and it
    // must be a vp_snapshot (the session_ready→subscribe contract).
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('vp_snapshot');

    // A subsequent broadcast must arrive AFTER the snapshot (i.e. appended
    // to the events array). This guarantees the wire ordering that
    // frontend Pinia-store code relies on.
    registry.setVp(mkVp('__ord_bob__'));
    _broadcastChangeForTest({ added: ['__ord_bob__'], updated: [], removed: [] }, registry);

    expect(events.length).toBeGreaterThan(1);
    expect(events[0].type).toBe('vp_snapshot');
    expect(events.slice(1).some(e => e.type === 'vp_updated' && e.vpId === '__ord_bob__')).toBe(true);

    unsub();
  });

  it('after a full bridge reset, the next subscribe still produces a well-ordered snapshot', () => {
    // Simulates page refresh: the agent may have torn down its VP
    // subscription (see _vpUnsubscribe reset in web-bridge) between the
    // old session_ready and the new one. The new subscribe must re-emit
    // a fresh, correctly formatted snapshot — not rely on stale module
    // state from the previous cycle.
    const registryOld = new Registry();
    registryOld.setVp(mkVp('__old__'));
    const oldEvents = [];
    const unsubOld = handleVpSubscribe((e) => oldEvents.push(e), registryOld);
    unsubOld();

    // Full bridge reset — agent-side teardown.
    _resetVpBridgeForTest();

    const registryNew = new Registry();
    registryNew.setVp(mkVp('__new__'));
    const newEvents = [];
    const unsubNew = handleVpSubscribe((e) => newEvents.push(e), registryNew);

    expect(newEvents).toHaveLength(1);
    expect(newEvents[0].type).toBe('vp_snapshot');
    expect(newEvents[0].vps.map(v => v.vpId)).toContain('__new__');
    // Must NOT leak old cycle's subscriber state.
    expect(newEvents[0].vps.map(v => v.vpId)).not.toContain('__old__');

    unsubNew();
  });
});
