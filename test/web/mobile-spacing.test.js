import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-235: Mobile message area spacing optimization.
 *
 * Fix 1: Wider horizontal padding for .chat-container on mobile (≤768px)
 * Fix 2: Larger bottom padding for .input-area on mobile with safe-area-inset
 *
 * Validates:
 * 1. Mobile media query exists for .chat-container with wider padding
 * 2. Mobile media query exists for .input-area with increased bottom padding
 * 3. Desktop styles remain unchanged
 * 4. safe-area-inset-bottom preserved for iPhone X+ devices
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let sidebarCss;
let chatInputCss;

beforeAll(() => {
  sidebarCss = read('web/styles/sidebar.css');
  chatInputCss = read('web/styles/chat-input.css');
});

// =============================================================================
// Fix 1: Mobile message area horizontal padding
// =============================================================================
describe('Fix 1: Mobile .chat-container padding (task-235)', () => {
  it('has mobile media query for .chat-container', () => {
    // Should have a @media (max-width: 768px) block containing .chat-container
    expect(sidebarCss).toContain('@media (max-width: 768px)');
  });

  it('mobile .chat-container has horizontal padding (not 0)', () => {
    // Find the mobile media query block with .chat-container
    const mobileMatch = sidebarCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.chat-container\s*\{([^}]+)\}/
    );
    expect(mobileMatch).not.toBeNull();
    const block = mobileMatch[1];
    // Should have left/right padding > 0
    expect(block).toContain('padding');
    // padding: 16px 12px means top/bottom=16px, left/right=12px
    expect(block).toMatch(/padding:\s*16px\s+12px/);
  });

  it('desktop .chat-container still has padding: 24px 0', () => {
    // The base (non-mobile) rule should remain
    const baseMatch = sidebarCss.match(
      /\.chat-container\s*\{[^}]*padding:\s*24px\s+0/
    );
    expect(baseMatch).not.toBeNull();
  });
});

// =============================================================================
// Fix 2: Mobile input area bottom padding
// =============================================================================
describe('Fix 2: Mobile .input-area bottom padding (task-235)', () => {
  it('has mobile media query for .input-area', () => {
    const mobileMatch = chatInputCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.input-area\s*\{([^}]+)\}/
    );
    expect(mobileMatch).not.toBeNull();
  });

  it('mobile .input-area has increased bottom padding (32px)', () => {
    const mobileMatch = chatInputCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.input-area\s*\{([^}]+)\}/
    );
    expect(mobileMatch).not.toBeNull();
    const block = mobileMatch[1];
    // Should reference 32px in padding-bottom
    expect(block).toContain('32px');
  });

  it('mobile .input-area preserves safe-area-inset-bottom', () => {
    const mobileMatch = chatInputCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.input-area\s*\{([^}]+)\}/
    );
    expect(mobileMatch).not.toBeNull();
    const block = mobileMatch[1];
    expect(block).toContain('env(safe-area-inset-bottom');
  });

  it('mobile .input-area uses calc() for bottom padding with safe area', () => {
    const mobileMatch = chatInputCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{[^}]*\.input-area\s*\{([^}]+)\}/
    );
    expect(mobileMatch).not.toBeNull();
    const block = mobileMatch[1];
    expect(block).toMatch(/calc\(\s*32px\s*\+\s*env\(safe-area-inset-bottom/);
  });

  it('desktop .input-area still has original padding (24px bottom)', () => {
    // Base rule: padding-bottom: calc(24px + env(...))
    const baseMatch = chatInputCss.match(
      /\.input-area\s*\{[^}]*padding-bottom:\s*calc\(\s*24px/
    );
    expect(baseMatch).not.toBeNull();
  });

  it('desktop .input-area has padding: 16px 24px 24px', () => {
    const baseMatch = chatInputCss.match(
      /\.input-area\s*\{[^}]*padding:\s*16px\s+24px\s+24px/
    );
    expect(baseMatch).not.toBeNull();
  });
});

// =============================================================================
// Cross-check: only mobile affected, no desktop side effects
// =============================================================================
describe('No desktop side effects (task-235)', () => {
  it('mobile breakpoint is 768px (standard tablet/mobile cutoff)', () => {
    // Both files should use 768px breakpoint
    const sidebarBreakpoints = sidebarCss.match(/@media\s*\(max-width:\s*768px\)/g);
    const inputBreakpoints = chatInputCss.match(/@media\s*\(max-width:\s*768px\)/g);
    expect(sidebarBreakpoints).not.toBeNull();
    expect(inputBreakpoints).not.toBeNull();
  });

  it('sidebar.css desktop .chat-container has 0 horizontal padding', () => {
    // Ensure the desktop rule hasn't been accidentally changed
    expect(sidebarCss).toMatch(/\.chat-container\s*\{[^}]*padding:\s*24px\s+0[^0-9]/);
  });

  it('chat-input.css desktop .input-area bottom is 24px', () => {
    expect(chatInputCss).toMatch(
      /\.input-area\s*\{[^}]*padding-bottom:\s*calc\(\s*24px\s*\+\s*env\(safe-area-inset-bottom/
    );
  });
});
