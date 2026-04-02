import { describe, it, expect } from 'vitest';

/**
 * Tests for task-213: Screenshot padding symmetry fix
 *
 * Validates:
 * 1. .turn-content has padding-right: 40px for hover buttons
 * 2. .turn-content.screenshot-mode resets padding-right to 0
 * 3. Hover buttons are not affected in normal mode (screenshot-mode is temporary)
 * 4. CrewTurnRenderer (.crew-msg-content) has no padding-right issue
 * 5. Screenshot flow: screenshot-mode class is added/removed correctly
 * 6. toPng style applies uniform padding: 32px
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const rootDir = join(import.meta.dirname, '..', '..');
const chatMessagesCss = readFileSync(join(rootDir, 'web/styles/chat-messages.css'), 'utf8');
const assistantTurnJs = readFileSync(join(rootDir, 'web/components/AssistantTurn.js'), 'utf8');
const crewTurnRendererJs = readFileSync(join(rootDir, 'web/components/crew/CrewTurnRenderer.js'), 'utf8');
const crewWorkspaceCss = readFileSync(join(rootDir, 'web/styles/crew-workspace.css'), 'utf8');

// =====================================================================
// Root cause: .turn-content padding-right for hover buttons
// =====================================================================
describe('Root cause: .turn-content padding-right', () => {
  it('.turn-content should have padding-right: 40px (for hover buttons)', () => {
    // This is the root cause of asymmetric screenshots
    expect(chatMessagesCss).toContain('padding-right: 40px');
    // Verify it's inside .turn-content rule
    const turnContentMatch = chatMessagesCss.match(/\.turn-content\s*\{[^}]*padding-right:\s*40px/);
    expect(turnContentMatch).not.toBeNull();
  });
});

// =====================================================================
// Fix: .turn-content.screenshot-mode resets padding-right
// =====================================================================
describe('Fix: screenshot-mode padding-right reset', () => {
  it('should have .turn-content.screenshot-mode rule', () => {
    expect(chatMessagesCss).toContain('.turn-content.screenshot-mode');
  });

  it('should reset padding-right to 0 with !important', () => {
    const rule = chatMessagesCss.match(/\.turn-content\.screenshot-mode\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const ruleBody = rule[1];
    expect(ruleBody).toContain('padding-right: 0 !important');
  });

  it('screenshot-mode rule should be after the base .turn-content rule', () => {
    const baseIdx = chatMessagesCss.indexOf('.turn-content {');
    const fixIdx = chatMessagesCss.indexOf('.turn-content.screenshot-mode');
    expect(fixIdx).toBeGreaterThan(baseIdx);
  });

  it('screenshot-mode rule should be near the other screenshot-mode rules', () => {
    // The new rule should be logically grouped with existing screenshot-mode rules
    const existingScreenshotMode = chatMessagesCss.indexOf('.screenshot-mode,\n.screenshot-mode *');
    const newRule = chatMessagesCss.indexOf('.turn-content.screenshot-mode');
    // Should be within 500 chars of each other (same section of the CSS file)
    expect(Math.abs(newRule - existingScreenshotMode)).toBeLessThan(500);
  });

  it('has a clear comment explaining the fix', () => {
    expect(chatMessagesCss).toContain('Screenshot mode: reset turn-content padding-right');
  });
});

// =====================================================================
// Normal mode: hover buttons unaffected
// =====================================================================
describe('Normal mode: hover buttons unaffected', () => {
  it('.turn-content .turn-header should still have opacity: 0 (hidden by default)', () => {
    const headerRule = chatMessagesCss.match(/\.turn-content\s+\.turn-header\s*\{([^}]*)\}/);
    expect(headerRule).not.toBeNull();
    expect(headerRule[1]).toContain('opacity: 0');
  });

  it('.turn-content:hover .turn-header should show buttons (opacity: 1)', () => {
    expect(chatMessagesCss).toContain('.turn-content:hover .turn-header');
    const hoverRule = chatMessagesCss.match(/\.turn-content:hover\s+\.turn-header\s*\{([^}]*)\}/);
    expect(hoverRule).not.toBeNull();
    expect(hoverRule[1]).toContain('opacity: 1');
  });

  it('screenshot-mode is only applied via classList during screenshotTurn()', () => {
    // Verify the class is added then removed
    expect(assistantTurnJs).toContain("classList.add('screenshot-mode')");
    expect(assistantTurnJs).toContain("classList.remove('screenshot-mode')");
  });

  it('screenshot-mode removal is in a finally block (guaranteed cleanup)', () => {
    // The remove is inside a finally block, so even on error it's cleaned up
    const addIdx = assistantTurnJs.indexOf("classList.add('screenshot-mode')");
    const removeIdx = assistantTurnJs.indexOf("classList.remove('screenshot-mode')");
    const finallyBetween = assistantTurnJs.substring(addIdx, removeIdx);
    expect(finallyBetween).toContain('finally');
  });
});

// =====================================================================
// AssistantTurn screenshot: toPng with uniform padding
// =====================================================================
describe('AssistantTurn screenshot: toPng configuration', () => {
  it('toPng style should apply padding: 32px (uniform)', () => {
    // The inline style on the clone should be uniform 32px
    expect(assistantTurnJs).toContain("padding: '32px'");
  });

  it('should NOT have old asymmetric padding 24px 32px', () => {
    expect(assistantTurnJs).not.toContain("padding: '24px 32px'");
  });

  it('toPng filter should exclude turn-header (hover buttons)', () => {
    expect(assistantTurnJs).toContain("node.classList.contains('turn-header')");
  });

  it('toPng filter should exclude screenshot-btn', () => {
    expect(assistantTurnJs).toContain("node.classList.contains('screenshot-btn')");
  });

  it('should use pixelRatio: 3 for high-res output', () => {
    expect(assistantTurnJs).toContain('pixelRatio: 3');
  });
});

// =====================================================================
// CrewTurnRenderer: no padding-right issue
// =====================================================================
describe('CrewTurnRenderer screenshot: no padding-right issue', () => {
  it('.crew-msg-content has no padding-right in CSS', () => {
    // The crew workspace CSS for .crew-msg-content should not have padding-right
    const crewMsgContentMatch = crewWorkspaceCss.match(/\.crew-msg-content\s*\{([^}]*)\}/);
    expect(crewMsgContentMatch).not.toBeNull();
    expect(crewMsgContentMatch[1]).not.toContain('padding-right');
  });

  it('CrewTurnRenderer screenshot targets .crew-msg-content not .turn-content', () => {
    // The screenshot targets a different element, so the .turn-content fix doesn't interfere
    expect(crewTurnRendererJs).toContain('.crew-msg-content.markdown-body');
  });

  it('CrewTurnRenderer also uses padding: 32px', () => {
    expect(crewTurnRendererJs).toContain("padding: '32px'");
  });

  it('CrewTurnRenderer also uses screenshot-mode class', () => {
    expect(crewTurnRendererJs).toContain("classList.add('screenshot-mode')");
    expect(crewTurnRendererJs).toContain("classList.remove('screenshot-mode')");
  });
});

// =====================================================================
// Padding symmetry analysis (computed values)
// =====================================================================
describe('Padding symmetry analysis', () => {
  it('in normal mode: left=0, right=40px (asymmetric, for button space)', () => {
    // .turn-content { padding: 0; padding-right: 40px; }
    const turnContentRule = chatMessagesCss.match(/\.turn-content\s*\{([^}]*)\}/);
    expect(turnContentRule[1]).toContain('padding: 0');
    expect(turnContentRule[1]).toContain('padding-right: 40px');
  });

  it('in screenshot-mode: right=0 (reset), then toPng adds 32px all sides', () => {
    // Step 1: .turn-content.screenshot-mode { padding-right: 0 !important }
    // → computed padding: 0 0 0 0
    // Step 2: toPng style: { padding: '32px' }
    // → final padding: 32px 32px 32px 32px (symmetric!)
    const screenshotRule = chatMessagesCss.match(/\.turn-content\.screenshot-mode\s*\{([^}]*)\}/);
    expect(screenshotRule[1]).toContain('padding-right: 0 !important');
    expect(assistantTurnJs).toContain("padding: '32px'");
    // Together they produce symmetric padding
  });
});

// =====================================================================
// Change scope: only 1 file modified
// =====================================================================
describe('Change scope', () => {
  it('only chat-messages.css is modified (no JS changes needed)', () => {
    // The fix is CSS-only — the JS already had the correct padding: 32px
    // and screenshot-mode class toggling
    expect(chatMessagesCss).toContain('.turn-content.screenshot-mode');
    // AssistantTurn.js already had padding: '32px' (not '24px 32px')
    expect(assistantTurnJs).toContain("padding: '32px'");
  });
});
