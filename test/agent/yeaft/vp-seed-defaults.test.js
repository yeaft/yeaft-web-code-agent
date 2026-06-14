import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-vp-seed-'));
}

describe('default VP souls', () => {
  it('ships every stock VP with bilingual soul sections', () => {
    expect(DEFAULT_VPS.length).toBeGreaterThan(20);
    for (const vp of DEFAULT_VPS) {
      expect(vp.roleZh).toBeTruthy();
      expect(vp.personaEn).toContain('You are');
      expect(vp.personaZh).toContain('你是');
      expect(vp.persona).toContain('<!-- lang:en -->');
      expect(vp.persona).toContain('<!-- lang:zh -->');
    }
  });

  it('backfills exact old stock persona bodies without touching edited bodies', () => {
    const libDir = tempDir();
    const linus = DEFAULT_VPS.find(vp => vp.vpId === 'linus');
    const martin = DEFAULT_VPS.find(vp => vp.vpId === 'martin');
    mkdirSync(join(libDir, 'linus'), { recursive: true });
    mkdirSync(join(libDir, 'martin'), { recursive: true });
    writeFileSync(join(libDir, 'linus', 'role.md'), buildRoleMd({ ...linus, persona: linus.personaEn, roleZh: '' }), 'utf-8');
    writeFileSync(join(libDir, 'martin', 'role.md'), buildRoleMd({ ...martin, persona: `${martin.personaEn}\n\nUser edit.`, roleZh: '' }), 'utf-8');

    const result = topUpDefaultVps(libDir);
    const linusRole = readFileSync(join(libDir, 'linus', 'role.md'), 'utf-8');
    const martinRole = readFileSync(join(libDir, 'martin', 'role.md'), 'utf-8');

    expect(result.personaBackfilled).toContain('linus');
    expect(result.roleZhBackfilled).toContain('linus');
    expect(linusRole).toContain('<!-- lang:zh -->');
    expect(linusRole).toContain('roleZh: "系统工程师"');
    expect(martinRole).not.toContain('<!-- lang:zh -->');
    expect(martinRole).toContain('User edit.');
  });
});
