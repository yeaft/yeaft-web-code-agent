/**
 * task-334-ui-g — VP CRUD (filesystem) tests.
 *
 * Covers:
 *   (1) createVp happy path + role.md / memory dir layout
 *   (2) all six validateVpId rejection reasons bubble through
 *   (3) duplicate detection
 *   (4) updateVp rewrites role.md, preserves dir; not_found path
 *   (5) deleteVp removes dir + path-traversal safety
 *   (6) readVp round-trip (traits, modelHint, persona body)
 *   (7) buildRoleMd YAML quoting rules (colons, leading dashes, whitespace)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  createVp, updateVp, deleteVp, readVp, buildRoleMd, VpCrudError,
} from '../../../../agent/unify/vp/vp-crud.js';
import { parseRoleMd } from '../../../../agent/unify/vp/vp-store.js';

describe('vp-crud', () => {
  let libDir;

  beforeEach(() => {
    libDir = mkdtempSync(join(tmpdir(), 'yeaft-vp-crud-'));
  });
  afterEach(() => {
    rmSync(libDir, { recursive: true, force: true });
  });

  describe('createVp', () => {
    it('writes role.md + memory/ at <lib>/<vpId>/', () => {
      const res = createVp({
        vpId: 'alice',
        displayName: 'Alice',
        role: 'PM',
        traits: ['curious', 'pragmatic'],
        modelHint: 'primary',
        persona: 'Alice is a friendly PM.',
      }, { libDir });

      expect(res.vpId).toBe('alice');
      expect(existsSync(join(libDir, 'alice', 'role.md'))).toBe(true);
      expect(existsSync(join(libDir, 'alice', 'memory'))).toBe(true);

      const src = readFileSync(join(libDir, 'alice', 'role.md'), 'utf-8');
      const { meta, body } = parseRoleMd(src);
      expect(meta.id).toBe('alice');
      expect(meta.name).toBe('Alice');
      expect(meta.role).toBe('PM');
      expect(meta.modelHint).toBe('primary');
      expect(meta.traits).toEqual(['curious', 'pragmatic']);
      expect(body).toContain('Alice is a friendly PM.');
    });

    it('rejects each of the six validateVpId reasons', () => {
      const cases = [
        ['', 'empty_or_non_string'],
        [null, 'empty_or_non_string'],
        ['a'.repeat(41), 'too_long'],
        ['bad id!', 'illegal_character'],
        ['_hidden', 'underscore_prefix_reserved'],
        ['12345', 'pure_digits'],
        ['system', 'reserved'],
      ];
      for (const [id, reason] of cases) {
        let err;
        try { createVp({ vpId: id, persona: 'x' }, { libDir }); }
        catch (e) { err = e; }
        expect(err, `expected throw for id=${JSON.stringify(id)}`).toBeInstanceOf(VpCrudError);
        expect(err.code).toBe(reason);
      }
    });

    it('throws duplicate when dir already exists', () => {
      createVp({ vpId: 'bob', persona: 'one' }, { libDir });
      let err;
      try { createVp({ vpId: 'bob', persona: 'two' }, { libDir }); }
      catch (e) { err = e; }
      expect(err).toBeInstanceOf(VpCrudError);
      expect(err.code).toBe('duplicate');
    });
  });

  describe('updateVp', () => {
    it('rewrites role.md without touching the dir layout', () => {
      createVp({ vpId: 'carol', displayName: 'Carol', persona: 'v1' }, { libDir });
      updateVp({ vpId: 'carol', displayName: 'Carol 2', persona: 'v2', role: 'Designer' }, { libDir });
      const vp = readVp('carol', { libDir });
      expect(vp.displayName).toBe('Carol 2');
      expect(vp.persona).toContain('v2');
      expect(vp.role).toBe('Designer');
      expect(existsSync(join(libDir, 'carol', 'memory'))).toBe(true);
    });

    it('throws not_found on missing id', () => {
      let err;
      try { updateVp({ vpId: 'ghost', persona: 'x' }, { libDir }); }
      catch (e) { err = e; }
      expect(err).toBeInstanceOf(VpCrudError);
      expect(err.code).toBe('not_found');
    });
  });

  describe('deleteVp', () => {
    it('removes the VP dir tree', () => {
      createVp({ vpId: 'dave', persona: 'p' }, { libDir });
      expect(existsSync(join(libDir, 'dave'))).toBe(true);
      deleteVp('dave', { libDir });
      expect(existsSync(join(libDir, 'dave'))).toBe(false);
    });

    it('refuses path-traversal inputs', () => {
      for (const bad of ['..', '.', 'foo/bar', 'foo\\bar']) {
        let err;
        try { deleteVp(bad, { libDir }); } catch (e) { err = e; }
        expect(err, `expected throw for ${JSON.stringify(bad)}`).toBeInstanceOf(VpCrudError);
        expect(err.code).toBe('illegal_character');
      }
    });

    it('throws not_found for missing id', () => {
      let err;
      try { deleteVp('never-existed', { libDir }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(VpCrudError);
      expect(err.code).toBe('not_found');
    });
  });

  describe('readVp', () => {
    it('round-trips full editable shape', () => {
      createVp({
        vpId: 'eve',
        displayName: 'Eve',
        role: 'QA',
        traits: ['rigorous', 'skeptical'],
        modelHint: 'fast',
        persona: 'Eve asks sharp questions.\nEve tests edge cases.',
      }, { libDir });
      const got = readVp('eve', { libDir });
      expect(got).toBeTruthy();
      expect(got.vpId).toBe('eve');
      expect(got.displayName).toBe('Eve');
      expect(got.role).toBe('QA');
      expect(got.traits).toEqual(['rigorous', 'skeptical']);
      expect(got.modelHint).toBe('fast');
      expect(got.persona).toContain('Eve asks sharp questions.');
      expect(got.persona).toContain('Eve tests edge cases.');
    });

    it('returns null for missing', () => {
      expect(readVp('nope', { libDir })).toBe(null);
    });
  });

  describe('buildRoleMd YAML quoting', () => {
    it('quotes values containing colons', () => {
      const md = buildRoleMd({ vpId: 'x', displayName: 'Title: big', role: '', persona: '' });
      expect(md).toContain('name: "Title: big"');
    });

    it('quotes values with leading dash', () => {
      const md = buildRoleMd({ vpId: 'x', displayName: '-lead', role: '', persona: '' });
      expect(md).toContain('name: "-lead"');
    });

    it('leaves plain values unquoted', () => {
      const md = buildRoleMd({ vpId: 'x', displayName: 'Alice', role: 'PM', persona: '' });
      expect(md).toContain('name: Alice');
      expect(md).toContain('role: PM');
    });

    it('omits empty traits / no modelHint cleanly', () => {
      const md = buildRoleMd({ vpId: 'x', displayName: 'x', role: '', persona: 'body' });
      expect(md).not.toContain('traits:');
      expect(md).not.toContain('modelHint:');
      expect(md).toContain('body');
    });
  });
});
