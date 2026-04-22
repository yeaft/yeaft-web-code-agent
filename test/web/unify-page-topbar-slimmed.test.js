// @vitest-environment happy-dom
/**
 * task-339-F1+F3 — UnifyPage topbar slimmed, GroupSelector removed.
 *
 * Source-level asserts (cheap & reliable) over UnifyPage.js + unify.css:
 *   - GroupSelector import + registration + template usage all gone
 *   - Topbar CSS min-height reduced to 40px (from 48px)
 *   - Model selector still referenced in the template
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const rootDir = join(import.meta.dirname, '..', '..');
const unifyPageSrc = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const unifyCssSrc = readFileSync(join(rootDir, 'web/styles/unify.css'), 'utf8');

describe('UnifyPage — task-339-F1 GroupSelector removal', () => {
  it('no longer imports GroupSelector', () => {
    expect(unifyPageSrc).not.toMatch(/import GroupSelector from/);
  });

  it('no longer registers GroupSelector in components', () => {
    // Entire "GroupSelector" identifier must not appear in the components block.
    const componentsMatch = unifyPageSrc.match(/components:\s*\{[^}]*\}/);
    expect(componentsMatch).not.toBeNull();
    expect(componentsMatch[0]).not.toMatch(/GroupSelector/);
  });

  it('no longer renders <GroupSelector /> in the template', () => {
    expect(unifyPageSrc).not.toMatch(/<GroupSelector\b/);
  });

  it('still renders the topbar model selector', () => {
    expect(unifyPageSrc).toMatch(/unify-topbar-model/);
  });
});

describe('Unify topbar — task-339-F3 slimmed to 40px', () => {
  it('.unify-topbar has min-height: 40px (was 48px)', () => {
    // Grab the first `.unify-topbar {}` block (desktop default) and inspect.
    const match = unifyCssSrc.match(/\.unify-topbar\s*\{[^}]+\}/);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/min-height:\s*40px/);
    expect(match[0]).not.toMatch(/min-height:\s*48px/);
  });

  it('.unify-topbar padding reduced (vertical ≤ 4px)', () => {
    const match = unifyCssSrc.match(/\.unify-topbar\s*\{[^}]+\}/);
    expect(match[0]).toMatch(/padding:\s*4px\s+16px/);
  });
});
