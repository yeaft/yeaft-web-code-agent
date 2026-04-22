/**
 * task-329 — mobile Header lost after tab/background switch-and-return.
 *
 * Root cause (RCA):
 *   iOS Safari briefly returns a stale 100dvh viewport on visibilitychange →
 *   flex parent (`.main-content`) overflows → child `.chat-header` with
 *   `min-height:48px` but without `flex-shrink:0` gets compressed to 0 height
 *   by the flex algorithm → header visually disappears, user cannot refresh.
 *
 * Plan A (minimal diff):
 *   1. mobile `.chat-header` — add `flex-shrink: 0` (core fix, inside
 *      `@media (max-width: 768px)` in chat-modals.css)
 *   2. desktop `.chat-header` — add defensive `flex-shrink: 0` in sidebar.css
 *   3. Three-Page consistency: verify all top-bar rules receive flex-shrink:0
 *      - Chat/Crew share `.chat-header` (both checks above)
 *      - Unify: `.unify-topbar` in unify.css (already had it historically)
 *
 * Source-level assertions only — no live module / DOM / style cascade needed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

function read(rel) {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('task-329 — mobile header flex-shrink:0 defense', () => {
  describe('Chat / Crew header (.chat-header)', () => {
    it('mobile media query block contains flex-shrink:0 for .chat-header', () => {
      const css = read('web/styles/chat-modals.css');
      // Locate the `@media (max-width: 768px)` block
      const mobileIdx = css.indexOf('@media (max-width: 768px)');
      expect(mobileIdx).toBeGreaterThan(-1);
      // Grab the mobile block (naïve but sufficient: up to the next top-level
      // `@media` or EOF). Good enough for source-level shape assertion.
      const mobileBlock = css.slice(mobileIdx);
      // Multiple mobile `@media (max-width: 768px)` blocks exist in the file
      // (one earlier, one later). At least one `.chat-header` rule inside
      // some mobile block must carry `flex-shrink: 0` + `min-height: 48px`.
      const chatHeaderRules = mobileBlock.match(
        /\.chat-header\s*\{[^}]*\}/g,
      ) || [];
      expect(chatHeaderRules.length).toBeGreaterThan(0);
      const fixed = chatHeaderRules.find(
        (r) => /flex-shrink:\s*0/.test(r) && /min-height:\s*48px/.test(r),
      );
      expect(fixed, 'expected a mobile .chat-header rule with flex-shrink:0 + min-height:48px').toBeTruthy();
    });

    it('desktop .chat-header in sidebar.css carries flex-shrink:0 defense', () => {
      const css = read('web/styles/sidebar.css');
      // Match the first standalone `.chat-header { ... }` rule (the desktop
      // base rule sits outside any @media block in sidebar.css).
      const rule = css.match(/\n\.chat-header\s*\{[^}]*\}/);
      expect(rule).not.toBeNull();
      expect(rule[0]).toMatch(/flex-shrink:\s*0/);
      // Sanity: preserve pre-existing properties untouched.
      expect(rule[0]).toMatch(/display:\s*flex/);
      expect(rule[0]).toMatch(/justify-content:\s*center/);
    });

    it('references task-329 in a code comment for traceability', () => {
      const mobileCss = read('web/styles/chat-modals.css');
      const desktopCss = read('web/styles/sidebar.css');
      expect(mobileCss).toMatch(/task-329/);
      expect(desktopCss).toMatch(/task-329/);
    });
  });

  describe('Unify top bar (.unify-topbar) — three-Page consistency', () => {
    it('.unify-topbar rule in unify.css carries flex-shrink:0', () => {
      const css = read('web/styles/unify.css');
      // Base (non-mobile) .unify-topbar rule
      const rule = css.match(/\n\.unify-topbar\s*\{[^}]*\}/);
      expect(rule).not.toBeNull();
      expect(rule[0]).toMatch(/flex-shrink:\s*0/);
      // task-339-F3: topbar slimmed from 48px → 40px now that the
      // GroupSelector is out of it. flex-shrink:0 is still required so
      // the bar doesn't get compressed on mobile.
      expect(rule[0]).toMatch(/min-height:\s*40px/);
    });
  });
});
