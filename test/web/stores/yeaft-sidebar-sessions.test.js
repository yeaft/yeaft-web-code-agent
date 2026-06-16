import { describe, expect, it } from 'vitest';

import { buildYeaftSidebarSessionList } from '../../../web/stores/helpers/yeaft-sidebar-sessions.js';

const YEAFT_SIDEBAR_SOURCE = await import('node:fs').then(fs => fs.readFileSync(
  new URL('../../../web/components/YeaftSidebar.js', import.meta.url),
  'utf8',
));

function ids(rows) {
  return rows.map(row => row.id);
}

describe('Yeaft sidebar session list', () => {
  it('marks pinned Yeaft sessions for the sidebar pin indicator', () => {
    const rows = buildYeaftSidebarSessionList({
      sessions: [
        { id: 's-a', createdAt: 1 },
        { id: 's-b', createdAt: 2 },
      ],
      activeSessionId: null,
      pinnedSessionIds: ['s-b'],
    });

    expect(rows.find(row => row.id === 's-b')).toMatchObject({ pinned: true });
    expect(rows.find(row => row.id === 's-a')).toMatchObject({ pinned: false });
  });

  it('marks the active Yeaft session without requiring it to be pinned', () => {
    const rows = buildYeaftSidebarSessionList({
      sessions: [
        { id: 's-a', createdAt: 1 },
        { id: 's-b', createdAt: 2 },
      ],
      activeSessionId: 's-a',
      pinnedSessionIds: [],
    });

    expect(rows.find(row => row.id === 's-a')).toMatchObject({ active: true, pinned: false });
    expect(rows.find(row => row.id === 's-b')).toMatchObject({ active: false });
  });

  it('keeps pinned sessions above the active non-pinned session', () => {
    const rows = buildYeaftSidebarSessionList({
      sessions: [
        { id: 's-active', lastMessageAt: 300 },
        { id: 's-old', lastMessageAt: 100 },
        { id: 's-pin', lastMessageAt: 50 },
      ],
      activeSessionId: 's-active',
      pinnedSessionIds: ['s-pin'],
    });

    expect(ids(rows)).toEqual(['s-pin', 's-active', 's-old']);
    expect(rows[0]).toMatchObject({ id: 's-pin', pinned: true, active: false });
    expect(rows[1]).toMatchObject({ id: 's-active', pinned: false, active: true });
  });

  it('keeps multiple pinned sessions stable above an active non-pinned session', () => {
    const rows = buildYeaftSidebarSessionList({
      sessions: [
        { id: 's-active', lastMessageAt: 400 },
        { id: 's-pin-old', lastMessageAt: 100 },
        { id: 's-free', lastMessageAt: 300 },
        { id: 's-pin-new', lastMessageAt: 200 },
      ],
      activeSessionId: 's-active',
      pinnedSessionIds: ['s-pin-new', 's-pin-old'],
    });

    expect(ids(rows)).toEqual(['s-pin-new', 's-pin-old', 's-active', 's-free']);
  });

  it('wires pinned and active metadata into YeaftSidebar visual classes', () => {
    expect(YEAFT_SIDEBAR_SOURCE).toContain('class="session-pin-icon"');
    expect(YEAFT_SIDEBAR_SOURCE).toContain(':class="{ active: s.active, pinned: s.pinned');
  });
});

describe('Yeaft settings entry markup', () => {
  it('uses session-scoped processing dots and no standalone LLM gear button', async () => {
    expect(YEAFT_SIDEBAR_SOURCE).toContain('isSessionProcessing(s.id)');

    const pageSource = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../../web/components/YeaftPage.js', import.meta.url),
      'utf8',
    ));
    expect(pageSource).not.toContain('yeaft.modelMenu.label');
    expect(pageSource).toContain('yeaft-model-config-option');
    expect(pageSource).toContain('settings.llm.configureMenu');
    expect(pageSource).not.toContain('class="yeaft-topbar-llm-config"');
    expect(pageSource).toContain('yeaft-llm-config-overlay');
    expect(pageSource).not.toContain('yeaft-topbar-group-settings');
    expect(YEAFT_SIDEBAR_SOURCE).toContain('yeaft.session.openSettings');

    const cssSource = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../../web/styles/yeaft.css', import.meta.url),
      'utf8',
    ));
    expect(cssSource).toContain('.yeaft-topbar-model-dropdown');
    expect(cssSource).toContain('top: calc(100% + 8px);');
    expect(cssSource).toContain('max-height: min(420px, calc(100vh - 120px));');

    const enSource = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../../web/i18n/en.js', import.meta.url),
      'utf8',
    ));
    const zhSource = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../../web/i18n/zh-CN.js', import.meta.url),
      'utf8',
    ));
    expect(enSource).toContain("'settings.llm.configureMenu': 'LLM Settings'");
    expect(zhSource).toContain("'settings.llm.configureMenu': '设置 LLM'");
  });
});
