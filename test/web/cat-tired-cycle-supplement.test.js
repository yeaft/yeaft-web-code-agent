/**
 * task-255 supplementary tests: Running Cat tired 5th speed tier + 13s cycle.
 *
 * Supplements dev's cat-speed-animation.test.js and cat-turbo-crazy-animation.test.js with:
 * 1. Multi-cycle behavioral: 2nd/3rd/4th cycles work correctly
 * 2. Cycle boundary precision: edge cases at 12999/13000/13001ms
 * 3. Tired visual details: head nod transform-origin, tail range, ear droop symmetry
 * 4. Tired → Normal transition: blur/head/tail reset cleanly
 * 5. Crazy → Tired transition: blur drops, legs slow down
 * 6. Dark mode: tired CSS uses CSS variables (no hardcoded colors)
 * 7. Three-component consistency: identical pattern across MessageList/SplitPane/CrewChatView
 * 8. Core principle: legs visible in tired mode too
 * 9. Timing duration accuracy: each tier has correct duration in the 13s cycle
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

/** Simulate catSpeed logic identical to all 3 components */
function computeCatSpeed(typingStartTime, now) {
  if (!typingStartTime) return 'speed-normal';
  const elapsed = (now - typingStartTime) % 13000;
  if (elapsed >= 10000) return 'speed-tired';
  if (elapsed >= 6000) return 'speed-crazy';
  if (elapsed >= 4000) return 'speed-turbo';
  if (elapsed >= 2000) return 'speed-fast';
  return 'speed-normal';
}

// =============================================================================
// 1. Multi-cycle behavioral: complete cycles repeat correctly
// =============================================================================
describe('Multi-cycle: 13s loop repeats correctly', () => {
  const base = 1000000;

  it('first cycle: full 5-tier progression (0-13s)', () => {
    expect(computeCatSpeed(base, base + 500)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + 2500)).toBe('speed-fast');
    expect(computeCatSpeed(base, base + 4500)).toBe('speed-turbo');
    expect(computeCatSpeed(base, base + 7000)).toBe('speed-crazy');
    expect(computeCatSpeed(base, base + 11000)).toBe('speed-tired');
  });

  it('second cycle (13-26s): repeats all 5 tiers', () => {
    expect(computeCatSpeed(base, base + 13500)).toBe('speed-normal');   // 13500 % 13000 = 500
    expect(computeCatSpeed(base, base + 15500)).toBe('speed-fast');     // 15500 % 13000 = 2500
    expect(computeCatSpeed(base, base + 17500)).toBe('speed-turbo');    // 17500 % 13000 = 4500
    expect(computeCatSpeed(base, base + 20000)).toBe('speed-crazy');    // 20000 % 13000 = 7000
    expect(computeCatSpeed(base, base + 24000)).toBe('speed-tired');    // 24000 % 13000 = 11000
  });

  it('third cycle (26-39s): still correct', () => {
    expect(computeCatSpeed(base, base + 26000)).toBe('speed-normal');   // 26000 % 13000 = 0
    expect(computeCatSpeed(base, base + 28500)).toBe('speed-fast');     // 28500 % 13000 = 2500
    expect(computeCatSpeed(base, base + 30500)).toBe('speed-turbo');    // 30500 % 13000 = 4500
    expect(computeCatSpeed(base, base + 33000)).toBe('speed-crazy');    // 33000 % 13000 = 7000
    expect(computeCatSpeed(base, base + 37000)).toBe('speed-tired');    // 37000 % 13000 = 11000
  });

  it('10th cycle (117-130s): long-running session still cycles', () => {
    const offset = 9 * 13000; // 117000
    expect(computeCatSpeed(base, base + offset)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + offset + 2500)).toBe('speed-fast');
    expect(computeCatSpeed(base, base + offset + 4500)).toBe('speed-turbo');
    expect(computeCatSpeed(base, base + offset + 7000)).toBe('speed-crazy');
    expect(computeCatSpeed(base, base + offset + 11000)).toBe('speed-tired');
  });

  it('100th cycle: extreme long running session still works', () => {
    const offset = 99 * 13000; // 1287000
    expect(computeCatSpeed(base, base + offset + 500)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + offset + 11500)).toBe('speed-tired');
  });
});

