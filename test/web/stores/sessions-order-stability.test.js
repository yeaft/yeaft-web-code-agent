/**
 * sessions-order-stability.test.js
 *
 * Regression tests for fix-yeaft-session-list-and-menu Bug 1.
 *
 * Before this fix, sessions store's `applySnapshot` would always
 * physically slot the current agent's rows AFTER all other agents'
 * rows when receiving a per-agent snapshot. Switching agents or
 * receiving a roster delta echo would re-group the sidebar and break
 * the user's mental map of "where session X lives in the list".
 *
 * New rule: positional identity is per-id, not per-agent. Any id
 * already in `sessionOrder` keeps its slot. Only ids that are
 * genuinely new (this is the first snapshot they appear in) get
 * appended at the end, in the order the snapshot delivers them.
 *
 * Also covers sidebar activation order:
 *   pinned rows render first, while selecting an unpinned row mutates
 *   sessionOrder by insertion-at-front instead of swapping with the
 *   previously active row.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// --- minimal Pinia / window / localStorage shim (same as the
// existing sessions-store-last-viewed test).
let lastViewedValue = null;
let pinnedSessions = [];
let pinnedLocalStorage = '[]';
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
// Provide a fake useChatStore so sessions.js's sort and pin-mirror
// paths both have something to read/write.
// applyServerPinSnapshot mirrors web/stores/chat.js's real action —
// the test owns localStorage persistence (via the localStorage shim
// below) so this duplicates the production add/remove/persist logic.
globalThis.Pinia.useChatStore = () => ({
  get pinnedSessions() { return pinnedSessions; },
  set pinnedSessions(v) { pinnedSessions = v; },
  isSessionPinned(id) { return pinnedSessions.includes(id); },
  applyServerPinSnapshot(agentId, pinnedInSnapshot, isOwnedByAgent) {
    const existing = new Set(pinnedSessions);
    const toAdd = [];
    for (const id of pinnedInSnapshot) {
      if (!existing.has(id)) toAdd.push(id);
    }
    if (toAdd.length > 0) pinnedSessions = [...toAdd, ...pinnedSessions];
    if (agentId) {
      pinnedSessions = pinnedSessions.filter(id => {
        if (!isOwnedByAgent(id)) return true;
        return pinnedInSnapshot.has(id);
      });
    }
    globalThis.localStorage.setItem('pinned-sessions', JSON.stringify(pinnedSessions));
  },
});
globalThis.localStorage = {
  getItem: (k) => {
    if (k === 'lastViewedYeaftSession') return lastViewedValue;
    if (k === 'pinned-sessions') return pinnedLocalStorage;
    return null;
  },
  setItem: (k, v) => {
    if (k === 'lastViewedYeaftSession') lastViewedValue = v;
    if (k === 'pinned-sessions') pinnedLocalStorage = v;
  },
  removeItem: (k) => {
    if (k === 'lastViewedYeaftSession') lastViewedValue = null;
    if (k === 'pinned-sessions') pinnedLocalStorage = '[]';
  },
};

const { useSessionsStore } = await import('../../../web/stores/sessions.js');

function makeStore() {
  const schema = useSessionsStore();
  const state = schema.state();
  const store = { ...state };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  // Expose getters as a method that runs against `store` so tests can
  // call `store.runGetter('sessionList')` and exercise the real
  // implementation against current state.
  store.runGetter = (name) => schema.getters[name](store);
  return store;
}

describe('sessions store — order stability across cross-agent snapshots (Bug 1)', () => {
  beforeEach(() => {
    lastViewedValue = null;
    pinnedSessions = [];
    pinnedLocalStorage = '[]';
  });

  it('initial snapshot establishes order', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    expect(s.sessionOrder).toEqual(['s1', 's2', 's3']);
  });

  it('second agent appends to the end without disturbing first agent rows', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    s.applySnapshot([{ id: 's4' }, { id: 's5' }], 'agent_B');
    expect(s.sessionOrder).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('re-applying a snapshot from the same agent does NOT shuffle existing rows', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    s.applySnapshot([{ id: 's4' }, { id: 's5' }], 'agent_B');
    // Agent A re-pushes with internal reorder + same ids. Order MUST stay
    // [s1, s2, s3, s4, s5] — known ids hold their slot.
    s.applySnapshot([{ id: 's2' }, { id: 's1' }, { id: 's3' }], 'agent_A');
    expect(s.sessionOrder).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('a brand-new id in an agent snapshot is appended at the end of the list', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }], 'agent_A');
    s.applySnapshot([{ id: 's3' }], 'agent_B');
    // Agent A adds s_new — it MUST go to the end of the whole list
    // (not slot 0, not between A's rows).
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's_new' }], 'agent_A');
    expect(s.sessionOrder).toEqual(['s1', 's2', 's3', 's_new']);
  });

  it('an id dropped from an agent snapshot is removed; other rows preserve order', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    s.applySnapshot([{ id: 's4' }], 'agent_B');
    // Agent A drops s2.
    s.applySnapshot([{ id: 's1' }, { id: 's3' }], 'agent_A');
    expect(s.sessionOrder).toEqual(['s1', 's3', 's4']);
  });

  it('two-agent dance: switching back and forth does not reshuffle', () => {
    const s = makeStore();
    // Agent A first
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }], 'agent_A');
    // Agent B comes online
    s.applySnapshot([{ id: 'b1' }, { id: 'b2' }], 'agent_B');
    // User switches focus — A re-broadcasts unchanged
    s.applySnapshot([{ id: 'a1' }, { id: 'a2' }], 'agent_A');
    // B re-broadcasts unchanged
    s.applySnapshot([{ id: 'b1' }, { id: 'b2' }], 'agent_B');
    expect(s.sessionOrder).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});

describe('sessions store — sessionList getter sort', () => {
  beforeEach(() => {
    lastViewedValue = null;
    pinnedSessions = [];
    pinnedLocalStorage = '[]';
  });

  it('with no pinned and no active, returns sessions in sessionOrder', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    s.activeSessionId = null;
    const ids = s.runGetter('sessionList').map(x => x.id);
    expect(ids).toEqual(['s1', 's2', 's3']);
  });

  it('selecting an unpinned session inserts it at the top instead of swapping', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    s.setActive('s3');
    expect(s.sessionOrder).toEqual(['s3', 's1', 's2']);
    s.setActive('s2');
    expect(s.sessionOrder).toEqual(['s2', 's3', 's1']);
    const ids = s.runGetter('sessionList').map(x => x.id);
    expect(ids).toEqual(['s2', 's3', 's1']);
  });

  it('pinned sessions come first; selecting unpinned inserts below pinned', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }], 'agent_A');
    pinnedSessions = ['s4'];
    s.setActive('s3');
    const ids = s.runGetter('sessionList').map(x => x.id);
    // pinned first (s4), then selected unpinned (s3), then the rest in preserved order.
    expect(ids).toEqual(['s4', 's3', 's1', 's2']);
    expect(s.sessionOrder).toEqual(['s3', 's1', 's2', 's4']);
  });

  it('active that is itself pinned does NOT double-shuffle', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1' }, { id: 's2' }, { id: 's3' }], 'agent_A');
    pinnedSessions = ['s2'];
    s.activeSessionId = 's2';
    const ids = s.runGetter('sessionList').map(x => x.id);
    // s2 is pinned → it's already first. Active-float must not move it.
    expect(ids).toEqual(['s2', 's1', 's3']);
  });
});

describe('sessions store — snapshot pin state mirrors into chatStore (Fix 3e)', () => {
  beforeEach(() => {
    lastViewedValue = null;
    pinnedSessions = [];
    pinnedLocalStorage = '[]';
  });

  it('snapshot pinned ids are added to chatStore.pinnedSessions', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1', pinned: true }, { id: 's2' }, { id: 's3', pinned: true }], 'agent_A');
    expect(pinnedSessions.sort()).toEqual(['s1', 's3']);
  });

  it('a snapshot that unpins an id removes it from chatStore.pinnedSessions', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1', pinned: true }, { id: 's2', pinned: true }], 'agent_A');
    expect(pinnedSessions.sort()).toEqual(['s1', 's2']);
    // Server unpins s2 — re-snapshot says s2 is no longer pinned.
    s.applySnapshot([{ id: 's1', pinned: true }, { id: 's2' }], 'agent_A');
    expect(pinnedSessions).toEqual(['s1']);
  });

  it('does NOT remove pins owned by another agent when snapshotting agent A', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 'a1', pinned: true }], 'agent_A');
    s.applySnapshot([{ id: 'b1', pinned: true }], 'agent_B');
    expect(pinnedSessions.sort()).toEqual(['a1', 'b1']);
    // Re-snapshot agent A — must NOT touch b1's pin.
    s.applySnapshot([{ id: 'a1', pinned: true }], 'agent_A');
    expect(pinnedSessions.sort()).toEqual(['a1', 'b1']);
  });

  it('persists pinnedSessions to localStorage after mirror', () => {
    const s = makeStore();
    s.applySnapshot([{ id: 's1', pinned: true }], 'agent_A');
    expect(JSON.parse(pinnedLocalStorage)).toEqual(['s1']);
  });
});
