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
