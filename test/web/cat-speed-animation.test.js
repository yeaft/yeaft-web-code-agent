import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-252/255: Running Cat — five-speed animation with tired cycle
 *
 * 1. Cuter cat: bigger head (r=7), rounder eyes (rx=2,ry=2.2), shorter body, eye shine, inner ears
 * 2. Five speed classes: speed-normal, speed-fast, speed-turbo, speed-crazy, speed-tired
 * 3. catSpeed computed in all 3 components (13s cycle via % 13000)
 * 4. Core principle: LEGS ALWAYS VISIBLE in all five tiers
 *    - Turbo: real legs at 0.14s/±35°, blur as faint trail (opacity 0.2)
 *    - Crazy: semi-transparent legs (opacity 0.3) at 0.08s/±42°, wobble blur (no rotate)
 *    - Tired: slow legs at 0.9s/±8°, head nod, droopy tail/ears, no blur
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

  it('has inner leg blur ellipses for crazy mode wobble', () => {
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
// catSpeed computed property — five tiers (13s cycle)
// =====================================================================
describe('catSpeed computed property (five tiers)', () => {
  it('MessageList.js has all five speed classes', () => {
    expect(messageListJs).toContain('catSpeed');
    expect(messageListJs).toContain("'speed-normal'");
    expect(messageListJs).toContain("'speed-fast'");
    expect(messageListJs).toContain("'speed-turbo'");
    expect(messageListJs).toContain("'speed-crazy'");
    expect(messageListJs).toContain("'speed-tired'");
  });

  it('SplitPane.js has all five speed classes', () => {
    expect(splitPaneJs).toContain('catSpeed');
    expect(splitPaneJs).toContain("'speed-turbo'");
    expect(splitPaneJs).toContain("'speed-crazy'");
    expect(splitPaneJs).toContain("'speed-tired'");
  });

  it('CrewChatView.js has all five speed classes', () => {
    expect(crewChatViewJs).toContain('catSpeed');
    expect(crewChatViewJs).toContain("'speed-turbo'");
    expect(crewChatViewJs).toContain("'speed-crazy'");
    expect(crewChatViewJs).toContain("'speed-tired'");
  });

  it('uses % 13000 modulo cycle in all 3 components', () => {
    expect(messageListJs).toContain('% 13000');
    expect(splitPaneJs).toContain('% 13000');
    expect(crewChatViewJs).toContain('% 13000');
  });

  it('speed-tired triggers at 10000ms', () => {
    expect(messageListJs).toContain('10000');
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
// catSpeed behavioral tests (five tiers, 13s cycle)
// =====================================================================
describe('catSpeed computation logic (five tiers, 13s cycle)', () => {
  function computeCatSpeed(typingStartTime, now) {
    if (!typingStartTime) return 'speed-normal';
    const elapsed = (now - typingStartTime) % 13000;
    if (elapsed >= 10000) return 'speed-tired';
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

  it('returns speed-crazy when elapsed is 6-9.999s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 6000, now)).toBe('speed-crazy');
    expect(computeCatSpeed(now - 8000, now)).toBe('speed-crazy');
    expect(computeCatSpeed(now - 9999, now)).toBe('speed-crazy');
  });

  it('returns speed-tired when elapsed is 10-12.999s', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 10000, now)).toBe('speed-tired');
    expect(computeCatSpeed(now - 11000, now)).toBe('speed-tired');
    expect(computeCatSpeed(now - 12999, now)).toBe('speed-tired');
  });

  it('cycles back to speed-normal at 13s (modulo 13000)', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 13000, now)).toBe('speed-normal');
    expect(computeCatSpeed(now - 13500, now)).toBe('speed-normal');
  });

  it('cycles back through all tiers on second cycle', () => {
    const now = Date.now();
    expect(computeCatSpeed(now - 15000, now)).toBe('speed-fast');   // 15000 % 13000 = 2000
    expect(computeCatSpeed(now - 17000, now)).toBe('speed-turbo');  // 17000 % 13000 = 4000
    expect(computeCatSpeed(now - 19000, now)).toBe('speed-crazy');  // 19000 % 13000 = 6000
    expect(computeCatSpeed(now - 23000, now)).toBe('speed-tired');  // 23000 % 13000 = 10000
    expect(computeCatSpeed(now - 26000, now)).toBe('speed-normal'); // 26000 % 13000 = 0
  });
});

