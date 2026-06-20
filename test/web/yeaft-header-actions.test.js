import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const pageSource = read('components/YeaftPage.js');
const sidebarSource = read('components/YeaftSidebar.js');
const chatHeaderSource = read('components/ChatHeader.js');
const vpTimelineSource = read('components/VpTimelinePane.js');
const sessionActionsSource = read('components/YeaftSessionActions.js');
const yeaftCss = read('styles/yeaft.css');
const sidebarCss = read('styles/sidebar.css');
const variablesCss = read('styles/variables.css');
const enI18n = read('i18n/en.js');
const zhI18n = read('i18n/zh-CN.js');

function actionComponentBlock() {
  const start = sessionActionsSource.indexOf('<div class="yeaft-session-actions">');
  expect(start).toBeGreaterThan(-1);
  const end = sessionActionsSource.indexOf('    </div>', start);
  expect(end).toBeGreaterThan(start);
  return sessionActionsSource.slice(start, end);
}

describe('Yeaft conversation header actions', () => {
  it('keeps announcement controls in the Session status pane, not the conversation header', () => {
    expect(pageSource).not.toContain('yeaft-topbar-announcement-edit');
    expect(pageSource).not.toContain('@click="openAnnouncementSettings"');
    expect(pageSource).toContain('@edit-announcement="openAnnouncementSettings"');
    expect(pageSource).toContain('resolveActiveSessionIdForSettings({');
    expect(pageSource).toContain('const openAnnouncementSettings = () => {');
    expect(pageSource).toContain('const sessionId = activeSessionIdForSettings();');
    expect(pageSource).toContain("openSessionSettings({ sessionId, section: 'announcement' });");
    expect(pageSource).toContain(':initial-section="groupSettingsSection"');
    expect(vpTimelineSource).toContain('class="yeaft-session-status-announcement-card"');
    expect(vpTimelineSource).toContain("$t('yeaft.sessionStatus.announcement')");
    expect(vpTimelineSource).toContain("$t('yeaft.sessionStatus.announcementAdd')");
    expect(yeaftCss).toContain('.yeaft-session-status-announcement-card');
    expect(yeaftCss).not.toContain('.yeaft-topbar-announcement-edit');
    expect(enI18n).toContain("'yeaft.sessionStatus.announcement': 'Announcement'");
    expect(zhI18n).toContain("'yeaft.sessionStatus.announcement': '公告'");
    expect(pageSource).not.toContain('openTopbarGroupSettings');
    expect(sidebarSource).toContain('class="session-dots-btn"');
    expect(sidebarSource).toContain("openGroupSettingsFromMenu(s.raw, 'announcement')");
    expect(sidebarSource).toContain("$t('yeaft.session.openSettings')");
  });

  it('keeps the four session controls owned by the conversation header on desktop', () => {
    expect(pageSource).toContain('<YeaftSessionActions\n            v-if="!showOnboardingGuide"\n            class="yeaft-topbar-right"');
    expect(pageSource).not.toContain('v-if="showHeaderSessionActions"');
    expect(pageSource).not.toContain('showHeaderSessionActions');
    expect(pageSource).not.toContain('<template #actions>');
    expect(vpTimelineSource).not.toContain('<slot name="actions"></slot>');
    expect(yeaftCss).not.toContain('yeaft-session-status-actionbar');

    const statusPaneStart = pageSource.indexOf('<VpTimelinePane');
    expect(statusPaneStart).toBeGreaterThan(-1);
    const afterStatusPane = pageSource.slice(statusPaneStart, pageSource.indexOf('<!-- Right Detail Panel', statusPaneStart));
    expect(afterStatusPane).not.toContain('YeaftSessionActions');
  });

  it('keeps the mobile status pane as a full-screen standalone surface with title and close button', () => {
    expect(vpTimelineSource).toContain('class="yeaft-session-status-header"');
    expect(vpTimelineSource).toContain('class="yeaft-session-status-title"');
    expect(vpTimelineSource).toContain('class="yeaft-session-status-close"');
    expect(yeaftCss).toContain('.yeaft-session-status-header {\n  display: none;\n}');
    expect(yeaftCss).toContain('.yeaft-vp-timeline.mobile-session-status {\n    display: flex;\n    position: fixed;\n    inset: 0;\n    width: 100vw;');
    expect(yeaftCss).toContain('height: 100dvh;\n    z-index: 108;\n    background: var(--bg-main);\n    box-shadow: none;');
    expect(yeaftCss).not.toContain('width: min(360px, 92vw);');
    expect(yeaftCss).toContain('.yeaft-vp-timeline.mobile-session-status .yeaft-session-status-header {\n    display: flex;\n  }');
  });

  it('keeps message refresh as a session-history refresh action', () => {
    const block = actionComponentBlock();

    expect(block).toContain("@click=\"$emit('reload-messages')\"");
    expect(block).toContain("$t('yeaft.reloadMessages')");
    expect(block).toContain('<polyline points="23 4 23 10 17 10"/>');
    expect(block).toContain('<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
    expect(block).not.toContain('<path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h5"/>');
    expect(pageSource).toContain('const reloadMessages = () => {\n      store.reloadYeaftMessages();\n    };');
  });

  it('renders page reload only behind the mobile prop and as the last action', () => {
    const block = actionComponentBlock();
    const pageReloadStart = block.indexOf('v-if="showPageReload"');

    expect(pageReloadStart).toBeGreaterThan(-1);
    expect(block.slice(pageReloadStart)).toContain("@click=\"$emit('reload-page')\"");
    expect(block.slice(0, pageReloadStart)).not.toContain("$emit('reload-page')");
    expect(block.lastIndexOf("$emit('reload-page')")).toBeGreaterThan(block.lastIndexOf("$emit('toggle-debug')"));
    expect(pageSource).toContain(':show-page-reload="isMobile"');
  });

  it('orders actions as refresh, Session status, debug, mobile page refresh', () => {
    const block = actionComponentBlock();
    const order = [
      "$emit('reload-messages')",
      "$emit('toggle-session-status')",
      "$emit('toggle-debug')",
      "$emit('reload-page')",
    ].map((needle) => block.indexOf(needle));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('conversation header titles', () => {
  it('renders a readable Yeaft session title in the header with id/path fallback hidden from visible text', () => {
    expect(pageSource).toContain('class="yeaft-topbar-title-group"');
    expect(pageSource).toContain("showOnboardingGuide ? $t('yeaft.onboarding.topbarTitle') : (topbarSessionTitle || $t('yeaft.session.create.untitled'))");
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
