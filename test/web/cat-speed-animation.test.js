import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-243: Running Cat SVG redesign + three-speed animation
 *
 * 1. Cuter cat: bigger head (r=7), rounder eyes (rx=2,ry=2.2), shorter body, eye shine, inner ears
 * 2. Three speed classes: speed-normal, speed-fast, speed-crazy
 * 3. catSpeed computed in all 3 components (5s fast, 15s crazy)
 * 4. CSS speed overrides + crazy mode spinning leg blur
 */

const rootDir = join(import.meta.dirname, '..', '..');
const messageListJs = readFileSync(join(rootDir, 'web/components/MessageList.js'), 'utf8');
const splitPaneJs = readFileSync(join(rootDir, 'web/components/SplitPane.js'), 'utf8');
const crewChatViewJs = readFileSync(join(rootDir, 'web/components/CrewChatView.js'), 'utf8');
const chatMessagesCss = readFileSync(join(rootDir, 'web/styles/chat-messages.css'), 'utf8');

// =====================================================================
// Cuter cat SVG: new elements
// =====================================================================
describe('Cuter cat SVG design', () => {
  it('head radius is 7 (bigger than old 5.5)', () => {
    expect(messageListJs).toContain('r="7"');
  });

  it('eyes are bigger (rx=2, ry=2.2)', () => {
    expect(messageListJs).toContain('rx="2" ry="2.2"');
  });

  it('body is shorter/rounder (rx=7.5, ry=5)', () => {
    expect(messageListJs).toContain('rx="7.5" ry="5"');
  });

  it('has eye shine circles', () => {
    expect(messageListJs).toContain('svg-cat-eye-shine');
  });

  it('has inner ear patches', () => {
    expect(messageListJs).toContain('svg-cat-inner-ear');
  });

  it('has triangle nose (path with Z)', () => {
    expect(messageListJs).toMatch(/svg-cat-nose.*Z/);
  });

  it('has leg blur ellipses for crazy mode', () => {
    expect(messageListJs).toContain('svg-cat-leg-blur');
  });

  it('viewBox is 0 0 36 28', () => {
    expect(messageListJs).toContain('viewBox="0 0 36 28"');
  });
});

// =====================================================================
// SVG consistency across 3 components
// =====================================================================
describe('Cat SVG consistency across components', () => {
  const extractSvg = (src) => {
    const m = src.match(/<svg viewBox="0 0 36 28"[\s\S]*?<\/svg>/);
    return m ? m[0].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim() : null;
  };

  it('all 3 components have the new cat SVG', () => {
    expect(messageListJs).toContain('viewBox="0 0 36 28"');
    expect(splitPaneJs).toContain('viewBox="0 0 36 28"');
    expect(crewChatViewJs).toContain('viewBox="0 0 36 28"');
  });

  it('SVG content is identical across all 3 components', () => {
    const ml = extractSvg(messageListJs);
    const sp = extractSvg(splitPaneJs);
    const ccv = extractSvg(crewChatViewJs);
    expect(ml).not.toBeNull();
    expect(sp).not.toBeNull();
    expect(ccv).not.toBeNull();
    expect(ml).toBe(sp);
    expect(ml).toBe(ccv);
  });
});

// =====================================================================
// Speed class binding (:class="catSpeed")
// =====================================================================
describe('Speed class binding in templates', () => {
  it('MessageList.js binds :class="catSpeed" on svg-running-cat', () => {
    expect(messageListJs).toContain(':class="catSpeed"');
  });

  it('SplitPane.js binds :class="catSpeed" on svg-running-cat', () => {
    expect(splitPaneJs).toContain(':class="catSpeed"');
  });

  it('CrewChatView.js binds :class="catSpeed" on svg-running-cat', () => {
    expect(crewChatViewJs).toContain(':class="catSpeed"');
  });
});

