import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #394 — Split-pane mode panel float overlay.
 *
 * Covers 8 areas:
 * 1. Expert Panel — split-pane float (absolute positioning with overlay)
 * 2. Expert Panel overlay — display + positioning in split-pane
 * 3. SubAgent Panel — split-pane float
 * 4. SubAgent Panel — expanded mode in split-pane
 * 5. Desktop regression — Expert Panel still inline 320px
 * 6. Desktop regression — SubAgent Panel still inline 320px
 * 7. Mobile regression — still position: fixed
 * 8. Selector isolation — .split-pane rules scoped correctly
 * Edge: z-index ordering, both panels sharing same z-index scheme
 */

let expertCss;
let subagentCss;

beforeAll(() => {
  const base = resolve(__dirname, '../../web/styles');
  expertCss = readFileSync(resolve(base, 'expert-panel.css'), 'utf-8');
  subagentCss = readFileSync(resolve(base, 'subagent-panel.css'), 'utf-8');
});

// Helper: extract a CSS rule block by selector
function extractRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}

// Helper: extract the split-pane section (everything after the split-pane comment)
function extractSplitPaneSection(css) {
  const marker = 'Split-pane mode: panel floats over conversation';
  const idx = css.indexOf(marker);
  return idx >= 0 ? css.substring(idx) : '';
}

// =====================================================================
// 1. Expert Panel — split-pane float positioning
// =====================================================================
describe('Expert Panel — split-pane float', () => {
  it('should set .split-pane .expert-panel.open to position: absolute', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel.open');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: absolute');
  });

  it('should pin to top/right/bottom edges', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel.open');
    expect(rule).toContain('top: 0');
    expect(rule).toContain('right: 0');
    expect(rule).toContain('bottom: 0');
  });

  it('should set width to 80% with max-width 320px', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel.open');
    expect(rule).toContain('width: 80%');
    expect(rule).toContain('max-width: 320px');
  });

  it('should set z-index: 60 for the panel', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel.open');
    expect(rule).toContain('z-index: 60');
  });

  it('should have border-left and box-shadow', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel.open');
    expect(rule).toContain('border-left: 1px solid var(--border-color)');
    expect(rule).toContain('box-shadow');
  });
});

// =====================================================================
// 2. Expert Panel overlay — split-pane backdrop
// =====================================================================
describe('Expert Panel overlay — split-pane mode', () => {
  it('should set .split-pane .expert-panel-overlay to display: block', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('display: block');
  });

  it('should use position: absolute (not fixed)', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    expect(rule).toContain('position: absolute');
  });

  it('should cover full area with inset-like top/left/right/bottom: 0', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    expect(rule).toContain('top: 0');
    expect(rule).toContain('left: 0');
    expect(rule).toContain('right: 0');
    expect(rule).toContain('bottom: 0');
  });

  it('should set z-index: 59 for overlay (below panel z-index: 60)', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    expect(rule).toContain('z-index: 59');
  });

  it('should have semi-transparent background', () => {
    const rule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    expect(rule).toContain('background: rgba(0, 0, 0, 0.3)');
  });

  it('should set .split-pane .chat-body to position: relative (containment)', () => {
    const rule = extractRule(expertCss, '.split-pane .chat-body');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: relative');
  });
});

// =====================================================================
// 3. SubAgent Panel — split-pane float
// =====================================================================
describe('SubAgent Panel — split-pane float', () => {
  it('should set .split-pane .subagent-panel.open to position: absolute', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(rule).not.toBeNull();
    expect(rule).toContain('position: absolute');
  });

  it('should pin to top/right/bottom edges', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(rule).toContain('top: 0');
    expect(rule).toContain('right: 0');
    expect(rule).toContain('bottom: 0');
  });

  it('should set width to 80% with max-width 320px', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(rule).toContain('width: 80%');
    expect(rule).toContain('max-width: 320px');
  });

  it('should set z-index: 60 for the panel', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(rule).toContain('z-index: 60');
  });

  it('should have border-left and box-shadow', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(rule).toContain('border-left: 1px solid var(--border-color)');
    expect(rule).toContain('box-shadow');
  });
});

