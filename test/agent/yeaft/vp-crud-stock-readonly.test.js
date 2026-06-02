/**
 * vp-crud-stock-readonly.test.js — pin the contract that the 12+ seed VPs
 * shipped via `seed-defaults.js#DEFAULT_VPS` cannot be mutated through the
 * CRUD layer, even when the on-disk dir is present.
 *
 * The frontend disables Edit/Delete buttons for stock VPs, but a
 * misbehaving WS client could still send `yeaft_vp_update` / `yeaft_vp_delete`
 * for `steve` directly. These tests guard the SERVER-side refusal so
 * `~/.yeaft/virtual-persons/steve/role.md` cannot be silently rewritten.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createVp, updateVp, deleteVp, VpCrudError, buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { STOCK_VP_IDS } from '../../../agent/yeaft/vp/stock-ids.js';

let tmpRoot;
let libDir;
let memoryRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vp-stock-ro-'));
  libDir = join(tmpRoot, 'vps');
  memoryRoot = join(tmpRoot, 'memory');
  mkdirSync(libDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Seed a stock VP dir on disk so update / delete have a target to refuse against. */
function seedStockVpOnDisk(vpId, persona = 'original') {
  const dir = join(libDir, vpId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'role.md'),
    buildRoleMd({ vpId, displayName: vpId, role: 'stock', persona }),
    'utf-8',
  );
  return dir;
}

describe('vp-crud — stock VPs are immutable server-side', () => {
  it('STOCK_VP_IDS is a non-empty Set covering at least the original 12 seed VPs', () => {
    expect(STOCK_VP_IDS).toBeInstanceOf(Set);
    expect(STOCK_VP_IDS.size).toBeGreaterThanOrEqual(12);
    // Spot-check a couple of canonical seed ids.
    expect(STOCK_VP_IDS.has('steve')).toBe(true);
    expect(STOCK_VP_IDS.has('linus')).toBe(true);
  });

  it('updateVp throws stock_readonly for a stock vpId', () => {
    seedStockVpOnDisk('steve', 'original persona');

    expect(() =>
      updateVp({ vpId: 'steve', displayName: 'Hacked', persona: 'pwned' }, { libDir }),
    ).toThrow(VpCrudError);

    try {
      updateVp({ vpId: 'steve', displayName: 'Hacked', persona: 'pwned' }, { libDir });
    } catch (err) {
      expect(err).toBeInstanceOf(VpCrudError);
      expect(err.code).toBe('stock_readonly');
      expect(err.vpId).toBe('steve');
    }

    // role.md must NOT have been rewritten.
    const body = readFileSync(join(libDir, 'steve', 'role.md'), 'utf-8');
    expect(body).toContain('original persona');
    expect(body).not.toContain('pwned');
    expect(body).not.toContain('Hacked');
  });

  it('deleteVp throws stock_readonly for a stock vpId', () => {
    const dir = seedStockVpOnDisk('linus');

    expect(() => deleteVp('linus', { libDir, memoryRoot })).toThrow(VpCrudError);

    try {
      deleteVp('linus', { libDir, memoryRoot });
    } catch (err) {
      expect(err).toBeInstanceOf(VpCrudError);
      expect(err.code).toBe('stock_readonly');
      expect(err.vpId).toBe('linus');
    }

    // Dir must still exist on disk.
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'role.md'))).toBe(true);
  });

  it('user-authored (non-stock) VPs update and delete normally', () => {
    const customId = `custom_${Date.now()}`;
    expect(STOCK_VP_IDS.has(customId)).toBe(false);

    createVp(
      { vpId: customId, displayName: 'Custom', role: 'lead', persona: 'v1' },
      { libDir, memoryRoot },
    );
    // update OK
    updateVp(
      { vpId: customId, displayName: 'Custom 2', role: 'lead', persona: 'v2' },
      { libDir },
    );
    const after = readFileSync(join(libDir, customId, 'role.md'), 'utf-8');
    expect(after).toContain('v2');
    expect(after).toContain('Custom 2');

    // delete OK
    deleteVp(customId, { libDir, memoryRoot });
    expect(existsSync(join(libDir, customId))).toBe(false);
  });
});
