/**
 * engine-registry-maxconcurrent.test.js — task-318.
 *
 * Covers ThreadEngineRegistry's soft cap on concurrent live instances:
 *   - ensure() throws ERR_MAX_CONCURRENT_THREADS once the cap is hit
 *   - replacing a terminated slot for the same threadId does not
 *     count against the cap
 *   - setMaxConcurrent() updates the cap at runtime without
 *     terminating already-live instances
 *   - null / 0 / negative ⇒ unlimited
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadEngineRegistry } from '../../../agent/unify/threads/engine-registry.js';

// Minimal stub that satisfies the factory contract: must return an
// object with a `query()` method and a `terminated` boolean + `terminate()`.
function stubFactory() {
  return (threadId) => {
    const inst = {
      threadId,
      terminated: false,
      query: async function* () { /* no-op */ },
      terminate() { inst.terminated = true; },
    };
    return inst;
  };
}

describe('ThreadEngineRegistry — concurrent cap (task-318)', () => {
  let registry;
  beforeEach(() => {
    registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 3 });
  });

  it('allows ensure() up to the cap', () => {
    registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    expect(registry.listActive().length).toBe(3);
  });

  it('throws ERR_MAX_CONCURRENT_THREADS beyond the cap', () => {
    registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    let err;
    try { registry.ensure('thr-4'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('ERR_MAX_CONCURRENT_THREADS');
    expect(err.limit).toBe(3);
    expect(err.live).toBe(3);
  });

  it('replacing a terminated slot with the same threadId does NOT count as net-new', () => {
    const a = registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    a.terminate();
    // Re-ensure same threadId — should succeed even though 3/3 slots technically existed
    const fresh = registry.ensure('thr-1');
    expect(fresh.terminated).toBe(false);
    expect(registry.listActive().length).toBe(3);
  });

  it('terminating a live thread frees a slot', () => {
    const a = registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    // Would throw:
    expect(() => registry.ensure('thr-4')).toThrow(/limit reached/);
    a.terminate();
    // Now there's room
    const d = registry.ensure('thr-4');
    expect(d.terminated).toBe(false);
  });

  it('setMaxConcurrent() raises the cap at runtime', () => {
    registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    expect(() => registry.ensure('thr-4')).toThrow();
    registry.setMaxConcurrent(5);
    expect(registry.maxConcurrent).toBe(5);
    expect(() => registry.ensure('thr-4')).not.toThrow();
  });

  it('setMaxConcurrent() lowering does NOT terminate existing live instances', () => {
    registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    registry.setMaxConcurrent(1);
    // Existing 3 remain alive (cap only gates future ensure()).
    expect(registry.listActive().length).toBe(3);
    expect(() => registry.ensure('thr-new')).toThrow();
  });

  it('null / 0 / negative cap = unlimited', () => {
    for (const v of [null, 0, -1, undefined]) {
      const r = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: v });
      for (let i = 0; i < 10; i++) {
        r.ensure(`thr-${i}`);
      }
      expect(r.listActive().length).toBe(10);
    }
  });

  it('setMaxConcurrent(null) disables the cap', () => {
    registry.ensure('thr-1');
    registry.ensure('thr-2');
    registry.ensure('thr-3');
    registry.setMaxConcurrent(null);
    expect(registry.maxConcurrent).toBeNull();
    for (let i = 4; i < 20; i++) {
      registry.ensure(`thr-${i}`);
    }
    expect(registry.listActive().length).toBeGreaterThanOrEqual(10);
  });
});
