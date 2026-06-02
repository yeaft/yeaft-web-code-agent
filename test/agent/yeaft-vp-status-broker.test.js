/**
 * Tests for `agent/yeaft/vp-status-broker.js` — the in-memory broker
 * that emits authoritative per-VP status to the frontend.
 *
 * These tests collect events into an array (the broker's `send`
 * callback is injected), so no WebSocket / network is involved.
 */

import { describe, it, expect } from 'vitest';
import {
  createVpStatusBroker,
  VALID_STATES,
} from '../../agent/yeaft/vp-status-broker.js';

function makeBrokerWithSink() {
  const events = [];
  // Inject a fixed clock so we can assert `since` deterministically.
  let t = 1_700_000_000_000;
  const broker = createVpStatusBroker({
    send: (ev) => events.push(ev),
    now: () => ++t,
  });
  return { broker, events };
}

describe('vp-status-broker — basics', () => {
  it('rejects construction without a send callback', () => {
    expect(() => createVpStatusBroker({})).toThrow(/send/);
  });

  it('exposes the documented terminal state set', () => {
    // Frontend code reads from VALID_STATES — keep the set tight so a
    // typo in transition() can't sneak a new label past the row renderer.
    expect([...VALID_STATES].sort()).toEqual([
      'error',
      'idle',
      'streaming',
      'thinking',
      'tool',
      'typing',
    ]);
  });

  it('throws RangeError on an unknown state', () => {
    const { broker } = makeBrokerWithSink();
    expect(() =>
      broker.transition({ groupId: 'g1', vpId: 'v1', state: 'magic' })
    ).toThrow(RangeError);
  });

  it('ignores transitions without a vpId (defensive)', () => {
    const { broker, events } = makeBrokerWithSink();
    const changed = broker.transition({
      groupId: 'g1',
      vpId: '',
      state: 'thinking',
    });
    expect(changed).toBe(false);
    expect(events).toEqual([]);
  });
});

describe('vp-status-broker — dedup', () => {
  it('emits once per real transition, not per call', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'typing', turnId: 't1' });
    // Same state + same turnId → no event.
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'typing', turnId: 't1' });
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'typing', turnId: 't1' });
    expect(events.filter((e) => e.type === 'vp_status_changed').length).toBe(1);
  });

  it('re-emits when the same state arrives with a new turnId', () => {
    // Why: a fresh turn starts at the same label (`typing`) the previous
    // turn ended on; without re-emission the row's `since` stamp would
    // stick to the old turn's start time and the activity indicator
    // would look stuck.
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'typing', turnId: 't1' });
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'typing', turnId: 't2' });
    expect(events.filter((e) => e.type === 'vp_status_changed').length).toBe(2);
  });
});

describe('vp-status-broker — happy-path state machine', () => {
  it('walks idle → typing → thinking → streaming → tool → streaming → idle', () => {
    const { broker, events } = makeBrokerWithSink();
    const turnId = 'turn-A';
    const g = 'g1';
    const v = 'v1';

    broker.transition({ groupId: g, vpId: v, state: 'typing', turnId });
    broker.transition({ groupId: g, vpId: v, state: 'thinking', turnId });
    broker.transition({ groupId: g, vpId: v, state: 'streaming', turnId });
    broker.transition({ groupId: g, vpId: v, state: 'tool', turnId });
    broker.transition({ groupId: g, vpId: v, state: 'streaming', turnId });
    broker.settleIdle({ groupId: g, vpId: v });

    const states = events
      .filter((e) => e.type === 'vp_status_changed')
      .map((e) => e.state);
    expect(states).toEqual([
      'typing',
      'thinking',
      'streaming',
      'tool',
      'streaming',
      'idle',
    ]);
  });

  it('settleIdle is idempotent on a row already at idle', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g', vpId: 'v', state: 'thinking', turnId: 't1' });
    broker.settleIdle({ groupId: 'g', vpId: 'v' });
    const before = events.length;
    broker.settleIdle({ groupId: 'g', vpId: 'v' });
    expect(events.length).toBe(before);
  });
});

