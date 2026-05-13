/**
 * seed-topup.test.js — contract for the existing-library top-up pass.
 *
 * Plan §4 acceptance:
 *   case 1: empty lib + no .seeded-versions.json → all 32 seeded, ledger has 32.
 *   case 2: lib has 12 legacy VPs + no ledger → 20 new added, 12 untouched on disk.
 *   case 3: ledger has entry but VP not on disk → user deleted, do NOT recreate.
 *   case 4: user-edited role.md → body byte-identical after top-up.
 *   case 5: area backfill — legacy role.md gains `area: ...` line, body unchanged.
 *
 * Top-up MUST be additive: never overwrite a body, never recreate a deleted VP.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  topUpDefaultVps,
  readSeedVersions,
  insertAreaLine,
} from '../../agent/unify/vp/seed-topup.js';
import { DEFAULT_VPS } from '../../agent/unify/vp/seed-defaults.js';

let tmpRoot;
let libDir;

function writeRoleMd(id, body) {
  const dir = join(libDir, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'role.md'), body, 'utf-8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vp-topup-'));
  libDir = join(tmpRoot, 'vps');
  mkdirSync(libDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('topUpDefaultVps — empty library', () => {
  it('seeds every default VP and writes a ledger with one entry per id', () => {
    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.added.length).toBe(DEFAULT_VPS.length);

    for (const vp of DEFAULT_VPS) {
      expect(existsSync(join(libDir, vp.vpId, 'role.md'))).toBe(true);
    }

    const versions = readSeedVersions(libDir);
    for (const vp of DEFAULT_VPS) {
      expect(versions.seeded[vp.vpId]).toBeDefined();
    }
  });
});

describe('topUpDefaultVps — legacy 12-VP library, no ledger yet', () => {
  it('treats existing VPs as legacy, adds only the missing ones, never rewrites bodies', () => {
    // Simulate the old 12 default ids with hand-edited bodies. We do NOT
    // need a real frontmatter — the topup only cares whether role.md exists
    // and (for area backfill) whether `---` brackets are present.
    const legacyIds = [
      'steve', 'linus', 'martin', 'dieter', 'ada', 'grace',
      'alice', 'ken', 'margaret', 'shannon', 'alan', 'norman',
    ];
    const legacyBodies = new Map();
    for (const id of legacyIds) {
      // Plain text body (no frontmatter) — top-up must NOT touch this file.
      const body = `# Hand-written persona for ${id}\nThis user edited it.\n`;
      writeRoleMd(id, body);
      legacyBodies.set(id, body);
    }

    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);

    // 12 should be marked existing, 20 newly added.
    expect(result.skippedExisting.length).toBe(12);
    expect(result.added.length).toBe(DEFAULT_VPS.length - 12);

    // Legacy bodies remain byte-identical (no area splice happens because
    // we wrote raw text, not frontmatter).
    for (const id of legacyIds) {
      const after = readFileSync(join(libDir, id, 'role.md'), 'utf-8');
      expect(after).toBe(legacyBodies.get(id));
    }

    // Ledger now records all 32 ids: 12 as 'legacy', 20 with persona hash.
    const versions = readSeedVersions(libDir);
    for (const id of legacyIds) {
      expect(versions.seeded[id]).toBe('legacy');
    }
    for (const vp of DEFAULT_VPS) {
      if (legacyIds.includes(vp.vpId)) continue;
      expect(versions.seeded[vp.vpId]).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe('topUpDefaultVps — respects user deletes', () => {
  it('does NOT recreate a VP whose id is in the ledger but not on disk', () => {
    // Pre-populate the ledger as if we'd seeded kongzi before, then the
    // user deleted ~/.yeaft/virtual-persons/kongzi/ manually.
    const ledger = { version: 1, seeded: { kongzi: 'abc12345' } };
    writeFileSync(
      join(libDir, '.seeded-versions.json'),
      JSON.stringify(ledger, null, 2),
      'utf-8',
    );

    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.respectedDeletes).toContain('kongzi');
    expect(existsSync(join(libDir, 'kongzi', 'role.md'))).toBe(false);

    // The other 31 should have been seeded.
    expect(result.added.length).toBe(DEFAULT_VPS.length - 1);
  });
});

describe('topUpDefaultVps — area backfill on legacy frontmatter', () => {
  it('inserts an area line into a legacy role.md whose frontmatter lacks it, body unchanged', () => {
    // Build a minimal valid role.md for `steve` without an `area:` line,
    // and with a persona body the user has clearly edited.
    const legacyRoleMd =
      '---\n' +
      'id: steve\n' +
      'name: Steve Jobs\n' +
      'role: Product Strategist\n' +
      'modelHint: primary\n' +
      'traits:\n' +
      '  - minimalist\n' +
      '---\n' +
      '\n' +
      'I am a user-edited persona body. Do NOT rewrite me.\n';
    writeRoleMd('steve', legacyRoleMd);

    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.areaBackfilled).toContain('steve');

    const after = readFileSync(join(libDir, 'steve', 'role.md'), 'utf-8');
    // New file MUST contain area: business (steve's bucket) immediately
    // after role:.
    expect(after).toMatch(/role: Product Strategist\narea: business\n/);
    // Body MUST be unchanged byte-for-byte.
    expect(after).toContain('I am a user-edited persona body. Do NOT rewrite me.');
    // No accidental duplication of role/name/id.
    const idCount = (after.match(/^id: steve$/gm) || []).length;
    expect(idCount).toBe(1);
  });

  it('does not re-insert area on a re-run', () => {
    const legacyRoleMd =
      '---\n' +
      'id: linus\n' +
      'name: Linus Torvalds\n' +
      'role: Systems Engineer\n' +
      '---\n' +
      '\nbody\n';
    writeRoleMd('linus', legacyRoleMd);

    topUpDefaultVps(libDir);
    const first = readFileSync(join(libDir, 'linus', 'role.md'), 'utf-8');
    const second = topUpDefaultVps(libDir);
    const after = readFileSync(join(libDir, 'linus', 'role.md'), 'utf-8');
    expect(after).toBe(first);
    expect(second.areaBackfilled).not.toContain('linus');
  });
});

describe('insertAreaLine — pure helper', () => {
  it('returns null when no frontmatter is present', () => {
    expect(insertAreaLine('no frontmatter here', 'philosophy')).toBe(null);
  });

  it('returns null when area is already declared', () => {
    const src = '---\nid: x\nrole: y\narea: philosophy\n---\nbody';
    expect(insertAreaLine(src, 'philosophy')).toBe(null);
  });

  it('returns null when bucket is empty', () => {
    const src = '---\nid: x\nrole: y\n---\nbody';
    expect(insertAreaLine(src, '   ')).toBe(null);
  });

  it('inserts the line after role: and preserves the rest', () => {
    const src = '---\nid: x\nname: X\nrole: Y\nmodelHint: primary\n---\nbody\n';
    const out = insertAreaLine(src, 'science');
    expect(out).toBe(
      '---\nid: x\nname: X\nrole: Y\narea: science\nmodelHint: primary\n---\nbody\n',
    );
  });

  it('preserves CRLF line endings end-to-end (Windows-authored role.md)', () => {
    // The function detects CRLF by inspecting the YAML block and uses the
    // matching separator on output. A Windows-edited file must round-trip
    // without becoming a mixed-newline mess.
    const src = '---\r\nid: x\r\nrole: y\r\n---\r\nbody\r\n';
    const out = insertAreaLine(src, 'arts');
    expect(out).toBe('---\r\nid: x\r\nrole: y\r\narea: arts\r\n---\r\nbody\r\n');
    // No bare LF inside the frontmatter region.
    const fm = out.match(/^---\r\n([\s\S]*?)\r\n---/);
    expect(fm).not.toBeNull();
    expect(fm[1]).not.toMatch(/[^\r]\n/);
  });
});