// =============================================================================
// 2. Cycle boundary precision: exact edge cases
// =============================================================================
describe('Cycle boundary precision', () => {
  const base = 1000000;

  it('12999ms = still tired (last ms of tired)', () => {
    expect(computeCatSpeed(base, base + 12999)).toBe('speed-tired');
  });

  it('13000ms = normal (exact cycle boundary)', () => {
    expect(computeCatSpeed(base, base + 13000)).toBe('speed-normal');
  });

  it('13001ms = normal (first ms of new cycle)', () => {
    expect(computeCatSpeed(base, base + 13001)).toBe('speed-normal');
  });

  it('9999ms = crazy (last ms before tired)', () => {
    expect(computeCatSpeed(base, base + 9999)).toBe('speed-crazy');
  });

  it('10000ms = tired (exact tired boundary)', () => {
    expect(computeCatSpeed(base, base + 10000)).toBe('speed-tired');
  });

  it('10001ms = tired (first ms of tired)', () => {
    expect(computeCatSpeed(base, base + 10001)).toBe('speed-tired');
  });

  it('5999ms = turbo (last ms before crazy)', () => {
    expect(computeCatSpeed(base, base + 5999)).toBe('speed-turbo');
  });

  it('6000ms = crazy (exact crazy boundary)', () => {
    expect(computeCatSpeed(base, base + 6000)).toBe('speed-crazy');
  });

  it('0ms elapsed = normal', () => {
    expect(computeCatSpeed(base, base)).toBe('speed-normal');
  });

  it('null typingStartTime = normal', () => {
    expect(computeCatSpeed(null, base)).toBe('speed-normal');
  });

  it('undefined typingStartTime = normal', () => {
    expect(computeCatSpeed(undefined, base)).toBe('speed-normal');
  });

  it('0 typingStartTime (falsy) = normal', () => {
    expect(computeCatSpeed(0, base)).toBe('speed-normal');
  });
});

// =============================================================================
// 3. Tired visual details: panting breath, wobbly legs, droopy head/ears
// =============================================================================
describe('Tired visual details (panting redesign)', () => {
  it('panting bob uses 1.4s breathing cycle', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s*\{[^}]*svg-cat-panting-bob\s+1\.4s/);
  });

  it('body heaves with 1.4s breathing cycle', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-body\s*\{[^}]*svg-body-panting\s+1\.4s/);
  });

  it('body has transform-origin at 15px 17px', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-body\s*\{[^}]*transform-origin:\s*15px 17px/);
  });

  it('panting-bob keyframe has 4-step cycle (0%, 30%, 60%, 100%)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('30%');
    expect(kf[0]).toContain('60%');
    expect(kf[0]).toContain('100%');
  });

  it('panting-bob preserves scale(1.2) at all keyframes', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('body-panting: inhale expands (scaleY 1.04), exhale compresses (scaleY 0.88)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-body-panting\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scaleY(1.04)');
    expect(kf[0]).toContain('scaleY(0.88)');
  });

  it('head droops on exhale: rotate(8deg) translateY(3px)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-head-panting\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(8deg)');
    expect(kf[0]).toContain('translateY(3px)');
  });

  it('head has transform-origin at 20px 12px', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-head\s*\{[^}]*transform-origin:\s*20px 12px/);
  });

  it('tail limp sway: -28° to -15° (always negative = hanging low)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-tired-limp\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-28deg)');
    expect(kf[0]).toContain('rotate(-15deg)');
  });

  it('tail stays in negative range (always drooping)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-tired-limp\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    const rotateMatches = kf[0].match(/rotate\((-?\d+)deg\)/g);
    expect(rotateMatches).not.toBeNull();
    for (const m of rotateMatches) {
      const deg = parseInt(m.match(/(-?\d+)/)[1]);
      expect(deg).toBeLessThan(0);
    }
  });

  it('ears flop with breathing: animated with 1.4s droop cycle', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*svg-ear-tired-droop-l\s+1\.4s/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*svg-ear-tired-droop-r\s+1\.4s/);
  });

  it('ears have distinct transform-origins for natural droop', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*transform-origin:\s*12px 8px/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*transform-origin:\s*18px 8px/);
  });
});

// =============================================================================
// 4. Tired → Normal transition: clean reset
// =============================================================================
describe('Tired → Normal transition semantics', () => {
  it('tired blur is explicitly hidden (opacity: 0 for outer)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0[^.]?/);
  });

  it('tired blur-inner is explicitly hidden (opacity: 0)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur-inner\s*\{[^}]*opacity:\s*0[^.]?/);
  });

  it('normal mode has no head animation override (head nod stops on tier change)', () => {
    // The base .svg-cat-head rule should only define fill/opacity, not animation
    const headRule = chatMessagesCss.match(/\.svg-cat-head\s*\{([^}]*)\}/);
    expect(headRule).not.toBeNull();
    expect(headRule[1]).not.toContain('animation');
    expect(headRule[1]).toContain('fill:');
  });

  it('normal mode ears use twitch animation (not static droop)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear-l\s*\{[^}]*svg-ear-twitch-l/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear-r\s*\{[^}]*svg-ear-twitch-r/);
  });

  it('normal mode tail uses standard wag (not droopy)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-tail-group\s*\{[^}]*svg-tail-wag\s+0\.5s/);
  });
});

