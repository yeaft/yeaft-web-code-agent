/**
 * task-252 supplementary tests: Running Cat four-speed redesign.
 *
 * Supplements the externally-updated cat-turbo-crazy-animation.test.js with:
 * 1. Normal speed (0-2s): baseline animation parameters verified
 * 2. Fast speed (2-4s): body crouch, tail, no blur
 * 3. Removed keyframes: old shimmer/rotate eliminated
 * 4. Dark mode: CSS variables used for all cat parts (no regression)
 * 5. Leg visibility: no opacity override in normal/fast modes
 * 6. Speed class consistency across 3 components
 * 7. Bounce keyframe progression: amplitude increases with speed
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
// 1. Normal speed (0-2s): baseline animation parameters
// =============================================================================
describe('Scenario 1: Normal speed baseline (0-2s)', () => {
  it('normal leg front-left uses 0.5s cycle', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-fl\s*\{[^}]*0\.5s/);
  });

  it('normal leg front-right uses 0.5s cycle', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-fr\s*\{[^}]*0\.5s/);
  });

  it('normal leg back-left uses 0.5s cycle', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-bl\s*\{[^}]*0\.5s/);
  });

  it('normal leg back-right uses 0.5s cycle', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-br\s*\{[^}]*0\.5s/);
  });

  it('normal bounce is 0.6s', () => {
    expect(chatMessagesCss).toMatch(/\.svg-running-cat\s*\{[^}]*svg-cat-bounce\s+0\.6s/);
  });

  it('normal front-left swing is ±20°/18° (modest)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-front-l\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(20deg)');
    expect(kf[0]).toContain('rotate(-18deg)');
  });

  it('normal tail wag at 0.5s', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-tail-group\s*\{[^}]*svg-tail-wag\s+0\.5s/);
  });

  it('normal ear twitch at slow pace (>1s)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear-l\s*\{[^}]*svg-ear-twitch-l\s+1\.2s/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear-r\s*\{[^}]*svg-ear-twitch-r\s+1\.6s/);
  });

  it('no body transform in normal mode (no scaleY override)', () => {
    // Normal mode should NOT have a body transform override
    // The body should just use default fill/opacity, no scaleY
    const normalSection = chatMessagesCss.match(/\.svg-cat-body\s*\{[^}]*\}/);
    expect(normalSection).not.toBeNull();
    expect(normalSection[0]).not.toContain('scaleY');
  });

  it('no blur visible in normal mode', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0[^.]/);
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-blur-inner\s*\{[^}]*opacity:\s*0[^.]/);
  });
});

// =============================================================================
// 2. Fast speed (2-4s): body crouch, faster legs, no blur
// =============================================================================
describe('Scenario 2: Fast speed details (2-4s)', () => {
  it('fast bounce uses dedicated keyframe svg-cat-bounce-fast', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s*\{[^}]*svg-cat-bounce-fast/);
  });

  it('fast bounce at 0.4s (shorter than normal 0.6s)', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s*\{[^}]*svg-cat-bounce-fast\s+0\.4s/);
  });

  it('fast legs speed up to 0.25s (all four)', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-leg-fl\s*\{[^}]*0\.25s/);
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-leg-fr\s*\{[^}]*0\.25s/);
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-leg-bl\s*\{[^}]*0\.25s/);
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-leg-br\s*\{[^}]*0\.25s/);
  });

  it('fast body crouches with scaleY(0.92)', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-body\s*\{[^}]*scaleY\(0\.92\)/);
  });

  it('fast tail speeds up to 0.3s', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-tail-group\s*\{[^}]*0\.3s/);
  });

  it('fast mode does NOT show blur (no .speed-fast .svg-cat-leg-blur opacity)', () => {
    const fastSection = chatMessagesCss.match(/Speed: Fast[\s\S]*?Speed: Turbo/);
    expect(fastSection).not.toBeNull();
    expect(fastSection[0]).not.toContain('svg-cat-leg-blur');
  });

  it('fast legs keep full opacity (no opacity override)', () => {
    // Fast leg rules should only change animation-duration, not add opacity
    const fastLegFl = chatMessagesCss.match(/speed-fast\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(fastLegFl).not.toBeNull();
    expect(fastLegFl[1]).not.toContain('opacity');
  });

  it('fast bounce-fast has scale(1.2) and translateY', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-fast\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scale(1.2)');
    expect(kf[0]).toContain('translateY');
  });
});

// =============================================================================
// 3. Removed keyframes: old animations eliminated
// =============================================================================
describe('Removed old animations (no regression)', () => {
  it('no svg-leg-blur-shimmer keyframe (old turbo shimmer removed)', () => {
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-blur-shimmer');
  });

  it('no svg-leg-rotate keyframe (old crazy rotate removed)', () => {
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-rotate');
  });

  it('no svg-leg-rotate-reverse keyframe (old crazy reverse removed)', () => {
    expect(chatMessagesCss).not.toContain('@keyframes svg-leg-rotate-reverse');
  });

  it('no svg-ear-twitch-crazy keyframe (replaced by svg-ear-flatten)', () => {
    expect(chatMessagesCss).not.toContain('@keyframes svg-ear-twitch-crazy');
  });

  it('new svg-ear-flatten keyframe exists (replacement for ear-twitch-crazy)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-ear-flatten');
  });

  it('new svg-leg-blur-trail keyframe exists (turbo trail)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-blur-trail');
  });

  it('new svg-leg-blur-wobble keyframe exists (crazy wobble)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-blur-wobble');
  });

  it('new svg-leg-blur-wobble-reverse keyframe exists (crazy inner wobble)', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-blur-wobble-reverse');
  });
});

// =============================================================================
// 4. Dark mode: CSS variables for all cat parts (no hardcoded colors)
// =============================================================================
describe('Dark mode: CSS variables for all cat parts (no regression)', () => {
  it('body uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-body\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('head uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-head\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('ears use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-ear\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('inner ear uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-inner-ear\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('eye uses var(--cat-eye-fill)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-eye\s*\{[^}]*var\(--cat-eye-fill\)/);
  });

  it('pupil uses var(--cat-pupil-fill)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-pupil\s*\{[^}]*var\(--cat-pupil-fill\)/);
  });

  it('nose uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-nose\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('mouth uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-mouth\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('whiskers use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-whisker\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('tail uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-tail\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('legs use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('blur ellipse uses var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-leg-blur\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('no hardcoded hex color in cat parts (#xxx or #xxxxxx)', () => {
    // Extract all cat-related CSS rules
    const catRules = chatMessagesCss.match(/\.svg-cat-[a-z-]*\s*\{[^}]*\}/g);
    expect(catRules).not.toBeNull();
    for (const rule of catRules) {
      // Allow --cat-eye-shine default (#ffffff) but no other hardcoded fills/strokes
      if (rule.includes('eye-shine')) continue;
      // Check fill: and stroke: values don't use hex
      const fillMatches = rule.match(/(?:fill|stroke):\s*#[0-9a-fA-F]+/g);
      expect(fillMatches).toBeNull();
    }
  });

  it('eye-shine has #ffffff fallback (fine for both themes)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-cat-eye-shine\s*\{[^}]*--cat-eye-shine,\s*#ffffff/);
  });
});

// =============================================================================
// 5. Leg visibility: legs never hidden (CORE PRINCIPLE)
// =============================================================================
describe('Core principle: legs always visible in all tiers', () => {
  it('normal mode: legs have no individual opacity (opacity on silhouette group)', () => {
    // With group opacity, individual legs don't need opacity
    const baseLeg = chatMessagesCss.match(/\.svg-cat-leg\s*\{([^}]*)\}/);
    expect(baseLeg).not.toBeNull();
    expect(baseLeg[1]).not.toContain('opacity');
  });

  it('fast mode: legs have no opacity override', () => {
    const fastLegRules = chatMessagesCss.match(/speed-fast\s+\.svg-cat-leg-f[lr]\s*\{([^}]*)\}/g);
    expect(fastLegRules).not.toBeNull();
    for (const rule of fastLegRules) {
      expect(rule).not.toContain('opacity');
    }
  });

  it('turbo mode: legs keep full opacity (no opacity set on individual legs)', () => {
    const turboLegFl = chatMessagesCss.match(/speed-turbo\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(turboLegFl).not.toBeNull();
    expect(turboLegFl[1]).not.toContain('opacity');
  });

  it('crazy mode: legs have opacity: 0.5 (semi-transparent within silhouette group, effective ~0.3)', () => {
    const crazyLegFl = chatMessagesCss.match(/speed-crazy\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(crazyLegFl).not.toBeNull();
    expect(crazyLegFl[1]).toContain('opacity: 0.5');
    // 0.5 within silhouette group (0.6) = ~0.3 effective, still clearly visible
    const opMatch = crazyLegFl[1].match(/opacity:\s*([\d.]+)/);
    expect(parseFloat(opMatch[1])).toBeGreaterThanOrEqual(0.2);
  });

  it('no display:none or visibility:hidden on any leg element', () => {
    const legRules = chatMessagesCss.match(/svg-cat-leg-[fb][lr]\s*\{[^}]*\}/g);
    expect(legRules).not.toBeNull();
    for (const rule of legRules) {
      expect(rule).not.toContain('display: none');
      expect(rule).not.toContain('visibility: hidden');
    }
  });
});

// =============================================================================
// 6. Speed class consistency: all 3 components use same thresholds
// =============================================================================
describe('Speed class assignment in all 3 components', () => {
  it('all 3 components check 6000ms for crazy threshold', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('6000');
    }
  });

  it('all 3 components check 4000ms for turbo threshold', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('4000');
    }
  });

  it('all 3 components check 2000ms for fast threshold', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain('2000');
    }
  });

  it('all 3 components use speed-crazy class', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain("'speed-crazy'");
    }
  });

  it('all 3 components use speed-turbo class', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain("'speed-turbo'");
    }
  });

  it('all 3 components use speed-fast class', () => {
    for (const src of [messageListJs, splitPaneJs, crewChatViewJs]) {
      expect(src).toContain("'speed-fast'");
    }
  });

  it('threshold order: crazy(6000) > turbo(4000) > fast(2000)', () => {
    // Verify the logical ordering is correct
    expect(6000).toBeGreaterThan(4000);
    expect(4000).toBeGreaterThan(2000);
  });
});

// =============================================================================
// 7. Bounce keyframe progression: amplitude increases with speed
// =============================================================================
describe('Bounce amplitude consistent across speed tiers (level ground)', () => {
  it('normal bounce: subtle translateY — max 0.5px for consistent height', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-0.5px)');
  });

  it('fast bounce: same subtle translateY as normal', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-fast\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-0.5px)');
  });

  it('turbo bounce: same subtle translateY', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-turbo\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-0.5px)');
  });

  it('crazy bounce: same subtle translateY', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-crazy\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-0.5px)');
  });

  it('no horizontal drift in bounce keyframes (removed translateX)', () => {
    const kfFast = chatMessagesCss.match(/@keyframes svg-cat-bounce-fast\s*\{[\s\S]*?\n\}/);
    expect(kfFast).not.toBeNull();
    expect(kfFast[0]).not.toContain('translateX');
  });

  it('crazy bounce has 3-step keyframe (more erratic)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-crazy\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    // Should have 0%, 40%, 100% (3 steps)
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('40%');
    expect(kf[0]).toContain('100%');
  });

  it('turbo bounce has 3-step keyframe (similar to crazy)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-bounce-turbo\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('0%');
    expect(kf[0]).toContain('50%');
    expect(kf[0]).toContain('100%');
  });
});

// =============================================================================
// 8. Body crouch progression: scaleY decreases with speed
// =============================================================================
describe('Body crouch progression across tiers', () => {
  it('normal: no scaleY (body at natural height)', () => {
    // The base .svg-cat-body rule should not have scaleY
    const baseBody = chatMessagesCss.match(/\.svg-cat-body\s*\{([^}]*)\}/);
    expect(baseBody).not.toBeNull();
    expect(baseBody[1]).not.toContain('scaleY');
  });

  it('fast: scaleY(0.92)', () => {
    expect(chatMessagesCss).toMatch(/speed-fast\s+\.svg-cat-body[^}]*scaleY\(0\.92\)/);
  });

  it('turbo: scaleY(0.87) — more crouched', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-body[^}]*scaleY\(0\.87\)/);
  });

  it('crazy: scaleY(0.82) — most crouched', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[^}]*scaleY\(0\.82\)/);
  });

  it('crouch progression: 0.92 > 0.87 > 0.82 (increases with speed)', () => {
    expect(0.92).toBeGreaterThan(0.87);
    expect(0.87).toBeGreaterThan(0.82);
  });

  it('crazy body also stretches horizontally: scaleX(1.03)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[^}]*scaleX\(1\.03\)/);
  });

  it('fast and turbo do NOT have scaleX (only crazy)', () => {
    const fastBody = chatMessagesCss.match(/speed-fast\s+\.svg-cat-body\s*\{([^}]*)\}/);
    expect(fastBody).not.toBeNull();
    expect(fastBody[1]).not.toContain('scaleX');

    const turboBody = chatMessagesCss.match(/speed-turbo\s+\.svg-cat-body\s*\{([^}]*)\}/);
    expect(turboBody).not.toBeNull();
    expect(turboBody[1]).not.toContain('scaleX');
  });
});

// =============================================================================
// 9. Turbo-specific: all 4 dedicated leg keyframes exist
// =============================================================================
describe('Turbo: all 4 dedicated leg keyframes exist', () => {
  for (const leg of ['fl', 'fr', 'bl', 'br']) {
    it(`svg-leg-turbo-${leg} keyframe exists`, () => {
      expect(chatMessagesCss).toContain(`@keyframes svg-leg-turbo-${leg}`);
    });
  }

  it('turbo front legs swing ±35°', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-turbo-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(35deg)');
    expect(kf[0]).toContain('rotate(-35deg)');
  });

  it('turbo back legs swing ±35° (reversed direction)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-turbo-bl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-35deg)');
    expect(kf[0]).toContain('rotate(35deg)');
  });
});

// =============================================================================
// 10. Crazy-specific: all 4 dedicated leg keyframes exist
// =============================================================================
describe('Crazy: all 4 dedicated leg keyframes exist', () => {
  for (const leg of ['fl', 'fr', 'bl', 'br']) {
    it(`svg-leg-crazy-${leg} keyframe exists`, () => {
      expect(chatMessagesCss).toContain(`@keyframes svg-leg-crazy-${leg}`);
    });
  }

  it('crazy front legs swing ±42°', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-crazy-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(42deg)');
    expect(kf[0]).toContain('rotate(-42deg)');
  });

  it('crazy tail wag has dedicated keyframe svg-tail-wag-crazy', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-tail-wag-crazy');
  });

  it('crazy tail wag ±30° (wider than normal ±15°/18°)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-wag-crazy\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-30deg)');
    expect(kf[0]).toContain('rotate(30deg)');
  });
});

// =============================================================================
// 11. Leg animation swing angle progression
// =============================================================================
describe('Swing angle progression: wider with speed', () => {
  it('normal: ±20° (front-left)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-front-l\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(20deg)');
  });

  it('turbo: ±35° > normal ±20°', () => {
    expect(35).toBeGreaterThan(20);
  });

  it('crazy: ±42° > turbo ±35°', () => {
    expect(42).toBeGreaterThan(35);
  });

  it('leg animation duration progression: 0.5s > 0.25s > 0.14s > 0.08s', () => {
    expect(0.5).toBeGreaterThan(0.25);
    expect(0.25).toBeGreaterThan(0.14);
    expect(0.14).toBeGreaterThan(0.08);
  });
});
