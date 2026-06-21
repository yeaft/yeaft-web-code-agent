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

  it('renders only the request-level max-loop message/tool split', () => {
    // Turn header shows the authoritative request total plus the message/tool
    // split for the single largest loop in that request. Per-loop rows keep
    // in/out totals but no longer repeat msg/tool distribution noise.
    expect(panel).toContain('formatTokens(turnTotalTokens(turn))');
    expect(panel).toContain('turn.maxLoopTokenBreakdown');
    expect(panel).toContain('turn.maxLoopNumber');
    expect(panel).toContain('loopBreakdownMessageTokens(turn.maxLoopTokenBreakdown)');
    expect(panel).toContain('loopBreakdownToolTokens(turn.maxLoopTokenBreakdown)');
    const template = panel.slice(panel.indexOf('template: `'));
    expect(template).not.toMatch(/loopMessageTokens\(loop\)/);
    expect(template).not.toMatch(/loopToolTokens\(loop\)/);
    expect(template).not.toMatch(/tokenPct\(loopMessageTokens\(loop\),\s*usageTotalTokens\(loop\.usage\)\)/);
    expect(template).not.toMatch(/tokenPct\(loopToolTokens\(loop\),\s*usageTotalTokens\(loop\.usage\)\)/);
    expect(panel).not.toContain('yeaft-debug-tokens-split');
    expect(panel).not.toMatch(/turnTokenBreakdown\(turn\)/);
  });

  it('keeps loop rows to in/out totals while precomputing loop breakdowns for the request max', () => {
    expect(panel).toContain('usageTotalInputTokens(loop.usage)');
    expect(panel).toContain('loop.usage?.outputTokens || 0');
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
    for (const cls of ['yeaft-debug-turn-clock', 'yeaft-debug-loop-clock']) {
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

  it('renders regex search for the global request log', () => {
    expect(panel).toContain(`v-model="searchQuery"`);
    expect(panel).toContain(`$t('yeaft.debugSearchPlaceholder')`);
    expect(panel).toContain(`$t('yeaft.debugSearchHint')`);
    expect(panel).toContain('search: this.searchQuery');
    expect(storeJs).toContain('searchPattern');
    expect(storeJs).toContain('payload.search = searchPattern');
    expect(storeJs).not.toContain('turnMatchesSearch');
  });

  it('renders request log turns and loops as two-line summary rows', () => {
    expect(panel).toContain('class="yeaft-debug-turn-content"');
    expect(panel).toContain('class="yeaft-debug-turn-primary"');
    expect(panel).toContain('class="yeaft-debug-turn-secondary"');
    expect(panel).toContain('class="yeaft-debug-turn-source"');
    expect(panel).toContain('class="yeaft-debug-loop-content"');
    expect(panel).toContain('class="yeaft-debug-loop-primary"');
    expect(panel).toContain('class="yeaft-debug-loop-secondary"');
    expect(panel).toContain('class="yeaft-debug-loop-token"');
    expect(panel).toContain('in {{ formatTokens(usageTotalInputTokens(loop.usage)) }}');
    expect(panel).toContain('out {{ formatTokens(loop.usage?.outputTokens || 0) }}');
  });

  it('keeps request log controls inside the row while allowing token rows to wrap', () => {
    const turnHeader = css.match(/\.yeaft-debug-turn-header\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const loopHeader = css.match(/\.yeaft-debug-loop-header\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const turnSecondary = css.match(/\.yeaft-debug-turn-secondary\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const loopSecondary = css.match(/\.yeaft-debug-loop-secondary\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    expect(turnHeader).toMatch(/display:\s*flex/);
    expect(loopHeader).toMatch(/display:\s*flex/);
    expect(turnSecondary).toMatch(/flex-wrap:\s*wrap/);
    expect(loopSecondary).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toContain('.yeaft-debug-turn-content');
    expect(css).toContain('.yeaft-debug-loop-content');
    expect(css).toContain('.yeaft-debug-turn-copy');
    expect(css).toContain('.yeaft-debug-loop-action');
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

describe('YeaftDebugPanel · close affordance', () => {
  const page = read('web/components/YeaftPage.js');
  const panel = read('web/components/YeaftDebugPanel.js');
  const css = read('web/styles/yeaft.css');

  it('uses one persistent panel close button instead of a second mobile-only close button', () => {
    expect(panel).toContain('class="yeaft-debug-close"');
    expect(panel).toContain('@click="$emit(\'close\')"');
    expect(page).not.toContain('yeaft-debug-mobile-close');
    expect(css).not.toContain('.yeaft-debug-mobile-close');
  });

  it('keeps the debug panel template compile-covered', () => {
    const compileTest = read('test/web/vue-template-compile.test.js');
    expect(compileTest).toContain("'YeaftDebugPanel.js'");
  });
});


describe('YeaftDebugPanel · request history loading model', () => {
  const panel = read('web/components/YeaftDebugPanel.js');
  const storeJs = read('web/stores/chat.js');
  const bridge = read('agent/yeaft/web-bridge.js');

  it('loads request indexes first and fetches request details on expansion', () => {
    expect(panel).toContain('indexOnly: true');
    expect(panel).toContain('detailTurnId: turnId');
    expect(storeJs).toContain('indexOnly = false, detailTurnId = null');
    expect(storeJs).toContain('payload.indexOnly = true');
    expect(storeJs).toContain('payload.detailTurnId = detailTurnId');
    expect(bridge).toContain('const indexOnly = !!msg?.indexOnly');
    expect(bridge).toContain('detailTurnId');
  });

  it('keeps request order stable when a detail payload arrives', () => {
    const handler = read('web/stores/helpers/messageHandler.js');
    expect(handler).toContain('const isDetailFetch = typeof msg?.detailTurnId');
    expect(handler).toContain('they must NOT move that request in the list');
    expect(handler).toContain('let that shrink the global debug retention window');
    expect(handler).toMatch(/if \(isDetailFetch\) \{[\s\S]{0,160}store\.yeaftDebugTurnOrder/);
  });

  it('correlates debug history requests and drops stale list responses', () => {
    const handler = read('web/stores/helpers/messageHandler.js');
    const serverRelay = read('server/handlers/agent-output.js');
    expect(storeJs).toContain('requestId,');
    expect(storeJs).toContain('requestKind');
    expect(storeJs).toContain('_yeaftDebugHistoryLatestListRequestId');
    expect(handler).toContain('requestId && !isDetailFetch');
    expect(handler).toContain('requestId !== store._yeaftDebugHistoryLatestListRequestId');
    expect(serverRelay).toContain('requestId: msg.requestId');
    expect(serverRelay).toContain('search: msg.search');
  });

  it('keeps debug search i18n keys unique', () => {
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');
    expect(en.match(/'yeaft\.debugSearchPlaceholder'/g)).toHaveLength(1);
    expect(zh.match(/'yeaft\.debugSearchPlaceholder'/g)).toHaveLength(1);
  });
});
