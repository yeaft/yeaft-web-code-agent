/**
 * task-306a — governance: AI dev prompt path tagging checklist.
 *
 * task-304 put the full checklist in CONTRIBUTING.md, but AI dev-* roles
 * load their behaviour from `.crew/CLAUDE.md` (generated from
 * `agent/crew-i18n.js` mergeRulesContent) and per-role guidance
 * (`agent/crew-i18n.js` roleGuidance.developer). This suite asserts that
 * the 4-point tagging checklist and a no-self-tag red warning are present
 * in those prompt-path sources so the guidance actually reaches dev-*
 * agents at runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const i18nSrc = readFileSync(join(root, 'agent/crew-i18n.js'), 'utf8');

// Split into the zh-CN and en halves for targeted assertions.
const enSectionStart = i18nSrc.indexOf("'en':");
expect(enSectionStart).toBeGreaterThan(0);
const zhSection = i18nSrc.slice(0, enSectionStart);
const enSection = i18nSrc.slice(enSectionStart);

describe('governance — CLAUDE.md (shared crew prompt) tagging checklist [zh-CN]', () => {
  it('contains the "Tagging Checklist" heading in zh merge rules', () => {
    expect(zhSection).toContain('Tagging Checklist');
  });

  it('checklist mentions branch check (main)', () => {
    expect(zhSection).toMatch(/分支检查[\s\S]*?main/);
  });

  it('checklist mentions conventional commits', () => {
    expect(zhSection).toMatch(/Conventional commits|conventional commits/);
  });

  it('checklist mentions not self-tagging', () => {
    expect(zhSection).toContain('不得自打 tag');
  });

  it('checklist mentions origin/main reachability check', () => {
    expect(zhSection).toMatch(/origin\/main/);
    expect(zhSection).toMatch(/merge-base\s+--is-ancestor/);
  });

  it('links back to CONTRIBUTING.md for full rules', () => {
    expect(zhSection).toMatch(/CONTRIBUTING\.md/);
  });
});

describe('governance — CLAUDE.md (shared crew prompt) tagging checklist [en]', () => {
  it('contains the "Tagging Checklist" heading in en merge rules', () => {
    expect(enSection).toContain('Tagging Checklist');
  });

  it('checklist mentions branch check (main)', () => {
    expect(enSection).toMatch(/Branch check[\s\S]*?main/);
  });

  it('checklist mentions no self-tagging', () => {
    expect(enSection).toMatch(/No self-tagging|MUST NOT run `git tag`/);
  });

  it('checklist mentions origin/main reachability check', () => {
    expect(enSection).toMatch(/origin\/main/);
    expect(enSection).toMatch(/merge-base\s+--is-ancestor/);
  });

  it('links back to CONTRIBUTING.md', () => {
    expect(enSection).toContain('CONTRIBUTING.md');
  });
});

describe('governance — developer role guidance red warning block', () => {
  it('zh-CN developer guidance contains the red self-tag warning', () => {
    expect(zhSection).toContain('Dev 严禁自打 tag');
    // Must discourage git tag + push v* / release-*
    expect(zhSection).toMatch(/git tag/);
    expect(zhSection).toMatch(/release-\*|v\*/);
  });

  it('en developer guidance contains the red self-tag warning', () => {
    expect(enSection).toMatch(/Dev MUST NOT self-tag|must never create tags/);
    expect(enSection).toMatch(/git tag/);
  });

  it('both warnings reference the authoritative docs (.crew/CLAUDE.md + CONTRIBUTING.md)', () => {
    // zh
    expect(zhSection).toMatch(/\.crew\/CLAUDE\.md/);
    expect(zhSection).toMatch(/CONTRIBUTING\.md/);
    // en
    expect(enSection).toMatch(/\.crew\/CLAUDE\.md/);
    expect(enSection).toMatch(/CONTRIBUTING\.md/);
  });

  it('developer guidance warnings are scoped to the developer role only', () => {
    // Sanity: the warning block keyword should appear near the developer:
    // entry, not sprinkled across every role guidance. We spot-check by
    // counting — two copies (zh + en), not four or more.
    const zhMatches = zhSection.match(/Dev 严禁自打 tag/g) || [];
    const enMatches = enSection.match(/Dev MUST NOT self-tag/g) || [];
    expect(zhMatches.length).toBe(1);
    expect(enMatches.length).toBe(1);
  });
});

describe('governance — checklist is short (prompt-size discipline)', () => {
  it('zh checklist body is under 600 chars (avoid prompt bloat)', () => {
    const match = zhSection.match(/## Tagging Checklist[\s\S]*?CONTRIBUTING\.md[^`]*`/);
    expect(match).toBeTruthy();
    expect(match[0].length).toBeLessThan(600);
  });

  it('en checklist body is under 800 chars (avoid prompt bloat)', () => {
    const match = enSection.match(/## Tagging Checklist[\s\S]*?CONTRIBUTING\.md[^`]*`/);
    expect(match).toBeTruthy();
    expect(match[0].length).toBeLessThan(800);
  });
});
