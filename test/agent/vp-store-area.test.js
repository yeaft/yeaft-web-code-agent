/**
 * vp-store-area.test.js — contract for the new `area` taxonomy field on the
 * VP record produced by `loadVpFromDir`.
 *
 * The field is additive: legacy role.md files written before this field
 * existed must still parse cleanly, with `area === ''` (NEVER null, NEVER
 * undefined, NEVER a default category). Consumers can rely on the string
 * type and treat '' as "uncategorised."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadVpFromDir, parseRoleMd, scanVpLibrary } from '../../agent/yeaft/vp/vp-store.js';
import { buildRoleMd } from '../../agent/yeaft/vp/vp-crud.js';

let tmpRoot;
let libDir;

function writeVp(id, roleMd) {
  const dir = join(libDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.md'), roleMd, 'utf-8');
  return dir;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vp-area-'));
  libDir = join(tmpRoot, 'vps');
  mkdirSync(libDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadVpFromDir — area frontmatter field', () => {
  it('returns area when role.md declares one', () => {
    const dir = writeVp(
      'kongzi',
      '---\nid: kongzi\nname: Confucius\nrole: Moral Philosopher\narea: philosophy\n---\nbody',
    );
    const vp = loadVpFromDir(dir);
    expect(vp).not.toBeNull();
    expect(vp.area).toBe('philosophy');
  });

  it('returns empty string when role.md has no area line (legacy)', () => {
    const dir = writeVp(
      'legacy',
      '---\nid: legacy\nname: Legacy\nrole: Old\n---\nbody',
    );
    const vp = loadVpFromDir(dir);
    expect(vp).not.toBeNull();
    expect(vp.area).toBe('');
    // Specifically a string — not null/undefined — so dispatch code can
    // safely compare against '' without type guards.
    expect(typeof vp.area).toBe('string');
  });

  it('trims whitespace around the area value', () => {
    const dir = writeVp(
      'untidy',
      '---\nid: untidy\nname: Untidy\nrole: r\narea:   investing   \n---\nbody',
    );
    const vp = loadVpFromDir(dir);
    expect(vp.area).toBe('investing');
  });
});

describe('buildRoleMd — area serialisation', () => {
  it('emits an area line when payload.area is set', () => {
    const md = buildRoleMd({
      vpId: 'buffett',
      displayName: 'Warren Buffett',
      role: 'Value Investor',
      area: 'investing',
      traits: ['moat'],
      persona: 'body',
    });
    expect(md).toMatch(/^area: investing$/m);
    const { meta } = parseRoleMd(md);
    expect(meta.area).toBe('investing');
  });

  it('omits the area line entirely when payload.area is missing or empty', () => {
    const mdMissing = buildRoleMd({
      vpId: 'plain',
      displayName: 'Plain',
      role: 'r',
      traits: [],
      persona: '',
    });
    const mdEmpty = buildRoleMd({
      vpId: 'plain',
      displayName: 'Plain',
      role: 'r',
      area: '',
      traits: [],
      persona: '',
    });
    expect(mdMissing).not.toMatch(/^area:/m);
    expect(mdEmpty).not.toMatch(/^area:/m);
  });

  it('round-trips area through buildRoleMd → parseRoleMd → loadVpFromDir', () => {
    const md = buildRoleMd({
      vpId: 'sunzi',
      displayName: 'Sun Tzu',
      role: 'Strategist',
      area: 'strategy',
      traits: ['shaping'],
      persona: 'body',
    });
    const dir = writeVp('sunzi', md);
    const vp = loadVpFromDir(dir);
    expect(vp.area).toBe('strategy');
  });
});

describe('scanVpLibrary — area surfaces through the library scan', () => {
  it('returns vps with their area fields populated', () => {
    writeVp(
      'a',
      '---\nid: a\nname: A\nrole: r\narea: philosophy\n---\nbody',
    );
    writeVp(
      'b',
      '---\nid: b\nname: B\nrole: r\n---\nbody',
    );
    const vps = scanVpLibrary({ dir: libDir });
    const byId = Object.fromEntries(vps.map(v => [v.id, v.area]));
    expect(byId.a).toBe('philosophy');
    expect(byId.b).toBe('');
  });
});
