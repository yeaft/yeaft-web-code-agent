/**
 * task-252/255 supplementary tests: Running Cat five-speed redesign with tired cycle.
 *
 * Core principle: LEGS ALWAYS VISIBLE in all five tiers.
 * Test scenarios:
 * 1. Turbo (4-6s): real legs at 0.14s/±35° with faint blur trail
 * 2. Crazy (6-10s): semi-transparent legs at 0.08s/±42° with wobble blur (no rotate)
 * 3. Five-speed 0-2-4-6-10-13s progression with 13s cycle
 * 4. scale(1.2) preserved across all tiers
 * 5. Tired (10-13s): slow legs 0.9s/±8°, head nod, droopy tail/ears
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
// 1. Turbo: real legs with increased swing + faint blur trail
// =============================================================================
describe('Scenario 1: Turbo legs visible with blur trail', () => {
  it('turbo leg animation uses dedicated keyframes at 0.14s', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fl\s*\{[^}]*svg-leg-turbo-fl\s+0\.14s/);
  });

  it('turbo legs have ±35° swing (wider than fast ±20°)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-turbo-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(35deg)');
    expect(kf[0]).toContain('rotate(-35deg)');
  });

  it('turbo blur trail has low opacity (0.2) — not replacing legs', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0\.2/);
  });

  it('turbo blur uses trail animation (scaleX pulse), not shimmer/rotate', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur[\s\S]*?svg-leg-blur-trail/);
    // Trail keyframe should have scaleX but no rotate
    const kf = chatMessagesCss.match(/@keyframes svg-leg-blur-trail\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scaleX');
    expect(kf[0]).not.toContain('rotate');
  });

  it('turbo ears flatten in the wind (svg-ear-flatten)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-ear-l[\s\S]*?svg-ear-flatten/);
  });

  it('turbo body crouches: scaleY(0.87)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-body[\s\S]*?scaleY\(0\.87\)/);
  });
});

// =============================================================================
// 2. Crazy: semi-transparent legs + wobble blur (NO rotate)
// =============================================================================
describe('Scenario 2: Crazy semi-transparent legs with wobble', () => {
  it('crazy legs are semi-transparent (opacity: 0.3), not hidden', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*opacity:\s*0\.3/);
  });

  it('crazy legs run at 0.08s with ±42° swing', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*0\.08s/);
    const kf = chatMessagesCss.match(/@keyframes svg-leg-crazy-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(42deg)');
    expect(kf[0]).toContain('rotate(-42deg)');
  });

  it('crazy blur uses wobble (scaleX/scaleY), NOT rotate', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\s*\{[^}]*svg-leg-blur-wobble\b/);
    const kf = chatMessagesCss.match(/@keyframes svg-leg-blur-wobble\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scaleX');
    expect(kf[0]).toContain('scaleY');
    expect(kf[0]).not.toContain('rotate');
  });

  it('crazy inner blur uses reverse wobble for layered effect', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?svg-leg-blur-wobble-reverse/);
  });

  it('crazy body extremely crouched + stretched: scaleY(0.82) scaleX(1.03)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[\s\S]*?scaleY\(0\.82\)/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[\s\S]*?scaleX\(1\.03\)/);
  });

  it('crazy tail wag is frantic at 0.12s', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-tail-group[\s\S]*?svg-tail-wag-crazy\s+0\.12s/);
  });

  it('crazy ears flatten at 0.18s', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-ear-l[\s\S]*?svg-ear-flatten\s+0\.18s/);
  });

  it('no rotate animation in crazy mode (no svg-leg-rotate)', () => {
    const crazySection = chatMessagesCss.match(/Speed: Crazy[\s\S]*?Speed: Tired/);
    expect(crazySection).not.toBeNull();
    expect(crazySection[0]).not.toContain('svg-leg-rotate');
  });
});

// =============================================================================
// 2b. Blur ellipse positions within body bounds
// =============================================================================
describe('Scenario 2b: Blur ellipses within body bounds', () => {
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
    const blurs = messageListJs.match(/svg-cat-leg-blur[^"]*"[^/]*cy="(\d+)"/g);
    expect(blurs).not.toBeNull();
    for (const m of blurs) {
      const cy = m.match(/cy="(\d+)"/);
      expect(parseInt(cy[1])).toBe(22);
    }
  });

  it('outer and inner pairs are symmetric around body center (x=15)', () => {
    expect(15 - 12.5).toBe(17.5 - 15);
    expect(15 - 14).toBe(16 - 15);
  });
});

// =============================================================================
// 3. Five-speed transitions: 0-2-4-6-10-13s cycle
// =============================================================================
describe('Scenario 3: Five-speed 13s cycle transitions', () => {
  it('normal mode: standard leg animation (0.5s)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-fl\s*\{[^}]*animation:.*0\.5s/);
  });

  it('fast mode (2-4s): legs speed up to 0.25s', () => {
    expect(chatMessagesCss).toMatch(/speed-fast.*animation-duration:\s*0\.25s/);
  });

  it('turbo mode (4-6s): legs at 0.14s with ±35° swing + faint blur trail', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fl\s*\{[^}]*0\.14s/);
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0\.2/);
  });

  it('crazy mode (6-10s): legs at 0.08s semi-transparent + wobble blur', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*0\.08s[^}]*opacity:\s*0\.3/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\s*\{[^}]*svg-leg-blur-wobble\b/);
  });

  it('tired mode (10-13s): slow legs at 0.9s, blur hidden', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*0\.9s/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0/);
  });

  it('bounce durations decrease with speed: normal > fast > turbo > crazy', () => {
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

  it('tired bounce is slowest (1.2s > normal 0.6s)', () => {
    const tiredMatch = chatMessagesCss.match(/speed-tired\s*\{[^}]*svg-cat-bounce-tired\s+(\d+\.?\d*)s/);
    expect(tiredMatch).toBeTruthy();
    expect(parseFloat(tiredMatch[1])).toBe(1.2);
  });

  it('catSpeed computed uses correct thresholds in all 3 components', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('10000');
      expect(src).toContain('6000');
      expect(src).toContain('4000');
      expect(src).toContain('2000');
      expect(src).toContain('13000');
      expect(src).toContain("'speed-tired'");
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

  it('tired bounce has scale(1.2)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-tired\s*\{[\s\S]*?\n\}/);
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
      expect(blurs.length).toBe(4);
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

  it('inner blur is not visible in turbo mode (only outer trail)', () => {
    const turboSection = chatMessagesCss.match(/Speed: Turbo[\s\S]*?Speed: Crazy/);
    expect(turboSection).not.toBeNull();
    expect(turboSection[0]).not.toContain('svg-cat-leg-blur-inner');
  });
});
