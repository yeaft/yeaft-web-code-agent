/**
 * web-bridge-default-vp-resolution.test.js — PR-G regression guard.
 *
 * The bug this guards against:
 *   PR-A (v0.1.598) wired persona-as-identity into the engine. The engine
 *   regression test proved that *given* a vpPersona, the system prompt
 *   speaks as the VP. But the live web-bridge caller `buildVpQueryOpts`
 *   returned `undefined` whenever no vpId was on the inbound message —
 *   which is exactly what the legacy `unify_chat` (no-group) path and the
 *   coordinator-fallback paths did. Engine therefore got `vpPersona:
 *   undefined` and fell back to the legacy "Yeaft — AI Companion"
 *   identity in production, even though every engine-level test was green.
 *
 *   Option A fix: when no vpId is supplied, resolve a default in this
 *   order — group's defaultVpId → session config → first library VP →
 *   undefined (cold-start). The Yeaft identity is now reachable only when
 *   the VP library is empty.
 *
 *   This test exercises `buildVpQueryOpts` directly and covers each
 *   resolution branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock readVp + scanVpLibrary so the resolver is deterministic without
// needing a populated ~/.yeaft/virtual-persons on disk. The mocks live at
// the same path web-bridge imports them from.
vi.mock('../../agent/unify/vp/vp-crud.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    readVp: vi.fn((vpId) => ({
      vpId,
      displayName: vpId === 'linus' ? 'Linus' : vpId,
      role: vpId === 'linus' ? 'kernel hacker' : 'tester',
      persona: `You are ${vpId}.`,
    })),
  };
});

vi.mock('../../agent/unify/vp/vp-store.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    scanVpLibrary: vi.fn(() => [
      { vpId: 'linus', displayName: 'Linus', role: 'kernel hacker', persona: '' },
      { vpId: 'grace', displayName: 'Grace', role: 'compiler pioneer', persona: '' },
    ]),
  };
});

import { buildVpQueryOpts } from '../../agent/unify/web-bridge.js';

describe('PR-G — buildVpQueryOpts resolves a default VP when none is supplied', () => {
  it('uses caller-supplied vpId when present (legacy behaviour preserved)', () => {
    const out = buildVpQueryOpts({ vpId: 'grace' });
    expect(out).toBeDefined();
    expect(out.senderVpId).toBe('grace');
    expect(out.vpPersona).toBeDefined();
    expect(out.vpPersona.displayName).toBe('grace');
  });

  it("falls back to group's defaultVpId when caller did not supply vpId", () => {
    const groupCoordinator = {
      group: { getMeta: () => ({ defaultVpId: 'linus', roster: ['linus', 'grace'] }) },
    };
    const out = buildVpQueryOpts({ vpId: null, groupCoordinator, groupId: 'g-1' });
    expect(out).toBeDefined();
    expect(out.senderVpId).toBe('linus');
    expect(out.vpPersona.displayName).toBe('Linus');
    expect(out.vpPersona.role).toBe('kernel hacker');
    expect(out.groupId).toBe('g-1');
  });

  it('falls back to first library VP when no vpId, no group, no config', () => {
    const out = buildVpQueryOpts({ vpId: null });
    expect(out).toBeDefined();
    // First library entry per scanVpLibrary mock is `linus`.
    expect(out.senderVpId).toBe('linus');
    expect(out.vpPersona.displayName).toBe('Linus');
  });

  it('returns undefined only when the VP library is empty (cold start)', async () => {
    const store = await import('../../agent/unify/vp/vp-store.js');
    store.scanVpLibrary.mockReturnValueOnce([]);
    const out = buildVpQueryOpts({ vpId: null });
    expect(out).toBeUndefined();
  });
});
