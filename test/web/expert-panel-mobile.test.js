import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for ExpertPanel mobile UI bug fixes (task-67, PR #229).
 *
 * Covers 4 bugs:
 * 1. i18n fallback — keys exist in both locales, no broken || fallback pattern
 * 2. Mobile overlay — backdrop CSS + template click-to-close
 * 3. Panel scroll — .expert-role-list has correct flex+scroll properties
 * 4. Z-index layering — overlay < panel, panel doesn't block input flow
 */

// ---- Helpers ----
const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

function extractCssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(regex);
  return match ? match[1] : null;
}

function hasProp(rule, prop, val) {
  if (!rule) return false;
  const regex = new RegExp(`${prop}\\s*:\\s*${val}`);
  return regex.test(rule.replace(/\s+/g, ' '));
}

/**
 * Extract CSS rules inside a @media block.
 */
function extractMediaBlock(css, query) {
  const escaped = query.replace(/[()]/g, '\\$&');
  const regex = new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{`, 'g');
  const match = regex.exec(css);
  if (!match) return '';
  // Find matching closing brace (handle nested braces)
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(match.index + match[0].length, i - 1);
}

// =====================================================================
// Bug 1: i18n keys — expertPanel translations exist in both locales
// =====================================================================

describe('Bug 1: i18n expertPanel keys', () => {
  const zhCN = read('web/i18n/zh-CN.js');
  const en = read('web/i18n/en.js');

  const requiredKeys = [
    { key: 'expertPanel.title', zh: '帮帮团', en: 'Expert Panel' },
    { key: 'expertPanel.search', zh: '搜索角色或 Action', en: 'Search roles or actions' },
    { key: 'expertPanel.noResults', zh: '没有匹配结果', en: 'No results' },
    { key: 'expertPanel.clearAll', zh: '清空', en: 'Clear' },
    { key: 'chatHeader.expertPanel', zh: '帮帮团', en: 'Expert Panel' },
  ];

  for (const { key, zh, en: enVal } of requiredKeys) {
    it(`zh-CN has '${key}' with correct value`, () => {
      expect(zhCN).toContain(`'${key}'`);
      // Check the value contains expected Chinese text
      const regex = new RegExp(`'${key.replace('.', '\\.')}'\\s*:\\s*'([^']*)'`);
      const match = zhCN.match(regex);
      expect(match).toBeTruthy();
      expect(match[1]).toContain(zh);
    });

    it(`en has '${key}' with correct value`, () => {
      expect(en).toContain(`'${key}'`);
      const regex = new RegExp(`'${key.replace('.', '\\.')}'\\s*:\\s*'([^']*)'`);
      const match = en.match(regex);
      expect(match).toBeTruthy();
      expect(match[1]).toContain(enVal);
    });
  }

  it('ExpertPanel template does not use broken || fallback pattern', () => {
    const source = read('web/components/ExpertPanel.js');
    // The old pattern was: $t('expertPanel.xxx') || '硬编码'
    // This is broken because $t returns the key string when not found (truthy)
    const brokenPattern = /\$t\('expertPanel\.\w+'\)\s*\|\|/;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it('ChatHeader template does not use broken || fallback pattern for expertPanel', () => {
    const source = read('web/components/ChatHeader.js');
    const brokenPattern = /\$t\('chatHeader\.expertPanel'\)\s*\|\|/;
    expect(brokenPattern.test(source)).toBe(false);
  });
});

// =====================================================================
// Bug 2: Mobile overlay — backdrop + click-to-close
// =====================================================================

describe('Bug 2: mobile overlay', () => {
  const css = read('web/styles/expert-panel.css');

  it('overlay is hidden by default (display: none)', () => {
    const rule = extractCssRule(css, '.expert-panel-overlay');
    expect(hasProp(rule, 'display', 'none')).toBe(true);
  });

  it('overlay is visible on mobile (≤768px) with fixed position', () => {
    const mobileBlock = extractMediaBlock(css, 'max-width: 768px');
    const rule = extractCssRule(mobileBlock, '.expert-panel-overlay');
    expect(hasProp(rule, 'display', 'block')).toBe(true);
    expect(hasProp(rule, 'position', 'fixed')).toBe(true);
  });

  it('overlay z-index (99) is below panel z-index (100)', () => {
    const mobileBlock = extractMediaBlock(css, 'max-width: 768px');
    const overlayRule = extractCssRule(mobileBlock, '.expert-panel-overlay');
    const panelRule = extractCssRule(mobileBlock, '.expert-panel.open');
    // Extract z-index values
    const overlayZ = overlayRule.match(/z-index\s*:\s*(\d+)/);
    const panelZ = panelRule.match(/z-index\s*:\s*(\d+)/);
    expect(overlayZ).toBeTruthy();
    expect(panelZ).toBeTruthy();
    expect(Number(overlayZ[1])).toBeLessThan(Number(panelZ[1]));
  });

  it('ChatPage template has overlay element that closes panel on click', () => {
    const source = read('web/components/ChatPage.js');
    // Verify overlay exists with v-if bound to activeRightPanel
    expect(source).toContain('class="expert-panel-overlay"');
    expect(source).toContain('v-if="store.activeRightPanel"');
    // Verify click handler sets activeRightPanel to null
    expect(source).toMatch(/expert-panel-overlay.*@click="store\.activeRightPanel\s*=\s*null"/s);
  });
});

// =====================================================================
// Bug 3: Panel scroll — role list is scrollable
// =====================================================================

describe('Bug 3: panel scroll', () => {
  const css = read('web/styles/expert-panel.css');
  const rule = extractCssRule(css, '.expert-role-list');

  it('.expert-role-list fills available space (flex: 1)', () => {
    expect(hasProp(rule, 'flex', '1')).toBe(true);
  });

  it('.expert-role-list allows vertical scroll (overflow-y: auto)', () => {
    expect(hasProp(rule, 'overflow-y', 'auto')).toBe(true);
  });

  it('.expert-role-list has min-height: 0 to enable flex shrink + scroll', () => {
    // Without min-height: 0, a flex child defaults to min-height: auto,
    // which prevents it from shrinking below content size and breaks scroll
    expect(hasProp(rule, 'min-height', '0')).toBe(true);
  });
});

// =====================================================================
// Bug 4: Layout integrity — panel doesn't block input
// =====================================================================

describe('Bug 4: layout integrity', () => {
  const css = read('web/styles/expert-panel.css');

  it('mobile panel uses position: fixed (does not affect document flow)', () => {
    const mobileBlock = extractMediaBlock(css, 'max-width: 768px');
    const rule = extractCssRule(mobileBlock, '.expert-panel.open');
    expect(hasProp(rule, 'position', 'fixed')).toBe(true);
  });

  it('overlay covers full viewport (top/left/right/bottom: 0)', () => {
    const mobileBlock = extractMediaBlock(css, 'max-width: 768px');
    const rule = extractCssRule(mobileBlock, '.expert-panel-overlay');
    expect(hasProp(rule, 'top', '0')).toBe(true);
    expect(hasProp(rule, 'left', '0')).toBe(true);
    expect(hasProp(rule, 'right', '0')).toBe(true);
    expect(hasProp(rule, 'bottom', '0')).toBe(true);
  });

  it('overlay has semi-transparent background', () => {
    const mobileBlock = extractMediaBlock(css, 'max-width: 768px');
    const rule = extractCssRule(mobileBlock, '.expert-panel-overlay');
    // Should have rgba background with alpha < 1
    expect(rule).toMatch(/background:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.5\s*\)/);
  });
});