// =====================================================================
// 4. SubAgent Panel — expanded mode in split-pane
// =====================================================================
describe('SubAgent Panel — expanded mode in split-pane', () => {
  it('should have .split-pane .subagent-panel.open.expanded rule', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open.expanded');
    expect(rule).not.toBeNull();
  });

  it('should set width to 90% in expanded mode', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open.expanded');
    expect(rule).toContain('width: 90%');
  });

  it('should remove max-width constraint in expanded mode', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open.expanded');
    expect(rule).toContain('max-width: none');
  });

  it('should reset min-width to 0 in expanded mode', () => {
    const rule = extractRule(subagentCss, '.split-pane .subagent-panel.open.expanded');
    expect(rule).toContain('min-width: 0');
  });
});

// =====================================================================
// 5. Desktop regression — Expert Panel default (inline 320px)
// =====================================================================
describe('Desktop regression — Expert Panel default', () => {
  it('should keep .expert-panel.open at width: 320px (no position change)', () => {
    // The base rule (without .split-pane ancestor) should not have position: absolute
    const rule = extractRule(expertCss, '.expert-panel.open');
    expect(rule).not.toBeNull();
    expect(rule).toContain('width: 320px');
    // Base rule should NOT have position: absolute or position: fixed
    expect(rule).not.toContain('position: absolute');
    expect(rule).not.toContain('position: fixed');
  });

  it('should keep .expert-panel-overlay hidden by default (display: none)', () => {
    const rule = extractRule(expertCss, '.expert-panel-overlay');
    expect(rule).not.toBeNull();
    expect(rule).toContain('display: none');
  });
});

// =====================================================================
// 6. Desktop regression — SubAgent Panel default (inline 320px)
// =====================================================================
describe('Desktop regression — SubAgent Panel default', () => {
  it('should keep .subagent-panel.open at width: 320px', () => {
    const rule = extractRule(subagentCss, '.subagent-panel.open');
    expect(rule).not.toBeNull();
    expect(rule).toContain('width: 320px');
  });

  it('should NOT have position: absolute in default .subagent-panel.open', () => {
    // Only .split-pane scoped rules should set position
    const rule = extractRule(subagentCss, '.subagent-panel.open');
    expect(rule).not.toContain('position: absolute');
    expect(rule).not.toContain('position: fixed');
  });

  it('should keep default expanded mode with different sizing (40%, min 360px, max 600px)', () => {
    const rule = extractRule(subagentCss, '.subagent-panel.open.expanded');
    expect(rule).not.toBeNull();
    expect(rule).toContain('width: 40%');
    expect(rule).toContain('min-width: 360px');
    expect(rule).toContain('max-width: 600px');
  });
});

