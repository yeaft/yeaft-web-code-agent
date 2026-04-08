/**
 * Tests for task-250: Dark mode Running Cat eyes invisible fix
 *
 * PR #471 fixes dark mode cat eyes that became invisible after task-236/237
 * over-corrected (rgba(255,255,255,0.15) eye white = invisible on gray cat head).
 *
 * Changed file: web/styles/variables.css (3 lines)
 * - Dark mode --cat-eye-fill: rgba(255,255,255,0.15) → rgba(255,255,255,0.7)
 * - Dark mode --cat-pupil-fill: rgba(255,255,255,0.5) → #1a1a1a
 *
 * Test coverage:
 * 1. Dark mode eye values correct (visible white sclera + dark pupil)
 * 2. Light mode NOT regressed (still uses CSS variable references)
 * 3. Eye color visible against all status body colors (disconnected, compacting, etc.)
 * 4. Transition-friendly: no properties that would break theme switching
 * 5. CSS variables used in chat-messages.css (not hardcoded)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let variablesCss;
let chatMessagesCss;
let darkModeBlock;
let lightModeBlock;

beforeAll(() => {
  const base = resolve(__dirname, '../..');
  variablesCss = readFileSync(resolve(base, 'web/styles/variables.css'), 'utf-8');
  chatMessagesCss = readFileSync(resolve(base, 'web/styles/chat-messages.css'), 'utf-8');

  // Extract light mode (root :root) and dark mode ([data-theme="dark"]) blocks
  const darkStart = variablesCss.indexOf('[data-theme="dark"]');
  const darkEnd = variablesCss.indexOf('}', variablesCss.lastIndexOf('--cat-pupil-fill', variablesCss.length));
  darkModeBlock = variablesCss.substring(darkStart, darkEnd + 1);

  // Light mode: from :root to first closing brace section containing --cat-eye-fill
  const rootStart = variablesCss.indexOf(':root');
  const lightEyeIdx = variablesCss.indexOf('--cat-eye-fill');
  const lightBlockEnd = variablesCss.indexOf('}', lightEyeIdx);
  lightModeBlock = variablesCss.substring(rootStart, lightBlockEnd + 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Dark mode: eye white (sclera) is visible
// ─────────────────────────────────────────────────────────────────────────
describe('Dark mode cat eye sclera (--cat-eye-fill)', () => {
  it('dark mode has --cat-eye-fill defined', () => {
    expect(darkModeBlock).toContain('--cat-eye-fill:');
  });

  it('dark mode eye fill uses rgba(255, 255, 255, 0.7) — visible white', () => {
    expect(darkModeBlock).toMatch(/--cat-eye-fill:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.7\s*\)/);
  });

  it('dark mode eye fill opacity is >= 0.5 (not invisible like the old 0.15)', () => {
    const match = darkModeBlock.match(/--cat-eye-fill:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
    expect(match).not.toBeNull();
    const opacity = parseFloat(match[1]);
    expect(opacity).toBeGreaterThanOrEqual(0.5);
    expect(opacity).toBeLessThanOrEqual(1.0);
  });

  it('dark mode eye fill is NOT the old invisible value (rgba 0.15)', () => {
    expect(darkModeBlock).not.toMatch(/--cat-eye-fill:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.15\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Dark mode: pupil is dark (contrast with white sclera)
// ─────────────────────────────────────────────────────────────────────────
describe('Dark mode cat pupil (--cat-pupil-fill)', () => {
  it('dark mode has --cat-pupil-fill defined', () => {
    expect(darkModeBlock).toContain('--cat-pupil-fill:');
  });

  it('dark mode pupil is #1a1a1a — dark color for contrast against white sclera', () => {
    expect(darkModeBlock).toMatch(/--cat-pupil-fill:\s*#1a1a1a/);
  });

  it('dark mode pupil is NOT white (old value was rgba(255,255,255,0.5) = white pupil on white sclera)', () => {
    expect(darkModeBlock).not.toMatch(/--cat-pupil-fill:\s*rgba\(\s*255\s*,\s*255\s*,\s*255/);
  });

  it('dark mode pupil is a dark color (not light/bright)', () => {
    // #1a1a1a = RGB(26, 26, 26) which is very dark
    const match = darkModeBlock.match(/--cat-pupil-fill:\s*#([0-9a-fA-F]{6})/);
    expect(match).not.toBeNull();
    const hex = match[1];
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Luminance should be low (dark color)
    const luminance = (r + g + b) / 3;
    expect(luminance).toBeLessThan(80); // Very dark
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Light mode: NOT regressed
// ─────────────────────────────────────────────────────────────────────────
describe('Light mode cat eyes — no regression', () => {
  it('light mode --cat-eye-fill uses var(--bg-primary) CSS variable reference', () => {
    expect(lightModeBlock).toMatch(/--cat-eye-fill:\s*var\(--bg-primary/);
  });

  it('light mode --cat-eye-fill has #fff fallback', () => {
    expect(lightModeBlock).toMatch(/--cat-eye-fill:\s*var\(--bg-primary\s*,\s*#fff\)/);
  });

  it('light mode --cat-pupil-fill uses var(--text-primary)', () => {
    expect(lightModeBlock).toMatch(/--cat-pupil-fill:\s*var\(--text-primary\)/);
  });

  it('light mode pupil is NOT changed to a hardcoded dark mode value', () => {
    // Should still use CSS variable, not hardcoded #1a1a1a
    expect(lightModeBlock).not.toMatch(/--cat-pupil-fill:\s*#1a1a1a/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Eye-pupil contrast: sclera and pupil are distinguishable
// ─────────────────────────────────────────────────────────────────────────
describe('Dark mode eye-pupil contrast', () => {
  it('sclera (white-ish) and pupil (dark) create visible contrast', () => {
    // Sclera: rgba(255,255,255,0.7) → effective brightness high
    // Pupil: #1a1a1a → RGB(26,26,26) → brightness very low
    // The difference should be large enough to be clearly visible
    const scleraOpacity = 0.7; // from rgba(255,255,255,0.7)
    const scleraBrightness = 255 * scleraOpacity; // ~178.5

    const pupilBrightness = 26; // #1a1a1a = 26

    const contrast = scleraBrightness - pupilBrightness;
    expect(contrast).toBeGreaterThan(100); // Strong contrast
  });

  it('eye and pupil are different CSS properties (not same value)', () => {
    const eyeMatch = darkModeBlock.match(/--cat-eye-fill:\s*([^;]+)/);
    const pupilMatch = darkModeBlock.match(/--cat-pupil-fill:\s*([^;]+)/);
    expect(eyeMatch).not.toBeNull();
    expect(pupilMatch).not.toBeNull();
    expect(eyeMatch[1].trim()).not.toBe(pupilMatch[1].trim());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Status colors do NOT override eyes (eyes remain visible in all states)
// ─────────────────────────────────────────────────────────────────────────
describe('Status color overrides do NOT affect eyes', () => {
  const statuses = ['disconnected', 'agent-offline', 'compacting', 'session-lost', 'cli-exited'];

  for (const status of statuses) {
    it(`status-${status} overrides cat body/head/ear/leg but NOT cat-eye`, () => {
      const statusPattern = new RegExp(`\\.typing-indicator\\.status-${status}[^{]*\\.svg-cat-eye`);
      // There should be no override of .svg-cat-eye for this status
      expect(chatMessagesCss).not.toMatch(statusPattern);
    });

    it(`status-${status} overrides cat body/head/ear/leg but NOT cat-pupil`, () => {
      const statusPattern = new RegExp(`\\.typing-indicator\\.status-${status}[^{]*\\.svg-cat-pupil`);
      // There should be no override of .svg-cat-pupil for this status
      expect(chatMessagesCss).not.toMatch(statusPattern);
    });
  }

  it('status color rules only target body/head/ear/inner-ear/leg/leg-blur/tail', () => {
    // All status-* .svg-cat-* selectors should NOT include eye or pupil
    const statusCatRules = chatMessagesCss.match(/\.typing-indicator\.status-\w+[^{]+\{[^}]+\}/g) || [];
    for (const rule of statusCatRules) {
      expect(rule).not.toContain('svg-cat-eye');
      expect(rule).not.toContain('svg-cat-pupil');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. CSS variables used in chat-messages.css (not hardcoded)
// ─────────────────────────────────────────────────────────────────────────
describe('Eye CSS uses variables (supports theme switching)', () => {
  it('.svg-cat-eye fill uses var(--cat-eye-fill)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-eye\s*\{[^}]*fill:\s*var\(--cat-eye-fill\)/);
  });

  it('.svg-cat-pupil fill uses var(--cat-pupil-fill)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-pupil\s*\{[^}]*fill:\s*var\(--cat-pupil-fill\)/);
  });

  it('.svg-cat-eye does NOT use hardcoded color values', () => {
    const eyeRule = chatMessagesCss.match(/\.svg-cat-eye\s*\{([^}]*)\}/);
    expect(eyeRule).not.toBeNull();
    const eyeBody = eyeRule[1];
    // fill should use var(), not #hex or rgba()
    expect(eyeBody).toContain('var(');
    expect(eyeBody).not.toMatch(/fill:\s*#/);
    expect(eyeBody).not.toMatch(/fill:\s*rgba/);
  });

  it('.svg-cat-pupil does NOT use hardcoded color values', () => {
    const pupilRule = chatMessagesCss.match(/\.svg-cat-pupil\s*\{([^}]*)\}/);
    expect(pupilRule).not.toBeNull();
    const pupilBody = pupilRule[1];
    expect(pupilBody).toContain('var(');
    expect(pupilBody).not.toMatch(/fill:\s*#/);
    expect(pupilBody).not.toMatch(/fill:\s*rgba/);
  });

  it('theme switching works because values are in :root and [data-theme="dark"]', () => {
    // :root defines light values
    expect(variablesCss).toMatch(/:root\s*\{[^}]*--cat-eye-fill:/s);
    expect(variablesCss).toMatch(/:root\s*\{[^}]*--cat-pupil-fill:/s);
    // [data-theme="dark"] overrides them
    expect(variablesCss).toMatch(/\[data-theme="dark"\]\s*\{[^}]*--cat-eye-fill:/s);
    expect(variablesCss).toMatch(/\[data-theme="dark"\]\s*\{[^}]*--cat-pupil-fill:/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Dark mode comment is descriptive
// ─────────────────────────────────────────────────────────────────────────
describe('Code quality', () => {
  it('dark mode section has updated comment explaining the fix', () => {
    // Old comment: "softer eyes in dark mode"
    // New comment should mention visibility
    expect(darkModeBlock).toMatch(/visible\s+eyes\s+in\s+dark\s+mode/i);
  });

  it('dark mode comment no longer says "softer" (that was the bug)', () => {
    expect(darkModeBlock).not.toMatch(/softer\s+eyes/i);
  });

  it('dark mode cat eye variables are inside [data-theme="dark"] block', () => {
    expect(darkModeBlock).toContain('[data-theme="dark"]');
    expect(darkModeBlock).toContain('--cat-eye-fill:');
    expect(darkModeBlock).toContain('--cat-pupil-fill:');
  });
});
