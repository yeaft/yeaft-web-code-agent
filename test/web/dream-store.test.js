/**
 * Tests for web/stores/dream.js — DESIGN-v2 §19.1–19.3.
 *
 * Pinia is loaded via CDN in the browser (web/index.html), so it isn't
 * an npm dep. We install a minimal Options-API-compatible shim onto
 * globalThis.Pinia before importing the store module.
 */

import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Minimal `defineStore({ state, getters, actions })` shim that supports
 * the patterns used by web/stores/dream.js:
 *  - state: () => ({...})
 *  - getters: { name(state) { ... } }
 *  - actions: { foo() { this.x = 1; ... } }
 * Each call to the returned `useStore()` builds a fresh instance per
 * active "pinia" (we just track one active pinia at a time).
 */
function makePiniaShim() {
  let active = null;
  function createPinia() {
    return { stores: new Map() };
  }
  function setActivePinia(p) { active = p; }
  function defineStore(name, opts) {
    return function useStore() {
      if (!active) throw new Error('No active pinia');
      if (active.stores.has(name)) return active.stores.get(name);
      const s = opts.state ? opts.state() : {};
      // Bind actions onto the instance.
      if (opts.actions) {
        for (const [k, fn] of Object.entries(opts.actions)) {
          s[k] = fn.bind(s);
        }
      }
      // Define getters as accessor properties on the instance.
      if (opts.getters) {
        for (const [k, fn] of Object.entries(opts.getters)) {
          Object.defineProperty(s, k, {
            get() { return fn(s); },
            enumerable: true,
            configurable: true,
          });
        }
      }
      active.stores.set(name, s);
      return s;
    };
  }
  return { createPinia, setActivePinia, defineStore };
}

globalThis.Pinia = makePiniaShim();

const { useDreamStore, DEFAULT_HISTORY_CAP } = await import('../../web/stores/dream.js');

function freshStore() {
  const fresh = globalThis.Pinia.createPinia();
  globalThis.Pinia.setActivePinia(fresh);
  return useDreamStore();
}

describe('useDreamStore — initial state', () => {
  it('starts idle with no current run, no history, no errors', () => {
    const s = freshStore();
    expect(s.status).toBe('idle');
    expect(s.currentRun).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.lastError).toBeNull();
    expect(s.lastRunAt).toBeNull();
    expect(s.isRunning).toBe(false);
    expect(s.isCoolingDown).toBe(false);
  });
});

describe('applyProgress — phase=start', () => {
  it('moves status to running and creates a fresh currentRun', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start', manual: true, ts: '2026-04-28T12:00:00.000Z' });
    expect(s.status).toBe('running');
    expect(s.isRunning).toBe(true);
    expect(s.currentRun).toBeTruthy();
    expect(s.currentRun.startedAt).toBe('2026-04-28T12:00:00.000Z');
    expect(s.currentRun.manual).toBe(true);
    expect(s.currentRun.phase).toBe('start');
    expect(s.currentRun.groups).toEqual({});
    expect(s.currentRun.targets).toEqual({});
  });

  it('clears prior lastError on new start', () => {
    const s = freshStore();
    s.lastError = 'previous boom';
    s.applyProgress({ phase: 'start', manual: false });
    expect(s.lastError).toBeNull();
  });
});

describe('applyProgress — phase=load-diff / triage', () => {
  it('records loading then triaging then triaged for a group', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'load-diff', groupId: 'g1' });
    expect(s.currentRun.groups.g1.status).toBe('loading');

    s.applyProgress({ phase: 'triage', groupId: 'g1', status: 'running', segments: 4 });
    expect(s.currentRun.groups.g1.status).toBe('triaging');
    expect(s.currentRun.groups.g1.segments).toBe(4);

    s.applyProgress({ phase: 'triage', groupId: 'g1', status: 'done', actions: 7 });
    expect(s.currentRun.groups.g1.status).toBe('triaged');
    expect(s.currentRun.groups.g1.actions).toBe(7);
  });

  it('surfaces triage errors via lastError', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'triage', groupId: 'g1', status: 'error', error: 'LLM 500' });
    expect(s.currentRun.groups.g1.status).toBe('error');
    expect(s.currentRun.groups.g1.error).toBe('LLM 500');
    expect(s.lastError).toMatch(/triage\[g1\].*LLM 500/);
  });
});