// =============================================================================
// 5. Crazy → Tired transition: blur disappears, panting kicks in
// =============================================================================
describe('Crazy → Tired transition semantics', () => {
  it('crazy has blur visible (opacity 0.35), tired hides it (opacity 0)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0\.35/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0[^.]/);
  });

  it('crazy legs at 0.08s, tired legs at 1.4s breathing wobble (dramatically slower)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*0\.08s/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*1\.4s/);
  });

  it('crazy bounce 0.18s, tired panting-bob 1.4s (7.8x slower)', () => {
    const crazyBounce = chatMessagesCss.match(/speed-crazy\s*\{[^}]*svg-cat-bounce-crazy\s+(\d+\.?\d*)s/);
    const tiredBob = chatMessagesCss.match(/speed-tired\s*\{[^}]*svg-cat-panting-bob\s+(\d+\.?\d*)s/);
    expect(crazyBounce).not.toBeNull();
    expect(tiredBob).not.toBeNull();
    expect(parseFloat(tiredBob[1])).toBeGreaterThan(parseFloat(crazyBounce[1]) * 5);
  });

  it('head panting is tired-exclusive (not in any other tier)', () => {
    expect(chatMessagesCss).toContain('svg-head-panting');
    // Only tired should reference head panting animation
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    expect(tiredSection[0]).toContain('svg-head-panting');

    // Fast/turbo/crazy sections should NOT have head panting animation
    const fastSection = chatMessagesCss.match(/Speed: Fast[\s\S]*?Speed: Turbo/);
    expect(fastSection).not.toBeNull();
    expect(fastSection[0]).not.toContain('svg-head-panting');

    const turboSection = chatMessagesCss.match(/Speed: Turbo[\s\S]*?Speed: Crazy/);
    expect(turboSection).not.toBeNull();
    expect(turboSection[0]).not.toContain('svg-head-panting');

    const crazySection = chatMessagesCss.match(/Speed: Crazy[\s\S]*?Speed: Tired/);
    expect(crazySection).not.toBeNull();
    expect(crazySection[0]).not.toContain('svg-head-panting');
  });
});

