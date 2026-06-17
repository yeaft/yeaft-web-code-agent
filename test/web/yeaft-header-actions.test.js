import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const pageSource = read('components/YeaftPage.js');
const sidebarSource = read('components/YeaftSidebar.js');
const chatHeaderSource = read('components/ChatHeader.js');
const yeaftCss = read('styles/yeaft.css');
const sidebarCss = read('styles/sidebar.css');
const variablesCss = read('styles/variables.css');
const enI18n = read('i18n/en.js');
const zhI18n = read('i18n/zh-CN.js');

function topbarRightBlock() {
  const start = pageSource.indexOf('<div class="yeaft-topbar-right">');
  expect(start).toBeGreaterThan(-1);
  const end = pageSource.indexOf('          </div>\n        </div>\n\n', start);
  expect(end).toBeGreaterThan(start);
  return pageSource.slice(start, end);
}

describe('Yeaft conversation header actions', () => {
  it('keeps the header announcement edit action scoped to the announcement section', () => {
    const block = topbarRightBlock();

    expect(block).toContain('class="yeaft-topbar-announcement-edit"');
    expect(block).toContain('@click="openAnnouncementSettings"');
    expect(block).toContain('d="M4 14.5V9.5l11-4v13l-11-4z"');
    expect(block).toContain("$t('yeaft.session.announcement.editTitle')");
    expect(block).not.toContain('yeaft-topbar-announcement-edit-label');
    expect(block).not.toContain("$t('yeaft.session.announcement.edit')");
    expect(pageSource).toContain('const openAnnouncementSettings = () => {');
    expect(pageSource).toContain("openGroupSettings({ sessionId, section: 'announcement' });");
    expect(pageSource).toContain(':initial-section="groupSettingsSection"');
    expect(yeaftCss).toContain('.yeaft-topbar-announcement-edit');
    expect(yeaftCss).not.toContain('.yeaft-topbar-announcement-edit-label');
    expect(enI18n).toContain("'yeaft.session.announcement.editTitle': 'Edit session announcement'");
    expect(zhI18n).toContain("'yeaft.session.announcement.editTitle': '编辑会话公告'");
    expect(pageSource).not.toContain('openTopbarGroupSettings');
    expect(sidebarSource).toContain('class="session-dots-btn"');
    expect(sidebarSource).toContain("openGroupSettingsFromMenu(s.raw, 'announcement')");
    expect(sidebarSource).toContain("$t('yeaft.session.openSettings')");
  });

  it('keeps message refresh as a session-history refresh action', () => {
    const block = topbarRightBlock();

    expect(block).toContain('@click="reloadMessages"');
    expect(block).toContain("$t('yeaft.reloadMessages')");
    expect(block).toContain('<polyline points="23 4 23 10 17 10"/>');
    expect(block).toContain('<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
    expect(block).not.toContain('<path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h5"/>');
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

  it('orders header actions as VP list, announcement edit, message refresh, dream, debug, mobile page refresh', () => {
    const block = topbarRightBlock();
    const order = [
      '@click="toggleVpTimeline"',
      '@click="openAnnouncementSettings"',
      '@click="reloadMessages"',
      '@click="onDreamTriggerClick"',
      '@click="toggleDebug"',
      '@click="reloadPage"',
    ].map((needle) => block.indexOf(needle));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('conversation header titles', () => {
  it('renders a readable Yeaft session title in the header with id/path fallback hidden from visible text', () => {
    expect(pageSource).toContain('class="yeaft-topbar-title-group"');
    expect(pageSource).toContain('{{ topbarSessionTitle || $t(\'yeaft.session.create.untitled\') }}');
    expect(pageSource).toContain('if (id && value === id) continue;');
    expect(pageSource).toContain('/^(sessions?|groups?)\\//i.test(value)');
    expect(pageSource).toContain('if (g.workDir && value === g.workDir) continue;');
  });

  it('centers the Yeaft header title while keeping it single-line and shrinkable beside actions', () => {
    expect(yeaftCss).toContain('.yeaft-topbar-title-group');
    expect(yeaftCss).toContain('flex: 1 1 auto;');
    expect(yeaftCss).toContain('min-width: 0;');
    expect(yeaftCss).toContain('justify-content: center;');
    expect(yeaftCss).toContain('text-align: center;');
    expect(yeaftCss).toContain('.yeaft-topbar-session-title');
    expect(yeaftCss).toContain('max-width: 100%;');
    expect(yeaftCss).toContain('text-overflow: ellipsis;');
    expect(yeaftCss).toContain('white-space: nowrap;');
    expect(yeaftCss).toContain('.yeaft-topbar-right');
    expect(yeaftCss).toContain('flex: 0 0 auto;');
  });

  it('keeps Chat header to one visible title line and removes the workdir/path subtitle', () => {
    expect(chatHeaderSource).toContain('<div class="chat-title">{{ headerTitle }}</div>');
    expect(chatHeaderSource).not.toContain('class="chat-title-path"');
    expect(chatHeaderSource).not.toContain('chat-title-path-text');
    expect(chatHeaderSource).not.toContain('{{ folderPath }}');
  });

  it('keeps the Chat header title single-line and shrinkable', () => {
    expect(sidebarCss).toContain('.chat-title-group');
    expect(sidebarCss).toContain('min-width: 0;');
    expect(sidebarCss).toContain('.chat-title');
    expect(sidebarCss).toContain('text-overflow: ellipsis;');
    expect(sidebarCss).toContain('white-space: nowrap;');
  });
});

describe('light theme surface colors', () => {
  it('uses neutral Yeaft mode toggle colors instead of the black accent track', () => {
    expect(sidebarCss).toContain('.mode-toggle.is-yeaft .mode-toggle-track');
    expect(sidebarCss).toContain('background: var(--session-active);');
    expect(sidebarCss).toContain('border-color: var(--border-color);');
    expect(sidebarCss).not.toContain('.mode-toggle.is-yeaft .mode-toggle-track {\n  background: var(--accent);');
  });

  it('maps code blocks to theme surfaces instead of dark-only colors in light mode', () => {
    expect(variablesCss).toContain('  --code-bg: var(--bg-sidebar);');
    expect(variablesCss).toContain('  --code-header-bg: var(--bg-input-wrapper);');
    expect(variablesCss).toContain('  --code-text: var(--text-primary);');
    expect(variablesCss).not.toMatch(/--code-bg:\s*#[0-9a-f]{6}/i);
    expect(variablesCss).not.toMatch(/--code-header-bg:\s*#[0-9a-f]{6}/i);
    expect(variablesCss).not.toMatch(/--code-text:\s*#[0-9a-f]{6}/i);
  });
});
