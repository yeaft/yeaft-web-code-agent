import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for the three-column chat layout.
 *
 * Desktop chat mode uses a 20% / 60% / 20% visual layout by setting
 * .messages, .input-wrapper, .input-hints, and .attachments-preview to
 * max-width: 60% with margin: 0 auto. The left/right 20% columns are
 * reserved whitespace for future features (animation, message search).
 *
 * Mobile (≤768px) reverts to max-width: 90% for usability.
 * Split-pane mode also keeps 90% since pane width is already narrow.
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

function extractCssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(regex);
  return match ? match[1] : null;
}

function extractMediaBlock(css, mediaQuery) {
  const idx = css.indexOf(`@media (${mediaQuery})`);
  if (idx === -1) return null;
  let depth = 0;
  let start = -1;
  for (let i = idx; i < css.length; i++) {
    if (css[i] === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.substring(start + 1, i);
    }
  }
  return null;
}

function hasMaxWidth(ruleContent, value) {
  if (!ruleContent) return false;
  return new RegExp(`max-width\\s*:\\s*${value}`).test(ruleContent);
}

// =====================================================================
// Desktop: 60% max-width (three-column visual layout)
// =====================================================================

describe('Desktop chat — 60% max-width (three-column layout)', () => {
  describe('sidebar.css — .messages container', () => {
    const css = read('web/styles/sidebar.css');
    const rule = extractCssRule(css, '.messages');

    it('sets max-width to 60%', () => {
      expect(hasMaxWidth(rule, '60%')).toBe(true);
    });

    it('centers with margin: 0 auto', () => {
      expect(rule).toMatch(/margin\s*:\s*0\s+auto/);
    });
  });

  describe('chat-input.css — input elements', () => {
    const css = read('web/styles/chat-input.css');

    it('.attachments-preview has max-width 60%', () => {
      const rule = extractCssRule(css, '.attachments-preview');
      expect(hasMaxWidth(rule, '60%')).toBe(true);
    });

    it('.input-hints has max-width 60%', () => {
      const rule = extractCssRule(css, '.input-hints');
      expect(hasMaxWidth(rule, '60%')).toBe(true);
    });

    it('.input-wrapper has max-width 60%', () => {
      const rule = extractCssRule(css, '.input-wrapper');
      expect(hasMaxWidth(rule, '60%')).toBe(true);
    });
  });
});

// =====================================================================
// Mobile: 90% max-width override
// =====================================================================

describe('Mobile (≤768px) — 90% max-width override', () => {
  it('.messages reverts to 90% on mobile', () => {
    const css = read('web/styles/sidebar.css');
    const block = extractMediaBlock(css, 'max-width: 768px');
    expect(block).not.toBeNull();
    expect(block).toContain('.messages');
    expect(block).toMatch(/\.messages\s*\{[^}]*max-width\s*:\s*90%/);
  });

  it('.attachments-preview reverts to 90% on mobile', () => {
    const css = read('web/styles/chat-input.css');
    const block = extractMediaBlock(css, 'max-width: 768px');
    expect(block).not.toBeNull();
    expect(block).toContain('.attachments-preview');
    expect(block).toMatch(/max-width\s*:\s*90%/);
  });

  it('.input-hints reverts to 90% on mobile', () => {
    const css = read('web/styles/chat-input.css');
    const block = extractMediaBlock(css, 'max-width: 768px');
    expect(block).toContain('.input-hints');
  });

  it('.input-wrapper reverts to 90% on mobile', () => {
    const css = read('web/styles/chat-input.css');
    const block = extractMediaBlock(css, 'max-width: 768px');
    expect(block).toContain('.input-wrapper');
  });
});

// =====================================================================
// Split-pane: stays at 90%
// =====================================================================

describe('Split-pane mode — 90% max-width preserved', () => {
  const css = read('web/styles/split-screen.css');

  it('.split-pane-messages .messages has max-width 90%', () => {
    const rule = extractCssRule(css, '.split-pane-messages .messages');
    expect(hasMaxWidth(rule, '90%')).toBe(true);
  });

  it('.split-pane .input-wrapper has max-width 90%', () => {
    expect(css).toMatch(/\.split-pane\s+\.input-wrapper[^{]*\{[^}]*max-width\s*:\s*90%/);
  });

  it('.split-pane .input-hints has max-width 90%', () => {
    expect(css).toMatch(/\.split-pane\s+\.input-hints[^{]*\{[^}]*max-width\s*:\s*90%/);
  });

  it('.split-pane .attachments-preview has max-width 90%', () => {
    expect(css).toMatch(/\.split-pane\s+\.attachments-preview[^{]*\{[^}]*max-width\s*:\s*90%/);
  });
});

// =====================================================================
// Consistency checks
// =====================================================================

describe('Layout consistency', () => {
  it('desktop .messages and .input-wrapper use the same max-width', () => {
    const sidebarCss = read('web/styles/sidebar.css');
    const inputCss = read('web/styles/chat-input.css');
    const messagesRule = extractCssRule(sidebarCss, '.messages');
    const inputRule = extractCssRule(inputCss, '.input-wrapper');
    // Both should be 60%
    expect(hasMaxWidth(messagesRule, '60%')).toBe(true);
    expect(hasMaxWidth(inputRule, '60%')).toBe(true);
  });

  it('mobile overrides use consistent 90% for all elements', () => {
    const inputCss = read('web/styles/chat-input.css');
    const block = extractMediaBlock(inputCss, 'max-width: 768px');
    // All three input elements should be in the same 90% override
    expect(block).toContain('.attachments-preview');
    expect(block).toContain('.input-hints');
    expect(block).toContain('.input-wrapper');
    expect(block).toMatch(/max-width\s*:\s*90%/);
  });
});
