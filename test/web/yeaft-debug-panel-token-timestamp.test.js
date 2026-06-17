// Static-source tests for YeaftDebugPanel: ensures the debug panel
// renders the new token-breakdown + timestamp UI per the spec without
// requiring a DOM / Vue runtime. We assert on file contents — the same
// pattern used by `yeaft-mobile-layout.test.js`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (relPath) => readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8');

describe('YeaftDebugPanel · token breakdown + timestamp', () => {
  const panel = read('web/components/YeaftDebugPanel.js');
  const css = read('web/styles/yeaft.css');
  const storeJs = read('web/stores/chat.js');

  it('imports the helper module', () => {
    expect(panel).toContain(`from './yeaft-debug-helpers.js'`);
    expect(panel).toMatch(/import\s*\{[^}]*splitTokenBreakdown[^}]*\}\s*from\s*['"]\.\/yeaft-debug-helpers\.js['"]/);
    expect(panel).toMatch(/import\s*\{[^}]*formatClockTime[^}]*\}\s*from\s*['"]\.\/yeaft-debug-helpers\.js['"]/);
  });

  it('renders message / tool split next to the total in turn header from a cached field', () => {
    // Turn header still shows the real total tokens unchanged…
    expect(panel).toContain('formatTokens(turn.totalTokens)');
    // …and now also shows an inline (msg X · tool Y) split from the
    // computed/decorated turn, not by recomputing in the template.
    expect(panel).toContain('turn.tokenBreakdown.messageTotal');
    expect(panel).toContain('turn.tokenBreakdown.toolTotal');
    expect(panel).toContain('yeaft-debug-tokens-split');
    expect(panel).not.toMatch(/turnTokenBreakdown\(turn\)/);
  });

  it('renders message / tool split next to per-loop input and output tokens from cached fields', () => {
    // Real loop input / output unchanged; input goes through the existing
    // cache-aware total helper from origin/main.
    expect(panel).toContain('usageTotalInputTokens(loop.usage)');
    expect(panel).toContain('loop.usage?.outputTokens || 0');
    // Breakdown fields are read from loop.tokenBreakdown, avoiding repeated
    // template calls that would walk loop.messages on every patch.
    expect(panel).toContain('loop.tokenBreakdown.inputMessage');
    expect(panel).toContain('loop.tokenBreakdown.inputTool');
    expect(panel).toContain('loop.tokenBreakdown.outputMessage');
    expect(panel).toContain('loop.tokenBreakdown.outputTool');
    const template = panel.slice(panel.indexOf('template: `'));
    expect(template).not.toMatch(/loopTokenBreakdown\(loop\)/);
  });

  it('renders per-turn timestamp from turn.openedAt', () => {
    expect(panel).toMatch(/yeaft-debug-turn-clock/);
    expect(panel).toMatch(/formatClock\(turn\.openedAt\)/);
  });

  it('renders per-loop timestamp via loopClockTime helper', () => {
    expect(panel).toMatch(/yeaft-debug-loop-clock/);
    expect(panel).toMatch(/loopClockTime\(turn,\s*loop\)/);
  });

  it('loopClockTime method falls back to turn.openedAt + cumulative latency when loop.at missing', () => {
    // Method body must read both loop.at and turn.openedAt.
    expect(panel).toMatch(/loopClockTime\(turn,\s*loop\)\s*\{[\s\S]{0,400}loop\.at/);
    expect(panel).toMatch(/loopClockTime\(turn,\s*loop\)\s*\{[\s\S]{0,800}turn\.openedAt/);
    expect(panel).toMatch(/loopClockTime\(turn,\s*loop\)\s*\{[\s\S]{0,800}latencyMs/);
  });

  it('uses design tokens (no hardcoded hex / rgb) for new debug classes', () => {
    const sliceFor = (className) => {
      const idx = css.indexOf(`.${className}`);
      if (idx < 0) return '';
      // Take the rule block until the next blank line / EOF.
      const end = css.indexOf('\n}\n', idx);
      return end >= 0 ? css.slice(idx, end + 3) : css.slice(idx, idx + 400);
    };
    for (const cls of ['yeaft-debug-tokens-split', 'yeaft-debug-turn-clock', 'yeaft-debug-loop-clock']) {
      const block = sliceFor(cls);
      expect(block.length, `missing CSS for ${cls}`).toBeGreaterThan(0);
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      expect(block).not.toMatch(/rgba?\(/);
    }
  });

  it('timestamp classes use --text-muted and tabular-nums', () => {
    const block = css.slice(css.indexOf('.yeaft-debug-turn-clock'));
    expect(block).toContain('var(--text-muted)');
    expect(block).toContain('tabular-nums');
  });

  it('store persists loop.at from the wire event', () => {
    // The chat store's 'loop' case must thread event.at into the
    // pushed loop record so the panel can render per-loop time.
    expect(storeJs).toMatch(/case 'loop':[\s\S]{0,2000}at:\s*typeof\s+event\.at\s*===\s*['"]number['"]\s*\?\s*event\.at\s*:\s*null/);
  });

  it('engine stamps `at: Date.now()` on both loop emit paths', () => {
    const engine = read('agent/yeaft/engine.js');
    // Find every emit of `type: 'loop',` and confirm an `at:` sibling
    // appears within the same yield block.
    const blocks = engine.split(/yield\s*\{[\s\S]*?type:\s*['"]loop['"]/g);
    // First chunk is preamble; subsequent ones each follow a loop yield.
    let foundAtFields = 0;
    for (let i = 1; i < blocks.length; i++) {
      const chunk = blocks[i].slice(0, 1500);
      if (/at:\s*Date\.now\(\)/.test(chunk)) foundAtFields += 1;
    }
    expect(foundAtFields).toBe(blocks.length - 1);
  });

  it('web-bridge forwards loop.at to the wire', () => {
    const bridge = read('agent/yeaft/web-bridge.js');
    // Inside the 'loop' case, `at: event.at` must be forwarded.
    const loopCase = bridge.slice(bridge.indexOf(`case 'loop':`));
    expect(loopCase.slice(0, 1500)).toMatch(/at:\s*event\.at/);
  });
});

// Guard the prior Yeaft Debug behavior so this change doesn't
// regress the Dream accordion / header layout that earlier passes
// stabilized.
describe('YeaftDebugPanel · regression guards', () => {
  const panel = readFileSync(new URL('../../web/components/YeaftDebugPanel.js', import.meta.url), 'utf8');

  it('still imports the dream-debug-model helpers (no accidental swap)', () => {
    expect(panel).toContain(`from './dream-debug-model.js'`);
    expect(panel).toMatch(/buildDreamDebugItems/);
    expect(panel).toMatch(/filterDreamDebugItems/);
  });

  it('keeps the activeTab default at requests', () => {
    expect(panel).toMatch(/activeTab:\s*['"]requests['"]/);
  });
});