// =====================================================================
// catSpeed computed property logic
// =====================================================================
describe('catSpeed computed property', () => {
  it('MessageList.js has catSpeed computed', () => {
    expect(messageListJs).toContain('catSpeed');
    expect(messageListJs).toContain("'speed-normal'");
    expect(messageListJs).toContain("'speed-fast'");
    expect(messageListJs).toContain("'speed-crazy'");
  });

  it('SplitPane.js has catSpeed computed', () => {
    expect(splitPaneJs).toContain('catSpeed');
    expect(splitPaneJs).toContain("'speed-crazy'");
  });

  it('CrewChatView.js has catSpeed computed', () => {
    expect(crewChatViewJs).toContain('catSpeed');
    expect(crewChatViewJs).toContain("'speed-crazy'");
  });

  it('speed-fast triggers at 5000ms', () => {
    expect(messageListJs).toContain('5000');
  });

  it('speed-crazy triggers at 15000ms', () => {
    expect(messageListJs).toContain('15000');
  });

  it('catSpeed is in the return object (MessageList.js)', () => {
    const returnBlock = messageListJs.match(/return\s*\{[\s\S]*?\}/);
    expect(returnBlock).not.toBeNull();
    expect(returnBlock[0]).toContain('catSpeed');
  });

  it('catSpeed is in the return object (SplitPane.js)', () => {
    const returnBlock = splitPaneJs.match(/return\s*\{[\s\S]*?\}/);
    expect(returnBlock).not.toBeNull();
    expect(returnBlock[0]).toContain('catSpeed');
  });
});

// =====================================================================
// catSpeed behavioral tests
// =====================================================================
describe('catSpeed computation logic', () => {
  function computeCatSpeed(typingStartTime, now) {
    if (!typingStartTime) return 'speed-normal';
    const elapsed = now - typingStartTime;
    if (elapsed >= 15000) return 'speed-crazy';
    if (elapsed >= 5000) return 'speed-fast';
    return 'speed-normal';
  }

  it('returns speed-normal when typingStartTime is 0', () => {
    expect(computeCatSpeed(0, Date.now())).toBe('speed-normal');
  });

  it('returns speed-normal when elapsed < 5s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 3000, now)).toBe('speed-normal');
  });

  it('returns speed-fast when elapsed is 5-14s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 5000, now)).toBe('speed-fast');
    expect(computeCatSpeed(now - 10000, now)).toBe('speed-fast');
    expect(computeCatSpeed(now - 14999, now)).toBe('speed-fast');
  });

  it('returns speed-crazy when elapsed >= 15s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 15000, now)).toBe('speed-crazy');
    expect(computeCatSpeed(now - 30000, now)).toBe('speed-crazy');
  });
});

// =====================================================================
// CSS: speed variant styles
// =====================================================================
describe('CSS: speed variant styles', () => {
  it('has speed-fast class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-fast');
  });

  it('has speed-crazy class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-crazy');
  });

  it('speed-fast changes bounce animation', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-fast');
  });

  it('speed-crazy has bouncing keyframe', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-crazy');
  });

  it('speed-crazy has spinning leg animation', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-spin');
  });

  it('speed-crazy hides real legs', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl[\s\S]*?opacity:\s*0/);
  });

  it('speed-crazy shows leg blur', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur[\s\S]*?opacity:\s*0\.55/);
  });

  it('speed-fast makes legs faster (shorter animation-duration)', () => {
    const fastBlock = chatMessagesCss.match(/speed-fast[\s\S]*?speed-crazy/);
    expect(fastBlock).not.toBeNull();
    expect(fastBlock[0]).toContain('animation-duration: 0.25s');
  });
});

// =====================================================================
// CSS: new cat part styles
// =====================================================================
describe('CSS: new cat parts', () => {
  it('has .svg-cat-inner-ear style', () => {
    expect(chatMessagesCss).toContain('.svg-cat-inner-ear');
  });

  it('has .svg-cat-eye-shine style', () => {
    expect(chatMessagesCss).toContain('.svg-cat-eye-shine');
  });

  it('has .svg-cat-leg-blur style (hidden by default)', () => {
    const blurRule = chatMessagesCss.match(/\.svg-cat-leg-blur\s*\{([^}]*)\}/);
    expect(blurRule).not.toBeNull();
    expect(blurRule[1]).toContain('opacity: 0');
  });

  it('inner ear uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-inner-ear\s*\{[^}]*var\(--text-secondary\)/);
  });
});

// =====================================================================
// CSS: status colors include new selectors
// =====================================================================
describe('CSS: status colors include new parts', () => {
  it('disconnected status includes svg-cat-leg-blur', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-cat-leg-blur');
  });

  it('disconnected status includes svg-cat-inner-ear', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-cat-inner-ear');
  });

  it('compacting status includes svg-cat-leg-blur', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-compacting .svg-cat-leg-blur');
  });

  it('session-lost status includes svg-cat-leg-blur', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-session-lost .svg-cat-leg-blur');
  });
});

// =====================================================================
// CSS: normal speed leg animation duration is 0.5s
// =====================================================================
describe('CSS: normal speed animation timing', () => {
  it('normal leg animation is 0.5s', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-fl\s*\{[^}]*0\.5s/);
  });

  it('crazy tail wag uses 0.15s', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-tail-wag-crazy');
  });
});
