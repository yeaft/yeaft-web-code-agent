/**
 * session-settings-fixed-shell.test.js — pins the CLAUDE.md UI rule 3
 * contract on the SessionSettingsModal: settings dialogs must declare a
 * fixed shell height so switching tabs does NOT reflow the modal.
 *
 * Bug (reported by user 2026-06-07):
 *   Switching between "成员" (a long roster) and "群记忆" (one button
 *   + two help lines) jerked the dialog up/down on the viewport,
 *   shrinking from ~640px down to ~280px and back. Caused by
 *   `.group-settings-modal { max-height: min(640px, ...) }` instead of
 *   a real `height` — `max-height` lets the flex column collapse to
 *   content, so the empty 群记忆 tab pulled the shell down with it.
 *
 * Fix:
 *   `.group-settings-modal` now uses `height: min(680px, 90vh)` (mirror
 *   of `.settings-dialog` in settings.css) and `.group-settings-roster`
 *   drops its inner `max-height: 320px` cap. Outer pane scrolls.
 *
 * This is a pure-CSS contract test — we read the file and assert the
 * declared properties. A render-based test would need jsdom layout
 * which Vitest doesn't ship. The failure mode we're guarding against
 * is "someone reverts to max-height" or "someone adds an inner
 * roster scroller back" — both detectable from the stylesheet text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(__dirname, '../../web/styles/yeaft.css');
const rawCss = readFileSync(cssPath, 'utf-8');

// Strip CSS comments so /* max-height: ... */ inside a doc comment
// doesn't trip the negation checks below.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Extract the body of a CSS rule. We use a plain indexOf-based scan
 * rather than a regex to avoid template-literal escaping headaches.
 * Matches `<selector> {` at the start of a line (after stripping
 * comments) so a nested-selector usage of `.group-settings-modal`
 * inside another rule wouldn't false-match.
 */
function block(selector) {
  // Look for `<selector>` followed (possibly via whitespace) by `{`.
  // We scan from start; selector strings here don't contain regex
  // metacharacters so substring search is fine.
  let cursor = 0;
  while (cursor < css.length) {
    const hit = css.indexOf(selector, cursor);
    if (hit === -1) break;
    // The character before the hit should be a newline or whitespace
    // (top-level rule), and after `selector` there should only be
    // whitespace before `{`.
    const charBefore = hit === 0 ? '\n' : css[hit - 1];
    if (charBefore !== '\n' && charBefore !== ' ' && charBefore !== '\t') {
      cursor = hit + selector.length;
      continue;
    }
    let p = hit + selector.length;
    while (p < css.length && (css[p] === ' ' || css[p] === '\t' || css[p] === '\n')) p++;
    if (css[p] !== '{') {
      cursor = hit + selector.length;
      continue;
    }
    const end = css.indexOf('}', p);
    if (end === -1) break;
    return css.slice(p + 1, end);
  }
  throw new Error(`Selector ${selector} not found in yeaft.css`);
}

function declares(body, prop) {
  // Each declaration in the body either starts at the body or after a
  // `;`. We check both forms to avoid matching `max-height` when
  // looking for `height`.
  const needle = prop + ':';
  let i = 0;
  while (i < body.length) {
    const hit = body.indexOf(needle, i);
    if (hit === -1) return false;
    // The character before the hit must be whitespace, `;`, or `{` —
    // not a letter or hyphen (which would indicate this is part of
    // another property like `max-height` when searching for `height`).
    const prev = hit === 0 ? ';' : body[hit - 1];
    const isBoundary =
      prev === ';' || prev === ' ' || prev === '\t' || prev === '\n';
    if (isBoundary) return true;
    i = hit + needle.length;
  }
  return false;
}

describe('SessionSettingsModal CSS — fixed-shell contract (UI rule 3)', () => {
  it('.group-settings-modal declares `height` (not `max-height`) so the shell does not collapse per tab', () => {
    const body = block('.group-settings-modal');
    // The shell must have a hard `height:` declaration. max-height
    // alone is what caused the bug.
    expect(declares(body, 'height')).toBe(true);
    // No literal `max-height` on the shell — the comment-stripped block
    // would still expose a regression if someone reintroduces the cap.
    expect(declares(body, 'max-height')).toBe(false);
  });

  it('.group-settings-roster has no inner `max-height` (outer pane is the only scroller)', () => {
    // Pre-fix: the roster had `max-height: 320px; overflow-y: auto;`
    // which nested a scrollbar inside the Members tab and capped the
    // visible row count even when the fixed shell had more room.
    const body = block('.group-settings-roster');
    expect(declares(body, 'max-height')).toBe(false);
    expect(declares(body, 'overflow-y')).toBe(false);
  });

  it('.group-settings-pane keeps `overflow-y: auto` so tall sections still scroll inside the fixed shell', () => {
    // The OTHER half of the fixed-shell pattern: shell stays pinned,
    // pane scrolls. If someone drops the pane overflow, the long
    // Members section would push the shell back to overflow: hidden +
    // content-clipped — also a regression.
    const body = block('.group-settings-pane');
    expect(declares(body, 'overflow-y')).toBe(true);
    // And the declared value must be `auto`, not `hidden`.
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
  });
});
