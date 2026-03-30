import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #400 (task-180):
 *   Split-pane Crew panels as overlay drawers.
 *
 * 6 test areas:
 *   1. CSS: .split-pane .crew-panel-left/right — absolute overlay positioning + transition
 *   2. CSS: .split-pane .crew-workspace — position:relative as anchor
 *   3. CSS: .split-pane .crew-mobile-overlay — backdrop overlay
 *   4. CSS: panel show/hide via mobile-panel-roles/features classes
 *   5. ChatHeader.js — isSplitMode routes to toggleCrewMobilePanel
 *   6. ChatHeader.js — isSplitMode reads crewMobilePanel via getPaneMobilePanel
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

// Helper: extract a CSS rule block by selector
function getCssRule(css, selector) {
  // Escape special chars for regex
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(escaped + '\\s*\\{[^}]+\\}'));
  return match ? match[0] : null;
}

// =====================================================================
// 1. CSS: crew-panel-left/right absolute overlay positioning
// =====================================================================
describe('Split-pane crew panels overlay positioning', () => {
  const css = readFile('styles/split-screen.css');

  it('should define shared rule for .split-pane .crew-panel-left and .crew-panel-right', () => {
    expect(css).toMatch(/\.split-pane\s+\.crew-panel-left,\s*\n?\s*\.split-pane\s+\.crew-panel-right\s*\{/);
  });

  it('should set position: absolute on both panels', () => {
    const rule = getCssRule(css, '.split-pane .crew-panel-left,\n.split-pane .crew-panel-right');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: absolute');
  });

  it('should set z-index: 100 for panels to float above content', () => {
    const rule = getCssRule(css, '.split-pane .crew-panel-left,\n.split-pane .crew-panel-right');
    expect(rule).not.toBeNull();
    expect(rule).toContain('z-index: 100');
  });

  it('should set transition on transform for smooth slide', () => {
    const rule = getCssRule(css, '.split-pane .crew-panel-left,\n.split-pane .crew-panel-right');
    expect(rule).not.toBeNull();
    expect(rule).toContain('transition: transform');
  });

  it('should hide left panel off-screen with translateX(-100%)', () => {
    // The separate .crew-panel-left rule
    const leftRules = css.match(/\.split-pane\s+\.crew-panel-left\s*\{[^}]+\}/g);
    expect(leftRules).not.toBeNull();
    const leftSpecific = leftRules.find(r => r.includes('translateX(-100%)'));
    expect(leftSpecific).toBeDefined();
  });

  it('should hide right panel off-screen with translateX(100%)', () => {
    const rightRules = css.match(/\.split-pane\s+\.crew-panel-right\s*\{[^}]+\}/g);
    expect(rightRules).not.toBeNull();
    const rightSpecific = rightRules.find(r => r.includes('translateX(100%)'));
    expect(rightSpecific).toBeDefined();
  });
});

