import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VPS, seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { readSeedVersions, topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';
import { STOCK_VP_IDS } from '../../../agent/yeaft/vp/stock-ids.js';
import { buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { parseRoleMd, personaHash } from '../../../agent/yeaft/vp/vp-store.js';

// Captured from shipped 8c8c9cb, independent of the current definition builder.
// A historical prompt must remain exact, not silently follow the new prompt.
const SHIPPED_HASHES = {
  omni: ['c700054566339f25d3d28b1963af10d336e2f742d7499d3415ac7b729cc4eb04', '6d5bb1acc6c868003cf1f395f6e93d4456f906e93baf9cc638a53a3f6ed0ec3b'],
  'software-omni': ['4ed9faad698dcaa7fbbaac0e72d39bdfbe35f024779d004604dbe136a7cb64d1', '2a19b50a48af961565760f22d7863f39b4d470c0420907530a6ce03fc1c63e49'],
  'writing-omni': ['5030943685794545128cc4b5a3cb59ea9ff52d7a7e1474efd17f089326c5630c', '7bf389dd4982bbc1ebb4510a121741593448b8dcd82cde522c64947675fb6b80'],
  'short-video-omni': ['56ebea6b17bddaa8a6b8495107e6689113f1f65c91b83120b545b38fc3a28725', '57f0293ee6f709d175e2297961fe9c512c7751bdd647a918c13dd7fce0dab703'],
  'quant-omni': ['e833ddf2b7dc81786ce984b4d92be3d496228abe6ff677ba0569dc10541e37af', 'ea86fbe2c4624b022a7151a0e348a016ad9805f37706c7dedc28986d78ef8ebc'],
};
const PRIMARY_VPS = DEFAULT_VPS.filter(vp => Object.hasOwn(SHIPPED_HASHES, vp.vpId));
const OTHER_VPS = DEFAULT_VPS.filter(vp => !Object.hasOwn(SHIPPED_HASHES, vp.vpId));
const hash = value => createHash('sha256').update(value).digest('hex');
const shippedBody = (vp, format = 'bilingual') => vp.legacyPersonas.at(format === 'en' ? -2 : -1);

function shippedPayload(vp, format = 'bilingual') {
  const old = vp.legacyMetadata.at(-1);
  return {
    ...vp,
    displayName: old.name,
    displayNameZh: old.nameZh,
    role: old.role,
    roleZh: old.roleZh,
    description: old.description,
    descriptionZh: old.descriptionZh,
    aliases: old.aliases,
    persona: shippedBody(vp, format),
  };
}

let libDir;
const rolePath = vp => join(libDir, vp.vpId, 'role.md');
const readRole = vp => readFileSync(rolePath(vp), 'utf8');
function writeRole(vp, source) {
  mkdirSync(join(libDir, vp.vpId), { recursive: true });
  writeFileSync(rolePath(vp), source, 'utf8');
}
function snapshotLibrary() {
  return Object.fromEntries(readdirSync(libDir).sort().map(name => [name,
    readFileSync(name.startsWith('.') ? join(libDir, name) : join(libDir, name, 'role.md'), 'utf8'),
  ]));
}

beforeEach(() => { libDir = mkdtempSync(join(tmpdir(), 'yeaft-vp-defaults-')); });
afterEach(() => { rmSync(libDir, { recursive: true, force: true }); });

describe('stock VP scenario defaults', () => {
  it('seeds the entire shipped roster with compact bilingual assistants and preserves all other defaults', () => {
    expect(seedDefaultVps(libDir)).toEqual({ seeded: 41, skipped: false, errors: [] });
    expect(new Set(readdirSync(libDir))).toEqual(STOCK_VP_IDS);
    expect(hash(JSON.stringify(OTHER_VPS))).toBe('219e64b579d3aa06e7643798647157284e1a27b90a340b36ffb053a6afd6612e');
    for (const vp of DEFAULT_VPS) expect(readRole(vp)).toBe(buildRoleMd(vp));
    for (const vp of PRIMARY_VPS) {
      const old = vp.legacyMetadata.at(-1);
      expect(vp.aliases).toEqual(expect.arrayContaining([...old.aliases, old.name, vp.displayName, vp.displayNameZh]));
      expect(vp.personaEn.length).toBeLessThan(shippedBody(vp, 'en').length);
      expect(vp.personaZh.length).toBeLessThan(shippedBody(vp).split('<!-- lang:zh -->')[1].trim().length);
      expect(vp.persona).toContain(`<!-- lang:en -->\n\n${vp.personaEn}\n\n<!-- lang:zh -->\n\n${vp.personaZh}`);
      expect(vp.personaEn).toContain('skills');
      expect(vp.personaZh).toContain('skills');
      expect(hash(shippedBody(vp, 'en'))).toBe(SHIPPED_HASHES[vp.vpId][0]);
      expect(hash(shippedBody(vp))).toBe(SHIPPED_HASHES[vp.vpId][1]);
    }
    const before = Object.fromEntries(OTHER_VPS.map(vp => [vp.vpId, readRole(vp)]));
    expect(topUpDefaultVps(libDir).errors).toEqual([]);
    for (const vp of OTHER_VPS) expect(readRole(vp)).toBe(before[vp.vpId]);
    expect(seedDefaultVps(libDir)).toEqual({ seeded: 0, skipped: true, errors: [] });
  });

  it.each(['en', 'bilingual'])('upgrades exact shipped %s souls and official metadata on disk', format => {
    for (const vp of PRIMARY_VPS) writeRole(vp, buildRoleMd(shippedPayload(vp, format)));
    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.personaBackfilled.sort()).toEqual(PRIMARY_VPS.map(vp => vp.vpId).sort());
    for (const vp of PRIMARY_VPS) {
      const { meta, body } = parseRoleMd(readRole(vp));
      expect(body).toBe(vp.persona.trim());
      expect(meta).toMatchObject({
        name: vp.displayName, nameZh: vp.displayNameZh,
        role: vp.role, roleZh: vp.roleZh,
        description: vp.description, descriptionZh: vp.descriptionZh,
        aliases: vp.aliases,
      });
      expect(readSeedVersions(libDir).seeded[vp.vpId]).toBe(personaHash(vp.persona));
    }
  });

  it('keeps older Omni official history eligible without replacing user-owned fields', () => {
    const vp = PRIMARY_VPS.find(vp => vp.vpId === 'omni');
    const earliest = vp.legacyMetadata[0];
    const historicalBodies = [vp.legacyPersonaEn, vp.legacyPersona, ...vp.legacyPersonas.slice(0, -2)];
    for (const persona of historicalBodies) {
      let source = buildRoleMd({ ...vp, displayName: 'My helper', displayNameZh: earliest.nameZh,
        role: earliest.role, roleZh: earliest.roleZh, description: earliest.description,
        descriptionZh: earliest.descriptionZh, persona });
      source = source.replace('---\n\n', 'customSetting: keep-me\n---\n\n');
      writeRole(vp, source);
      expect(topUpDefaultVps(libDir).personaBackfilled).toContain('omni');
      const { meta, body } = parseRoleMd(readRole(vp));
      expect(body).toBe(vp.persona.trim());
      expect(meta).toMatchObject({ name: 'My helper', nameZh: vp.displayNameZh,
        role: vp.role, roleZh: vp.roleZh, description: vp.description,
        descriptionZh: vp.descriptionZh, customSetting: 'keep-me' });
    }
  });

  it('is byte-idempotent after migration, including the ledger and all legacy specialist VPs', () => {
    for (const vp of PRIMARY_VPS) writeRole(vp, buildRoleMd(shippedPayload(vp)));
    expect(topUpDefaultVps(libDir).errors).toEqual([]);
    const before = snapshotLibrary();
    for (let run = 0; run < 2; run += 1) {
      const result = topUpDefaultVps(libDir);
      expect(result.errors).toEqual([]);
      expect(result.added).toEqual([]);
      expect(result.personaBackfilled).toEqual([]);
      expect(snapshotLibrary()).toEqual(before);
    }
  });

  it.each(['subtle edit', 'appended prompt'])('preserves a user %s and its existing metadata byte-for-byte', kind => {
    const sources = new Map();
    for (const vp of PRIMARY_VPS) {
      const old = shippedPayload(vp);
      old.persona = kind === 'subtle edit'
        ? old.persona.replace('You are', 'I am')
        : `${old.persona}\nMy private custom prompt: answer in haiku.`;
      const source = buildRoleMd(old);
      writeRole(vp, source);
      sources.set(vp.vpId, source);
    }
    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.personaBackfilled).toEqual([]);
    for (const vp of PRIMARY_VPS) expect(readRole(vp)).toBe(sources.get(vp.vpId));
  });

  it('retains user names, metadata, aliases, and unknown frontmatter while migrating an exact official soul', () => {
    const expected = new Map();
    for (const vp of PRIMARY_VPS) {
      const payload = { ...shippedPayload(vp), displayName: `My ${vp.vpId}`, displayNameZh: '私人助手',
        role: 'Private role', roleZh: '私人角色', description: 'Private description',
        descriptionZh: '私人说明', aliases: ['private-alias'], area: 'private-area',
        traits: ['private-trait'], modelHint: 'fast' };
      let source = buildRoleMd(payload);
      source = source.replace('---\n\n', "customSetting: 'keep: all bytes'\ncustomList:\n  - custom value\n---\n\n");
      writeRole(vp, source);
      expected.set(vp.vpId, source.slice(0, source.indexOf('\n---\n')));
    }
    const result = topUpDefaultVps(libDir);
    expect(result.errors).toEqual([]);
    expect(result.personaBackfilled).toHaveLength(5);
    for (const vp of PRIMARY_VPS) {
      const source = readRole(vp);
      expect(source.slice(0, source.indexOf('\n---\n'))).toBe(expected.get(vp.vpId));
      expect(parseRoleMd(source).body).toBe(vp.persona.trim());
    }
  });

  it('updates only official fields when a user has renamed the VP and extended its alias list', () => {
    for (const vp of PRIMARY_VPS) {
      const payload = shippedPayload(vp);
      payload.displayName = `User ${vp.vpId}`;
      payload.aliases = [...payload.aliases, 'my-extra-alias'];
      writeRole(vp, buildRoleMd(payload));
    }
    expect(topUpDefaultVps(libDir).errors).toEqual([]);
    for (const vp of PRIMARY_VPS) {
      const { meta } = parseRoleMd(readRole(vp));
      expect(meta.name).toBe(`User ${vp.vpId}`);
      expect(meta.aliases).toEqual([...vp.legacyMetadata.at(-1).aliases, 'my-extra-alias']);
      expect(meta.description).toBe(vp.description);
      expect(meta.roleZh).toBe(vp.roleZh);
    }
  });

  it('does not migrate an exact stock soul paired with custom prompt instructions', () => {
    const sources = new Map();
    const customPrompts = [
      "planInstruction: 'Keep my private behavior'",
      'prompt:',
      'systemPrompt: |\n  Keep my private behavior',
      "custom-instruction: 'Keep my private behavior'",
      'system_prompt:\n  - Keep my private behavior',
      "'planInstruction': 'Always write haiku'",
      'planInstruction : |\n  Always write haiku',
      'behavior:\n  systemPrompt: Always write haiku',
      'behavior: { systemPrompt: Always write haiku }',
    ];
    for (const prompt of customPrompts) {
      for (const vp of PRIMARY_VPS) {
        const source = buildRoleMd(shippedPayload(vp))
          .replace('---\n\n', `${prompt}\n---\n\n`);
        writeRole(vp, source);
        sources.set(vp.vpId, source);
      }
      const result = topUpDefaultVps(libDir);
      expect(result.errors).toEqual([]);
      expect(result.personaBackfilled).toEqual([]);
      for (const vp of PRIMARY_VPS) expect(readRole(vp)).toBe(sources.get(vp.vpId));
    }
  });

  it('does not treat a user-selected English-only current soul as shipped history', () => {
    const sources = new Map();
    for (const vp of PRIMARY_VPS) {
      const source = buildRoleMd({ ...vp, persona: vp.personaEn });
      writeRole(vp, source);
      sources.set(vp.vpId, source);
    }
    expect(topUpDefaultVps(libDir).personaBackfilled).toEqual([]);
    for (const vp of PRIMARY_VPS) expect(readRole(vp)).toBe(sources.get(vp.vpId));
  });

  it.each(['multiline description', 'multiline trait', 'duplicate field'])('preserves ambiguous user frontmatter: %s', kind => {
    const vp = PRIMARY_VPS.find(vp => vp.vpId === 'software-omni');
    const payload = shippedPayload(vp);
    let source;
    if (kind === 'multiline trait') {
      source = buildRoleMd({ ...payload, description: '', roleZh: '',
        traits: [`My private notes\ndescription: ${payload.description}\nrole: ${payload.role}\nDo not edit`] });
    } else if (kind === 'multiline description') {
      source = buildRoleMd(payload).replace(`description: ${payload.description}`,
        `description: ${payload.description}\n  and my private additions`);
    } else {
      source = buildRoleMd(payload).replace('---\n\n', 'description: My private duplicate\n---\n\n');
    }
    writeRole(vp, source);
    expect(topUpDefaultVps(libDir).personaBackfilled).not.toContain(vp.vpId);
    expect(readRole(vp)).toBe(source);
  });

  it.each(['  # My grouping note\n', '\n'])('preserves the full alias list when its layout includes %j', extra => {
    const vp = PRIMARY_VPS.find(vp => vp.vpId === 'software-omni');
    const source = buildRoleMd(shippedPayload(vp)).replace('  - software\n', `${extra}  - software\n`);
    writeRole(vp, source);
    expect(topUpDefaultVps(libDir).personaBackfilled).toContain(vp.vpId);
    const after = readRole(vp);
    expect(after.slice(after.indexOf('aliases:'), after.indexOf('\n---\n')))
      .toBe(source.slice(source.indexOf('aliases:'), source.indexOf('\n---\n')));
    expect(parseRoleMd(after).meta.aliases).toEqual(vp.legacyMetadata.at(-1).aliases);
    expect(parseRoleMd(after).body).toBe(vp.persona.trim());
    expect(topUpDefaultVps(libDir).personaBackfilled).toEqual([]);
    expect(readRole(vp)).toBe(after);
  });
});
