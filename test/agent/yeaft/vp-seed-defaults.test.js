import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildWorkerPrompt } from '../../../agent/yeaft/prompts.js';
import { buildRoleMd } from '../../../agent/yeaft/vp/vp-crud.js';
import { DEFAULT_VPS } from '../../../agent/yeaft/vp/seed-defaults.js';
import { topUpDefaultVps } from '../../../agent/yeaft/vp/seed-topup.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yeaft-vp-seed-'));
}

const BANNED_IDENTITY_TERMS = [
  /\bVP\b/,
  /Virtual Person/i,
  /AI assistant/i,
  /Yeaft AI/i,
  /AI Companion/i,
  /AI 伙伴/,
  /虚拟角色/,
];

const BANNED_FIELD_LABELS = [
  /人物特点/,
  /擅长的事情/,
  /解决问题的方式/,
  /用户通常期待/,
  /回答风格/,
  /Traits:/,
  /Strengths:/,
  /Problem-solving/i,
  /Expected tasks/i,
  /Answer style/i,
  /Core capabilities:/,
  /Decision style:/,
  /Good for:/,
  /Bad for:/,
  /Catchphrases:/,
  /^[A-Z][A-Za-z -]+ means /m,
];

const BANNED_TEMPLATE_SCAFFOLDS = [
  /You look for the work that matters first:/,
  /Your familiar lines still matter:/,
  /People come to you for/,
];

describe('default VP souls', () => {
  it('ships every stock persona with bilingual natural soul sections', () => {
    expect(DEFAULT_VPS.length).toBeGreaterThan(20);
    for (const vp of DEFAULT_VPS) {
      expect(vp.roleZh).toBeTruthy();
      expect(vp.personaEn).toContain('You are');
      expect(vp.personaZh).toContain('你是');
      expect(vp.persona).toContain('<!-- lang:en -->');
      expect(vp.persona).toContain('<!-- lang:zh -->');
      for (const body of [vp.personaEn, vp.personaZh, vp.persona]) {
        for (const banned of BANNED_IDENTITY_TERMS) expect(body).not.toMatch(banned);
        for (const banned of BANNED_FIELD_LABELS) expect(body).not.toMatch(banned);
        for (const banned of BANNED_TEMPLATE_SCAFFOLDS) expect(body).not.toMatch(banned);
      }
    }
  });

  it('keeps stock souls as authored source text, not generated naturalization output', () => {
    const source = readFileSync(new URL('../../../agent/yeaft/vp/seed-defaults.js', import.meta.url), 'utf-8');

    expect(source).not.toMatch(/naturalizeDefaultPersona/);
    expect(source).not.toMatch(/cleanDefaultPersonaFragment/);
    expect(source).not.toMatch(/sentenceFromFragment/);
    expect(source).not.toMatch(/AUTHORED_DEFAULT_PERSONAS/);
    expect((source.match(/\n    personaEn: `/g) || [])).toHaveLength(DEFAULT_VPS.length);
    expect((source.match(/\n    personaZh: `/g) || [])).toHaveLength(DEFAULT_VPS.length);
  });

  it('ships distinct authored voices instead of one reusable template', () => {
    const byId = Object.fromEntries(DEFAULT_VPS.map(vp => [vp.vpId, vp]));

    expect(byId.linus.personaEn).toContain('sloppy engineering begins');
    expect(byId.martin.personaEn).toContain('design decay in naming');
    expect(byId.omni.personaEn).toContain('whole session in view');
    expect(byId.linus.personaZh).toContain('系统工程判断');
    expect(byId.martin.personaZh).toContain('架构边界');
    expect(byId.omni.personaZh).toContain('整个会话的形状');

    expect(byId.linus.personaEn).not.toBe(byId.martin.personaEn.replace(/Martin Fowler/g, 'Linus Torvalds'));
    expect(byId.steve.personaZh).not.toContain('整个会话的形状');
  });

  it('renders stock persona prompts as the selected person, not a VP definition', () => {
    const linus = DEFAULT_VPS.find(vp => vp.vpId === 'linus');
    const prompt = buildWorkerPrompt({ language: 'zh-CN', includeShape: false, vpPersona: linus });

    expect(prompt).toContain('# 林纳斯·托瓦兹');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('你是林纳斯·托瓦兹');
    const soul = prompt.split('## Soul')[1].split('## 核心原则')[0];
    expect(soul).not.toMatch(/\bVP\b/);
    expect(soul).not.toContain('人物特点');
  });

  it('backfills exact old stock persona bodies without touching edited bodies', () => {
    const libDir = tempDir();
    const linus = DEFAULT_VPS.find(vp => vp.vpId === 'linus');
    const martin = DEFAULT_VPS.find(vp => vp.vpId === 'martin');
    const ada = DEFAULT_VPS.find(vp => vp.vpId === 'ada');
    mkdirSync(join(libDir, 'linus'), { recursive: true });
    mkdirSync(join(libDir, 'martin'), { recursive: true });
    mkdirSync(join(libDir, 'ada'), { recursive: true });
    writeFileSync(join(libDir, 'linus', 'role.md'), buildRoleMd({ ...linus, persona: linus.legacyPersonaEn, roleZh: '' }), 'utf-8');
    writeFileSync(join(libDir, 'ada', 'role.md'), buildRoleMd({ ...ada, persona: ada.legacyPersona, roleZh: '' }), 'utf-8');
    writeFileSync(join(libDir, 'martin', 'role.md'), buildRoleMd({ ...martin, persona: `${martin.legacyPersonaEn}\n\nUser edit.`, roleZh: '' }), 'utf-8');

    const result = topUpDefaultVps(libDir);
    const linusRole = readFileSync(join(libDir, 'linus', 'role.md'), 'utf-8');
    const adaRole = readFileSync(join(libDir, 'ada', 'role.md'), 'utf-8');
    const martinRole = readFileSync(join(libDir, 'martin', 'role.md'), 'utf-8');

    expect(result.personaBackfilled).toContain('linus');
    expect(result.personaBackfilled).toContain('ada');
    expect(result.roleZhBackfilled).toContain('linus');
    expect(linusRole).toContain('<!-- lang:zh -->');
    expect(linusRole).toContain('roleZh: "系统工程师"');
    expect(linusRole).toContain('你是林纳斯·托瓦兹');
    expect(linusRole).not.toContain('人物特点');
    expect(adaRole).toContain('你是阿达·洛芙莱斯');
    expect(adaRole).not.toContain('Core capabilities:');
    expect(martinRole).not.toContain('<!-- lang:zh -->');
    expect(martinRole).toContain('User edit.');
  });
});