// =====================================================================
// 2. CSS: .split-pane .crew-workspace — position:relative
// =====================================================================
describe('Split-pane crew-workspace relative positioning', () => {
  const css = readFile('styles/split-screen.css');

  it('should define .split-pane .crew-workspace rule', () => {
    expect(css).toMatch(/\.split-pane\s+\.crew-workspace\s*\{/);
  });

  it('should set position: relative as anchor for absolute panels', () => {
    const rule = getCssRule(css, '.split-pane .crew-workspace');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: relative');
  });
});

// =====================================================================
// 3. CSS: .split-pane .crew-mobile-overlay — backdrop
// =====================================================================
describe('Split-pane crew-mobile-overlay backdrop', () => {
  const css = readFile('styles/split-screen.css');

  it('should define .split-pane .crew-mobile-overlay rule', () => {
    expect(css).toMatch(/\.split-pane\s+\.crew-mobile-overlay\s*\{/);
  });

  it('should set display: block to show overlay in split mode', () => {
    const rule = getCssRule(css, '.split-pane .crew-mobile-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('display: block');
  });

  it('should set position: absolute for pane-scoped overlay', () => {
    const rule = getCssRule(css, '.split-pane .crew-mobile-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: absolute');
  });

  it('should set z-index: 99 (below panels z-index: 100)', () => {
    const rule = getCssRule(css, '.split-pane .crew-mobile-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('z-index: 99');
  });

  it('should use inset: 0 for full coverage', () => {
    const rule = getCssRule(css, '.split-pane .crew-mobile-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('inset: 0');
  });
});

// =====================================================================
// 4. CSS: panel show/hide via mobile-panel-roles/features
// =====================================================================
describe('Split-pane panel slide-in via mobile-panel classes', () => {
  const css = readFile('styles/split-screen.css');

  it('should slide left panel in when mobile-panel-roles is set', () => {
    expect(css).toMatch(/\.split-pane\s+\.crew-workspace\.mobile-panel-roles\s+\.crew-panel-left/);
    const rule = getCssRule(css, '.split-pane .crew-workspace.mobile-panel-roles .crew-panel-left');
    expect(rule).not.toBeNull();
    expect(rule).toContain('translateX(0)');
  });

  it('should slide right panel in when mobile-panel-features is set', () => {
    expect(css).toMatch(/\.split-pane\s+\.crew-workspace\.mobile-panel-features\s+\.crew-panel-right/);
    const rule = getCssRule(css, '.split-pane .crew-workspace.mobile-panel-features .crew-panel-right');
    expect(rule).not.toBeNull();
    expect(rule).toContain('translateX(0)');
  });

  it('should override hide-roles width for drawer mode', () => {
    const rule = getCssRule(css, '.split-pane .crew-workspace.hide-roles .crew-panel-left');
    expect(rule).not.toBeNull();
    expect(rule).toContain('min-width: auto');
  });

  it('should override hide-features width for drawer mode', () => {
    const rule = getCssRule(css, '.split-pane .crew-workspace.hide-features .crew-panel-right');
    expect(rule).not.toBeNull();
    expect(rule).toContain('min-width: auto');
  });

  it('should remove center panel padding when panels are hidden', () => {
    // Both hide-roles and hide-features should reset center padding
    expect(css).toContain('.split-pane .crew-workspace.hide-roles .crew-panel-center');
    expect(css).toContain('.split-pane .crew-workspace.hide-features .crew-panel-center');
    expect(css).toContain('padding-left: 0');
    expect(css).toContain('padding-right: 0');
  });
});

// =====================================================================
// 5. ChatHeader.js — isSplitMode routes to toggleCrewMobilePanel
// =====================================================================
describe('ChatHeader onCrewPanelToggle in split mode', () => {
  const chatHeaderJs = readFile('components/ChatHeader.js');

  it('should check store.isSplitMode in onCrewPanelToggle condition', () => {
    expect(chatHeaderJs).toContain('window.innerWidth < 768 || store.isSplitMode');
  });

  it('should call toggleCrewMobilePanel when isSplitMode is true', () => {
    // The condition block: if (width < 768 || store.isSplitMode) → toggleCrewMobilePanel
    const toggleBlock = chatHeaderJs.match(/onCrewPanelToggle[\s\S]*?toggleCrewMobilePanel/);
    expect(toggleBlock).not.toBeNull();
  });

  it('should call toggleCrewPanel for non-split desktop mode', () => {
    // The else block should still call toggleCrewPanel
    const toggleSection = chatHeaderJs.match(/onCrewPanelToggle[\s\S]*?toggleCrewPanel\(panel/);
    expect(toggleSection).not.toBeNull();
  });
});

// =====================================================================
// 6. ChatHeader.js — isSplitMode reads via getPaneMobilePanel
// =====================================================================
describe('ChatHeader isCrewPanelActive in split mode', () => {
  const chatHeaderJs = readFile('components/ChatHeader.js');

  it('should check store.isSplitMode in isCrewPanelActive condition', () => {
    // Both onCrewPanelToggle and isCrewPanelActive share the same condition pattern
    const isActiveBlock = chatHeaderJs.match(/isCrewPanelActive[\s\S]*?store\.isSplitMode/);
    expect(isActiveBlock).not.toBeNull();
  });

  it('should read getPaneMobilePanel when isSplitMode is true', () => {
    const isActiveBlock = chatHeaderJs.match(/isCrewPanelActive[\s\S]*?getPaneMobilePanel/);
    expect(isActiveBlock).not.toBeNull();
  });

  it('should read getPanelVisible for non-split desktop mode', () => {
    const isActiveBlock = chatHeaderJs.match(/isCrewPanelActive[\s\S]*?getPanelVisible/);
    expect(isActiveBlock).not.toBeNull();
  });

  it('should use the same condition pattern for both toggle and active check', () => {
    // Both should have: window.innerWidth < 768 || store.isSplitMode
    const matches = chatHeaderJs.match(/window\.innerWidth < 768 \|\| store\.isSplitMode/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
