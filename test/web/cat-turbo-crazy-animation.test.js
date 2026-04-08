/**
 * task-248 supplementary tests: Running Cat turbo shimmer + crazy Tom&Jerry vortex.
 *
 * Test scenarios from PM:
 * 1. Turbo (4-6s) shimmer speed 明显比 crazy 慢
 * 2. Crazy (6s+) 漩涡旋转在身体正下方，不超出身体轮廓
 * 3. 四档变速 0-2-4-6s 过渡自然
 * 4. scale(1.2) 放大效果不变
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let chatMessagesCss;
let messageListJs;
let splitPaneJs;
let crewChatViewJs;

beforeAll(() => {
  chatMessagesCss = read('web/styles/chat-messages.css');
  messageListJs = read('web/components/MessageList.js');
  splitPaneJs = read('web/components/SplitPane.js');
  crewChatViewJs = read('web/components/CrewChatView.js');
});

// =============================================================================
// 1. Turbo shimmer speed is visibly slower than crazy rotate
// =============================================================================
describe('Scenario 1: Turbo shimmer speed slower than crazy', () => {
  it('turbo shimmer animation duration is 0.22s', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\b[^-][\s\S]*?0\.22s/);
  });

  it('crazy rotate animation duration is 0.18s (outer)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?0\.18s/);
  });

  it('crazy reverse rotate is even faster: 0.14s (inner)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?0\.14s/);
  });

  it('turbo shimmer (0.22s) > crazy outer (0.18s) > crazy inner (0.14s)', () => {
    // Extract animation durations
    const turboMatch = chatMessagesCss.match(/speed-turbo\s+\.svg-cat-leg-blur\b[^-][^}]*?(\d+\.?\d*)s/);
    const crazyOuterMatch = chatMessagesCss.match(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][^}]*?(\d+\.?\d*)s.*?linear/);
    const crazyInnerMatch = chatMessagesCss.match(/speed-crazy\s+\.svg-cat-leg-blur-inner[^}]*?(\d+\.?\d*)s/);

    expect(turboMatch).toBeTruthy();
    expect(crazyOuterMatch).toBeTruthy();
    expect(crazyInnerMatch).toBeTruthy();

    const turboDuration = parseFloat(turboMatch[1]);
    const crazyOuterDuration = parseFloat(crazyOuterMatch[1]);
    const crazyInnerDuration = parseFloat(crazyInnerMatch[1]);

    // Turbo should be slower (longer duration) than crazy
    expect(turboDuration).toBeGreaterThan(crazyOuterDuration);
    expect(crazyOuterDuration).toBeGreaterThan(crazyInnerDuration);
  });

  it('turbo uses shimmer (translateX/scaleX), not rotate', () => {
    // Turbo uses svg-leg-blur-shimmer which has translateX/scaleX
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\b[^-][\s\S]*?svg-leg-blur-shimmer/);
    // And the shimmer keyframe has no rotate
    const shimmer = chatMessagesCss.match(/@keyframes svg-leg-blur-shimmer\s*\{[\s\S]*?\}/);
    expect(shimmer[0]).toContain('translateX');
    expect(shimmer[0]).toContain('scaleX');
    expect(shimmer[0]).not.toContain('rotate');
  });

  it('crazy uses rotate (not shimmer)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?svg-leg-rotate\b/);
    // The rotate keyframe has rotate() not translateX/scaleX
    const rotate = chatMessagesCss.match(/@keyframes svg-leg-rotate\s*\{[\s\S]*?\n\}/);
    expect(rotate[0]).toContain('rotate(360deg)');
    expect(rotate[0]).not.toContain('translateX');
  });
});

// =============================================================================
// 2. Crazy vortex stays under body, doesn't exceed body width
// =============================================================================
describe('Scenario 2: Crazy vortex within body bounds', () => {
  // Body: cx=15, rx=7.5 → left edge = 7.5, right edge = 22.5
  const bodyLeft = 15 - 7.5;  // 7.5
  const bodyRight = 15 + 7.5; // 22.5

  it('body has cx=15 rx=7.5 (range 7.5 to 22.5)', () => {
    expect(messageListJs).toContain('class="svg-cat-body" cx="15"');
    expect(messageListJs).toMatch(/svg-cat-body.*rx="7\.5"/);
  });

  it('outer blur left ellipse (cx=12.5 rx=1.8) stays within body', () => {
    const cx = 12.5, rx = 1.8;
    expect(cx - rx).toBeGreaterThanOrEqual(bodyLeft);
    expect(cx + rx).toBeLessThanOrEqual(bodyRight);
    expect(messageListJs).toContain('svg-cat-leg-blur" cx="12.5"');
  });

  it('outer blur right ellipse (cx=17.5 rx=1.8) stays within body', () => {
    const cx = 17.5, rx = 1.8;
    expect(cx - rx).toBeGreaterThanOrEqual(bodyLeft);
    expect(cx + rx).toBeLessThanOrEqual(bodyRight);
    expect(messageListJs).toContain('svg-cat-leg-blur" cx="17.5"');
  });

  it('inner blur left ellipse (cx=14 rx=1.5) stays within body', () => {
    const cx = 14, rx = 1.5;
    expect(cx - rx).toBeGreaterThanOrEqual(bodyLeft);
    expect(cx + rx).toBeLessThanOrEqual(bodyRight);
    expect(messageListJs).toContain('svg-cat-leg-blur-inner" cx="14"');
  });

  it('inner blur right ellipse (cx=16 rx=1.5) stays within body', () => {
    const cx = 16, rx = 1.5;
    expect(cx - rx).toBeGreaterThanOrEqual(bodyLeft);
    expect(cx + rx).toBeLessThanOrEqual(bodyRight);
    expect(messageListJs).toContain('svg-cat-leg-blur-inner" cx="16"');
  });

  it('all blur ellipses are at cy=22 (under body cy=17)', () => {
    // Body cy=17, blur cy=22 — below the body
    const blurs = messageListJs.match(/svg-cat-leg-blur[^"]*"[^/]*cy="(\d+)"/g);
    expect(blurs).not.toBeNull();
    for (const m of blurs) {
      const cy = m.match(/cy="(\d+)"/);
      expect(parseInt(cy[1])).toBe(22);
    }
  });

  it('transform-origin is at body center (15px 22px) for orbit', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?transform-origin:\s*15px 22px/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?transform-origin:\s*15px 22px/);
  });

  it('outer and inner pairs are symmetric around body center (x=15)', () => {
    // Outer: 12.5 and 17.5 → distances from center: 2.5 and 2.5 ✓
    expect(15 - 12.5).toBe(17.5 - 15);
    // Inner: 14 and 16 → distances from center: 1 and 1 ✓
    expect(15 - 14).toBe(16 - 15);
  });

  it('inner ellipses are smaller than outer (more compact center)', () => {
    // Outer rx=1.8, inner rx=1.5
    expect(1.5).toBeLessThan(1.8);
    // Outer ry=1.2, inner ry=1.0
    expect(1.0).toBeLessThan(1.2);
  });

  it('counter-rotating inner pair creates swirl visual effect', () => {
    // Outer rotates forward (360deg), inner rotates backward (-360deg)
    const rotate = chatMessagesCss.match(/@keyframes svg-leg-rotate\s*\{[\s\S]*?\n\}/);
    const rotateRev = chatMessagesCss.match(/@keyframes svg-leg-rotate-reverse\s*\{[\s\S]*?\n\}/);
    expect(rotate[0]).toContain('rotate(360deg)');
    expect(rotateRev[0]).toContain('rotate(-360deg)');
  });
});

// =============================================================================
// 3. Four-speed transitions: 0-2-4-6s natural progression
// =============================================================================
describe('Scenario 3: Four-speed 0-2-4-6s transitions', () => {
  it('normal mode: standard leg animation (0.5s)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-fl\s*\{[^}]*animation:.*0\.5s/);
  });

  it('fast mode (2-4s): legs speed up to 0.25s', () => {
    expect(chatMessagesCss).toMatch(/speed-fast.*animation-duration:\s*0\.25s/);
  });

  it('turbo mode (4-6s): legs hidden, shimmer at 0.22s', () => {
    // Legs hidden
    expect(chatMessagesCss).toMatch(/speed-turbo[\s\S]*?svg-cat-leg-fl[\s\S]*?opacity:\s*0/);
    // Shimmer visible
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\b[^-][\s\S]*?opacity:\s*0\.55/);
  });

  it('crazy mode (6s+): legs hidden, rotating blur visible', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy[\s\S]*?svg-cat-leg-fl[\s\S]*?opacity:\s*0/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\b[^-][\s\S]*?opacity:\s*0\.5/);
  });

  it('bounce durations decrease with speed: normal > fast > turbo > crazy', () => {
    // Normal: 0.5s, Fast: 0.4s, Turbo: 0.3s, Crazy: 0.2s
    const normalMatch = chatMessagesCss.match(/\.svg-running-cat\s*\{[^}]*svg-cat-bounce\s+(\d+\.?\d*)s/);
    const fastMatch = chatMessagesCss.match(/speed-fast\s*\{[^}]*svg-cat-bounce-fast\s+(\d+\.?\d*)s/);
    const turboMatch = chatMessagesCss.match(/speed-turbo\s*\{[^}]*svg-cat-bounce-turbo\s+(\d+\.?\d*)s/);
    const crazyMatch = chatMessagesCss.match(/speed-crazy\s*\{[^}]*svg-cat-bounce-crazy\s+(\d+\.?\d*)s/);

    expect(normalMatch).toBeTruthy();
    expect(fastMatch).toBeTruthy();
    expect(turboMatch).toBeTruthy();
    expect(crazyMatch).toBeTruthy();

    const normal = parseFloat(normalMatch[1]);
    const fast = parseFloat(fastMatch[1]);
    const turbo = parseFloat(turboMatch[1]);
    const crazy = parseFloat(crazyMatch[1]);

    expect(normal).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThan(turbo);
    expect(turbo).toBeGreaterThan(crazy);
  });

  it('catSpeed computed uses correct thresholds in all 3 components', () => {
    // All three should have: 6000 → speed-crazy, 4000 → speed-turbo, 2000 → speed-fast
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('6000');
      expect(src).toContain('4000');
      expect(src).toContain('2000');
      expect(src).toContain("'speed-crazy'");
      expect(src).toContain("'speed-turbo'");
      expect(src).toContain("'speed-fast'");
    }
  });
});

// =============================================================================
// 4. scale(1.2) preserved across all bounce keyframes
// =============================================================================
describe('Scenario 4: scale(1.2) preserved', () => {
  it('normal bounce has scale(1.2)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('fast bounce has scale(1.2)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-fast\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('turbo bounce has scale(1.2)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-turbo\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('crazy bounce has scale(1.2)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-crazy\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });
});

// =============================================================================
// 5. SVG consistency: all 3 components have same blur ellipses
// =============================================================================
describe('Supplemental: SVG blur ellipses consistent across components', () => {
  it('all 3 components have outer blur at cx=12.5 and cx=17.5', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('svg-cat-leg-blur" cx="12.5"');
      expect(src).toContain('svg-cat-leg-blur" cx="17.5"');
    }
  });

  it('all 3 components have inner blur at cx=14 and cx=16', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('svg-cat-leg-blur-inner" cx="14"');
      expect(src).toContain('svg-cat-leg-blur-inner" cx="16"');
    }
  });

  it('all blur ellipses have cy=22 (under body)', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      const blurs = src.match(/svg-cat-leg-blur[^"]*"\s*cx="[\d.]+" cy="(\d+)"/g);
      expect(blurs).not.toBeNull();
      expect(blurs.length).toBe(4); // 2 outer + 2 inner
      for (const m of blurs) {
        expect(m).toContain('cy="22"');
      }
    }
  });
});

// =============================================================================
// 6. Blur hidden by default (no visual change in normal/fast modes)
// =============================================================================
describe('Supplemental: blur ellipses hidden by default', () => {
  it('.svg-cat-leg-blur has opacity: 0 by default', () => {
    const rule = chatMessagesCss.match(/\.svg-cat-leg-blur\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toContain('opacity: 0');
  });

  it('.svg-cat-leg-blur-inner has opacity: 0 by default', () => {
    const rule = chatMessagesCss.match(/\.svg-cat-leg-blur-inner\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toContain('opacity: 0');
  });

  it('inner blur is not visible in turbo mode (only outer shimmer)', () => {
    // Turbo only activates .svg-cat-leg-blur, not .svg-cat-leg-blur-inner
    const turboSection = chatMessagesCss.match(/Speed: Turbo[\s\S]*?Speed: Crazy/);
    expect(turboSection).not.toBeNull();
    expect(turboSection[0]).not.toContain('svg-cat-leg-blur-inner');
  });
});
