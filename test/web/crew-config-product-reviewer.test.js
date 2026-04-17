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

  it('dev-en.js either omits product-reviewer or defines it consistently', () => {
    // dev-en.js may not include product-reviewer yet (task-281 was zh-focused).
    // If present, it must have a name field. This test just documents the
    // current state — expand when en template is synced.
    const src = read('web/crew-templates/dev-en.js');
    if (src.includes("name: 'product-reviewer'")) {
      expect(src).toMatch(/name:\s*'product-reviewer'/);
    } else {
      expect(src).not.toContain("product-reviewer");
    }
  });
});
