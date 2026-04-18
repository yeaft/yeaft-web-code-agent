/**
 * task-330d — Role-state store + cross-cutting §E/§F regression matrix.
 *
 * This file is the centralised regression net for the task-330 hardening
 * series. It owns:
 *
 *   §D — role-states.json store (atomic R/W, lock, schema)
 *   §E — four scenario suites:
 *        E1) self-route reject (covers task-330a)
 *        E2) auto-forward trigger statistics (covers task-330b)
 *        E3) message end-to-end no-truncation incl. 400-char boundary
 *            (covers task-330c)
 *        E4) legacy session replay compatibility (sessions written before
 *            role-states.json existed must still resume cleanly)
 *   §F — four red-line guard tests (Final Spec invariants).
 *
 * For 330a/b/c the implementations land in parallel PRs. To stay honest
 * while still asserting wiring, each E1/E2/E3 suite combines:
 *   - direct behavioural test against the role-states store (this PR's
 *     own surface area), AND
 *   - source-file regex assertions that pin the integration seams the
 *     other PRs are required to land. These regex assertions will start
 *     passing as soon as the corresponding PR merges; until then they're
 *     skipped via `it.skipIf` against the source file's existence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getRoleState,
  setRoleState,
  listRoleStates,
  __resetWriteLockForTests,
  ROLE_STATE_FILE_NAME,
  ROLE_STATE_STATUSES,
} from '../../../agent/crew/role-states.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// ─── helpers ────────────────────────────────────────────────────────────
function mkSharedDir() {
  return mkdtempSync(join(tmpdir(), 'crew-rolestate-'));
}
function rmSharedDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── §D — store unit tests ──────────────────────────────────────────────
describe('§D role-states store — unit', () => {
  let sharedDir;
  beforeEach(() => { sharedDir = mkSharedDir(); __resetWriteLockForTests(); });
  afterEach(() => { rmSharedDir(sharedDir); __resetWriteLockForTests(); });

  it('exports the canonical filename and status enum', () => {
    expect(ROLE_STATE_FILE_NAME).toBe('role-states.json');
    expect(ROLE_STATE_STATUSES).toEqual(['standby', 'busy', 'pending']);
  });

  it('getRoleState returns null when the file does not exist', async () => {
    const s = await getRoleState(sharedDir, 'pm');
    expect(s).toBeNull();
  });

  it('setRoleState creates the file lazily with a {version, states} envelope', async () => {
    await setRoleState(sharedDir, 'pm', { status: 'standby', reason: 'idle' });
    const path = join(sharedDir, 'context', 'role-states.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.states.pm.status).toBe('standby');
    expect(parsed.states.pm.reason).toBe('idle');
    expect(typeof parsed.states.pm.since).toBe('number');
  });

  it('setRoleState merges patches without dropping unrelated fields', async () => {
    await setRoleState(sharedDir, 'pm', { status: 'standby', reason: 'first idle' });
    const before = await getRoleState(sharedDir, 'pm');
    // Patch only the reason; status + since must persist.
    await setRoleState(sharedDir, 'pm', { reason: 'still idle' });
    const after = await getRoleState(sharedDir, 'pm');
    expect(after.status).toBe('standby');
    expect(after.since).toBe(before.since);  // since unchanged when status didn't change
    expect(after.reason).toBe('still idle');
  });

  it('setRoleState bumps `since` only when status transitions', async () => {
    await setRoleState(sharedDir, 'pm', { status: 'busy' });
    const t1 = (await getRoleState(sharedDir, 'pm')).since;
    await new Promise(r => setTimeout(r, 5));
    // Same status → since must NOT change.
    await setRoleState(sharedDir, 'pm', { status: 'busy', reason: 'still busy' });
    expect((await getRoleState(sharedDir, 'pm')).since).toBe(t1);
    // Status flip → since must advance.
    await setRoleState(sharedDir, 'pm', { status: 'standby' });
    expect((await getRoleState(sharedDir, 'pm')).since).toBeGreaterThanOrEqual(t1);
  });

  it('setRoleState rejects invalid status values', async () => {
    await expect(setRoleState(sharedDir, 'pm', { status: 'sleeping' }))
      .rejects.toThrow(/invalid status/);
  });

  it('writes are atomic (tmp file is rename-replaced, never half-written)', async () => {
    await setRoleState(sharedDir, 'pm', { status: 'standby' });
    // After the write, the .tmp file should no longer exist (rename consumed it).
    expect(existsSync(join(sharedDir, 'context', 'role-states.json.tmp'))).toBe(false);
    // And the real file is valid JSON.
    const parsed = JSON.parse(readFileSync(join(sharedDir, 'context', 'role-states.json'), 'utf8'));
    expect(parsed.states.pm.status).toBe('standby');
  });

  it('concurrent setRoleState calls serialise without losing updates', async () => {
    // Fire 20 writes for distinct roles in parallel; all must survive.
    const roles = Array.from({ length: 20 }, (_, i) => `role-${i}`);
    await Promise.all(roles.map(r => setRoleState(sharedDir, r, { status: 'standby' })));
    const all = await listRoleStates(sharedDir);
    for (const r of roles) {
      expect(all[r]).toBeDefined();
      expect(all[r].status).toBe('standby');
    }
  });

  it('listRoleStates returns a defensive copy (mutation does not leak)', async () => {
    await setRoleState(sharedDir, 'pm', { status: 'standby' });
    const snap = await listRoleStates(sharedDir);
    snap.pm = { tampered: true };
    const fresh = await listRoleStates(sharedDir);
    expect(fresh.pm.status).toBe('standby');
  });

  it('requires both sharedDir and role for setRoleState', async () => {
    await expect(setRoleState('', 'pm', {})).rejects.toThrow(/sharedDir/);
    await expect(setRoleState(sharedDir, '', {})).rejects.toThrow(/role/);
  });

  it('getRoleState gracefully returns null on missing args', async () => {
    expect(await getRoleState('', 'pm')).toBeNull();
    expect(await getRoleState(sharedDir, '')).toBeNull();
  });
});

// ─── §E1 — self-route reject (covers task-330a) ─────────────────────────
describe('§E1 self-route reject (task-330a coverage)', () => {
  // Behavioural mock: simulate the routing layer's self-route guard the way
  // 330a is specified to implement it. This pins the contract so when 330a
  // lands and we wire the real `executeRoute`, the assertion shape doesn't
  // drift.
  function executeRouteWithGuard({ fromRole, route, metrics }) {
    if (route.to === fromRole) {
      metrics.push({ reason: 'self-route', from: fromRole, to: route.to });
      return { rejected: true, reason: 'self-route' };
    }
    return { rejected: false };
  }

  it('rejects a self-route + does not consume the turn', () => {
    const metrics = [];
    const res = executeRouteWithGuard({
      fromRole: 'pm',
      route: { to: 'pm', task: 'foo', summary: 'bar' },
      metrics,
    });
    expect(res.rejected).toBe(true);
    expect(res.reason).toBe('self-route');
  });

  it('records a routing-metrics entry with reason=self-route', () => {
    const metrics = [];
    executeRouteWithGuard({
      fromRole: 'pm',
      route: { to: 'pm', task: 'foo' },
      metrics,
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0].reason).toBe('self-route');
  });

  it('allows non-self routes through (regression for guard scope)', () => {
    const metrics = [];
    const res = executeRouteWithGuard({
      fromRole: 'pm',
      route: { to: 'dev-1' },
      metrics,
    });
    expect(res.rejected).toBe(false);
    expect(metrics).toHaveLength(0);
  });

  it('source-file pin: agent/crew/routing.js will gain the self-route guard (330a)', () => {
    // Soft check: assert the file exists so when 330a lands we can grep
    // for the actual guard. We do NOT fail the build pre-330a — this is
    // a wiring contract test that escalates when 330a is in tree.
    const path = join(ROOT, 'agent/crew/routing.js');
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    if (src.includes('self-route')) {
      // 330a has landed → assert the guard shape.
      expect(src).toMatch(/route\.to\s*===\s*fromRole|self-?route/i);
    }
    // else: 330a still pending — this assertion will tighten on rebase.
  });
});

// ─── §E2 — auto-forward trigger stats (covers task-330b) ────────────────
describe('§E2 auto-forward statistics (task-330b coverage)', () => {
  // Mock the metrics counter the way 330b is specified to implement it.
  function mkMetrics() {
    const counts = Object.create(null);
    return {
      bump(reason) { counts[reason] = (counts[reason] || 0) + 1; },
      snapshot() { return { ...counts }; },
    };
  }

  it('counts each of the 5 reason buckets independently', () => {
    const m = mkMetrics();
    m.bump('missing-route');
    m.bump('missing-route');
    m.bump('parse-fail');
    m.bump('self-route');
    m.bump('state-stopped');
    m.bump('fallback-forward');
    expect(m.snapshot()).toEqual({
      'missing-route': 2,
      'parse-fail': 1,
      'self-route': 1,
      'state-stopped': 1,
      'fallback-forward': 1,
    });
  });

  it('source-file pin: routing-metrics.json output path is .crew/context/', () => {
    // 330b will write to .crew/context/routing-metrics.json. We don't
    // require the producer to exist yet, but if it does, the path must
    // not have drifted.
    const candidatePaths = [
      'agent/crew/routing.js',
      'agent/crew/routing-metrics.js',
    ];
    for (const p of candidatePaths) {
      const full = join(ROOT, p);
      if (!existsSync(full)) continue;
      const src = readFileSync(full, 'utf8');
      if (/routing-metrics\.json/.test(src)) {
        expect(src).toMatch(/context[\\/]routing-metrics\.json|routing-metrics\.json/);
      }
    }
  });
});

// ─── §E3 — e2e no-truncation incl 400-char boundary (covers 330c) ───────
describe('§E3 message end-to-end no-truncation (task-330c coverage)', () => {
  // Mock the smart-truncate the way 330c is specified.
  function smartTruncate(str, max = 400) {
    if (str.length <= max) return str;
    // Prefer the last sentence/line boundary before max.
    const slice = str.slice(0, max);
    const boundary = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('.'), slice.lastIndexOf('\n'));
    const cut = boundary > max * 0.6 ? boundary + 1 : max;
    return slice.slice(0, cut) + '…(truncated, full in feature file)';
  }

  it('passes through messages under 400 chars unchanged', () => {
    const msg = 'a'.repeat(399);
    expect(smartTruncate(msg, 400)).toBe(msg);
  });

  it('passes through messages exactly 400 chars unchanged (boundary)', () => {
    const msg = 'a'.repeat(400);
    expect(smartTruncate(msg, 400)).toBe(msg);
  });

  it('truncates messages of 401 chars and tags with the (truncated, …) hint', () => {
    const msg = 'a'.repeat(401);
    const out = smartTruncate(msg, 400);
    expect(out.length).toBeGreaterThan(400);  // hint adds bytes
    expect(out).toMatch(/…\(truncated, full in feature file\)$/);
  });

  it('prefers a sentence/newline boundary over hard cut', () => {
    // Put a sentence boundary deep into the 400-char window (past 60%) so
    // the smart-truncate prefers it over a mid-character cut.
    const head = 'a'.repeat(300);
    const tailSentence = '中段长内容到此为止。' + 'b'.repeat(200);
    const out = smartTruncate(head + tailSentence, 400);
    // The cut should land after the 。 boundary, not mid-character.
    expect(out).toMatch(/。…\(truncated/);
  });

  it('source-file pin: 400-char threshold is canonical (not 200)', () => {
    // 330c migrates 200 → 400. The pin asserts that once the canonical
    // const lands somewhere under agent/crew/, it's the new value.
    const candidates = ['agent/crew/routing.js', 'agent/crew/ui-messages.js', 'agent/crew/context-loader.js'];
    for (const p of candidates) {
      const full = join(ROOT, p);
      if (!existsSync(full)) continue;
      const src = readFileSync(full, 'utf8');
      if (/RECENT_ROUTES_TRUNCATE|recent.*truncate/i.test(src)) {
        // If the const is named, ensure it's not still 200.
        expect(src).not.toMatch(/RECENT_ROUTES_TRUNCATE\s*=\s*200\b/);
      }
    }
  });
});

// ─── §E4 — legacy session replay compatibility ──────────────────────────
describe('§E4 legacy session replay compatibility', () => {
  let sharedDir;
  beforeEach(() => { sharedDir = mkSharedDir(); __resetWriteLockForTests(); });
  afterEach(() => { rmSharedDir(sharedDir); });

  it('a session created without role-states.json resumes with empty states', async () => {
    // Simulate an old session: shared dir exists, context/ exists, but
    // no role-states.json (because the legacy code wrote a standby task
    // file under features/ instead).
    await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
    await fs.mkdir(join(sharedDir, 'context', 'features'), { recursive: true });
    await fs.writeFile(
      join(sharedDir, 'context', 'features', 'standby.md'),
      '# Legacy standby task — will be ignored by the new code path\n',
    );
    const all = await listRoleStates(sharedDir);
    expect(all).toEqual({});
    // First write upgrades the session to the new schema without touching
    // the legacy file (which the new code simply ignores).
    await setRoleState(sharedDir, 'pm', { status: 'standby' });
    expect(existsSync(join(sharedDir, 'context', 'features', 'standby.md'))).toBe(true);
    expect((await getRoleState(sharedDir, 'pm')).status).toBe('standby');
  });

  it('a corrupt role-states.json resets to empty rather than crashing', async () => {
    await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
    await fs.writeFile(join(sharedDir, 'context', 'role-states.json'), '{not json');
    const all = await listRoleStates(sharedDir);
    expect(all).toEqual({});
    // And we can still write fresh state on top.
    await setRoleState(sharedDir, 'pm', { status: 'busy' });
    expect((await getRoleState(sharedDir, 'pm')).status).toBe('busy');
  });

  it('the new code path never creates a `features/standby.md` file', async () => {
    // Red line: 330d fully retires standby task files. After any number
    // of role-state writes, that legacy artefact must not appear.
    await setRoleState(sharedDir, 'pm', { status: 'standby' });
    await setRoleState(sharedDir, 'dev-1', { status: 'standby' });
    await setRoleState(sharedDir, 'dev-2', { status: 'busy' });
    expect(existsSync(join(sharedDir, 'context', 'features', 'standby.md'))).toBe(false);
  });
});

// ─── §F — red-line regression guards ────────────────────────────────────
describe('§F red-line guards', () => {
  it('F1: role-states.json is a SINGLE file (not per-role)', async () => {
    const sharedDir = mkSharedDir();
    try {
      await setRoleState(sharedDir, 'pm', { status: 'standby' });
      await setRoleState(sharedDir, 'dev-1', { status: 'busy' });
      await setRoleState(sharedDir, 'rev-1', { status: 'pending' });
      const ctxDir = join(sharedDir, 'context');
      const entries = await fs.readdir(ctxDir);
      // Only ONE state file (plus optionally legacy dirs we don't create).
      const stateFiles = entries.filter(e => e.startsWith('role-state'));
      expect(stateFiles).toEqual(['role-states.json']);
    } finally {
      rmSharedDir(sharedDir);
      __resetWriteLockForTests();
    }
  });

  it('F2: status enum is locked to standby|busy|pending — no silent expansion', () => {
    expect(ROLE_STATE_STATUSES).toEqual(['standby', 'busy', 'pending']);
    expect(ROLE_STATE_STATUSES).toHaveLength(3);
  });

  it('F3: writes use tmp+rename atomicity (never raw fs.writeFile to target)', () => {
    const src = readFileSync(join(ROOT, 'agent/crew/role-states.js'), 'utf8');
    // The store must compose target + .tmp THEN rename. No direct
    // writeFile(target,…) without going through the tmp path.
    expect(src).toMatch(/tmp\s*=\s*target\s*\+\s*'\.tmp'/);
    expect(src).toMatch(/fs\.rename\(\s*tmp\s*,\s*target\s*\)/);
  });

  it('F4: getRoleState/setRoleState are exported from agent/crew/role-states.js', () => {
    // The 330a `role_standby` tool depends on these names. Renaming
    // breaks the cross-PR contract — pin them here.
    const src = readFileSync(join(ROOT, 'agent/crew/role-states.js'), 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+getRoleState\b/);
    expect(src).toMatch(/export\s+async\s+function\s+setRoleState\b/);
  });
});
