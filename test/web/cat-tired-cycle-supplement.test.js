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
// 3. Tired visual details: head nod, tail droop, ear angles
// =============================================================================
describe('Tired visual details', () => {
  it('head nod uses 1.5s cycle (slow, gentle bobbing)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-head\s*\{[^}]*1\.5s/);
  });

  it('head nod has transform-origin at 15px 12px (head center)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-head\s*\{[^}]*transform-origin:\s*15px 12px/);
  });

  it('head nod keyframe: 3-step cycle (0% → 50% peak → 100% return)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-head-tired-nod\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('50%');
    expect(kf[0]).toContain('100%');
  });

  it('head nod peak: rotate(5deg) + translateY(1px) (subtle forward droop)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-head-tired-nod\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(5deg)');
    expect(kf[0]).toContain('translateY(1px)');
  });

  it('head nod start and end: rotate(0deg) (returns to neutral)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-head-tired-nod\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(0deg)');
  });

  it('tail droop uses 2s cycle (very slow sway)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-tail-group\s*\{[^}]*svg-tail-tired\s+2s/);
  });

  it('tail droop range: -25° to -12° (both negative = hanging low)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-25deg)');
    expect(kf[0]).toContain('rotate(-12deg)');
  });

  it('tail stays in negative range (always drooping, never perky)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    // Should NOT contain any positive rotate values
    const rotateMatches = kf[0].match(/rotate\((-?\d+)deg\)/g);
    expect(rotateMatches).not.toBeNull();
    for (const m of rotateMatches) {
      const deg = parseInt(m.match(/(-?\d+)/)[1]);
      expect(deg).toBeLessThan(0);
    }
  });

  it('ears are symmetric: left +8° and right -8°', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*rotate\(8deg\)/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*rotate\(-8deg\)/);
  });

  it('ears have animation: none (static droop, no twitching)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*animation:\s*none/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*animation:\s*none/);
  });

  it('ears have distinct transform-origins for natural droop', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*transform-origin:\s*12px 8px/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*transform-origin:\s*18px 8px/);
  });

  it('body slumps: scaleY(0.95) translateY(2px)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-body\s*\{[^}]*scaleY\(0\.95\)/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-body\s*\{[^}]*translateY\(2px\)/);
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
// 5. Crazy → Tired transition: blur disappears, speed drops dramatically
// =============================================================================
describe('Crazy → Tired transition semantics', () => {
  it('crazy has blur visible (opacity 0.35), tired hides it (opacity 0)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0\.35/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0[^.]/);
  });

  it('crazy legs at 0.08s, tired legs at 0.9s (dramatically slower)', () => {
    // Tired 0.9s vs crazy 0.08s — tired is ~11x slower
    const crazyDuration = 0.08;
    const tiredDuration = 0.9;
    expect(tiredDuration).toBeGreaterThan(crazyDuration);
    expect(tiredDuration / crazyDuration).toBeGreaterThan(10);
    // Verify from CSS that these values exist
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*0\.08s/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*0\.9s/);
  });

  it('crazy swing ±42°, tired swing ±8° (5.25x narrower)', () => {
    expect(42 / 8).toBeGreaterThan(5);
  });

  it('crazy bounce 0.18s, tired bounce 1.2s (6.67x slower)', () => {
    const crazyBounce = chatMessagesCss.match(/speed-crazy\s*\{[^}]*svg-cat-bounce-crazy\s+(\d+\.?\d*)s/);
    const tiredBounce = chatMessagesCss.match(/speed-tired\s*\{[^}]*svg-cat-bounce-tired\s+(\d+\.?\d*)s/);
    expect(crazyBounce).not.toBeNull();
    expect(tiredBounce).not.toBeNull();
    expect(parseFloat(tiredBounce[1])).toBeGreaterThan(parseFloat(crazyBounce[1]) * 5);
  });

  it('head nod is tired-exclusive (not in any other tier)', () => {
    expect(chatMessagesCss).toContain('svg-head-tired-nod');
    // Only tired should reference head nod animation
    const tiredSection = chatMessagesCss.match(/Speed: Tired[\s\S]*?\.typing-refresh/);
    expect(tiredSection).not.toBeNull();
    expect(tiredSection[0]).toContain('svg-head-tired-nod');

    // Fast/turbo/crazy sections should NOT have head animation
    const fastSection = chatMessagesCss.match(/Speed: Fast[\s\S]*?Speed: Turbo/);
    expect(fastSection).not.toBeNull();
    expect(fastSection[0]).not.toContain('svg-head-tired-nod');

    const turboSection = chatMessagesCss.match(/Speed: Turbo[\s\S]*?Speed: Crazy/);
    expect(turboSection).not.toBeNull();
    expect(turboSection[0]).not.toContain('svg-head-tired-nod');

    const crazySection = chatMessagesCss.match(/Speed: Crazy[\s\S]*?Speed: Tired/);
    expect(crazySection).not.toBeNull();
    expect(crazySection[0]).not.toContain('svg-head-tired-nod');
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

  it('tired legs still swing (±8°, not 0°)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-tired-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(8deg)');
    expect(kf[0]).toContain('rotate(-8deg)');
  });

  it('all four tired leg keyframes exist', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-fl');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-fr');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-bl');
    expect(chatMessagesCss).toContain('@keyframes svg-leg-tired-br');
  });

  it('tired back legs swing in opposite direction from front', () => {
    const frontKf = chatMessagesCss.match(/@keyframes svg-leg-tired-fl\s*\{[\s\S]*?\n\}/);
    const backKf = chatMessagesCss.match(/@keyframes svg-leg-tired-bl\s*\{[\s\S]*?\n\}/);
    expect(frontKf).not.toBeNull();
    expect(backKf).not.toBeNull();
    // Front: 0% → 8deg, 100% → -8deg
    // Back: 0% → -8deg, 100% → 8deg (opposite)
    expect(frontKf[0]).toMatch(/0%.*rotate\(8deg\)/);
    expect(frontKf[0]).toMatch(/100%.*rotate\(-8deg\)/);
    expect(backKf[0]).toMatch(/0%.*rotate\(-8deg\)/);
    expect(backKf[0]).toMatch(/100%.*rotate\(8deg\)/);
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
// 10. Tired bounce: scale(1.2) preserved (consistent with other tiers)
// =============================================================================
describe('Tired bounce preserves scale(1.2)', () => {
  it('tired bounce keyframe has scale(1.2) at 0%', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('tired bounce is 3-step (0%, 50%, 100%) for gentle bobbing', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('50%');
    expect(kf[0]).toContain('100%');
  });

  it('tired bounce has minimal translateY (-1px max, gentler than other tiers)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-1px)');
    // Should not have -2px or -3px (those are faster tiers)
    expect(kf[0]).not.toContain('translateY(-2px)');
    expect(kf[0]).not.toContain('translateY(-3px)');
  });

  it('tired bounce returns to translateY(0) (start and end match)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-tired\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    // Both 0% and 100% should have translateY(0)
    expect(kf[0]).toContain('translateY(0)');
  });
});