describe('applyProgress — phase=apply', () => {
  it('records applying then done with action label', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'apply', target: 'group/foo', kind: 'memory', sources: 3, status: 'running' });
    expect(s.currentRun.targets['group/foo'].status).toBe('applying');
    expect(s.currentRun.targets['group/foo'].kind).toBe('memory');
    expect(s.currentRun.targets['group/foo'].sources).toBe(3);

    s.applyProgress({ phase: 'apply', target: 'group/foo', status: 'done', action: 'merged' });
    expect(s.currentRun.targets['group/foo'].status).toBe('done');
    expect(s.currentRun.targets['group/foo'].action).toBe('merged');
  });

  it('surfaces apply errors via lastError', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'apply', target: 'feature/x', status: 'error', error: 'write failed' });
    expect(s.currentRun.targets['feature/x'].status).toBe('error');
    expect(s.lastError).toMatch(/apply\[feature\/x\].*write failed/);
  });
});

describe('applyProgress — phase=done', () => {
  it('moves currentRun → history, sets cooling-down, records lastRunAt', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start', manual: true });
    s.applyProgress({ phase: 'load-diff', groupId: 'g1' });
    s.applyProgress({
      phase: 'done',
      durationMs: 1234,
      groups: [{ groupId: 'g1', new: 5, status: 'done' }],
      targets: [{ target: 'group/g1', kind: 'memory', status: 'done' }],
      pruned: 2,
    });
    expect(s.currentRun).toBeNull();
    expect(s.status).toBe('cooling-down');
    expect(s.isCoolingDown).toBe(true);
    expect(s.history).toHaveLength(1);
    expect(s.history[0].durationMs).toBe(1234);
    expect(s.history[0].pruned).toBe(2);
    expect(s.history[0].manual).toBe(true);
    expect(s.history[0].groups).toHaveLength(1);
    expect(s.history[0].targets).toHaveLength(1);
    expect(s.lastRunAt).toBeTruthy();
    s._clearCoolingTimer();
  });

  it('caps history ring at DEFAULT_HISTORY_CAP', () => {
    const s = freshStore();
    for (let i = 0; i < DEFAULT_HISTORY_CAP + 5; i++) {
      s.applyProgress({ phase: 'start' });
      s.applyProgress({ phase: 'done', durationMs: i });
      s._clearCoolingTimer();
    }
    expect(s.history).toHaveLength(DEFAULT_HISTORY_CAP);
    // Most recent first — durationMs from the LAST iteration is at history[0].
    expect(s.history[0].durationMs).toBe(DEFAULT_HISTORY_CAP + 4);
  });

  it('synthesises a stub run if done arrives without start', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'done', durationMs: 99 });
    expect(s.history).toHaveLength(1);
    expect(s.history[0].durationMs).toBe(99);
    s._clearCoolingTimer();
  });
});

describe('getters — currentGroupsList / currentTargetsList', () => {
  it('returns sorted arrays from the live run', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'load-diff', groupId: 'b-group' });
    s.applyProgress({ phase: 'load-diff', groupId: 'a-group' });
    s.applyProgress({ phase: 'apply', target: 'z/1', status: 'running' });
    s.applyProgress({ phase: 'apply', target: 'a/1', status: 'running' });

    const groups = s.currentGroupsList;
    expect(groups.map(g => g.groupId)).toEqual(['a-group', 'b-group']);
    const targets = s.currentTargetsList;
    expect(targets.map(t => t.target)).toEqual(['a/1', 'z/1']);
  });

  it('returns empty arrays when idle', () => {
    const s = freshStore();
    expect(s.currentGroupsList).toEqual([]);
    expect(s.currentTargetsList).toEqual([]);
  });
});

describe('actions — clearHistory / unknown phases', () => {
  it('clearHistory empties the ring', () => {
    const s = freshStore();
    s.applyProgress({ phase: 'start' });
    s.applyProgress({ phase: 'done' });
    s._clearCoolingTimer();
    expect(s.history).toHaveLength(1);
    s.clearHistory();
    expect(s.history).toEqual([]);
  });

  it('ignores unknown phases without throwing', () => {
    const s = freshStore();
    expect(() => s.applyProgress({ phase: 'who-knows' })).not.toThrow();
    expect(() => s.applyProgress(null)).not.toThrow();
    expect(() => s.applyProgress('not an object')).not.toThrow();
    expect(s.status).toBe('idle');
  });
});
