import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-227: Split-mode two fixes
 *   Fix 1: Remove hamburger menu button in split-mode panes
 *   Fix 2: Feature expanded mode fills pane width in split-mode (no 50% shrink)
 *
 * Also verifies:
 *   - Non-split mode: feature-expanded still uses 50/50 layout
 *   - Mobile: feature-expanded still uses full-screen overlay
 *   - Dead CSS code (.pane-sidebar-toggle) removed from split-screen.css
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let chatHeaderSource;
let crewWorkspaceCssSource;
let splitScreenCssSource;

beforeAll(() => {
  chatHeaderSource = read('web/components/ChatHeader.js');
  crewWorkspaceCssSource = read('web/styles/crew-workspace.css');
  splitScreenCssSource = read('web/styles/split-screen.css');
});

// =============================================================================
// Fix 1: Remove hamburger menu button in split-mode
// =============================================================================
describe('Fix 1: No hamburger button in split-mode panes (task-227)', () => {
  it('does not contain pane-sidebar-toggle class in ChatHeader template', () => {
    expect(chatHeaderSource).not.toContain('pane-sidebar-toggle');
  });

  it('does not contain toggle-pane-sidebar emit in ChatHeader template', () => {
    expect(chatHeaderSource).not.toContain('toggle-pane-sidebar');
  });

  it('does not list toggle-pane-sidebar in emits array', () => {
    // The emits should only have toggle-sidebar and close-pane
    expect(chatHeaderSource).not.toContain("'toggle-pane-sidebar'");
  });

  it('still has toggle-sidebar emit for mobile sidebar', () => {
    expect(chatHeaderSource).toContain("'toggle-sidebar'");
  });

  it('still has close-pane emit for split-mode close button', () => {
    expect(chatHeaderSource).toContain("'close-pane'");
  });

  it('mobile sidebar toggle is conditionally hidden in split mode', () => {
    // The remaining sidebar toggle should have v-if="!store.isSplitMode"
    expect(chatHeaderSource).toContain('v-if="!store.isSplitMode"');
  });

  it('removed .pane-sidebar-toggle CSS from split-screen.css', () => {
    expect(splitScreenCssSource).not.toContain('.pane-sidebar-toggle');
  });
});

// =============================================================================
// Fix 2: Feature expanded fills pane in split-mode
// =============================================================================
describe('Fix 2: Feature expanded fills pane width in split-mode (task-227)', () => {
  it('has split-pane override for feature-expanded center panel', () => {
    expect(crewWorkspaceCssSource).toContain(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-center'
    );
  });

  it('split-pane center panel uses flex: unset (reverts 50/50)', () => {
    const idx = crewWorkspaceCssSource.indexOf(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-center'
    );
    expect(idx).toBeGreaterThan(-1);
    const block = crewWorkspaceCssSource.slice(idx, crewWorkspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('flex: unset');
  });

  it('has split-pane override for feature-expanded right panel', () => {
    expect(crewWorkspaceCssSource).toContain(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-right'
    );
  });

  it('split-pane right panel uses width: auto (no 50% constraint)', () => {
    const idx = crewWorkspaceCssSource.indexOf(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-right'
    );
    expect(idx).toBeGreaterThan(-1);
    const block = crewWorkspaceCssSource.slice(idx, crewWorkspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('width: auto');
  });

  it('split-pane right panel uses flex-shrink: unset', () => {
    const idx = crewWorkspaceCssSource.indexOf(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-right'
    );
    expect(idx).toBeGreaterThan(-1);
    const block = crewWorkspaceCssSource.slice(idx, crewWorkspaceCssSource.indexOf('}', idx) + 1);
    expect(block).toContain('flex-shrink: unset');
  });
});

// =============================================================================
// Non-split mode: feature-expanded 50/50 layout preserved
// =============================================================================
describe('Non-split mode: feature-expanded 50/50 layout unaffected (task-227)', () => {
  it('still has base feature-expanded center panel rule (flex: 1)', () => {
    // The base (non-split) rule should still exist
    const regex = /\.crew-workspace\.feature-expanded\s+\.crew-panel-center\s*\{[^}]*flex:\s*1/;
    expect(crewWorkspaceCssSource).toMatch(regex);
  });

  it('still has base feature-expanded right panel rule (width: 50%)', () => {
    const regex = /\.crew-workspace\.feature-expanded\s+\.crew-panel-right\s*\{[^}]*width:\s*50%/;
    expect(crewWorkspaceCssSource).toMatch(regex);
  });

  it('base right panel rule has flex-shrink: 0', () => {
    const regex = /\.crew-workspace\.feature-expanded\s+\.crew-panel-right\s*\{[^}]*flex-shrink:\s*0/;
    expect(crewWorkspaceCssSource).toMatch(regex);
  });
});

// =============================================================================
// Mobile: feature-expanded full-screen overlay unaffected
// =============================================================================
describe('Mobile: feature-expanded full-screen overlay unaffected (task-227)', () => {
  it('has mobile media query for feature-expanded right panel', () => {
    // Mobile override: width: 100vw !important
    expect(crewWorkspaceCssSource).toContain(
      '.crew-workspace.feature-expanded .crew-panel-right'
    );
  });

  it('mobile feature-expanded uses 100vw width', () => {
    // Look for 100vw in the mobile section
    expect(crewWorkspaceCssSource).toContain('width: 100vw !important');
  });
});

// =============================================================================
// CSS specificity: split-pane overrides are more specific
// =============================================================================
describe('CSS specificity correctness (task-227)', () => {
  it('split-pane override appears after base feature-expanded rules', () => {
    const baseIdx = crewWorkspaceCssSource.indexOf(
      '.crew-workspace.feature-expanded .crew-panel-center'
    );
    const splitIdx = crewWorkspaceCssSource.indexOf(
      '.split-pane .crew-workspace.feature-expanded .crew-panel-center'
    );
    expect(baseIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(baseIdx);
  });

  it('split-pane selector has higher specificity than base selector', () => {
    // .split-pane .crew-workspace.feature-expanded (3 classes)
    // vs .crew-workspace.feature-expanded (2 classes)
    // The split-pane prefix adds specificity — just verify it has the prefix
    const rule = '.split-pane .crew-workspace.feature-expanded';
    expect(crewWorkspaceCssSource).toContain(rule);
  });
});
