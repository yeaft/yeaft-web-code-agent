/**
 * vp-bridge-first-subscribe-replay.test.js — task-339-followup (C1)
 *
 * Regression scenario: the process-singleton VpLoader is lazily created on
 * the FIRST `handleVpSubscribe` call. Its `start()` scans disk once. If the
 * on-disk library changes between agent boot and the first subscribe (e.g.
 * `seedDefaultVps` writes 12 role.md files slightly after module import),
 * fs.watch is the only safety net — but `fs.watch` is unreliable across
 * platforms / bind-mounts / containers.
 *
 * Contract (this fix): on the FIRST subscribe against the PRODUCTION
 * default registry, the snapshot MUST reflect current disk, independent
 * of whether fs.watch has fired. A `rescanNow()` is invoked after
 * `VpLoader.start()` so late-written VPs are captured.
 *
 * Test-seed preservation: when the caller passes a CUSTOM registry (unit
 * tests seeding VPs manually, e.g. vp-bridge-live-diff.test.js), the
 * fresh-path rescan MUST NOT run — rescan against DEFAULT_VP_LIB_DIR
 * would wipe manually-seeded entries that don't exist on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleVpSubscribe,
  _resetVpBridgeForTest,
} from '../../agent/unify/vp/vp-bridge.js';
import { Registry, defaultRegistry } from '../../agent/unify/vp/registry.js';

function mkVp(id) {
  return {
    id,
    name: id.toUpperCase(),
    role: 'dev',
    traits: [],
    modelHint: null,
    persona: `p-${id}`,
    personaHash: `h-${id}`,
    dir: `/tmp/${id}`,
    memoryDir: `/tmp/${id}/memory`,
    mtimeMs: 1,
  };
}

function clearRegistry(r) {
  for (const vp of r.listVps()) r.removeVp(vp.id);
}

describe('task-339-followup C1: first-subscribe replay', () => {
  beforeEach(() => {
    _resetVpBridgeForTest();
    clearRegistry(defaultRegistry);
  });

  afterEach(() => {
    _resetVpBridgeForTest();
    clearRegistry(defaultRegistry);
  });

  it('first subscribe against a custom registry preserves manually-seeded VPs (no disk-scan side-effects on unrelated registries)', () => {
    // Guard: this is the test-seed preservation invariant. A custom
    // registry (non-defaultRegistry) must NOT see its manually-set entries
    // wiped by a rescan against DEFAULT_VP_LIB_DIR.
    const registry = new Registry();
    registry.setVp(mkVp('__custom_a__'));
    registry.setVp(mkVp('__custom_b__'));

    const events = [];
    const unsub = handleVpSubscribe((e) => events.push(e), registry);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('vp_snapshot');
    const ids = events[0].vps.map(v => v.vpId);
    // Using toContain (not toEqual) — disk may add real VPs via start()'s
    // scan, which is an unrelated concern. The invariant is only that
    // manually-seeded entries survive.
    expect(ids).toContain('__custom_a__');
    expect(ids).toContain('__custom_b__');

    unsub();
  });

  it('first subscribe against defaultRegistry emits a vp_snapshot (does not crash on empty or non-empty lib dir)', () => {
    // Production-safety: with the fresh-path rescan fix in place, the
    // bridge must still produce a well-formed snapshot regardless of
    // whether DEFAULT_VP_LIB_DIR exists / has entries / is empty.
    const events = [];
    const unsub = handleVpSubscribe((e) => events.push(e), defaultRegistry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('vp_snapshot');
    expect(typeof events[0].emptyLibrary).toBe('boolean');
    expect(Array.isArray(events[0].vps)).toBe(true);
    // Wire-format field mapping smoke-check on any entries present.
    for (const vp of events[0].vps) {
      expect(typeof vp.vpId).toBe('string');
      expect(typeof vp.displayName).toBe('string');
      expect(vp.id).toBeUndefined();
      expect(vp.name).toBeUndefined();
    }
    unsub();
  });
});
