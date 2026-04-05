import { describe, it, expect } from 'vitest';

/**
 * Tests for task-241: Cat-dog fight SVG animation in typing indicator
 *
 * The fight scene REPLACES the running cat (not appended alongside it).
 *
 * Validates:
 * 1. All 3 components contain .svg-fight-scene with identical SVG
 * 2. CSS has .svg-fight-scene styles and animations
 * 3. Colors use CSS variables (--text-secondary)
 * 4. Status color overrides exist for fight scene
 * 5. :not() selectors exclude .svg-fight-scene from dot animation
 * 6. Fight SVG has both cat and dog groups
 * 7. Dog has corgi-specific features (snout, large ears, short tail)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const rootDir = join(import.meta.dirname, '..', '..');
const messageListJs = readFileSync(join(rootDir, 'web/components/MessageList.js'), 'utf8');
const splitPaneJs = readFileSync(join(rootDir, 'web/components/SplitPane.js'), 'utf8');
const crewChatViewJs = readFileSync(join(rootDir, 'web/components/CrewChatView.js'), 'utf8');
const chatMessagesCss = readFileSync(join(rootDir, 'web/styles/chat-messages.css'), 'utf8');

// =====================================================================
// Presence: .svg-fight-scene in all 3 components
// =====================================================================
describe('Fight scene presence in all components', () => {
  it('MessageList.js contains .svg-fight-scene', () => {
    expect(messageListJs).toContain('class="svg-fight-scene"');
  });

  it('SplitPane.js contains .svg-fight-scene', () => {
    expect(splitPaneJs).toContain('class="svg-fight-scene"');
  });

  it('CrewChatView.js contains .svg-fight-scene', () => {
    expect(crewChatViewJs).toContain('class="svg-fight-scene"');
  });
});

// =====================================================================
// SVG consistency: all 3 components have identical fight SVG content
// =====================================================================
describe('Fight SVG consistency across components', () => {
  // Extract the fight SVG block from each component, strip HTML comments and normalize whitespace
  const extractFightSvg = (source) => {
    const match = source.match(/<svg viewBox="0 0 80 60"[\s\S]*?<\/svg>/);
    if (!match) return null;
    return match[0].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  };

  it('all 3 components have the fight SVG with viewBox 0 0 80 60', () => {
    expect(messageListJs).toContain('viewBox="0 0 80 60"');
    expect(splitPaneJs).toContain('viewBox="0 0 80 60"');
    expect(crewChatViewJs).toContain('viewBox="0 0 80 60"');
  });

  it('fight SVG is identical across all 3 components', () => {
    const ml = extractFightSvg(messageListJs);
    const sp = extractFightSvg(splitPaneJs);
    const ccv = extractFightSvg(crewChatViewJs);
    expect(ml).not.toBeNull();
    expect(sp).not.toBeNull();
    expect(ccv).not.toBeNull();
    expect(ml).toBe(sp);
    expect(ml).toBe(ccv);
  });
});

// =====================================================================
// SVG structure: cat and dog groups with correct classes
// =====================================================================
describe('Fight SVG structure', () => {
  it('has svg-fight-cat group', () => {
    expect(messageListJs).toContain('class="svg-fight-cat"');
  });

  it('has svg-fight-dog group', () => {
    expect(messageListJs).toContain('class="svg-fight-dog"');
  });

  it('cat has body, head, ears, eyes, arms', () => {
    expect(messageListJs).toContain('svg-fight-cat-body');
    expect(messageListJs).toContain('svg-fight-cat-head');
    expect(messageListJs).toContain('svg-fight-cat-ear');
    expect(messageListJs).toContain('svg-fight-cat-eye');
    expect(messageListJs).toContain('svg-fight-cat-arm-upper');
    expect(messageListJs).toContain('svg-fight-cat-arm-lower');
    expect(messageListJs).toContain('svg-fight-cat-fist');
  });

  it('dog has body, head, ears, eyes, arms', () => {
    expect(messageListJs).toContain('svg-fight-dog-body');
    expect(messageListJs).toContain('svg-fight-dog-head');
    expect(messageListJs).toContain('svg-fight-dog-ear');
    expect(messageListJs).toContain('svg-fight-dog-eye');
    expect(messageListJs).toContain('svg-fight-dog-arm-upper');
    expect(messageListJs).toContain('svg-fight-dog-arm-lower');
    expect(messageListJs).toContain('svg-fight-dog-fist');
  });

  it('cat has whiskers and tail', () => {
    expect(messageListJs).toContain('svg-fight-cat-whisker');
    expect(messageListJs).toContain('svg-fight-cat-tail');
  });

  it('dog has tail and snout (corgi features)', () => {
    expect(messageListJs).toContain('svg-fight-dog-tail');
    expect(messageListJs).toContain('svg-fight-dog-snout');
  });

  it('dog has nose (distinct from cat)', () => {
    expect(messageListJs).toContain('svg-fight-dog-nose');
  });

  it('dog does NOT have whiskers (dogs don\'t have prominent whiskers like cats)', () => {
    expect(messageListJs).not.toContain('svg-fight-dog-whisker');
  });

  it('fight scene has aria-hidden="true"', () => {
    expect(messageListJs).toContain('class="svg-fight-scene" aria-hidden="true"');
  });
});

// =====================================================================
// CSS: fight scene container styles (96x72 — larger size)
// =====================================================================
describe('CSS: fight scene container', () => {
  it('.svg-fight-scene has correct dimensions (96x72)', () => {
    expect(chatMessagesCss).toContain('.svg-fight-scene');
    const sceneRule = chatMessagesCss.match(/\.svg-fight-scene\s*\{([^}]*)\}/);
    expect(sceneRule).not.toBeNull();
    expect(sceneRule[1]).toContain('width: 96px');
    expect(sceneRule[1]).toContain('height: 72px');
  });

  it('.svg-fight-scene has margin-left: 12px', () => {
    const sceneRule = chatMessagesCss.match(/\.svg-fight-scene\s*\{([^}]*)\}/);
    expect(sceneRule[1]).toContain('margin-left: 12px');
  });

  it('.svg-fight-scene svg has overflow: visible', () => {
    expect(chatMessagesCss).toContain('.svg-fight-scene svg');
    const svgRule = chatMessagesCss.match(/\.svg-fight-scene svg\s*\{([^}]*)\}/);
    expect(svgRule).not.toBeNull();
    expect(svgRule[1]).toContain('overflow: visible');
  });
});

// =====================================================================
// CSS: colors use CSS variables
// =====================================================================
describe('CSS: theme-adaptive colors', () => {
  it('cat body parts use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-body\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-head\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-ear\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('dog body parts use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-body\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-head\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-ear\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('cat arm and fist use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-arm\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-fist\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('dog arm and fist use var(--text-secondary)', () => {
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-arm\s*\{[^}]*var\(--text-secondary\)/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-fist\s*\{[^}]*var\(--text-secondary\)/);
  });
});

// =====================================================================
// CSS: animations exist
// =====================================================================
describe('CSS: fight animations', () => {
  it('has body sway animations for cat and dog', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-fight-cat-sway');
    expect(chatMessagesCss).toContain('@keyframes svg-fight-dog-sway');
  });

  it('has punch animations for cat arms', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-fight-punch-cat-upper');
    expect(chatMessagesCss).toContain('@keyframes svg-fight-punch-cat-lower');
  });

  it('has punch animations for dog arms', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-fight-punch-dog-upper');
    expect(chatMessagesCss).toContain('@keyframes svg-fight-punch-dog-lower');
  });

  it('has tail wag animations', () => {
    expect(chatMessagesCss).toContain('@keyframes svg-fight-tail-cat');
    expect(chatMessagesCss).toContain('@keyframes svg-fight-tail-dog');
  });

  it('cat and dog arm groups have animation properties', () => {
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-arm-upper\s*\{[^}]*animation:/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-cat-arm-lower\s*\{[^}]*animation:/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-arm-upper\s*\{[^}]*animation:/);
    expect(chatMessagesCss).toMatch(/\.svg-fight-dog-arm-lower\s*\{[^}]*animation:/);
  });

  it('fight animations are fast (sway ≤ 0.5s, punch ≤ 0.3s)', () => {
    // Cat sway
    const catSway = chatMessagesCss.match(/\.svg-fight-cat\s*\{[^}]*animation:\s*svg-fight-cat-sway\s+(\d+\.?\d*)s/);
    expect(catSway).not.toBeNull();
    expect(parseFloat(catSway[1])).toBeLessThanOrEqual(0.5);

    // Dog sway
    const dogSway = chatMessagesCss.match(/\.svg-fight-dog\s*\{[^}]*animation:\s*svg-fight-dog-sway\s+(\d+\.?\d*)s/);
    expect(dogSway).not.toBeNull();
    expect(parseFloat(dogSway[1])).toBeLessThanOrEqual(0.5);

    // Cat punch
    const catPunch = chatMessagesCss.match(/\.svg-fight-cat-arm-upper\s*\{[^}]*animation:\s*svg-fight-punch-cat-upper\s+(\d+\.?\d*)s/);
    expect(catPunch).not.toBeNull();
    expect(parseFloat(catPunch[1])).toBeLessThanOrEqual(0.3);

    // Dog punch
    const dogPunch = chatMessagesCss.match(/\.svg-fight-dog-arm-upper\s*\{[^}]*animation:\s*svg-fight-punch-dog-upper\s+(\d+\.?\d*)s/);
    expect(dogPunch).not.toBeNull();
    expect(parseFloat(dogPunch[1])).toBeLessThanOrEqual(0.3);
  });
});

// =====================================================================
// CSS: status color overrides for fight scene
// =====================================================================
describe('CSS: status color overrides', () => {
  it('disconnected status turns fight cat/dog red', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-cat-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-dog-body');
  });

  it('agent-offline status turns fight cat/dog red', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-agent-offline .svg-fight-cat-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-agent-offline .svg-fight-dog-body');
  });

  it('compacting status turns fight cat/dog blue', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-compacting .svg-fight-cat-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-compacting .svg-fight-dog-body');
    // Verify it uses blue color
    expect(chatMessagesCss).toMatch(/status-compacting[\s\S]*?svg-fight[\s\S]*?91,\s*155,\s*213/);
  });

  it('session-lost and cli-exited status turns fight cat/dog orange', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-session-lost .svg-fight-cat-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-session-lost .svg-fight-dog-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-cli-exited .svg-fight-cat-body');
    expect(chatMessagesCss).toContain('.typing-indicator.status-cli-exited .svg-fight-dog-body');
  });

  it('status overrides include arm and fist selectors', () => {
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-cat-arm');
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-cat-fist');
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-dog-arm');
    expect(chatMessagesCss).toContain('.typing-indicator.status-disconnected .svg-fight-dog-fist');
  });
});

// =====================================================================
// CSS: :not() selectors exclude .svg-fight-scene (no .svg-running-cat)
// =====================================================================
describe('CSS: dot animation :not() selectors', () => {
  it('dot animation selector excludes .svg-fight-scene', () => {
    expect(chatMessagesCss).toContain(':not(.svg-fight-scene)');
  });

  it('dot animation selector does NOT reference .svg-running-cat (removed)', () => {
    expect(chatMessagesCss).not.toContain(':not(.svg-running-cat)');
  });

  it('base dot selector has correct exclusions', () => {
    const baseSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\)\s*\{/
    );
    expect(baseSelector).not.toBeNull();
  });

  it('nth-child(2) selector has correct exclusions', () => {
    const nthSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\):nth-child\(2\)/
    );
    expect(nthSelector).not.toBeNull();
  });

  it('nth-child(3) selector has correct exclusions', () => {
    const nthSelector = chatMessagesCss.match(
      /\.typing-indicator > span:not\(\.typing-status-text\):not\(\.svg-fight-scene\):nth-child\(3\)/
    );
    expect(nthSelector).not.toBeNull();
  });
});

// =====================================================================
// No running cat: fight scene is the sole animation
// =====================================================================
describe('Running cat fully removed — fight scene is sole animation', () => {
  it('no .svg-running-cat in any component', () => {
    expect(messageListJs).not.toContain('svg-running-cat');
    expect(splitPaneJs).not.toContain('svg-running-cat');
    expect(crewChatViewJs).not.toContain('svg-running-cat');
  });

  it('no .svg-running-cat in CSS', () => {
    expect(chatMessagesCss).not.toContain('svg-running-cat');
  });

  it('no viewBox="0 0 34 28" (old running cat viewBox) in any component', () => {
    expect(messageListJs).not.toContain('viewBox="0 0 34 28"');
    expect(splitPaneJs).not.toContain('viewBox="0 0 34 28"');
    expect(crewChatViewJs).not.toContain('viewBox="0 0 34 28"');
  });
});
