import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const pageSource = read('components/YeaftPage.js');
const sidebarSource = read('components/YeaftSidebar.js');

function topbarRightBlock() {
  const start = pageSource.indexOf('<div class="yeaft-topbar-right">');
  expect(start).toBeGreaterThan(-1);
  const end = pageSource.indexOf('          </div>\n        </div>\n\n', start);
  expect(end).toBeGreaterThan(start);
  return pageSource.slice(start, end);
}

describe('Yeaft conversation header actions', () => {
  it('removes the duplicate session settings action from the header', () => {
    const block = topbarRightBlock();

    expect(block).not.toContain('yeaft-topbar-group-settings');
    expect(block).not.toContain('openTopbarGroupSettings');
    expect(sidebarSource).toContain('class="session-dots-btn"');
    expect(sidebarSource).toContain("openGroupSettingsFromMenu(s.raw, 'announcement')");
    expect(sidebarSource).toContain("$t('yeaft.session.openSettings')");
  });

  it('keeps message refresh as a session-history refresh action', () => {
    const block = topbarRightBlock();

    expect(block).toContain('@click="reloadMessages"');
    expect(block).toContain("$t('yeaft.reloadMessages')");
    expect(pageSource).toContain('const reloadMessages = () => {\n      store.reloadYeaftMessages();\n    };');
  });

  it('renders page reload only behind the mobile condition and as the last header action', () => {
    const block = topbarRightBlock();
    const pageReloadStart = block.indexOf('v-if="isMobile"');

    expect(pageReloadStart).toBeGreaterThan(-1);
    expect(block.slice(pageReloadStart)).toContain('@click="reloadPage"');
    expect(block.slice(0, pageReloadStart)).not.toContain('@click="reloadPage"');
    expect(block.lastIndexOf('@click="reloadPage"')).toBeGreaterThan(block.lastIndexOf('@click="toggleDebug"'));
    expect(block.indexOf('@click="reloadPage"', block.lastIndexOf('@click="reloadPage"') + 1)).toBe(-1);
  });

  it('orders header actions as VP list, message refresh, dream, debug, mobile page refresh', () => {
    const block = topbarRightBlock();
    const order = [
      '@click="toggleVpTimeline"',
      '@click="reloadMessages"',
      '@click="onDreamTriggerClick"',
      '@click="toggleDebug"',
      '@click="reloadPage"',
    ].map((needle) => block.indexOf(needle));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