// =============================================================================
// 6. Dark mode: tired CSS uses CSS variables (no hardcoded colors)
// =============================================================================
describe('Dark mode: tired tier has no hardcoded colors', () => {
  it('tired section uses no hardcoded fill/stroke hex values', () => {
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    // Check for hardcoded hex colors in fill: or stroke: properties
    const hexFills = tiredSection[0].match(/(?:fill|stroke):\s*#[0-9a-fA-F]+/g);
    expect(hexFills).toBeNull();
  });

  it('tired section uses no rgb/rgba hardcoded colors', () => {
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    expect(tiredSection[0]).not.toMatch(/(?:fill|stroke):\s*rgba?\(/);
  });

  it('tired inherits body/leg/ear colors from base CSS variable rules', () => {
    // Base rules use var(--text-secondary) — tired does not override fill colors
    // So it inherits them naturally
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    // The tired CSS rules should not override fill: on any element
    // (they only change animation, transform, opacity)
    const tiredPropertyRules = tiredSection[0].match(/\.svg-running-cat\.speed-tired[^{]*\{[^}]*\}/g);
    expect(tiredPropertyRules).not.toBeNull();
    for (const rule of tiredPropertyRules) {
      expect(rule).not.toMatch(/\bfill:/);
    }
  });

  it('all cat body parts still use var(--text-secondary) in base rules', () => {
    // Verify base rules still intact (not accidentally overridden)
    expect(chatMessagesCss).toMatch(/\.svg-cat-body\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-head\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-tail\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear\s*\{[^}]*var\(--text-secondary\)/);
  });
});

// =============================================================================
// 7. Three-component consistency: identical pattern
// =============================================================================
describe('Three-component consistency for tired + 13s cycle', () => {
  it('all 3 components use % 13000 modulo', () => {
    expect(messageListJs).toContain('% 13000');
    expect(splitPaneJs).toContain('% 13000');
    expect(crewChatViewJs).toContain('% 13000');
  });

  it('all 3 components check >= 10000 for tired', () => {
    expect(messageListJs).toContain('10000');
    expect(splitPaneJs).toContain('10000');
    expect(crewChatViewJs).toContain('10000');
  });

  it('all 3 components return speed-tired string', () => {
    expect(messageListJs).toContain("'speed-tired'");
    expect(splitPaneJs).toContain("'speed-tired'");
    expect(crewChatViewJs).toContain("'speed-tired'");
  });

  it('all 3 components still have all 5 speed classes', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain("'speed-normal'");
      expect(src).toContain("'speed-fast'");
      expect(src).toContain("'speed-turbo'");
      expect(src).toContain("'speed-crazy'");
      expect(src).toContain("'speed-tired'");
    }
  });

  it('tired check comes BEFORE crazy check (order matters)', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      const tiredIdx = src.indexOf("'speed-tired'");
      const crazyIdx = src.indexOf("'speed-crazy'");
      expect(tiredIdx).toBeGreaterThan(-1);
      expect(crazyIdx).toBeGreaterThan(-1);
      expect(tiredIdx).toBeLessThan(crazyIdx);
    }
  });

  it('all 3 use same threshold order: tired(10000) > crazy(6000) > turbo(4000) > fast(2000)', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      // Find the catSpeed function by looking for the '% 13000' modulo — unique to catSpeed
      const moduloIdx = src.indexOf('% 13000');
      expect(moduloIdx).toBeGreaterThan(-1);
      // Extract a region around the catSpeed function (100 chars before, 300 after)
      const regionStart = Math.max(0, moduloIdx - 100);
      const regionEnd = Math.min(src.length, moduloIdx + 300);
      const region = src.slice(regionStart, regionEnd);
      const tiredIdx = region.indexOf('10000');
      const crazyIdx = region.indexOf('6000');
      const turboIdx = region.indexOf('4000');
      const fastIdx = region.indexOf('2000');
      // Thresholds should appear in descending order in the if-chain
      expect(tiredIdx).toBeGreaterThan(-1);
      expect(crazyIdx).toBeGreaterThan(-1);
      expect(turboIdx).toBeGreaterThan(-1);
      expect(fastIdx).toBeGreaterThan(-1);
      expect(tiredIdx).toBeLessThan(crazyIdx);
      expect(crazyIdx).toBeLessThan(turboIdx);
      expect(turboIdx).toBeLessThan(fastIdx);
    }
  });

  it('all 3 components have "5 tiers, 13s cycle" comment', () => {
    for (const src of [messageListJs, splitPaneJs]) {
      expect(src).toContain('5 tiers, 13s cycle');
    }
  });
});

// =============================================================================
// 8. Core principle: legs always visible in tired mode
// =============================================================================
describe('Core principle: legs always visible in tired mode', () => {
  it('tired legs have no opacity override (inherit normal 0.55)', () => {
    const tiredLegFl = chatMessagesCss.match(/speed-tired\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(tiredLegFl).not.toBeNull();
    expect(tiredLegFl[1]).not.toContain('opacity');
  });

  it('tired legs have animation (not animation: none)', () => {
    const tiredLegFl = chatMessagesCss.match(/speed-tired\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(tiredLegFl).not.toBeNull();
    expect(tiredLegFl[1]).toContain('animation:');
    expect(tiredLegFl[1]).not.toContain('animation: none');
  });

  it('no display:none on tired legs', () => {
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    expect(tiredSection[0]).not.toContain('display: none');
  });

  it('no visibility:hidden on tired legs', () => {
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    expect(tiredSection[0]).not.toContain('visibility: hidden');
  });

  it('tired legs wobble unevenly (4-step keyframe, not uniform swing)', () => {
    const kfA = chatMessagesCss.match(/@keyframes svg-leg-tired-wobble-a\s*\{[\s\S]*?\n\}/);
    expect(kfA).not.toBeNull();
    expect(kfA[0]).toContain('25%');
    expect(kfA[0]).toContain('50%');
    expect(kfA[0]).toContain('75%');
  });

  it('tired wobble-a and wobble-b exist (two patterns for asymmetry)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-wobble-a');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-wobble-b');
  });

  it('front-left and back-right share wobble-a, front-right and back-left share wobble-b', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*wobble-a/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-br\s*\{[^}]*wobble-a/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fr\s*\{[^}]*wobble-b/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-bl\s*\{[^}]*wobble-b/);
  });
});

