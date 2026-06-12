/**
 * boot-catch-up-stale.test.js — fix/dream-cadence-and-ui-trigger.
 *
 * `bootCatchUpStaleDream` reads per-group `.dream-state` `lastDreamAt`,
 * picks the newest, and fires a single non-manual dream tick at boot if
 * that timestamp is older than DREAM_INTERVAL_HOURS (or absent and at
 * least one group has user traffic).
 *
 * The interval timer alone is not enough — production observed 12 days
 * between scheduled ticks. This catch-up gives a deterministic guarantee
 * independent of timer behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootCatchUpStaleDream } from '../../../../agent/yeaft/dream/session-wiring.js';
import { writeGroupState } from '../../../../agent/yeaft/dream/state.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';
import { DREAM_INTERVAL_HOURS } from '../../../../agent/yeaft/dream/limits.js';

let yeaftDir;

beforeEach(() => {
  yeaftDir = mkdtempSync(join(tmpdir(), 'boot-catch-up-'));
});
afterEach(() => {
  rmSync(yeaftDir, { recursive: true, force: true });
});

/** Fake scheduler that records every fire path used. */
function fakeScheduler() {
  const calls = { catchUp: 0, scope: [] };
  return {
    catchUpNudge: async () => { calls.catchUp += 1; return { ok: true }; },
    triggerDreamForScopes: async (scopeFilter) => { calls.scope.push(scopeFilter); },
    _calls: calls,
  };
}

/** Helper: seed a group dir with a single message so streamMessages() yields. */
function seedGroupWithMessage(id) {
  const sessionsRoot = join(yeaftDir, 'sessions');
  const h = createSession(sessionsRoot, { id, roster: [], defaultVpId: null });
  h.appendMessage({ from: 'user', text: 'hello' });
}

