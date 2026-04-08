import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-248: Running Cat — four-speed animation
 *
 * 1. Cuter cat: bigger head (r=7), rounder eyes (rx=2,ry=2.2), shorter body, eye shine, inner ears
 * 2. Four speed classes: speed-normal, speed-fast, speed-turbo, speed-crazy
 * 3. catSpeed computed in all 3 components (2s fast, 4s turbo, 6s crazy)
 * 4. Turbo = shimmer blur (translateX/scaleX), Crazy = small rotating circles (Tom & Jerry)
 * 5. 20% larger cat via scale(1.2)
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

  it('has leg blur ellipses (outer pair)', () => {
    expect(messageListJs).toContain('svg-cat-leg-blur');
  });

  it('has inner leg blur ellipses for crazy mode swirl', () => {
    expect(messageListJs).toContain('svg-cat-leg-blur-inner');
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

  it('all 3 components have inner blur ellipses', () => {
    expect(messageListJs).toContain('svg-cat-leg-blur-inner');
    expect(splitPaneJs).toContain('svg-cat-leg-blur-inner');
    expect(crewChatViewJs).toContain('svg-cat-leg-blur-inner');
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
// catSpeed computed property — four tiers (0-2-4-6s)
// =====================================================================
describe('catSpeed computed property (four tiers)', () => {
  it('MessageList.js has all four speed classes', () => {
    expect(messageListJs).toContain('catSpeed');
    expect(messageListJs).toContain("'speed-normal'");
    expect(messageListJs).toContain("'speed-fast'");
    expect(messageListJs).toContain("'speed-turbo'");
    expect(messageListJs).toContain("'speed-crazy'");
  });

  it('SplitPane.js has all four speed classes', () => {
    expect(splitPaneJs).toContain('catSpeed');
    expect(splitPaneJs).toContain("'speed-turbo'");
    expect(splitPaneJs).toContain("'speed-crazy'");
  });

  it('CrewChatView.js has all four speed classes', () => {
    expect(crewChatViewJs).toContain('catSpeed');
    expect(crewChatViewJs).toContain("'speed-turbo'");
    expect(crewChatViewJs).toContain("'speed-crazy'");
  });

  it('speed-fast triggers at 2000ms', () => {
    expect(messageListJs).toContain('2000');
  });

  it('speed-turbo triggers at 4000ms', () => {
    expect(messageListJs).toContain('4000');
  });

  it('speed-crazy triggers at 6000ms', () => {
    expect(messageListJs).toContain('6000');
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
// catSpeed behavioral tests (four tiers)
// =====================================================================
describe('catSpeed computation logic (four tiers)', () => {
  function computeCatSpeed(typingStartTime, now) {
    if (!typingStartTime) return 'speed-normal';
    const elapsed = now - typingStartTime;
    if (elapsed >= 6000) return 'speed-crazy';
    if (elapsed >= 4000) return 'speed-turbo';
    if (elapsed >= 2000) return 'speed-fast';
    return 'speed-normal';
  }

  it('returns speed-normal when typingStartTime is 0', () => {
    expect(computeCatSpeed(0, Date.now())).toBe('speed-normal');
  });

  it('returns speed-normal when elapsed < 2s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 1000, now)).toBe('speed-normal');
    expect(computeCatSpeed(now - 1999, now)).toBe('speed-normal');
  });

  it('returns speed-fast when elapsed is 2-3.999s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 2000, now)).toBe('speed-fast');
    expect(computeCatSpeed(now - 3000, now)).toBe('speed-fast');
    expect(computeCatSpeed(now - 3999, now)).toBe('speed-fast');
  });

  it('returns speed-turbo when elapsed is 4-5.999s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 4000, now)).toBe('speed-turbo');
    expect(computeCatSpeed(now - 5000, now)).toBe('speed-turbo');
    expect(computeCatSpeed(now - 5999, now)).toBe('speed-turbo');
  });

  it('returns speed-crazy when elapsed >= 6s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 6000, now)).toBe('speed-crazy');
    expect(computeCatSpeed(now - 10000, now)).toBe('speed-crazy');
    expect(computeCatSpeed(now - 30000, now)).toBe('speed-crazy');
  });
});

// =====================================================================
// CSS: turbo = shimmer, crazy = small rotating circles
// =====================================================================
describe('CSS: turbo uses shimmer, crazy uses small rotate', () => {
  it('turbo hides real legs', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fl[\s\S]*?opacity:\s*0/);
  });

  it('turbo shows blur with shimmer animation', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur[\s\S]*?svg-leg-blur-shimmer/);
  });

  it('crazy hides real legs', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl[\s\S]*?opacity:\s*0/);
  });

  it('crazy uses rotate animation for outer blur (not shimmer)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?svg-leg-rotate\b/);
  });

  it('crazy blur orbits around body center (transform-origin: 15px 22px)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?transform-origin:\s*15px 22px/);
  });

  it('crazy uses reverse rotate for inner blur (swirl effect)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?svg-leg-rotate-reverse/);
  });

  it('crazy inner blur orbits around body center (transform-origin: 15px 22px)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?transform-origin:\s*15px 22px/);
  });

  it('has svg-leg-rotate keyframe (360 deg)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-rotate\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(360deg)');
  });

  it('has svg-leg-rotate-reverse keyframe (-360 deg)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-rotate-reverse\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-360deg)');
  });

  it('shimmer keyframe uses translateX/scaleX (no rotate)', () => {
    const shimmer = chatMessagesCss.match(/@keyframes svg-leg-blur-shimmer\s*\{[\s\S]*?\}/);
    expect(shimmer).not.toBeNull();
    expect(shimmer[0]).toContain('translateX');
    expect(shimmer[0]).toContain('scaleX');
    expect(shimmer[0]).not.toContain('rotate');
  });
});

// =====================================================================
// CSS: speed variant styles (four tiers)
// =====================================================================
describe('CSS: speed variant styles (four tiers)', () => {
  it('has speed-fast class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-fast');
  });

  it('has speed-turbo class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-turbo');
  });

  it('has speed-crazy class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-crazy');
  });

  it('has all bounce keyframes', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-fast');
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-turbo');
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-crazy');
  });

  it('speed-fast makes legs faster (0.25s)', () => {
    const fastBlock = chatMessagesCss.match(/speed-fast[\s\S]*?speed-turbo/);
    expect(fastBlock).not.toBeNull();
    expect(fastBlock[0]).toContain('animation-duration: 0.25s');
  });
});

// =====================================================================
// CSS: 20% larger cat via scale(1.2)
// =====================================================================
describe('CSS: cat scaled up 20%', () => {
  it('svg-running-cat has scale(1.2) in transform', () => {
    expect(chatMessagesCss).toMatch(/\.svg-running-cat\s*\{[^}]*scale\(1\.2\)/);
  });

  it('bounce keyframes include scale(1.2)', () => {
    const bounce = chatMessagesCss.match(/@keyframes svg-cat-bounce\s*\{[\s\S]*?\}/);
    expect(bounce).not.toBeNull();
    expect(bounce[0]).toContain('scale(1.2)');
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

  it('has .svg-cat-leg-blur-inner style (hidden by default)', () => {
    expect(chatMessagesCss).toContain('.svg-cat-leg-blur-inner');
    const blurInnerRule = chatMessagesCss.match(/\.svg-cat-leg-blur-inner\s*\{([^}]*)\}/);
    expect(blurInnerRule).not.toBeNull();
    expect(blurInnerRule[1]).toContain('opacity: 0');
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
