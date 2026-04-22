/**
 * vp-seed-defaults.test.js — task-337 tests.
 *
 * Covers:
 *   1. DEFAULT_VPS integrity (12 entries, all valid vpIds, required fields).
 *   2. Fresh seed creates all 12 VP directories + role.md + memory/.
 *   3. Idempotency: second call on a populated library is a no-op.
 *   4. Partial library: ANY existing directory suffices to skip.
 *   5. Persona bodies are non-trivial (multi-line, English-only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_VPS, seedDefaultVps } from '../../agent/unify/vp/seed-defaults.js';
import { validateVpId } from '../../agent/unify/groups/ids.js';

let libDir;

beforeEach(() => {
  libDir = mkdtempSync(join(tmpdir(), 'vp-seed-test-'));
});

afterEach(() => {
  try { rmSync(libDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('DEFAULT_VPS', () => {
  it('contains exactly 12 entries', () => {
    expect(DEFAULT_VPS).toHaveLength(12);
  });

  it('every vpId is valid and unique', () => {
    const seen = new Set();
    for (const vp of DEFAULT_VPS) {
      const v = validateVpId(vp.vpId);
      expect(v.ok, `vpId ${vp.vpId} must be valid: ${v.reason}`).toBe(true);
      expect(seen.has(vp.vpId), `duplicate vpId: ${vp.vpId}`).toBe(false);
      seen.add(vp.vpId);
    }
  });

  it('every entry has displayName, role, traits[], modelHint, persona', () => {
    for (const vp of DEFAULT_VPS) {
      expect(typeof vp.displayName).toBe('string');
      expect(vp.displayName.length).toBeGreaterThan(0);
      expect(typeof vp.role).toBe('string');
      expect(vp.role.length).toBeGreaterThan(0);
      expect(Array.isArray(vp.traits)).toBe(true);
      expect(vp.traits.length).toBeGreaterThan(0);
      expect(['primary', 'fast']).toContain(vp.modelHint);
      expect(typeof vp.persona).toBe('string');
      // Persona should be substantive (not a one-liner).
      expect(vp.persona.split('\n').length).toBeGreaterThanOrEqual(5);
      expect(vp.persona.length).toBeGreaterThan(200);
    }
  });

  it('personas are English-only (no CJK characters)', () => {
    const cjkRe = /[　-鿿]/;
    for (const vp of DEFAULT_VPS) {
      expect(cjkRe.test(vp.persona), `${vp.vpId} must be English-only`).toBe(false);
    }
  });
});

describe('seedDefaultVps — fresh library', () => {
  it('creates all 12 VPs when libDir does not exist', () => {
    const fresh = join(libDir, 'virtual-persons');
    const r = seedDefaultVps(fresh);
    expect(r.skipped).toBe(false);
    expect(r.seeded).toBe(12);
    expect(r.errors).toEqual([]);
    for (const vp of DEFAULT_VPS) {
      const roleMd = join(fresh, vp.vpId, 'role.md');
      expect(existsSync(roleMd), `${vp.vpId}/role.md should exist`).toBe(true);
      const memDir = join(fresh, vp.vpId, 'memory');
      expect(existsSync(memDir), `${vp.vpId}/memory should exist`).toBe(true);
      const content = readFileSync(roleMd, 'utf-8');
      expect(content).toContain(`id: ${vp.vpId}`);
      expect(content).toContain(vp.displayName);
    }
  });

  it('creates all 12 VPs when libDir exists but is empty', () => {
    mkdirSync(libDir, { recursive: true });
    const r = seedDefaultVps(libDir);
    expect(r.seeded).toBe(12);
    expect(r.skipped).toBe(false);
  });
});

describe('seedDefaultVps — idempotency', () => {
  it('second call is a no-op (skipped=true, seeded=0)', () => {
    const r1 = seedDefaultVps(libDir);
    expect(r1.seeded).toBe(12);

    const r2 = seedDefaultVps(libDir);
    expect(r2.skipped).toBe(true);
    expect(r2.seeded).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it('skips when ANY subdirectory exists (even user-authored non-seed)', () => {
    mkdirSync(join(libDir, 'my-custom-vp'), { recursive: true });
    const r = seedDefaultVps(libDir);
    expect(r.skipped).toBe(true);
    expect(r.seeded).toBe(0);
    // Confirm none of the default VPs were written.
    for (const vp of DEFAULT_VPS) {
      expect(existsSync(join(libDir, vp.vpId))).toBe(false);
    }
  });

  it('ignores hidden/dotfile entries when checking emptiness', () => {
    mkdirSync(libDir, { recursive: true });
    // A hidden file or dir (e.g. .DS_Store, .gitkeep) must not prevent seeding.
    writeFileSync(join(libDir, '.gitkeep'), '');
    const r = seedDefaultVps(libDir);
    expect(r.skipped).toBe(false);
    expect(r.seeded).toBe(12);
  });
});

describe('seedDefaultVps — error containment', () => {
  it('never throws even if libDir path is bogus', () => {
    // Point at a path that cannot be created (parent is a file).
    mkdirSync(libDir, { recursive: true });
    const filePath = join(libDir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const bogus = join(filePath, 'under-a-file');
    expect(() => seedDefaultVps(bogus)).not.toThrow();
  });
});