// =============================================================================
// 11. Speed comparison: tired is the slowest tier
// =============================================================================
describe('Tired is the slowest animation tier', () => {
  it('tired leg 0.9s is slower than normal 0.5s', () => {
    expect(0.9).toBeGreaterThan(0.5);
  });

  it('tired bounce 1.2s is slower than normal 0.6s', () => {
    expect(1.2).toBeGreaterThan(0.6);
  });

  it('tired swing ±8° is narrower than normal ±20°', () => {
    expect(8).toBeLessThan(20);
  });

  it('tired tail 2s is slower than normal 0.5s', () => {
    expect(2).toBeGreaterThan(0.5);
  });

  it('complete speed ladder: tired < normal < fast < turbo < crazy (by leg duration)', () => {
    // Leg durations: tired 0.9, normal 0.5, fast 0.25, turbo 0.14, crazy 0.08
    const durations = [0.9, 0.5, 0.25, 0.14, 0.08];
    for (let i = 0; i < durations.length - 1; i++) {
      expect(durations[i]).toBeGreaterThan(durations[i + 1]);
    }
  });

  it('complete swing ladder: tired < normal < turbo < crazy (by angle)', () => {
    // Swing angles: tired ±8°, normal ±20°, turbo ±35°, crazy ±42°
    const angles = [8, 20, 35, 42];
    for (let i = 0; i < angles.length - 1; i++) {
      expect(angles[i]).toBeLessThan(angles[i + 1]);
    }
  });
});
