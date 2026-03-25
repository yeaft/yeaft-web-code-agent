import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for Conductor Semaphore (global concurrency control).
 *
 * Replicates the Semaphore class from agent/conductor/semaphore.js
 * to avoid importing SDK/context side effects.
 */

// =====================================================================
// Replicate Semaphore for isolated testing
// =====================================================================

class Semaphore {
  constructor(max = 5) {
    this._max = max;
    this._current = 0;
    this._queue = [];
  }

  get current() { return this._current; }
  get max() { return this._max; }
  get waiting() { return this._queue.length; }

  acquire() {
    if (this._current < this._max) {
      this._current++;
      return Promise.resolve(this._createRelease());
    }
    return new Promise(resolve => {
      this._queue.push(() => {
        this._current++;
        resolve(this._createRelease());
      });
    });
  }

  tryAcquire() {
    if (this._current < this._max) {
      this._current++;
      return this._createRelease();
    }
    return null;
  }

  _createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._current--;
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        next();
      }
    };
  }
}

// =====================================================================
// Tests
// =====================================================================

describe('Semaphore', () => {
  let sem;

  beforeEach(() => {
    sem = new Semaphore(3);
  });

  describe('constructor', () => {
    it('should initialize with default max=5', () => {
      const s = new Semaphore();
      expect(s.max).toBe(5);
      expect(s.current).toBe(0);
      expect(s.waiting).toBe(0);
    });

    it('should accept custom max value', () => {
      const s = new Semaphore(10);
      expect(s.max).toBe(10);
    });

    it('should initialize with max=1 for mutex behavior', () => {
      const s = new Semaphore(1);
      expect(s.max).toBe(1);
    });
  });

  describe('acquire', () => {
    it('should acquire immediately when slots available', async () => {
      const release = await sem.acquire();
      expect(sem.current).toBe(1);
      expect(typeof release).toBe('function');
    });

    it('should track current count correctly after multiple acquires', async () => {
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();
      expect(sem.current).toBe(3);
    });

    it('should queue when all slots are taken', async () => {
      // Fill all 3 slots
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      // 4th should queue
      let resolved = false;
      const pending = sem.acquire().then(r => { resolved = true; return r; });

      // Give microtask a chance to resolve
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(sem.waiting).toBe(1);
    });

    it('should resolve queued acquire when a slot is released', async () => {
      const release1 = await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      let release4 = null;
      const pending = sem.acquire().then(r => { release4 = r; return r; });

      expect(sem.waiting).toBe(1);

      // Release one slot
      release1();

      // Queue should process
      await pending;
      expect(release4).not.toBeNull();
      expect(sem.current).toBe(3); // still 3: one released, one dequeued
      expect(sem.waiting).toBe(0);
    });

    it('should process queue in FIFO order', async () => {
      const sem1 = new Semaphore(1);
      const release1 = await sem1.acquire();

      const order = [];
      const p2 = sem1.acquire().then(r => { order.push(2); return r; });
      const p3 = sem1.acquire().then(r => { order.push(3); return r; });
      const p4 = sem1.acquire().then(r => { order.push(4); return r; });

      expect(sem1.waiting).toBe(3);

      // Release one by one
      release1();
      const r2 = await p2;
      expect(order).toEqual([2]);

      r2();
      const r3 = await p3;
      expect(order).toEqual([2, 3]);

      r3();
      await p4;
      expect(order).toEqual([2, 3, 4]);
    });

    it('should handle high concurrency queue', async () => {
      const sem1 = new Semaphore(1);
      const release = await sem1.acquire();

      const count = 20;
      const promises = [];
      for (let i = 0; i < count; i++) {
        promises.push(sem1.acquire());
      }

      expect(sem1.waiting).toBe(count);

      // Release the initial one, then chain releases
      release();
      for (let i = 0; i < count; i++) {
        const r = await promises[i];
        r();
      }

      expect(sem1.current).toBe(0);
      expect(sem1.waiting).toBe(0);
    });
  });

  describe('release', () => {
    it('should decrement current count', async () => {
      const release = await sem.acquire();
      expect(sem.current).toBe(1);
      release();
      expect(sem.current).toBe(0);
    });

    it('should be idempotent (double release is safe)', async () => {
      const release = await sem.acquire();
      expect(sem.current).toBe(1);
      release();
      expect(sem.current).toBe(0);
      release(); // second call should be no-op
      expect(sem.current).toBe(0);
    });

    it('should not go below zero on double release', async () => {
      const release = await sem.acquire();
      release();
      release();
      release(); // triple call
      expect(sem.current).toBe(0);
    });

    it('should dequeue next waiter on release', async () => {
      const sem1 = new Semaphore(1);
      const release1 = await sem1.acquire();

      let secondAcquired = false;
      const p2 = sem1.acquire().then(r => { secondAcquired = true; return r; });

      expect(secondAcquired).toBe(false);
      release1();
      await p2;
      expect(secondAcquired).toBe(true);
      expect(sem1.current).toBe(1);
    });
  });

  describe('tryAcquire', () => {
    it('should return release function when slots available', () => {
      const release = sem.tryAcquire();
      expect(typeof release).toBe('function');
      expect(sem.current).toBe(1);
    });

    it('should return null when no slots available', async () => {
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();
      const result = sem.tryAcquire();
      expect(result).toBeNull();
      expect(sem.current).toBe(3);
    });

    it('should not add to queue when failing', async () => {
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();
      sem.tryAcquire();
      expect(sem.waiting).toBe(0);
    });

    it('should work correctly after release makes slot available', async () => {
      const r1 = await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      expect(sem.tryAcquire()).toBeNull();

      r1();
      const r4 = sem.tryAcquire();
      expect(r4).not.toBeNull();
      expect(sem.current).toBe(3);
    });

    it('release from tryAcquire should be idempotent', () => {
      const release = sem.tryAcquire();
      expect(sem.current).toBe(1);
      release();
      expect(sem.current).toBe(0);
      release();
      expect(sem.current).toBe(0);
    });
  });

  describe('getters', () => {
    it('should report waiting count accurately', async () => {
      const sem1 = new Semaphore(1);
      await sem1.acquire();

      expect(sem1.waiting).toBe(0);
      sem1.acquire(); // will queue
      expect(sem1.waiting).toBe(1);
      sem1.acquire(); // will queue
      expect(sem1.waiting).toBe(2);
    });

    it('should report max correctly', () => {
      expect(sem.max).toBe(3);
    });

    it('should report current correctly through lifecycle', async () => {
      expect(sem.current).toBe(0);
      const r1 = await sem.acquire();
      expect(sem.current).toBe(1);
      const r2 = await sem.acquire();
      expect(sem.current).toBe(2);
      r1();
      expect(sem.current).toBe(1);
      r2();
      expect(sem.current).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle max=0 gracefully (always queues)', () => {
      const s = new Semaphore(0);
      let resolved = false;
      s.acquire().then(() => { resolved = true; });
      // Cannot resolve since max is 0
      expect(s.waiting).toBe(1);
      expect(s.current).toBe(0);
    });

    it('should handle rapid acquire-release cycles', async () => {
      for (let i = 0; i < 100; i++) {
        const release = await sem.acquire();
        release();
      }
      expect(sem.current).toBe(0);
      expect(sem.waiting).toBe(0);
    });

    it('should handle concurrent acquire-release with interleaving', async () => {
      const releases = [];
      for (let i = 0; i < 3; i++) {
        releases.push(await sem.acquire());
      }

      // Release in reverse order
      releases[2]();
      releases[0]();
      releases[1]();

      expect(sem.current).toBe(0);
    });

    it('should interleave acquire and tryAcquire correctly', async () => {
      const r1 = await sem.acquire();
      const r2 = sem.tryAcquire();
      const r3 = await sem.acquire();

      expect(sem.current).toBe(3);
      expect(sem.tryAcquire()).toBeNull(); // full

      r2();
      expect(sem.current).toBe(2);
      const r4 = sem.tryAcquire();
      expect(r4).not.toBeNull();
      expect(sem.current).toBe(3);
    });
  });
});
