/**
 * seed-topup.test.js — contract for the existing-library top-up pass.
 *
 * Plan §4 acceptance:
 *   case 1: empty lib + no .seeded-versions.json → all defaults seeded, ledger has every id.
 *   case 2: lib has 12 legacy VPs + no ledger → missing defaults added, 12 untouched on disk.
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
  insertNameZhLine,
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

  it('includes the bilingual Omni Assistant generalist VP', () => {
    const omni = DEFAULT_VPS.find(vp => vp.vpId === 'omni');
    expect(omni).toBeDefined();
    expect(omni.displayName).toBe('Omni Assistant');
    expect(omni.displayNameZh).toBe('全能助手');
    expect(omni.role).toBe('All-Purpose Assistant');
    expect(omni.roleZh).toBe('全能助手');
    expect(omni.area).toBe('generalist');
    expect(omni.modelHint).toBe('primary');
    expect(omni.traits).toEqual(expect.arrayContaining([
      'cross-domain',
      'execution-focused',
      'honest',
      'safety-aware',
    ]));
    expect(omni.persona).toContain('Language policy / 语言策略');
    expect(omni.persona).toContain('Prefer Chinese when the user writes in Chinese');
    expect(omni.persona).toContain('prefer English when the user writes in English');
    expect(omni.persona).toContain('Tool use and verification');
    expect(omni.persona).toContain('Honest uncertainty');
    expect(omni.persona).toContain('Safety boundaries');
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

    // 12 should be marked existing; every other default should be newly added.
    expect(result.skippedExisting.length).toBe(12);
    expect(result.added.length).toBe(DEFAULT_VPS.length - 12);

    // Legacy bodies remain byte-identical (no area splice happens because
    // we wrote raw text, not frontmatter).
    for (const id of legacyIds) {
      const after = readFileSync(join(libDir, id, 'role.md'), 'utf-8');
      expect(after).toBe(legacyBodies.get(id));
    }

    // Ledger now records every default id: 12 as 'legacy', the rest with persona hashes.
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
  it('recreates missing stock defaults such as Omni even when an old ledger says they were seeded', () => {
    const ledger = { version: 1, seeded: { omni: 'abc12345', kongzi: 'def67890' } };
    writeFileSync(
      join(libDir, '.seeded-versions.json'),
      JSON.stringify(ledger, null, 2),
      'utf-8',
    );

    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.respectedDeletes).not.toContain('omni');
    expect(result.respectedDeletes).not.toContain('kongzi');
    expect(existsSync(join(libDir, 'omni', 'role.md'))).toBe(true);
    expect(existsSync(join(libDir, 'kongzi', 'role.md'))).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(['omni', 'kongzi']));

    const versions = readSeedVersions(libDir);
    expect(versions.seeded.omni).toMatch(/^[0-9a-f]{8}$/);
    expect(versions.seeded.kongzi).toMatch(/^[0-9a-f]{8}$/);
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
    // New file MUST contain area: business (steve's bucket) inside the
    // YAML frontmatter. nameZh: may also have been inserted by the
    // independent bilingual backfill pass — both lines land near `role:`
    // but their relative order is an implementation detail, so we only
    // assert presence within the frontmatter, not their adjacency.
    const fm = after.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    expect(fm[1]).toMatch(/^area: business$/m);
    expect(fm[1]).toMatch(/^role: Product Strategist$/m);
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

describe('topUpDefaultVps — nameZh backfill on legacy frontmatter', () => {
  it('inserts a nameZh line into a legacy role.md whose frontmatter lacks it, body unchanged', () => {
    // Simulate a pre-bilingual seed: `name:` present, `nameZh:` missing.
    // After top-up the file MUST carry the canonical Chinese display name
    // from DEFAULT_VPS while the user-edited persona body stays byte-identical.
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
    expect(result.nameZhBackfilled).toContain('steve');

    const after = readFileSync(join(libDir, 'steve', 'role.md'), 'utf-8');
    // Must now contain a nameZh: line. Value comes from DEFAULT_VPS.
    const steveDef = DEFAULT_VPS.find(v => v.vpId === 'steve');
    expect(steveDef?.displayNameZh).toBeTruthy();
    // The value contains non-ASCII so it will be quoted by insertFrontmatterLine.
    expect(after).toMatch(
      new RegExp(`nameZh:\\s*"?${steveDef.displayNameZh}"?`),
    );
    // Body MUST be unchanged byte-for-byte.
    expect(after).toContain('I am a user-edited persona body. Do NOT rewrite me.');
    // No accidental duplication of name.
    const nameCount = (after.match(/^name: Steve Jobs$/gm) || []).length;
    expect(nameCount).toBe(1);
  });

  it('does not re-insert nameZh on a re-run', () => {
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
    expect(second.nameZhBackfilled).not.toContain('linus');
  });

  it('backfills nameZh even when area is already present (independent passes)', () => {
    // A role.md that has area: but no nameZh: must still get nameZh inserted.
    // The two backfill passes are independent.
    const legacyRoleMd =
      '---\n' +
      'id: steve\n' +
      'name: Steve Jobs\n' +
      'role: Product Strategist\n' +
      'area: business\n' +
      '---\n' +
      '\nbody\n';
    writeRoleMd('steve', legacyRoleMd);

    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.nameZhBackfilled).toContain('steve');
    expect(result.areaBackfilled).not.toContain('steve');

    const after = readFileSync(join(libDir, 'steve', 'role.md'), 'utf-8');
    expect(after).toMatch(/nameZh:\s*/);
    // area: business must still appear exactly once.
    const areaCount = (after.match(/^area: business$/gm) || []).length;
    expect(areaCount).toBe(1);
  });
});

describe('insertNameZhLine — pure helper', () => {
  it('returns null when no frontmatter is present', () => {
    expect(insertNameZhLine('no frontmatter here', '史蒂夫·乔布斯')).toBe(null);
  });

  it('returns null when nameZh is already declared', () => {
    const src = '---\nid: x\nrole: y\nnameZh: 张三\n---\nbody';
    expect(insertNameZhLine(src, '李四')).toBe(null);
  });

  it('returns null when nameZh value is empty', () => {
    const src = '---\nid: x\nrole: y\n---\nbody';
    expect(insertNameZhLine(src, '   ')).toBe(null);
  });

  it('inserts the line after role: and preserves the rest, quoting non-ASCII', () => {
    const src = '---\nid: x\nname: X\nrole: Y\nmodelHint: primary\n---\nbody\n';
    const out = insertNameZhLine(src, '某某');
    // Non-ASCII triggers double-quoting by insertFrontmatterLine.
    expect(out).toBe(
      '---\nid: x\nname: X\nrole: Y\nnameZh: "某某"\nmodelHint: primary\n---\nbody\n',
    );
  });

  it('does not collide with `name:` — anchored at start-of-line', () => {
    // `nameZh` shares a prefix with `name`. The keyPattern must be
    // anchored so the helper does NOT mistake `name:` for `nameZh:`
    // and silently bail.
    const src = '---\nid: x\nname: Steve\nrole: Y\n---\nbody\n';
    const out = insertNameZhLine(src, '乔布斯');
    expect(out).not.toBe(null);
    expect(out).toContain('nameZh: "乔布斯"');
  });

  it('preserves CRLF line endings (Windows-authored role.md)', () => {
    const src = '---\r\nid: x\r\nrole: y\r\n---\r\nbody\r\n';
    const out = insertNameZhLine(src, '苏东坡');
    expect(out).toBe('---\r\nid: x\r\nrole: y\r\nnameZh: "苏东坡"\r\n---\r\nbody\r\n');
  });
});