describe('bootCatchUpStaleDream', () => {
  it('returns no-op when scheduler is missing', async () => {
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: null });
    expect(r.fired).toBe(false);
    expect(r.stale).toBe(false);
  });

  it('returns no-op when there are no groups', async () => {
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.fired).toBe(false);
    expect(sched._calls.catchUp).toBe(0);
    expect(sched._calls.scope).toEqual([]);
  });

  it('returns no-op when groups exist but none have any user messages', async () => {
    const sessionsRoot = join(yeaftDir, 'sessions');
    createSession(sessionsRoot, { id: 'silent', roster: [], defaultVpId: null });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.fired).toBe(false);
    expect(r.stale).toBe(false);
  });

  it('fires when at least one group has user traffic but no .dream-state ever', async () => {
    seedGroupWithMessage('grp_fun');
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.stale).toBe(true);
    expect(r.lastDreamAt).toBeNull();
    expect(r.fired).toBe(true);
    // wait one tick for fire-and-forget
    await new Promise(resolve => setImmediate(resolve));
    expect(sched._calls.catchUp).toBe(1);
  });

  it('does NOT fire when newest lastDreamAt is fresh (within interval)', async () => {
    seedGroupWithMessage('grp_fun');
    // Stamped 30 minutes ago — well under the 1-hour interval.
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'grp_fun', { lastDreamAt: halfHourAgo });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.stale).toBe(false);
    expect(r.fired).toBe(false);
    expect(r.lastDreamAt).toBe(halfHourAgo);
    expect(sched._calls.catchUp).toBe(0);
  });

  it('fires when newest lastDreamAt is older than DREAM_INTERVAL_HOURS', async () => {
    seedGroupWithMessage('grp_fun');
    // 12 days ago — exactly the production scenario.
    const longAgo = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'grp_fun', { lastDreamAt: longAgo });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.stale).toBe(true);
    expect(r.fired).toBe(true);
    expect(r.lastDreamAt).toBe(longAgo);
    expect(r.ageMs).toBeGreaterThan(DREAM_INTERVAL_HOURS * 60 * 60 * 1000);
  });

  it('picks the NEWEST lastDreamAt across multiple groups', async () => {
    seedGroupWithMessage('a');
    seedGroupWithMessage('b');
    seedGroupWithMessage('c');
    const memRoot = join(yeaftDir, 'memory');
    await writeGroupState(memRoot, 'a', { lastDreamAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() });
    // Fresh — still under threshold.
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeGroupState(memRoot, 'b', { lastDreamAt: fresh });
    await writeGroupState(memRoot, 'c', { lastDreamAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.lastDreamAt).toBe(fresh);
    expect(r.stale).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('respects an explicit `now` argument (deterministic test override)', async () => {
    seedGroupWithMessage('grp_fun');
    const t0 = Date.parse('2026-05-09T00:00:00.000Z');
    const stamp = new Date(t0 - 12 * 24 * 60 * 60 * 1000).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'grp_fun', { lastDreamAt: stamp });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched, now: t0 });
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBe(12 * 24 * 60 * 60 * 1000);
  });

  it('boundary: exactly DREAM_INTERVAL_HOURS old is NOT stale (>, not >=)', async () => {
    seedGroupWithMessage('grp_fun');
    const intervalMs = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;
    const t0 = Date.parse('2026-05-09T00:00:00.000Z');
    const exactlyOnInterval = new Date(t0 - intervalMs).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'grp_fun', { lastDreamAt: exactlyOnInterval });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched, now: t0 });
    // age === interval → NOT stale (we want >, not >=, otherwise we
    // re-fire whenever the clock hits an exact tick boundary).
    expect(r.ageMs).toBe(intervalMs);
    expect(r.stale).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('boundary: one ms past DREAM_INTERVAL_HOURS IS stale', async () => {
    seedGroupWithMessage('grp_fun');
    const intervalMs = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;
    const t0 = Date.parse('2026-05-09T00:00:00.000Z');
    const justPast = new Date(t0 - intervalMs - 1).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'grp_fun', { lastDreamAt: justPast });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched, now: t0 });
    expect(r.stale).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('does NOT fire when there is no traffic, even if .dream-state is ancient', async () => {
    // Group exists, has a stale dream-state, but no user messages → nothing
    // to dream about. MIN_NEW_PER_GROUP would skip anyway, but we don't
    // even fire the tick.
    const sessionsRoot = join(yeaftDir, 'sessions');
    createSession(sessionsRoot, { id: 'silent', roster: [], defaultVpId: null });
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeGroupState(join(yeaftDir, 'memory'), 'silent', { lastDreamAt: longAgo });
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.fired).toBe(false);
    expect(r.stale).toBe(false);
    expect(sched._calls.catchUp).toBe(0);
  });

  it('fails closed when scheduler shim does not expose catchUpNudge', async () => {
    // PR #743 review (Martin): the previous behaviour fell back to
    // triggerDreamForScopes(), but that path routes through
    // v2.triggerNow() which sets manual:true and bypasses
    // MIN_NEW_PER_GROUP — directly contradicting the documented
    // contract of bootCatchUpStaleDream. We now refuse to substitute a
    // manual fire and report fired=false instead.
    seedGroupWithMessage('grp_fun');
    const calls = { scope: [] };
    const sched = {
      // Older shim — no catchUpNudge. triggerDreamForScopes is present
      // but MUST NOT be called by bootCatchUpStaleDream because its
      // semantics (manual=true) violate this code path's contract.
      triggerDreamForScopes: async (s) => { calls.scope.push(s); },
    };
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    expect(r.stale).toBe(true);
    expect(r.fired).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    // Crucially: we did NOT route through the manual path.
    expect(calls.scope).toEqual([]);
  });

  it('survives a corrupt .dream-state (per-group skip, no throw)', async () => {
    seedGroupWithMessage('grp_fun');
    // Write garbage instead of using writeGroupState.
    mkdirSync(join(yeaftDir, 'memory', 'group', 'grp_fun'), { recursive: true });
    writeFileSync(join(yeaftDir, 'memory', 'group', 'grp_fun', '.dream-state'), 'garbage\nlastDreamAt: not-a-date\n');
    const sched = fakeScheduler();
    const r = await bootCatchUpStaleDream({ yeaftDir, dreamScheduler: sched });
    // Date.parse('not-a-date') is NaN → newestAt stays null → stale (no record + traffic).
    expect(r.stale).toBe(true);
    expect(r.fired).toBe(true);
  });
});
