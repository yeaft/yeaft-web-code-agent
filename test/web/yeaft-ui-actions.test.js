import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const pageSource = read('components/YeaftPage.js');
const chatStoreSource = read('stores/chat.js');
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
    expect(yeaftCss).toContain('.yeaft-topbar-right :where(');
    expect(yeaftCss).toContain('width: 32px;');
    expect(yeaftCss).toContain('height: 32px;');
    expect(yeaftCss).toContain('flex: 0 0 18px;');
  });

  it('replaces VP profile info with an edit action that opens Settings VP editor', () => {
    expect(timelineSource).toContain("emits: ['mention-vp', 'edit-vp', 'start-resize', 'cancel-vp-turn', 'edit-announcement'");
    expect(timelineSource).toContain("'close'");
    expect(timelineSource).toContain('class="yeaft-vp-timeline-edit"');
    expect(timelineSource).toContain("$t('yeaft.vpTimeline.edit')");
    expect(timelineSource).not.toContain('yeaft-vp-timeline-info');
    expect(timelineSource).not.toContain('vpTimeline.info');
    expect(timelineSource).not.toContain('open-vp-detail');

    expect(pageSource).toContain('@edit-vp="onEditVpFromTimeline"');
    expect(pageSource).toContain('const onEditVpFromTimeline = (vpId) => {');
    expect(pageSource).toContain('const sessionId = activeSessionIdForSettings();');
    expect(pageSource).toContain("openSessionSettings({ sessionId, section: 'members', editVpId: vpId });");
    expect(pageSource).toContain(':initial-edit-vp-id="groupSettingsEditVpId"');
    expect(pageSource).not.toContain('onOpenVpDetailFromTimeline');

    expect(sessionSettingsSource).toContain('initialEditVpId: { type: String, default: \'\' }');
    expect(sessionSettingsSource).toContain("section: this.initialEditVpId ? 'members' : normalizeSettingsSection(this.initialSection)");
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

  it('keeps rename, announcement, and delete on one Session settings page', () => {
    expect(enI18n).toContain("'yeaft.session.settings.nav.session': 'Session'");
    expect(zhI18n).toContain("'yeaft.session.settings.nav.session': '会话'");
    expect(enI18n).toContain("'yeaft.session.removeFromList': 'Remove'");
    expect(zhI18n).toContain("'yeaft.session.removeFromList': '移除'");

    expect(enI18n).not.toContain('Danger zone');
    expect(zhI18n).not.toContain('危险操作');
    expect(sessionSettingsSource).toContain("const SESSION_SETTINGS_SECTION = 'session';");
    expect(sessionSettingsSource).toContain("const LEGACY_SESSION_SETTINGS_SECTIONS = new Set(['announcement', 'rename', 'danger']);");
    expect(sessionSettingsSource).toContain("{ id: SESSION_SETTINGS_SECTION, label: this.$t('yeaft.session.settings.nav.session') }");
    expect(sessionSettingsSource).not.toContain("settings.nav.announcement");
    expect(sessionSettingsSource).not.toContain("settings.nav.rename");
    expect(sessionSettingsSource).not.toContain("settings.nav.danger");
    expect(sessionSettingsSource).toContain('group-settings-section-session');
    expect(sessionSettingsSource).toContain('group-settings-section-delete');
    expect(sessionSettingsSource).toContain('group-settings-delete-btn');
    expect(sessionSettingsSource).not.toContain('group-settings-section-danger');
    expect(sessionSettingsSource).not.toContain('group-settings-danger-btn');
    expect(sidebarSource).toContain("sessionCrudRequest;\n      if (typeof fn === 'function') fn.call(this.chatStore, 'archive', { sessionId: g.id }, { agentId: g.agentId || null });");
    expect(sidebarSource).not.toContain('class="session-menu-item danger" @click="onRemoveFromList');
  });

  it('lets users inspect and stop background shell tasks from the Session status pane', () => {
    expect(timelineSource).toContain('stoppingTasksById: { type: Object');
    expect(timelineSource).toContain("'cancel-task'");
    expect(timelineSource).toContain('shellTaskCommand(task)');
    expect(timelineSource).toContain('taskSummaryTitle(task)');
    expect(timelineSource).toContain(':title="taskSummaryTitle(task)"');
    expect(timelineSource).toContain('<code v-if="shellTaskCommand(task)" class="yeaft-vp-task-command">{{ shellTaskCommand(task) }}</code>');
    expect(timelineSource).toContain("$emit('cancel-task', task)");
    expect(timelineSource).toContain('isTaskCancellable(task)');
    expect(timelineSource).toContain("task?.kind === 'shell' && task?.status === 'running' && !!task?.runtime?.pid");
    expect(timelineSource).toContain('isTaskStopping(task)');

    expect(pageSource).toContain(':stopping-tasks-by-id="store.yeaftStoppingTasksById"');
    expect(pageSource).toContain('@cancel-task="onCancelTaskFromTimeline"');
    expect(pageSource).toContain('const onCancelTaskFromTimeline = (task) => {');
    expect(pageSource).toContain('store.cancelYeaftTask({ sessionId: task.sessionId, taskId: task.id })');

    expect(chatStoreSource).toContain('yeaftStoppingTasksById: {}');
    expect(chatStoreSource).toContain('function taskStopKey(sessionId, taskId)');
    expect(chatStoreSource).toContain('cancelYeaftTask({ sessionId, taskId })');
    expect(chatStoreSource).toContain("type: 'yeaft_task_cancel'");
    expect(chatStoreSource).toContain("case 'yeaft_task_cancel_result':");

    expect(enI18n).toContain("'yeaft.sessionStatus.task.title': 'Task'");
    expect(enI18n).toContain("'yeaft.sessionStatus.task.command': 'Command'");
    expect(enI18n).toContain("'yeaft.sessionStatus.task.stop': 'Stop task'");
    expect(zhI18n).toContain("'yeaft.sessionStatus.task.title': '任务'");
    expect(zhI18n).toContain("'yeaft.sessionStatus.task.command': '命令'");
    expect(zhI18n).toContain("'yeaft.sessionStatus.task.stop': '停止任务'");
    expect(yeaftCss).toContain('.yeaft-vp-task-command');
    expect(yeaftCss).toContain('.yeaft-vp-task-cancel');
  });

  it('keeps newly touched Yeaft action CSS on design tokens', () => {
    const touched = [
      '.yeaft-debug-close',
      '.yeaft-vp-timeline-edit',
      '.group-settings-delete-btn',
      '.group-settings-section-delete .group-settings-heading',
      '.group-settings-section-session',
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
