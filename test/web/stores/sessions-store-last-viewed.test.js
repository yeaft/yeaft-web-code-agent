/**
 * sessions-store-last-viewed.test.js
 *
 * Verifies the fix for the "switching agent / reload lands you on the
 * wrong yeaft session" bug. The sessions store, after applying a
 * snapshot, must prefer `lastViewedYeaftSession` from localStorage
 * over a blind `sessionOrder[0]` fall-back. Also exercises the
 * cross-agent retention path so an unrelated agent's snapshot does
 * not blow away another agent's rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';

let lastViewedValue = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = {
  getItem: (k) => (k === 'lastViewedYeaftSession' ? lastViewedValue : null),
  setItem: (k, v) => { if (k === 'lastViewedYeaftSession') lastViewedValue = v; },
  removeItem: (k) => { if (k === 'lastViewedYeaftSession') lastViewedValue = null; },
};

const { useSessionsStore } = await import('../../../web/stores/sessions.js');

function makeStore() {
  const schema = useSessionsStore();
  const state = schema.state();
  const store = { ...state };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  return store;
}

describe('sessions store — last-viewed restore + cross-agent retention', () => {
  beforeEach(() => { lastViewedValue = null; });

  it('per-agent snapshot keeps the other agent\'s sessions intact', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }], 'agent_1');
    s.applySnapshot([{ id: 'b1', name: 'B1' }], 'agent_2');
    expect(Object.keys(s.sessions).sort()).toEqual(['a1', 'a2', 'b1']);
    // Agent_2 snapshot must not drop agent_1's rows.
    s.applySnapshot([], 'agent_2');
    expect(Object.keys(s.sessions).sort()).toEqual(['a1', 'a2']);
  });

  it('prefers lastViewedYeaftSession over sessionOrder[0] when restoring active', () => {
    lastViewedValue = 'a2';
    const s = makeStore();
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], 'agent_1');
    expect(s.activeSessionId).toBe('a2');
  });

  it('falls back to sessionOrder[0] when lastViewed points at a missing session', () => {
    lastViewedValue = 'ghost';
    const s = makeStore();
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }], 'agent_1');
    expect(s.activeSessionId).toBe('a1');
  });

  it('falls back to sessionOrder[0] when no lastViewed memory exists', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }], 'agent_1');
    expect(s.activeSessionId).toBe('a1');
  });

  it('per-agent snapshot drops only that agent\'s missing rows on subsequent applies', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }], 'agent_1');
    s.applySnapshot([{ id: 'b1' }], 'agent_2');
    // agent_1 says a2 is gone now
    s.applySnapshot([{ id: 'a1' }], 'agent_1');
    expect(Object.keys(s.sessions).sort()).toEqual(['a1', 'b1']);
  });
});