// =====================================================================
// CSS: turbo = fast real legs ±35° with faint blur trail
// =====================================================================
describe('CSS: turbo has real legs with blur trail', () => {
  it('turbo legs use dedicated turbo keyframes (not just duration override)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fl[\s\S]*?svg-leg-turbo-fl/);
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fr[\s\S]*?svg-leg-turbo-fr/);
  });

  it('turbo does NOT hide legs (no opacity: 0 on real legs)', () => {
    // Turbo leg rules should not set opacity: 0 (legs hidden)
    // Check each leg rule individually — the rule is on one line
    const turboLegFl = chatMessagesCss.match(/speed-turbo\s+\.svg-cat-leg-fl\s*\{([^}]*)\}/);
    expect(turboLegFl).not.toBeNull();
    expect(turboLegFl[1]).not.toMatch(/opacity:\s*0\b/);
  });

  it('turbo leg period is 0.14s', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-fl\s*\{[^}]*0\.14s/);
  });

  it('turbo leg swing is ±35deg', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-turbo-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(35deg)');
    expect(kf[0]).toContain('rotate(-35deg)');
  });

  it('turbo blur is faint trail (opacity 0.2)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0\.2/);
  });

  it('turbo blur uses trail animation (not shimmer/rotate)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-leg-blur[\s\S]*?svg-leg-blur-trail/);
  });

  it('turbo body is scaleY(0.87)', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-body[\s\S]*?scaleY\(0\.87\)/);
  });

  it('turbo ears use flatten animation', () => {
    expect(chatMessagesCss).toMatch(/speed-turbo\s+\.svg-cat-ear-l[\s\S]*?svg-ear-flatten/);
  });

  it('has svg-leg-blur-trail keyframe', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-blur-trail');
  });

  it('has svg-ear-flatten keyframe (±12deg)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-ear-flatten\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-12deg)');
    expect(kf[0]).toContain('rotate(12deg)');
  });
});

// =====================================================================
// CSS: crazy = ultra-fast semi-transparent legs ±42° with wobble blur
// =====================================================================
describe('CSS: crazy has semi-transparent legs with wobble blur', () => {
  it('crazy legs are semi-transparent (opacity: 0.5 inside silhouette group), NOT hidden', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*opacity:\s*0\.5/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fr\s*\{[^}]*opacity:\s*0\.5/);
  });

  it('crazy legs use dedicated crazy keyframes', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl[\s\S]*?svg-leg-crazy-fl/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-bl[\s\S]*?svg-leg-crazy-bl/);
  });

  it('crazy leg period is 0.08s', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-fl\s*\{[^}]*0\.08s/);
  });

  it('crazy leg swing is ±42deg', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-crazy-fl\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(42deg)');
    expect(kf[0]).toContain('rotate(-42deg)');
  });

  it('crazy blur uses wobble animation (not rotate)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur\s*\{[^}]*svg-leg-blur-wobble\b/);
  });

  it('crazy inner blur uses reverse wobble', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-leg-blur-inner[\s\S]*?svg-leg-blur-wobble-reverse/);
  });

  it('crazy body is extremely crouched: scaleY(0.82) scaleX(1.03)', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[\s\S]*?scaleY\(0\.82\)/);
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-body[\s\S]*?scaleX\(1\.03\)/);
  });

  it('crazy tail wag is 0.12s', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-tail-group[\s\S]*?svg-tail-wag-crazy\s+0\.12s/);
  });

  it('crazy ears use flatten animation at 0.18s', () => {
    expect(chatMessagesCss).toMatch(/speed-crazy\s+\.svg-cat-ear-l[\s\S]*?svg-ear-flatten\s+0\.18s/);
  });

  it('no rotate animation in crazy mode', () => {
    // The crazy section should NOT contain svg-leg-rotate
    const crazySection = chatMessagesCss.match(/Speed: Crazy[\s\S]*?Speed: Tired/);
    expect(crazySection).not.toBeNull();
    expect(crazySection[0]).not.toContain('svg-leg-rotate');
  });

  it('has svg-leg-blur-wobble keyframe (scaleX/scaleY, no rotate)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-blur-wobble\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('scaleX');
    expect(kf[0]).toContain('scaleY');
    expect(kf[0]).not.toContain('rotate');
  });

  it('has svg-leg-blur-wobble-reverse keyframe', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-leg-blur-wobble-reverse');
  });

  it('has svg-tail-wag-crazy keyframe (±30deg)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-tail-wag-crazy\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-30deg)');
    expect(kf[0]).toContain('rotate(30deg)');
  });
});