describe('vp-status-broker — error path', () => {
  it('records error as a regular state — caller is responsible for decay', () => {
    // The broker doesn't auto-decay; the web bridge wraps runVpTurn in a
    // try/finally that always settles to idle. This test pins the
    // contract: a manual error transition stays until the next call.
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g', vpId: 'v', state: 'streaming', turnId: 't1' });
    broker.transition({ groupId: 'g', vpId: 'v', state: 'error', turnId: 't1' });
    broker.settleIdle({ groupId: 'g', vpId: 'v' });
    const states = events
      .filter((e) => e.type === 'vp_status_changed')
      .map((e) => e.state);
    expect(states).toEqual(['streaming', 'error', 'idle']);
  });
});

describe('vp-status-broker — snapshot', () => {
  it('snapshot() returns one row per (groupId, vpId)', () => {
    const { broker } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'thinking', turnId: 't1' });
    broker.transition({ groupId: 'g1', vpId: 'v2', state: 'streaming', turnId: 't2' });
    broker.transition({ groupId: 'g2', vpId: 'v1', state: 'tool', turnId: 't3' });

    const all = broker.snapshot();
    expect(all).toHaveLength(3);
    const just_g1 = broker.snapshot('g1');
    expect(just_g1).toHaveLength(2);
    expect(new Set(just_g1.map((r) => r.vpId))).toEqual(new Set(['v1', 'v2']));
    expect(just_g1.every((r) => r.groupId === 'g1')).toBe(true);
  });

  it('broadcastSnapshot emits a single vp_status_snapshot event', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', state: 'streaming', turnId: 't1' });
    broker.transition({ groupId: 'g1', vpId: 'v2', state: 'thinking', turnId: 't1' });

    events.length = 0;
    broker.broadcastSnapshot();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('vp_status_snapshot');
    expect(events[0].groupId).toBe(null);
    expect(events[0].statuses).toHaveLength(2);
  });

  it('forget() drops a row so it does not haunt the next snapshot', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v-old', state: 'streaming', turnId: 't1' });
    broker.forget({ groupId: 'g1', vpId: 'v-old' });
    events.length = 0;
    broker.broadcastSnapshot({ groupId: 'g1' });
    expect(events[0].statuses).toEqual([]);
  });
});

describe('vp-status-broker — wire event shape', () => {
  it('vp_status_changed payload carries the documented fields', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({
      groupId: 'g1',
      vpId: 'v1',
      state: 'streaming',
      turnId: 't1',
    });
    expect(events[0]).toMatchObject({
      type: 'vp_status_changed',
      groupId: 'g1',
      vpId: 'v1',
      state: 'streaming',
      turnId: 't1',
    });
    expect(typeof events[0].since).toBe('number');
  });
});

describe('vp-status-broker — thread aggregate', () => {
  it('keeps one thread idle without clearing another running thread on the same VP', () => {
    const { broker, events } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', threadId: 'thr-a', state: 'streaming', turnId: 't-a', title: 'A' });
    broker.transition({ groupId: 'g1', vpId: 'v1', threadId: 'thr-b', state: 'tool', turnId: 't-b', title: 'B' });
    broker.settleIdle({ groupId: 'g1', vpId: 'v1', threadId: 'thr-a', title: 'A' });

    const last = events.filter((e) => e.type === 'vp_status_changed').at(-1);
    expect(last.vpId).toBe('v1');
    expect(last.state).toBe('tool');
    expect(last.runningThreadCount).toBe(1);
    expect(last.threads.map((t) => [t.threadId, t.status])).toEqual(expect.arrayContaining([
      ['thr-a', 'idle'],
      ['thr-b', 'tool'],
    ]));
  });

  it('snapshot emits aggregate rows with thread summaries', () => {
    const { broker } = makeBrokerWithSink();
    broker.transition({ groupId: 'g1', vpId: 'v1', threadId: 'thr-a', state: 'thinking', turnId: 't-a', title: 'A', messageCount: 2 });
    broker.transition({ groupId: 'g1', vpId: 'v1', threadId: 'thr-b', state: 'streaming', turnId: 't-b', title: 'B', messageCount: 3 });

    const [row] = broker.snapshot('g1');
    expect(row.state).toBe('streaming');
    expect(row.runningThreadCount).toBe(2);
    expect(row.threads).toHaveLength(2);
    expect(row.threads.map((t) => t.threadId)).toEqual(expect.arrayContaining(['thr-a', 'thr-b']));
    expect(row.threads.find((t) => t.threadId === 'thr-b')).toMatchObject({ title: 'B', messageCount: 3 });
  });
});
