/**
 * task-330b — Routing metrics + fallback resolver tests.
 *
 * Spec coverage:
 *   - 5 reason taxonomy + counter increments
 *   - bounded recent ring buffer (50)
 *   - flushRoutingMetricsNow writes JSON file with expected schema
 *   - resolveFallbackTarget policy (PM pending, non-PM auto-forward, etc.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ROUTING_REASONS,
  recordRoutingEvent,
  flushRoutingMetricsNow,
  getRoutingMetricsSnapshot,
  _resetRoutingMetricsForTest,
} from '../../../agent/crew/routing-metrics.js';
import { resolveFallbackTarget } from '../../../agent/crew/routing-fallback.js';

function makeSession(overrides = {}) {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    sharedDir: null,
    decisionMaker: 'pm',
    roles: new Map([['pm', { name: 'pm' }], ['dev-1', { name: 'dev-1' }]]),
    ...overrides,
  };
}

describe('task-330b — routing-metrics', () => {
  let tmpDir;
  let session;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'crew-metrics-'));
    session = makeSession({ sharedDir: tmpDir });
  });

  afterEach(async () => {
    _resetRoutingMetricsForTest(session.id);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('exports the 5 canonical reasons frozen list', () => {
    expect(ROUTING_REASONS).toEqual([
      'missing-route',
      'parse-fail',
      'self-route',
      'state-stopped',
      'fallback-forward',
    ]);
    expect(Object.isFrozen(ROUTING_REASONS)).toBe(true);
  });

  it('records each reason and bumps the per-session counter', () => {
    for (const r of ROUTING_REASONS) {
      expect(recordRoutingEvent(session, r, { fromRole: 'pm' })).toBe(true);
    }
    const snap = getRoutingMetricsSnapshot(session);
    for (const r of ROUTING_REASONS) {
      expect(snap.counts[r]).toBe(1);
    }
    expect(snap.recent).toHaveLength(ROUTING_REASONS.length);
  });

  it('rejects unknown reasons without throwing or counting', () => {
    expect(recordRoutingEvent(session, 'not-a-reason', {})).toBe(false);
    const snap = getRoutingMetricsSnapshot(session);
    if (snap) {
      const total = Object.values(snap.counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    }
  });

  it('rejects null session gracefully', () => {
    expect(recordRoutingEvent(null, 'missing-route', {})).toBe(false);
    expect(recordRoutingEvent({}, 'missing-route', {})).toBe(false);
  });

  it('keeps recent ring bounded at 50', () => {
    for (let i = 0; i < 75; i++) {
      recordRoutingEvent(session, 'missing-route', { fromRole: 'pm', note: `e${i}` });
    }
    const snap = getRoutingMetricsSnapshot(session);
    expect(snap.recent.length).toBe(50);
    // Verify FIFO eviction: oldest 25 dropped, newest survives.
    expect(snap.recent[snap.recent.length - 1].note).toBe('e74');
    expect(snap.recent[0].note).toBe('e25');
    // Counter still reflects ALL events, not just retained ones.
    expect(snap.counts['missing-route']).toBe(75);
  });

  it('flushRoutingMetricsNow writes JSON with correct schema', async () => {
    recordRoutingEvent(session, 'self-route', { fromRole: 'pm', toRole: 'pm' });
    recordRoutingEvent(session, 'fallback-forward', { fromRole: 'dev-1', toRole: 'pm' });
    await flushRoutingMetricsNow(session);

    const file = join(tmpDir, 'context', 'routing-metrics.json');
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.lastFlushedAt).toBe('number');
    expect(parsed.counts['self-route']).toBe(1);
    expect(parsed.counts['fallback-forward']).toBe(1);
    expect(Array.isArray(parsed.recent)).toBe(true);
    expect(parsed.recent).toHaveLength(2);
    expect(parsed.recent[0]).toMatchObject({
      reason: 'self-route',
      fromRole: 'pm',
      toRole: 'pm',
    });
  });

  it('flush is a no-op when sharedDir is missing', async () => {
    const sessionNoDir = makeSession({ sharedDir: null });
    recordRoutingEvent(sessionNoDir, 'missing-route', {});
    // Should not throw.
    await flushRoutingMetricsNow(sessionNoDir);
    _resetRoutingMetricsForTest(sessionNoDir.id);
  });
});

describe('task-330b — resolveFallbackTarget policy', () => {
  const session = makeSession();

  it('missing-route + PM caller → null (no self-forward, even with active task)', () => {
    expect(resolveFallbackTarget(session, 'pm', 'missing-route', { hasActiveTask: true })).toBe(null);
    expect(resolveFallbackTarget(session, 'pm', 'missing-route', { hasRouteIntent: true })).toBe(null);
  });

  it('missing-route + non-PM caller with active task → PM (auto-forward)', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'missing-route', { hasActiveTask: true })).toBe('pm');
  });

  it('missing-route + non-PM caller with route intent only → PM', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'missing-route', { hasRouteIntent: true })).toBe('pm');
  });

  it('missing-route + non-PM caller with neither → null (pending)', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'missing-route', {})).toBe(null);
  });

  it('parse-fail → PM regardless of caller', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'parse-fail', {})).toBe('pm');
    expect(resolveFallbackTarget(session, 'pm', 'parse-fail', {})).toBe('pm');
  });

  it('self-route → null (rejected by §A; §B does not dispatch)', () => {
    expect(resolveFallbackTarget(session, 'pm', 'self-route', {})).toBe(null);
  });

  it('state-stopped → null (do not auto-resume here)', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'state-stopped', {})).toBe(null);
  });

  it('fallback-forward → PM', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'fallback-forward', {})).toBe('pm');
  });

  it('unknown reason → null', () => {
    expect(resolveFallbackTarget(session, 'dev-1', 'made-up', {})).toBe(null);
  });

  it('null session → null', () => {
    expect(resolveFallbackTarget(null, 'pm', 'parse-fail', {})).toBe(null);
  });
});

describe('task-330b — wiring (source-level: §B item 1 wired in role-output / routing)', () => {
  // Source-level guard: ensures the wiring lines aren't accidentally
  // removed in a future refactor. Cheap and stable.
  it('role-output.js imports recordRoutingEvent + resolveFallbackTarget', async () => {
    const src = await fs.readFile('agent/crew/role-output.js', 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/routing-metrics\.js['"]/);
    expect(src).toMatch(/from\s+['"]\.\/routing-fallback\.js['"]/);
    expect(src).toMatch(/recordRoutingEvent\s*\(\s*session\s*,\s*['"]fallback-forward['"]/);
    expect(src).toMatch(/recordRoutingEvent\s*\(\s*session\s*,\s*['"]parse-fail['"]/);
    expect(src).toMatch(/resolveFallbackTarget\s*\(\s*session\s*,\s*roleName\s*,\s*['"]missing-route['"]/);
  });

  it('routing.js records self-route and state-stopped metrics', async () => {
    const src = await fs.readFile('agent/crew/routing.js', 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/routing-metrics\.js['"]/);
    expect(src).toMatch(/recordRoutingEvent\s*\(\s*session\s*,\s*['"]self-route['"]/);
    expect(src).toMatch(/recordRoutingEvent\s*\(\s*session\s*,\s*['"]state-stopped['"]/);
  });

  it('PM no-auto-forward path is documented in role-output.js', async () => {
    const src = await fs.readFile('agent/crew/role-output.js', 'utf8');
    // Comment marker proving the §B item 2 contract is intentional.
    expect(src).toMatch(/PM no-auto-forward/);
    expect(src).toMatch(/no self-forward/);
  });

  it('task-330b marker present in source (traceability)', async () => {
    const sources = await Promise.all([
      fs.readFile('agent/crew/routing-metrics.js', 'utf8'),
      fs.readFile('agent/crew/routing-fallback.js', 'utf8'),
      fs.readFile('agent/crew/role-output.js', 'utf8'),
      fs.readFile('agent/crew/routing.js', 'utf8'),
    ]);
    for (const s of sources) expect(s).toMatch(/task-330b/);
  });
});