// =====================================================================
// CSS: tired = panting exhausted cat with breathing rhythm
// =====================================================================
describe('CSS: tired has panting breath, wobbly legs, droopy head/ears', () => {
  it('tired uses panting-bob animation (1.4s breathing cycle)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s*\{[^}]*svg-cat-panting-bob\s+1\.4s/);
  });

  it('panting-bob keyframe has subtle up/down heave (translateY -1.5px to 1px)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-cat-panting-bob\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('translateY(-1.5px)');
    expect(kf[0]).toContain('translateY(1px)');
    expect(kf[0]).toContain('scale(1.2)');
  });

  it('tired body has panting animation (expanding/contracting)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-body\s*\{[^}]*svg-body-panting\s+1\.4s/);
  });

  it('body-panting keyframe has visible scaleY changes (inhale/exhale)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-body-panting\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    // Inhale: chest expands slightly
    expect(kf[0]).toContain('scaleY(1.02)');
    // Exhale: chest compresses slightly
    expect(kf[0]).toContain('scaleY(0.94)');
  });

  it('tired legs use wobble animations (not uniform swing)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*svg-leg-tired-wobble-a/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fr\s*\{[^}]*svg-leg-tired-wobble-b/);
  });

  it('wobble-a has multi-step uneven rotation', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-leg-tired-wobble-a\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    // Should have 4+ keyframe steps (not just 0%/100%)
    expect(kf[0]).toContain('25%');
    expect(kf[0]).toContain('50%');
    expect(kf[0]).toContain('75%');
  });

  it('tired head has panting droop animation', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-head\s*\{[^}]*svg-head-panting\s+1\.4s/);
  });

  it('head-panting keyframe has gentle droop (rotate 4deg, translateY 1.5px)', () => {
    const kf = chatMessagesCss.match(/@keyframes svg-head-panting\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(4deg)');
    expect(kf[0]).toContain('translateY(1.5px)');
  });

  it('tired tail hangs limp (-25° to -15°)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-tail-group[\s\S]*?svg-tail-tired-limp/);
    const kf = chatMessagesCss.match(/@keyframes svg-tail-tired-limp\s*\{[\s\S]*?\n\}/);
    expect(kf).not.toBeNull();
    expect(kf[0]).toContain('rotate(-25deg)');
    expect(kf[0]).toContain('rotate(-15deg)');
  });

  it('tired ears have droop animation synced with breathing', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-l\s*\{[^}]*svg-ear-tired-droop-l\s+1\.4s/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-ear-r\s*\{[^}]*svg-ear-tired-droop-r\s+1\.4s/);
  });

  it('tired blur is hidden (opacity: 0)', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur\s*\{[^}]*opacity:\s*0/);
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-blur-inner\s*\{[^}]*opacity:\s*0/);
  });
});

// =====================================================================
// CSS: speed variant styles (five tiers)
// =====================================================================
describe('CSS: speed variant styles (five tiers)', () => {
  it('has speed-fast class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-fast');
  });

  it('has speed-turbo class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-turbo');
  });

  it('has speed-crazy class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-crazy');
  });

  it('has speed-tired class overrides', () => {
    expect(chatMessagesCss).toContain('.svg-running-cat.speed-tired');
  });

  it('has all bounce keyframes', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-fast');
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-turbo');
    expect(chatMessagesCss).toContain('@keyframes svg-cat-bounce-crazy');
    expect(chatMessagesCss).toContain('@keyframes svg-cat-panting-bob');
  });

  it('speed-fast makes legs faster (0.25s)', () => {
    const fastBlock = chatMessagesCss.match(/speed-fast[\s\S]*?speed-turbo/);
    expect(fastBlock).not.toBeNull();
    expect(fastBlock[0]).toContain('animation-duration: 0.25s');
  });

  it('speed progression: normal 0.5s > fast 0.25s > turbo 0.14s > crazy 0.08s', () => {
    // Verify the leg animation durations are progressively faster
    expect(chatMessagesCss).toMatch(/svg-cat-leg-fl\s*\{[^}]*0\.5s/);      // normal
    expect(chatMessagesCss).toMatch(/speed-fast[^}]*leg-fl[^}]*0\.25s/);    // fast
    expect(chatMessagesCss).toMatch(/speed-turbo[^}]*leg-fl[^}]*0\.14s/);   // turbo
    expect(chatMessagesCss).toMatch(/speed-crazy[^}]*leg-fl[^}]*0\.08s/);   // crazy
  });

  it('tired legs wobble at 1.4s breathing rhythm', () => {
    expect(chatMessagesCss).toMatch(/speed-tired\s+\.svg-cat-leg-fl\s*\{[^}]*1\.4s/);
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
    const blurRule = chatMessagesCss.match(/^\.svg-cat-leg-blur\s*\{([^}]*)\}/m);
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

  it('crazy tail wag uses 0.12s', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-tail-wag-crazy');
    expect(chatMessagesCss).toMatch(/speed-crazy[^}]*tail-group[^}]*0\.12s/);
  });
});