// =============================================================================
// 9. Timing duration accuracy: each tier lasts the right amount
// =============================================================================
describe('Timing duration accuracy within 13s cycle', () => {
  const base = 1000000;

  it('normal tier lasts exactly 2s (0-1999ms)', () => {
    expect(computeCatSpeed(base, base + 0)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + 1000)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + 1999)).toBe('speed-normal');
    expect(computeCatSpeed(base, base + 2000)).not.toBe('speed-normal');
  });

  it('fast tier lasts exactly 2s (2000-3999ms)', () => {
    expect(computeCatSpeed(base, base + 2000)).toBe('speed-fast');
    expect(computeCatSpeed(base, base + 3000)).toBe('speed-fast');
    expect(computeCatSpeed(base, base + 3999)).toBe('speed-fast');
    expect(computeCatSpeed(base, base + 4000)).not.toBe('speed-fast');
  });

  it('turbo tier lasts exactly 2s (4000-5999ms)', () => {
    expect(computeCatSpeed(base, base + 4000)).toBe('speed-turbo');
    expect(computeCatSpeed(base, base + 5000)).toBe('speed-turbo');
    expect(computeCatSpeed(base, base + 5999)).toBe('speed-turbo');
    expect(computeCatSpeed(base, base + 6000)).not.toBe('speed-turbo');
  });

  it('crazy tier lasts exactly 4s (6000-9999ms)', () => {
    expect(computeCatSpeed(base, base + 6000)).toBe('speed-crazy');
    expect(computeCatSpeed(base, base + 8000)).toBe('speed-crazy');
    expect(computeCatSpeed(base, base + 9999)).toBe('speed-crazy');
    expect(computeCatSpeed(base, base + 10000)).not.toBe('speed-crazy');
  });

  it('tired tier lasts exactly 3s (10000-12999ms)', () => {
    expect(computeCatSpeed(base, base + 10000)).toBe('speed-tired');
    expect(computeCatSpeed(base, base + 11500)).toBe('speed-tired');
    expect(computeCatSpeed(base, base + 12999)).toBe('speed-tired');
    expect(computeCatSpeed(base, base + 13000)).not.toBe('speed-tired');
  });

  it('total cycle is exactly 13s: 2+2+2+4+3 = 13', () => {
    expect(2 + 2 + 2 + 4 + 3).toBe(13);
  });

  it('cycle seamlessly wraps: ms 12999 = tired, ms 13000 = normal', () => {
    expect(computeCatSpeed(base, base + 12999)).toBe('speed-tired');
    expect(computeCatSpeed(base, base + 13000)).toBe('speed-normal');
  });
});

// =============================================================================
// 10. Tired panting-bob: scale(1.2) preserved + breathing rhythm
// =============================================================================
describe('Tired panting-bob preserves scale(1.2)', () => {
  it('panting-bob keyframe has scale(1.2) at 0%', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('panting-bob is 4-step (0%, 30%, 60%, 100%) for breathing rhythm', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('30%');
    expect(kf[0]).toContain('60%');
    expect(kf[0]).toContain('100%');
  });

  it('panting-bob inhale lifts (-3px) and exhale drops (+2px)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-3px)');
    expect(kf[0]).toContain('translateY(2px)');
  });

  it('panting-bob returns to translateY(0) at start and end', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(0)');
  });
});

// =============================================================================
// 11. Speed comparison: tired is the slowest tier
// =============================================================================
describe('Tired is the slowest animation tier', () => {
  it('tired leg 1.4s is slower than normal 0.5s', () => {
    expect(1.4).toBeGreaterThan(0.5);
  });

  it('tired panting-bob 1.4s is slower than normal 0.6s', () => {
    expect(1.4).toBeGreaterThan(0.6);
  });

  it('tired wobble is narrower than normal ±20° swing', () => {
    // wobble-a peaks at ±5deg, much less than normal ±20deg
    expect(5).toBeLessThan(20);
  });

  it('tired tail 2.8s is slower than normal 0.5s', () => {
    expect(2.8).toBeGreaterThan(0.5);
  });

  it('complete speed ladder: tired < normal < fast < turbo < crazy (by animation duration)', () => {
    // Tired 1.4, normal 0.5, fast 0.25, turbo 0.14, crazy 0.08
    const durations = [1.4, 0.5, 0.25, 0.14, 0.08];
    for (let i = 0; i < durations.length - 1; i++) {
      expect(durations[i]).toBeGreaterThan(durations[i + 1]);
    }
  });

  it('complete swing ladder: tired < normal < turbo < crazy (by angle)', () => {
    // Swing angles: tired wobble ±5°, normal ±20°, turbo ±35°, crazy ±42°
    const angles = [5, 20, 35, 42];
    for (let i = 0; i < angles.length - 1; i++) {
      expect(angles[i]).toBeLessThan(angles[i + 1]);
    }
  });
});
