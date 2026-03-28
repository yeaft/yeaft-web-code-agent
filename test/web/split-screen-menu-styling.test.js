import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #374: split-screen menu styling.
 *
 * Verifies that split-screen components correctly reuse existing sidebar/header
 * CSS classes instead of defining custom duplicates, and that all CSS variables
 * reference valid tokens from the design system.
 *
 * 5 test areas:
 *   1. SessionSelector dropdown opaque background
 *   2. GlobalToolbar agent dropdown opaque background
 *   3. PaneHeader action buttons use shared .header-action-btn
 *   4. GlobalToolbar buttons use shared .sidebar-icon-btn
 *   5. SessionSelector list items reuse .session-item styles
 *   + boundary: empty state, in-other-pane opacity
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

// =====================================================================
// 1. SessionSelector dropdown — opaque background
// =====================================================================
describe('SessionSelector dropdown opaque background', () => {
  const css = readFile('styles/split-screen.css');
  const selectorJs = readFile('components/SessionSelector.js');

  it('should define .session-selector-dropdown with var(--bg-main) background', () => {
    // The dropdown must have an opaque background, not transparent/inherit
    const dropdownRule = css.match(/\.session-selector-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('background: var(--bg-main)');
  });

  it('should have box-shadow with opacity >= 0.3 for visual separation', () => {
    const dropdownRule = css.match(/\.session-selector-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    // Extract rgba opacity value from box-shadow
    const shadowMatch = dropdownRule[0].match(/rgba\(0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\)/);
    expect(shadowMatch).not.toBeNull();
    expect(parseFloat(shadowMatch[1])).toBeGreaterThanOrEqual(0.3);
  });

  it('should have border using var(--border-color)', () => {
    const dropdownRule = css.match(/\.session-selector-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('var(--border-color)');
  });

  it('should render dropdown with session-selector-dropdown class in template', () => {
    expect(selectorJs).toContain('class="session-selector-dropdown"');
  });
});

// =====================================================================
// 2. GlobalToolbar agent dropdown — opaque background
// =====================================================================
describe('GlobalToolbar agent dropdown opaque background', () => {
  const css = readFile('styles/split-screen.css');
  const toolbarJs = readFile('components/GlobalToolbar.js');

  it('should define .gt-agent-dropdown with var(--bg-main) background', () => {
    const dropdownRule = css.match(/\.gt-agent-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('background: var(--bg-main)');
  });

  it('should have box-shadow with opacity >= 0.3', () => {
    const dropdownRule = css.match(/\.gt-agent-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    const shadowMatch = dropdownRule[0].match(/rgba\(0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\)/);
    expect(shadowMatch).not.toBeNull();
    expect(parseFloat(shadowMatch[1])).toBeGreaterThanOrEqual(0.3);
  });

  it('should render dropdown with gt-agent-dropdown class in template', () => {
    expect(toolbarJs).toContain('class="gt-agent-dropdown"');
  });
});

// =====================================================================
// 3. PaneHeader uses .header-action-btn (not custom .ph-action-btn)
// =====================================================================
describe('PaneHeader uses shared header-action-btn class', () => {
  const paneHeaderJs = readFile('components/PaneHeader.js');
  const css = readFile('styles/split-screen.css');

  it('should use header-action-btn class on all action buttons', () => {
    // Count occurrences of header-action-btn in the template
    const matches = paneHeaderJs.match(/class="header-action-btn/g);
    expect(matches).not.toBeNull();
    // PaneHeader has: expert panel, compact, crew roles, refresh, add pane, close pane = 7 buttons
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('should NOT define .ph-action-btn as a standalone CSS rule', () => {
    // The old custom .ph-action-btn class should no longer be defined
    const phActionBtnRule = css.match(/\.ph-action-btn\s*\{/);
    expect(phActionBtnRule).toBeNull();
  });

  it('should NOT use ph-action-btn class in component template', () => {
    expect(paneHeaderJs).not.toContain('class="ph-action-btn"');
  });

  it('should still define .ph-close-btn hover override', () => {
    // Pane-specific hover for close button should remain
    expect(css).toContain('.ph-close-btn:hover');
    const closeRule = css.match(/\.ph-close-btn:hover\s*\{[^}]+\}/);
    expect(closeRule).not.toBeNull();
    expect(closeRule[0]).toContain('#ef4444');
  });

  it('should still define .ph-add-btn hover override', () => {
    expect(css).toContain('.ph-add-btn:hover');
    const addRule = css.match(/\.ph-add-btn:hover\s*\{[^}]+\}/);
    expect(addRule).not.toBeNull();
    expect(addRule[0]).toContain('var(--accent)');
  });
});

// =====================================================================
// 4. GlobalToolbar uses .sidebar-icon-btn (not custom .gt-btn)
// =====================================================================
describe('GlobalToolbar uses shared sidebar-icon-btn class', () => {
  const toolbarJs = readFile('components/GlobalToolbar.js');
  const css = readFile('styles/split-screen.css');

  it('should use sidebar-icon-btn class on all control buttons', () => {
    const matches = toolbarJs.match(/class="sidebar-icon-btn/g);
    expect(matches).not.toBeNull();
    // GlobalToolbar has: theme toggle, settings, add pane, merge = 4 buttons
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('should NOT define .gt-btn as a standalone CSS rule', () => {
    // The old custom .gt-btn class should no longer be defined as a standalone rule
    // (gt-btn-add and gt-btn-merge overrides are fine — those are color specializations)
    const gtBtnStandalone = css.match(/\.gt-btn\s*\{/);
    expect(gtBtnStandalone).toBeNull();
  });

  it('should NOT use gt-btn class (without suffix) in component template', () => {
    // Should not have class="gt-btn" as a class on buttons
    expect(toolbarJs).not.toMatch(/class="gt-btn"/);
  });

  it('should keep .gt-btn-add as a color override', () => {
    expect(css).toContain('.gt-btn-add');
    const addRule = css.match(/\.gt-btn-add\s*\{[^}]+\}/);
    expect(addRule).not.toBeNull();
    expect(addRule[0]).toContain('var(--accent)');
  });

  it('should keep .gt-btn-merge as a color override', () => {
    expect(css).toContain('.gt-btn-merge');
    const mergeRule = css.match(/\.gt-btn-merge\s*\{[^}]+\}/);
    expect(mergeRule).not.toBeNull();
    expect(mergeRule[0]).toContain('var(--text-muted)');
  });
});

// =====================================================================
// 5. SessionSelector list items reuse .session-item
// =====================================================================
describe('SessionSelector reuses sidebar session-item styles', () => {
  const selectorJs = readFile('components/SessionSelector.js');
  const css = readFile('styles/split-screen.css');

  it('should use session-item class on conversation items', () => {
    expect(selectorJs).toContain('class="session-item ss-session-item"');
  });

  it('should use session-group-header class on group headers', () => {
    expect(selectorJs).toContain('class="session-group-header ss-group-header-compact"');
  });

  it('should use session-item-header wrapper with title span', () => {
    expect(selectorJs).toContain('class="session-item-header"');
    expect(selectorJs).toContain('class="title"');
  });

  it('should NOT define .ss-option as a standalone CSS rule', () => {
    // Old custom .ss-option class should no longer be in CSS
    const ssOptionRule = css.match(/\.ss-option\s*\{/);
    expect(ssOptionRule).toBeNull();
  });

  it('should define .ss-session-item compact overrides', () => {
    const compactRule = css.match(/\.ss-session-item\s*\{[^}]+\}/);
    expect(compactRule).not.toBeNull();
    expect(compactRule[0]).toContain('padding');
  });

  it('should define .ss-group-header-compact overrides', () => {
    const compactHeader = css.match(/\.ss-group-header-compact\s*\{[^}]+\}/);
    expect(compactHeader).not.toBeNull();
    expect(compactHeader[0]).toContain('font-size: 11px');
  });
});

// =====================================================================
// 6. CSS variable correctness — no undefined/old variables
// =====================================================================
describe('CSS variable correctness in split-screen.css', () => {
  const css = readFile('styles/split-screen.css');

  it('should NOT use --bg-primary (old variable)', () => {
    expect(css).not.toContain('--bg-primary');
  });

  it('should NOT use --bg-secondary (old variable)', () => {
    expect(css).not.toContain('--bg-secondary');
  });

  it('should NOT use bare --border (should be --border-color)', () => {
    // Match var(--border) but not var(--border-color)
    const bareMatches = css.match(/var\(--border\b(?!-)/g);
    expect(bareMatches).toBeNull();
  });

  it('should NOT use bare --hover (should be --sidebar-hover)', () => {
    const hoverMatches = css.match(/var\(--hover\b(?!-)/g);
    expect(hoverMatches).toBeNull();
  });

  it('should use var(--bg-main) for opaque backgrounds', () => {
    const bgMainUsages = css.match(/var\(--bg-main\)/g);
    expect(bgMainUsages).not.toBeNull();
    // At least for .session-selector-dropdown and .gt-agent-dropdown
    expect(bgMainUsages.length).toBeGreaterThanOrEqual(2);
  });

  it('should use var(--bg-sidebar) for toolbar/trigger backgrounds', () => {
    const bgSidebarUsages = css.match(/var\(--bg-sidebar\)/g);
    expect(bgSidebarUsages).not.toBeNull();
    expect(bgSidebarUsages.length).toBeGreaterThanOrEqual(1);
  });

  it('should use var(--sidebar-hover) for hover states', () => {
    const sidebarHoverUsages = css.match(/var\(--sidebar-hover\)/g);
    expect(sidebarHoverUsages).not.toBeNull();
    expect(sidebarHoverUsages.length).toBeGreaterThanOrEqual(1);
  });

  it('should use var(--session-active) for pane-mode background', () => {
    const paneModeRule = css.match(/\.pane-mode\s*\{[^}]+\}/);
    expect(paneModeRule).not.toBeNull();
    expect(paneModeRule[0]).toContain('var(--session-active)');
  });

  it('should use var(--success, #22c55e) for online status dot', () => {
    const dotOnlineRule = css.match(/\.status-dot\.online\s*\{[^}]+\}/);
    expect(dotOnlineRule).not.toBeNull();
    expect(dotOnlineRule[0]).toContain('var(--success');
  });
});

// =====================================================================
// 7. Boundary conditions
// =====================================================================
describe('Boundary conditions', () => {
  const css = readFile('styles/split-screen.css');
  const selectorJs = readFile('components/SessionSelector.js');

  it('should define .in-other-pane opacity rule for cross-pane marking', () => {
    const inOtherRule = css.match(/\.ss-session-item\.in-other-pane\s*\{[^}]+\}/);
    expect(inOtherRule).not.toBeNull();
    expect(inOtherRule[0]).toContain('opacity');
    // Opacity should be a semi-transparent value (< 1)
    const opacityMatch = inOtherRule[0].match(/opacity:\s*([\d.]+)/);
    expect(opacityMatch).not.toBeNull();
    expect(parseFloat(opacityMatch[1])).toBeLessThan(1);
    expect(parseFloat(opacityMatch[1])).toBeGreaterThan(0);
  });

  it('should define empty state (.ss-empty) for when no sessions exist', () => {
    const emptyRule = css.match(/\.ss-empty\s*\{[^}]+\}/);
    expect(emptyRule).not.toBeNull();
    expect(emptyRule[0]).toContain('text-align: center');
    expect(emptyRule[0]).toContain('var(--text-muted)');
  });

  it('should render empty state in template when no conversations', () => {
    expect(selectorJs).toContain('class="ss-empty"');
    // Condition: both chat and crew arrays are empty
    expect(selectorJs).toContain('chatConversations.length === 0 && crewConversations.length === 0');
  });

  it('should render ss-option-badge for cross-pane identification', () => {
    expect(selectorJs).toContain('class="ss-option-badge"');
    // Badge only shows for items in other panes
    expect(selectorJs).toContain("isInOtherPane(conv.id)");
  });

  it('should define .ss-option-badge styling', () => {
    const badgeRule = css.match(/\.ss-option-badge\s*\{[^}]+\}/);
    expect(badgeRule).not.toBeNull();
    expect(badgeRule[0]).toContain('background: var(--accent)');
  });
});