// =====================================================================
// 7. Mobile regression — still position: fixed
// =====================================================================
describe('Mobile regression — panels still fixed', () => {
  it('should keep expert panel mobile rule with position: fixed', () => {
    // Mobile media query block should contain position: fixed for expert-panel
    const mobileBlock = expertCss.substring(expertCss.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('position: fixed');
    expect(mobileBlock).toContain('z-index: 100');
  });

  it('should keep expert panel overlay mobile rule with position: fixed', () => {
    const mobileBlock = expertCss.substring(expertCss.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('.expert-panel-overlay');
    expect(mobileBlock).toContain('z-index: 99');
  });

  it('should keep subagent panel mobile rule with position: fixed', () => {
    const mobileBlock = subagentCss.substring(subagentCss.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('position: fixed');
    expect(mobileBlock).toContain('z-index: 100');
  });
});

// =====================================================================
// 8. Selector isolation — .split-pane rules scoped correctly
// =====================================================================
describe('Selector isolation — .split-pane scoping', () => {
  it('all split-pane rules in expert-panel.css should start with .split-pane', () => {
    const section = extractSplitPaneSection(expertCss);
    // Extract CSS selectors (lines starting with . followed by { on same line or next)
    const selectors = section.match(/^\.[^/*][^{]*(?=\s*\{)/gm) || [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel.trim().startsWith('.split-pane')).toBe(true);
    }
  });

  it('all split-pane rules in subagent-panel.css should start with .split-pane', () => {
    const section = extractSplitPaneSection(subagentCss);
    const selectors = section.match(/^\.[^/*][^{]*(?=\s*\{)/gm) || [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel.trim().startsWith('.split-pane')).toBe(true);
    }
  });

  it('expert-panel split-pane section should not reference unscoped classes', () => {
    const section = extractSplitPaneSection(expertCss);
    // Should not have bare .expert-panel without .split-pane prefix
    const bareSelectors = section.match(/^\.[^s][^{]+(?=\s*\{)/gm) || [];
    for (const sel of bareSelectors) {
      if (sel.trim().startsWith('.expert-') || sel.trim().startsWith('.chat-body')) {
        // These should always be prefixed with .split-pane
        expect(sel.trim().startsWith('.split-pane')).toBe(true);
      }
    }
  });
});

// =====================================================================
// Edge: z-index ordering (overlay=59, panel=60)
// =====================================================================
describe('Edge — z-index ordering', () => {
  it('expert panel overlay z-index (59) should be less than panel z-index (60)', () => {
    const overlayRule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    const panelRule = extractRule(expertCss, '.split-pane .expert-panel.open');
    const overlayZ = parseInt(overlayRule.match(/z-index:\s*(\d+)/)[1]);
    const panelZ = parseInt(panelRule.match(/z-index:\s*(\d+)/)[1]);
    expect(overlayZ).toBeLessThan(panelZ);
  });

  it('subagent panel should have same z-index (60) as expert panel', () => {
    const expertRule = extractRule(expertCss, '.split-pane .expert-panel.open');
    const subagentRule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    const expertZ = parseInt(expertRule.match(/z-index:\s*(\d+)/)[1]);
    const subagentZ = parseInt(subagentRule.match(/z-index:\s*(\d+)/)[1]);
    expect(expertZ).toBe(subagentZ);
  });

  it('split-pane z-index values should be lower than mobile z-index values', () => {
    // Split-pane overlay: 59, panel: 60
    // Mobile overlay: 99, panel: 100
    const splitOverlayRule = extractRule(expertCss, '.split-pane .expert-panel-overlay');
    const splitOverlayZ = parseInt(splitOverlayRule.match(/z-index:\s*(\d+)/)[1]);
    // Mobile z-index is 99 for overlay — just verify split-pane values are below mobile
    expect(splitOverlayZ).toBeLessThan(99);
  });
});

// =====================================================================
// Edge: positioning model consistency
// =====================================================================
describe('Edge — positioning model consistency', () => {
  it('expert panel uses absolute (within relative parent) not fixed in split-pane', () => {
    const chatBodyRule = extractRule(expertCss, '.split-pane .chat-body');
    const panelRule = extractRule(expertCss, '.split-pane .expert-panel.open');
    // Parent has position: relative → child absolute is contained
    expect(chatBodyRule).toContain('position: relative');
    expect(panelRule).toContain('position: absolute');
    expect(panelRule).not.toContain('position: fixed');
  });

  it('subagent panel uses absolute not fixed in split-pane', () => {
    const panelRule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    expect(panelRule).toContain('position: absolute');
    expect(panelRule).not.toContain('position: fixed');
  });

  it('expert and subagent panels share consistent sizing in split-pane', () => {
    const expertRule = extractRule(expertCss, '.split-pane .expert-panel.open');
    const subagentRule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    // Both should use 80% width, 320px max-width
    expect(expertRule).toContain('width: 80%');
    expect(subagentRule).toContain('width: 80%');
    expect(expertRule).toContain('max-width: 320px');
    expect(subagentRule).toContain('max-width: 320px');
  });

  it('both panels share same box-shadow style', () => {
    const expertRule = extractRule(expertCss, '.split-pane .expert-panel.open');
    const subagentRule = extractRule(subagentCss, '.split-pane .subagent-panel.open');
    const expertShadow = expertRule.match(/box-shadow:\s*([^;]+)/)[1].trim();
    const subagentShadow = subagentRule.match(/box-shadow:\s*([^;]+)/)[1].trim();
    expect(expertShadow).toBe(subagentShadow);
  });
});
