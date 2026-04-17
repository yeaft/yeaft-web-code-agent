/**
 * Ensures CrewConfigPanel treats `product-reviewer` as an expandable role
 * (follows dev count, just like `reviewer` and `tester`).
 *
 * Without this, the "跟随 dev × N" hint row was hidden for product-reviewer
 * in both create and edit modes — UI out of sync with backend expansion.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('CrewConfigPanel — product-reviewer expandable', () => {
  let source;
  beforeAll(() => {
    source = read('web/components/CrewConfigPanel.js');
  });

  it('isExpandableRole whitelist includes product-reviewer', () => {
    // Extract the return statement body of isExpandableRole
    const match = source.match(/isExpandableRole\(name\)\s*\{[\s\S]*?return\s*(\[[^\]]+\])\.includes\(name\)/);
    expect(match, 'isExpandableRole should use an array whitelist').not.toBeNull();
    const arr = match[1];
    expect(arr).toContain("'developer'");
    expect(arr).toContain("'reviewer'");
    expect(arr).toContain("'product-reviewer'");
  });

  it('isExpandableRole keeps existing expandable roles (developer, reviewer, tester)', () => {
    // Evaluate the whitelist by regex rather than importing the Vue component.
    const match = source.match(/isExpandableRole\(name\)\s*\{[\s\S]*?return\s*\[([^\]]+)\]\.includes\(name\)/);
    expect(match).not.toBeNull();
    const names = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    for (const n of ['developer', 'tester', 'reviewer', 'product-reviewer']) {
      expect(names).toContain(n);
    }
  });
});

describe('Crew dev templates — product-reviewer parity with reviewer', () => {
  it('dev-zh.js defines product-reviewer role', () => {
    const src = read('web/crew-templates/dev-zh.js');
    expect(src).toMatch(/name:\s*'product-reviewer'/);
  });

  it('dev-en.js defines product-reviewer role with matching fields', () => {
    const src = read('web/crew-templates/dev-en.js');
    expect(src).toMatch(/name:\s*'product-reviewer'/);
    // English displayName must keep the Linus reference to match zh parity.
    expect(src).toMatch(/displayName:\s*'Product Reviewer-Linus'/);
    // Must have isDecisionMaker: false like the zh version.
    const block = src.slice(src.indexOf("name: 'product-reviewer'"));
    expect(block).toMatch(/isDecisionMaker:\s*false/);
    // Must include ROUTE examples to pm and developer (parity with zh).
    expect(block).toMatch(/to:\s*pm/);
    expect(block).toMatch(/to:\s*developer/);
  });

  it('dev-en.js product-reviewer claudeMd is substantive (not silently emptied)', () => {
    const src = read('web/crew-templates/dev-en.js');
    // Extract claudeMd content for the product-reviewer role — a template literal.
    const prBlock = src.slice(src.indexOf("name: 'product-reviewer'"));
    const md = prBlock.match(/claudeMd:\s*`([\s\S]*?)`\s*\n\s*\}/);
    expect(md, 'product-reviewer claudeMd template literal should be present').not.toBeNull();
    const content = md[1];
    // Guard against future refactors silently clearing the prompt.
    expect(content.length).toBeGreaterThan(500);
    // Identity + routing keywords must remain.
    expect(content).toMatch(/Product Review/);
    expect(content).toMatch(/ROUTE/);
  });

  it('dev-en.js no longer defines the tester role (task-281 dual-reviewer parity)', () => {
    const src = read('web/crew-templates/dev-en.js');
    // Role definition entry for tester must be gone.
    expect(src).not.toMatch(/name:\s*'tester'/);
    // No ROUTE examples should target tester as a recipient.
    expect(src).not.toMatch(/to:\s*tester\b/);
  });

  it('dev-en.js and dev-zh.js have matching role name topology', () => {
    const extractNames = (path) => {
      const src = read(path);
      return Array.from(src.matchAll(/name:\s*'([a-z-]+)',\s*displayName:/g)).map((m) => m[1]);
    };
    const en = extractNames('web/crew-templates/dev-en.js');
    const zh = extractNames('web/crew-templates/dev-zh.js');
    expect(en.sort()).toEqual(zh.sort());
    // Sanity: neither contains tester.
    expect(en).not.toContain('tester');
    expect(zh).not.toContain('tester');
  });
});
