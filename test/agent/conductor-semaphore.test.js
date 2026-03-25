/**
 * Tests for Conductor V5 — semaphore.js
 *
 * Covers: Semaphore acquire/release, tryAcquire, max concurrency,
 *         queue behavior, double-release protection
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Replicate Semaphore class ───────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────

describe('Semaphore — basic acquire/release', () => {
  let sem;
  beforeEach(() => { sem = new Semaphore(3); });

  it('should start with 0 current', () => {
    expect(sem.current).toBe(0);
  });

  it('should acquire immediately when under limit', async () => {
    const release = await sem.acquire();
    expect(sem.current).toBe(1);
    release();
    expect(sem.current).toBe(0);
  });

  it('should allow up to max concurrent acquires', async () => {
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const r3 = await sem.acquire();
    expect(sem.current).toBe(3);
    r1(); r2(); r3();
    expect(sem.current).toBe(0);
  });

  it('should queue when at max capacity', async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) releases.push(await sem.acquire());
    expect(sem.current).toBe(3);
    expect(sem.waiting).toBe(0);

    let fourthResolved = false;
    const fourthPromise = sem.acquire().then(r => { fourthResolved = true; return r; });
    expect(sem.waiting).toBe(1);
    expect(fourthResolved).toBe(false);

    releases[0]();
    const r4 = await fourthPromise;
    expect(fourthResolved).toBe(true);
    expect(sem.current).toBe(3);
    r4();
    releases[1](); releases[2]();
    expect(sem.current).toBe(0);
  });
});

describe('Semaphore — tryAcquire', () => {
  it('should return release function when available', () => {
    const sem = new Semaphore(1);
    const r = sem.tryAcquire();
    expect(r).toBeTypeOf('function');
    expect(sem.current).toBe(1);
    r();
    expect(sem.current).toBe(0);
  });

  it('should return null when at capacity', () => {
    const sem = new Semaphore(1);
    sem.tryAcquire();
    const r2 = sem.tryAcquire();
    expect(r2).toBeNull();
  });
});

describe('Semaphore — double release protection', () => {
  it('should ignore second release call', async () => {
    const sem = new Semaphore(2);
    const r = await sem.acquire();
    expect(sem.current).toBe(1);
    r();
    expect(sem.current).toBe(0);
    r(); // double release
    expect(sem.current).toBe(0); // should NOT go to -1
  });
});

describe('Semaphore — queue ordering (FIFO)', () => {
  it('should process queue in order', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const order = [];

    const p2 = sem.acquire().then(r => { order.push(2); return r; });
    const p3 = sem.acquire().then(r => { order.push(3); return r; });

    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();

    expect(order).toEqual([2, 3]);
  });
});

describe('Semaphore — properties', () => {
  it('should expose max, current, waiting', () => {
    const sem = new Semaphore(7);
    expect(sem.max).toBe(7);
    expect(sem.current).toBe(0);
    expect(sem.waiting).toBe(0);
  });
});
