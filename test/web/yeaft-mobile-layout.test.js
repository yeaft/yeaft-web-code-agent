import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

function mediaBlock(css, query, selector) {
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const start = css.indexOf(`@media ${query}`, searchFrom);
    if (start < 0) break;

    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      if (depth === 0) {
        const block = css.slice(open + 1, i);
        if (!selector || block.includes(selector)) return block;
        searchFrom = i + 1;
        break;
      }
    }
  }
  throw new Error(`Missing media block: ${query} ${selector || ''}`.trim());
}

function ruleBlock(css, selector, contains = '') {
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const start = css.indexOf(`${selector} {`, searchFrom);
    if (start < 0) break;
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      if (depth === 0) {
        const block = css.slice(open + 1, i);
        if (!contains || block.includes(contains)) return block;
        searchFrom = i + 1;
        break;
      }
    }
  }
  throw new Error(`Missing rule: ${selector} ${contains}`.trim());
}

describe('Yeaft mobile layout CSS', () => {
  it('keeps session settings modal usable on phone widths', () => {
    const css = read('styles/yeaft.css');
    const mobile = mediaBlock(css, '(max-width: 640px)', '.group-settings-modal');

    expect(mobile).toContain('.group-settings-modal');
    expect(mobile).toContain('height: calc(100dvh - 16px)');
    expect(mobile).toContain('.group-settings-body');
    expect(mobile).toContain('flex-direction: column');
    expect(mobile).toContain('.group-settings-nav');
    expect(mobile).toContain('overflow-x: auto');
    expect(mobile).toContain('.group-settings-pane');
    expect(mobile).toContain('min-height: 0');
    expect(mobile).toContain('.group-settings-link-btn');
    expect(mobile).toContain('.group-settings-actions');
    expect(mobile).toContain('column-reverse');
  });

  it('keeps Dream debug accordion content scrollable without a two-pane shell', () => {
    const css = read('styles/yeaft.css');
    const panel = ruleBlock(css, '.yeaft-debug-dream-panel', 'overflow: hidden');
    const list = ruleBlock(css, '.yeaft-debug-dream-list', 'overflow-y: auto');
    const detail = ruleBlock(css, '.yeaft-debug-dream-detail', 'max-height: min(560px, 62vh)');
    const detailBody = ruleBlock(css, '.yeaft-debug-dream-detail-body', 'overflow: auto');
    const mobile = mediaBlock(css, '(max-width: 640px)', '.yeaft-debug-dream-panel');

    expect(css).not.toContain('.yeaft-debug-dream-shell');
    expect(panel).toContain('min-width: 0');
    expect(panel).toContain('min-height: 0');
    expect(panel).toContain('overflow: hidden');
    expect(list).toContain('overflow-y: auto');
    expect(detail).toContain('overflow: hidden');
    expect(detailBody).toContain('overflow: auto');
    expect(mobile).toContain('.yeaft-debug-dream-item');
    expect(mobile).toContain('grid-template-columns: minmax(0, 1fr) auto');
  });

  it('stacks Yeaft invite CTAs on narrow phones', () => {
    const css = read('styles/group-invite.css');
    const mobile = mediaBlock(css, '(max-width: 480px)', '.group-invite-modal');

    expect(mobile).toContain('.group-invite-modal');
    expect(mobile).toContain('max-height: calc(100dvh - 16px)');
    expect(mobile).toContain('.group-invite-actions');
    expect(mobile).toContain('flex-direction: column-reverse');
    expect(mobile).toContain('.group-invite-primary');
    expect(mobile).toContain('width: 100%');
  });

  it('hides the Yeaft header title on mobile without hiding actions', () => {
    const css = read('styles/yeaft.css');
    const desktopTitle = ruleBlock(css, '.yeaft-topbar-model-name');
    const mobile = mediaBlock(css, '(max-width: 768px)', '.yeaft-topbar-model-name');

    expect(desktopTitle).toContain('max-width: 220px');
    expect(desktopTitle).not.toContain('display: none');
    expect(mobile).toContain('.yeaft-topbar-model-name');
    expect(mobile).toContain('display: none');
    expect(mobile).toContain('.yeaft-topbar-sidebar-toggle');
    expect(mobile).toContain('display: flex');
    expect(mobile).toContain('.yeaft-topbar');
    expect(mobile).toContain('position: sticky');
    expect(mobile).toContain('top: 0');
    expect(mobile).toContain('z-index: 1100');
    expect(mobile).not.toContain('.yeaft-topbar-right {\n    display: none');
  });

  it('tightens Yeaft create roster and VP turn chrome on mobile', () => {
    const createCss = read('styles/yeaft-session-create.css');
    const createMobile = mediaBlock(createCss, '(max-width: 640px)', '.resume-control-row-vp');
    expect(createMobile).toContain('.resume-control-row-vp');
    expect(createMobile).toContain('.yeaft-roster-name');
    expect(createMobile).toContain('text-overflow: ellipsis');
    expect(createMobile).toContain('.yeaft-roster-default-star');

    const vpCss = read('styles/yeaft-vp.css');
    const vpMobile = mediaBlock(vpCss, '(max-width: 640px)', '.vp-turn-block-main-header');
    expect(vpMobile).toContain('.vp-turn-block-main-header');
    expect(vpMobile).toContain('.vp-detail-dream-row');
    expect(vpMobile).toContain('flex-wrap: wrap');
  });
});
