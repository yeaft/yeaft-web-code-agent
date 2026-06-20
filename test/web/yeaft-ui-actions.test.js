import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const pageSource = read('components/YeaftPage.js');
const sessionActionsSource = read('components/YeaftSessionActions.js');
const debugSource = read('components/YeaftDebugPanel.js');
const timelineSource = read('components/VpTimelinePane.js');
const settingsSource = read('components/SettingsPanel.js');
const sessionSettingsSource = read('components/SessionSettingsModal.js');
const sidebarSource = read('components/YeaftSidebar.js');
const vpCrudSource = read('components/VpCrudPanel.js');
const yeaftCss = read('styles/yeaft.css');
const enI18n = read('i18n/en.js');
const zhI18n = read('i18n/zh-CN.js');

describe('Yeaft UI action polish', () => {
  it('keeps header action icons visually consistent', () => {
    expect(sessionActionsSource).toContain('class="yeaft-dream-icon"');
    expect(sessionActionsSource).toContain('class="yeaft-dream-moon"');
    expect(sessionActionsSource).toContain('class="yeaft-dream-spark"');
    expect(sessionActionsSource).not.toContain('yeaft-dream-arc');
    expect(yeaftCss).toContain('.yeaft-topbar-dream-toggle.running .yeaft-dream-icon');
    expect(yeaftCss).toContain('.yeaft-topbar-right :where(');
    expect(yeaftCss).toContain('width: 32px;');
    expect(yeaftCss).toContain('height: 32px;');
    expect(yeaftCss).toContain('flex: 0 0 18px;');
    expect(yeaftCss).not.toContain('.yeaft-topbar-dream-toggle.running .yeaft-topbar-dream-icon');
  });

  it('replaces VP profile info with an edit action that opens Settings VP editor', () => {
    expect(timelineSource).toContain("emits: ['mention-vp', 'edit-vp', 'start-resize', 'cancel-vp-turn', 'edit-announcement', 'close']");
    expect(timelineSource).toContain('class="yeaft-vp-timeline-edit"');
    expect(timelineSource).toContain("$t('yeaft.vpTimeline.edit')");
    expect(timelineSource).not.toContain('yeaft-vp-timeline-info');
    expect(timelineSource).not.toContain('vpTimeline.info');
    expect(timelineSource).not.toContain('open-vp-detail');

    expect(pageSource).toContain('@edit-vp="onEditVpFromTimeline"');
    expect(pageSource).toContain('const onEditVpFromTimeline = (vpId) => {');
    expect(pageSource).toContain("openSessionSettings({ sessionId, section: 'members', editVpId: vpId });");
    expect(pageSource).toContain(':initial-edit-vp-id="groupSettingsEditVpId"');
    expect(pageSource).not.toContain('onOpenVpDetailFromTimeline');

    expect(sessionSettingsSource).toContain('initialEditVpId: { type: String, default: \'\' }');
    expect(sessionSettingsSource).toContain("section: this.initialEditVpId ? 'members' : this.initialSection");
    expect(sessionSettingsSource).toContain("'is-edit-target': highlightedVpId === vp.vpId");
    expect(settingsSource).toContain('<VpCrudPanel :initial-edit-vp-id="initialEditVpId" />');
    expect(vpCrudSource).toContain('initialEditVpId: { type: String, default: \'\' }');
    expect(vpCrudSource).toContain('openInitialEdit()');
    expect(enI18n).toContain("'yeaft.vpTimeline.edit': 'Edit VP'");
    expect(zhI18n).toContain("'yeaft.vpTimeline.edit': '编辑 VP'");
    expect(enI18n).not.toContain('yeaft.vpTimeline.info');
    expect(zhI18n).not.toContain('yeaft.vpTimeline.info');
  });

  it('adds an i18n close button to the debug panel header', () => {
    expect(debugSource).toContain("emits: ['close']");
    expect(debugSource).toContain('class="yeaft-debug-header-actions"');
    expect(debugSource).toContain('class="yeaft-debug-close"');
    expect(debugSource).toContain("@click=\"$emit('close')\"");
    expect(debugSource).toContain("$t('yeaft.debugClose')");
    expect(pageSource).toContain('<YeaftDebugPanel @close="closeDebug" />');
    expect(pageSource).toContain('const closeDebug = () => {');
    expect(yeaftCss).toContain('.yeaft-debug-close');
    expect(enI18n).toContain("'yeaft.debugClose': 'Close debug panel'");
    expect(zhI18n).toContain("'yeaft.debugClose': '关闭调试面板'");
  });

  it('labels session deletion plainly and keeps list removal recoverable', () => {
    expect(enI18n).toContain("'yeaft.session.settings.nav.danger': 'Delete session'");
    expect(zhI18n).toContain("'yeaft.session.settings.nav.danger': '删除会话'");
    expect(enI18n).toContain("'yeaft.session.removeFromList': 'Remove'");
    expect(zhI18n).toContain("'yeaft.session.removeFromList': '移除'");

    expect(enI18n).not.toContain('Danger zone');
    expect(zhI18n).not.toContain('危险操作');
    expect(sessionSettingsSource).toContain('group-settings-section-delete');
    expect(sessionSettingsSource).toContain('group-settings-delete-btn');
    expect(sessionSettingsSource).not.toContain('group-settings-section-danger');
    expect(sessionSettingsSource).not.toContain('group-settings-danger-btn');
    expect(sidebarSource).toContain("sessionCrudRequest;\n      if (typeof fn === 'function') fn.call(this.chatStore, 'archive', { sessionId: g.id });");
    expect(sidebarSource).not.toContain('class="session-menu-item danger" @click="onRemoveFromList');
  });

  it('keeps newly touched Yeaft action CSS on design tokens', () => {
    const touched = [
      '.yeaft-debug-close',
      '.yeaft-vp-timeline-edit',
      '.yeaft-topbar-dream-toggle',
      '.group-settings-delete-btn',
      '.group-settings-section-delete .group-settings-heading',
    ];
    for (const selector of touched) {
      const start = yeaftCss.indexOf(selector);
      expect(start).toBeGreaterThan(-1);
      const block = yeaftCss.slice(start, yeaftCss.indexOf('}', start) + 1);
      expect(block).not.toMatch(/#[0-9a-f]{3,6}/i);
      expect(block).not.toContain('rgba(');
      expect(block).not.toContain('var(--error)');
    }
  });
});
