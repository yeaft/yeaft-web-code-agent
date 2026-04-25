/**
 * Verifies empty-group UX wiring:
 *  - GroupInviteModal styles are loaded (group-invite.css imported in index.css)
 *  - UnifyPage exposes `isActiveGroupEmpty` and renders the empty-group hero
 *    (mutually exclusive with MessageList)
 *  - UnifySidebarV2 applies `is-empty` / `is-default-empty` classes to empty
 *    groups so the sidebar can visually distinguish "container waiting to be
 *    filled" rows from populated ones.
 *  - i18n keys `unify.group.empty.{title,hint,cta}` exist in both locales.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('empty-group UX wiring', () => {
  it('imports group-invite.css from the CSS entry point', () => {
    const idx = read('web/styles/index.css');
    expect(idx).toMatch(/@import\s+['"]\.\/group-invite\.css['"]/);
  });

  it('group-invite.css declares the modal overlay + hero state', () => {
    const css = read('web/styles/group-invite.css');
    expect(css).toContain('.group-invite-overlay');
    expect(css).toContain('.group-invite-modal');
    expect(css).toContain('.group-invite-actions');
    expect(css).toContain('.unify-empty-group-hero');
    expect(css).toContain('.usv2-group-row.is-default-empty');
  });

  it('UnifyPage renders an empty-group hero gated on isActiveGroupEmpty', () => {
    const src = read('web/components/UnifyPage.js');
    expect(src).toContain('unify-empty-group-hero');
    expect(src).toContain('isActiveGroupEmpty');
    // Hero shown when empty; MessageList hidden when empty (mutually exclusive)
    expect(src).toMatch(/MessageList[\s\S]*!isActiveGroupEmpty/);
    // Hero CTA reuses the existing invite handler (no duplicate logic)
    expect(src).toMatch(/unify-empty-group-hero__cta[\s\S]{0,200}onInviteOpenLibrary/);
    // Setup must expose the flag to the template
    expect(src).toMatch(/return\s*\{[\s\S]*isActiveGroupEmpty[\s\S]*\}/);
  });

  it('UnifySidebarV2 marks empty groups (and the default group specially)', () => {
    const src = read('web/components/UnifySidebarV2.js');
    expect(src).toContain("'is-empty'");
    expect(src).toContain("'is-default-empty'");
    expect(src).toContain('grp_default');
  });

  it('exposes empty-group i18n keys in both locales', () => {
    for (const file of ['web/i18n/en.js', 'web/i18n/zh-CN.js']) {
      const src = read(file);
      expect(src, file).toContain("'unify.group.empty.title'");
      expect(src, file).toContain("'unify.group.empty.hint'");
      expect(src, file).toContain("'unify.group.empty.cta'");
    }
  });
});
