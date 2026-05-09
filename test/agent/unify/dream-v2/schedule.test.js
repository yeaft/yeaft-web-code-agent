/**
 * dream-v2/schedule.test.js — §10.2
 */

import { describe, it, expect, vi } from 'vitest';
import { createDreamScheduler } from '../../../../agent/unify/dream-v2/schedule.js';

describe('createDreamScheduler', () => {
  it('triggerNow forwards manual:true', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createDreamScheduler({ run });
    await sched.triggerNow();
    expect(run).toHaveBeenCalledWith({ manual: true, scopeFilter: undefined });
  });
  it('drops a tick when one is already in-flight', async () => {
    let resolveFirst;
    const run = vi.fn(async () => new Promise(r => { resolveFirst = r; }));
    const sched = createDreamScheduler({ run });
    const p1 = sched.triggerNow();
    const p2 = sched.triggerNow();   // dropped — re-uses the in-flight
    expect(run).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: true });
    await Promise.all([p1, p2]);
  });
  it('start/stop lifecycle is safe to call repeatedly', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createDreamScheduler({ run, intervalMs: 60_000 });
    sched.start();
    sched.start();
    sched.stop();
    sched.stop();
  });
  it('errors from run are swallowed (returned as { error })', async () => {
    const run = vi.fn(async () => { throw new Error('boom'); });
    const sched = createDreamScheduler({ run });
    const r = await sched.triggerNow();
    expect(r.error).toBe('boom');
  });
  it('start() unrefs the timer by default (CLI / one-shot path)', () => {
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createDreamScheduler({ run, intervalMs: 60_000 });
    const origSetInterval = global.setInterval;
    let captured = null;
    global.setInterval = vi.fn((fn, ms) => {
      const t = origSetInterval(fn, ms);
      t.unref = vi.fn(t.unref?.bind(t) || (() => {}));
      captured = t;
      return t;
    });
    try {
      sched.start();
      expect(captured.unref).toHaveBeenCalledTimes(1);
    } finally {
      sched.stop();
      global.setInterval = origSetInterval;
    }
  });
  it('start() does NOT unref when keepAlive=true (server path)', () => {
    const run = vi.fn(async () => ({ ok: true }));
    const sched = createDreamScheduler({ run, intervalMs: 60_000, keepAlive: true });
    const origSetInterval = global.setInterval;
    let captured = null;
    global.setInterval = vi.fn((fn, ms) => {
      const t = origSetInterval(fn, ms);
      t.unref = vi.fn(t.unref?.bind(t) || (() => {}));
      captured = t;
      return t;
    });
    try {
      sched.start();
      expect(captured.unref).not.toHaveBeenCalled();
    } finally {
      sched.stop();
      global.setInterval = origSetInterval;
    }
  });
});
