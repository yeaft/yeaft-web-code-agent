/**
 * task-238 supplementary tests: screenshot padding canvas compensation.
 *
 * Supplements dev's screenshot-padding-symmetry.test.js with:
 * 1. getBoundingClientRect is called before toPng (correct ordering)
 * 2. width/height formula: rect.width + pad * 2, rect.height + pad * 2
 * 3. Both AssistantTurn and CrewTurnRenderer use identical pad=32 pattern
 * 4. Padding template literal uses pad variable (not hardcoded string)
 * 5. Canvas compensation math: ensures content + padding fits without clipping
 * 6. screenshot-mode class add/remove lifecycle preserved
 * 7. Old padding: '32px' string literal replaced with template literal
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let assistantTurnJs;
let crewTurnRendererJs;
let chatMessagesCss;

beforeAll(() => {
  assistantTurnJs = read('web/components/AssistantTurn.js');
  crewTurnRendererJs = read('web/components/crew/CrewTurnRenderer.js');
  chatMessagesCss = read('web/styles/chat-messages.css');
});

// =============================================================================
// 1. AssistantTurn: getBoundingClientRect ordering and canvas compensation
// =============================================================================
describe('task-238 supplement: AssistantTurn canvas compensation', () => {
  it('getBoundingClientRect is called before toPng', () => {
    const rectIdx = assistantTurnJs.indexOf('contentEl.getBoundingClientRect()');
    const toPngIdx = assistantTurnJs.indexOf('window.htmlToImage.toPng(contentEl');
    expect(rectIdx).toBeGreaterThan(-1);
    expect(toPngIdx).toBeGreaterThan(rectIdx);
  });

  it('const pad = 32 is defined before getBoundingClientRect', () => {
    const padIdx = assistantTurnJs.indexOf('const pad = 32');
    const rectIdx = assistantTurnJs.indexOf('contentEl.getBoundingClientRect()');
    expect(padIdx).toBeGreaterThan(-1);
    expect(rectIdx).toBeGreaterThan(padIdx);
  });

  it('toPng receives width parameter with pad*2 compensation', () => {
    // Extract the toPng options block
    const toPngIdx = assistantTurnJs.indexOf('window.htmlToImage.toPng(contentEl');
    const optionsBlock = assistantTurnJs.slice(toPngIdx, assistantTurnJs.indexOf('});', toPngIdx + 100) + 3);
    expect(optionsBlock).toContain('width: rect.width + pad * 2');
  });

  it('toPng receives height parameter with pad*2 compensation', () => {
    const toPngIdx = assistantTurnJs.indexOf('window.htmlToImage.toPng(contentEl');
    const optionsBlock = assistantTurnJs.slice(toPngIdx, assistantTurnJs.indexOf('});', toPngIdx + 100) + 3);
    expect(optionsBlock).toContain('height: rect.height + pad * 2');
  });

  it('padding style uses template literal with pad variable', () => {
    // Should use `${pad}px` not hardcoded '32px'
    expect(assistantTurnJs).toContain('padding: `${pad}px`');
  });

  it('does NOT use old hardcoded padding: \'32px\' string', () => {
    // The old code had padding: '32px' — now replaced by template literal
    expect(assistantTurnJs).not.toContain("padding: '32px'");
  });
});

// =============================================================================
// 2. CrewTurnRenderer: identical canvas compensation pattern
// =============================================================================
describe('task-238 supplement: CrewTurnRenderer canvas compensation', () => {
  it('getBoundingClientRect is called before toPng', () => {
    const rectIdx = crewTurnRendererJs.indexOf('contentEl.getBoundingClientRect()');
    const toPngIdx = crewTurnRendererJs.indexOf('window.htmlToImage.toPng(contentEl');
    expect(rectIdx).toBeGreaterThan(-1);
    expect(toPngIdx).toBeGreaterThan(rectIdx);
  });

  it('const pad = 32 is defined before getBoundingClientRect', () => {
    const padIdx = crewTurnRendererJs.indexOf('const pad = 32');
    const rectIdx = crewTurnRendererJs.indexOf('contentEl.getBoundingClientRect()');
    expect(padIdx).toBeGreaterThan(-1);
    expect(rectIdx).toBeGreaterThan(padIdx);
  });

  it('toPng receives width: rect.width + pad * 2', () => {
    expect(crewTurnRendererJs).toContain('width: rect.width + pad * 2');
  });

  it('toPng receives height: rect.height + pad * 2', () => {
    expect(crewTurnRendererJs).toContain('height: rect.height + pad * 2');
  });

  it('padding style uses template literal with pad variable', () => {
    expect(crewTurnRendererJs).toContain('padding: `${pad}px`');
  });

  it('does NOT use old hardcoded padding: \'32px\' string', () => {
    expect(crewTurnRendererJs).not.toContain("padding: '32px'");
  });
});

// =============================================================================
// 3. Consistency: both files use identical pattern
// =============================================================================
describe('task-238 supplement: pattern consistency between components', () => {
  it('both use const pad = 32', () => {
    expect(assistantTurnJs).toContain('const pad = 32');
    expect(crewTurnRendererJs).toContain('const pad = 32');
  });

  it('both use getBoundingClientRect()', () => {
    expect(assistantTurnJs).toContain('contentEl.getBoundingClientRect()');
    expect(crewTurnRendererJs).toContain('contentEl.getBoundingClientRect()');
  });

  it('both use rect.width + pad * 2', () => {
    expect(assistantTurnJs).toContain('rect.width + pad * 2');
    expect(crewTurnRendererJs).toContain('rect.width + pad * 2');
  });

  it('both use rect.height + pad * 2', () => {
    expect(assistantTurnJs).toContain('rect.height + pad * 2');
    expect(crewTurnRendererJs).toContain('rect.height + pad * 2');
  });

  it('both use pixelRatio: 3', () => {
    expect(assistantTurnJs).toContain('pixelRatio: 3');
    expect(crewTurnRendererJs).toContain('pixelRatio: 3');
  });

  it('same pad value (32) used in both files', () => {
    const assistantPad = assistantTurnJs.match(/const pad = (\d+)/);
    const crewPad = crewTurnRendererJs.match(/const pad = (\d+)/);
    expect(assistantPad[1]).toBe('32');
    expect(crewPad[1]).toBe('32');
    expect(assistantPad[1]).toBe(crewPad[1]);
  });
});

// =============================================================================
// 4. screenshot-mode lifecycle preserved
// =============================================================================
describe('task-238 supplement: screenshot-mode class lifecycle', () => {
  it('AssistantTurn adds screenshot-mode before toPng', () => {
    const addIdx = assistantTurnJs.indexOf("contentEl.classList.add('screenshot-mode')");
    const toPngIdx = assistantTurnJs.indexOf('window.htmlToImage.toPng(contentEl');
    expect(addIdx).toBeGreaterThan(-1);
    expect(toPngIdx).toBeGreaterThan(addIdx);
  });

  it('AssistantTurn removes screenshot-mode in finally block', () => {
    const toPngIdx = assistantTurnJs.indexOf('window.htmlToImage.toPng(contentEl');
    const finallyBlock = assistantTurnJs.slice(toPngIdx, toPngIdx + 800);
    expect(finallyBlock).toContain('finally');
    expect(finallyBlock).toContain("contentEl.classList.remove('screenshot-mode')");
  });

  it('CrewTurnRenderer adds screenshot-mode before toPng', () => {
    const addIdx = crewTurnRendererJs.indexOf("contentEl.classList.add('screenshot-mode')");
    const toPngIdx = crewTurnRendererJs.indexOf('window.htmlToImage.toPng(contentEl');
    expect(addIdx).toBeGreaterThan(-1);
    expect(toPngIdx).toBeGreaterThan(addIdx);
  });

  it('CrewTurnRenderer removes screenshot-mode in finally block', () => {
    const toPngIdx = crewTurnRendererJs.indexOf('window.htmlToImage.toPng(contentEl');
    const finallyBlock = crewTurnRendererJs.slice(toPngIdx, toPngIdx + 600);
    expect(finallyBlock).toContain('finally');
    expect(finallyBlock).toContain("contentEl.classList.remove('screenshot-mode')");
  });
});

// =============================================================================
// 5. Canvas compensation math verification
// =============================================================================
describe('task-238 supplement: canvas compensation math', () => {
  it('pad*2 correctly accounts for left+right padding (32+32=64)', () => {
    const pad = 32;
    expect(pad * 2).toBe(64);
  });

  it('for a 600px wide element: canvas = 600+64 = 664px (content not clipped)', () => {
    const pad = 32;
    const contentWidth = 600;
    const canvasWidth = contentWidth + pad * 2;
    expect(canvasWidth).toBe(664);
    // After padding is applied to clone: content area = 664 - 64 = 600px (exact fit)
    expect(canvasWidth - pad * 2).toBe(contentWidth);
  });

  it('for a 400px tall element: canvas = 400+64 = 464px', () => {
    const pad = 32;
    const contentHeight = 400;
    const canvasHeight = contentHeight + pad * 2;
    expect(canvasHeight).toBe(464);
    expect(canvasHeight - pad * 2).toBe(contentHeight);
  });

  it('without compensation: 600px element with 32px padding → content squished to 536px (bug)', () => {
    // This was the bug: canvas = clientWidth (600), padding applied = 32*2=64
    // → content area = 600 - 64 = 536px → 64px of content clipped
    const canvasWithBug = 600;
    const pad = 32;
    const visibleContent = canvasWithBug - pad * 2;
    expect(visibleContent).toBe(536);
    expect(visibleContent).toBeLessThan(600); // content is clipped!
  });

  it('with compensation: 600px element + 64 → canvas = 664, content fits exactly', () => {
    const contentWidth = 600;
    const pad = 32;
    const canvasFixed = contentWidth + pad * 2;
    const visibleContentFixed = canvasFixed - pad * 2;
    expect(visibleContentFixed).toBe(contentWidth); // no clipping!
  });
});

// =============================================================================
// 6. CSS screenshot-mode rule still exists (not removed by accident)
// =============================================================================
describe('task-238 supplement: CSS screenshot-mode rules preserved', () => {
  it('.turn-content.screenshot-mode rule exists', () => {
    expect(chatMessagesCss).toContain('.turn-content.screenshot-mode');
  });

  it('screenshot-mode resets padding-right to 0', () => {
    const rule = chatMessagesCss.match(/\.turn-content\.screenshot-mode\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toContain('padding-right: 0 !important');
  });

  it('base .turn-content still has padding-right: 40px for hover buttons', () => {
    // This padding is for normal mode, reset by screenshot-mode
    const rule = chatMessagesCss.match(/\.turn-content\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toContain('padding-right: 40px');
  });
});

// =============================================================================
// 7. AssistantTurn filter preserved (turn-header and screenshot-btn excluded)
// =============================================================================
describe('task-238 supplement: toPng filter preserved', () => {
  it('AssistantTurn filter excludes turn-header', () => {
    expect(assistantTurnJs).toContain("node.classList.contains('turn-header')");
  });

  it('AssistantTurn filter excludes screenshot-btn', () => {
    expect(assistantTurnJs).toContain("node.classList.contains('screenshot-btn')");
  });

  it('CrewTurnRenderer does not need filter (no hover buttons in crew view)', () => {
    // CrewTurnRenderer's toPng call should not have a filter option
    const toPngIdx = crewTurnRendererJs.indexOf('window.htmlToImage.toPng(contentEl');
    const optionsEnd = crewTurnRendererJs.indexOf('});', toPngIdx);
    const optionsBlock = crewTurnRendererJs.slice(toPngIdx, optionsEnd + 3);
    expect(optionsBlock).not.toContain('filter:');
  });
});
