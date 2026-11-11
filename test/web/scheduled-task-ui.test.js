// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { useUserPreferences } from '../../web/utils/user-preferences.js';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
globalThis.Pinia = { defineStore: () => () => ({}) };
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
import { scheduleFormResult } from '../../web/utils/work-center-schedule.js';
import WorkCenterScheduleEditor from '../../web/components/WorkCenterScheduleEditor.js';
import en from '../../web/i18n/en.js';
import ScheduledTaskEditor from '../../web/components/ScheduledTaskEditor.js';
import ScheduledTaskBar from '../../web/components/ScheduledTaskBar.js';
import VpTimelinePane from '../../web/components/VpTimelinePane.js';
import ScheduledTaskSettings from '../../web/components/ScheduledTaskSettings.js';
import ScheduledTaskNotifications from '../../web/components/ScheduledTaskNotifications.js';
import YeaftSessionActions from '../../web/components/YeaftSessionActions.js';
import zh from '../../web/i18n/zh-CN.js';

let wrapper;
const t = key => en[key] || key;
const agents = [{ id: 'a', online: true, capabilities: ['scheduled_tasks'] }];
const task = { prompt: 'Check the build', enabled: true, notify: true, trigger: { type: 'manual' } };
const row = (id, extra = {}) => ({ catalogKey: `yeaft:a:${id}`, runtimeProvider: 'yeaft', title: id, availability: 'online', routeRef: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: id }, ...extra });
beforeEach(() => { vi.stubGlobal('Vue', Vue); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); delete window.Pinia; wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('keeps only mobile page reload in Session actions, with no message replay on either viewport', async () => {
  for (const messages of [en, zh]) {
    wrapper = mount(YeaftSessionActions, { props: { canUseWorkbench: true },
      global: { mocks: { $t: key => messages[key] || key } } });
    expect(wrapper.find('.yeaft-reload-btn').exists()).toBe(false);
    expect(wrapper.find(`button[aria-label="${messages['yeaft.reloadMessages']}"]`).exists()).toBe(false);
    expect(YeaftSessionActions.emits).not.toContain('reload-messages');
    await wrapper.setProps({ showPageReload: true });
    expect(wrapper.findAll('.yeaft-reload-btn')).toHaveLength(1);
    const reload = wrapper.get('.yeaft-page-reload-btn');
    expect(reload.attributes('type')).toBe('button');
    expect(reload.attributes('aria-label')).toBe(messages['yeaft.reloadPage']);
    await reload.trigger('click');
    expect(wrapper.emitted('reload-page')).toEqual([[]]);
    expect(wrapper.emitted('reload-messages')).toBeUndefined();
    await wrapper.get('.yeaft-search-btn').trigger('click');
    await wrapper.get('.yeaft-session-status-toggle').trigger('click');
    await wrapper.get('.yeaft-workbench-toggle').trigger('click');
    for (const event of ['toggle-search', 'toggle-session-status', 'toggle-workbench']) {
      expect(wrapper.emitted(event)).toEqual([[]]);
    }
    await wrapper.setProps({ showPageReload: false });
    expect(wrapper.find('.yeaft-reload-btn').exists()).toBe(false);
    wrapper.unmount();
    wrapper = null;
  }
});

it('lists task Sessions in recents or their owning Project with a badge and shared actions', async () => {
  // Old Tasks-collapse state must not hide tasks in either current section.
  localStorage.setItem('yeaft-sidebar-section-collapse', JSON.stringify({ tasks: true }));
  let saved = { sidebarProjectsRatio: 0.5, sidebarActionsCompact: false, sidebarCollapsedSections: {} };
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options?.method === 'PATCH') saved = { ...saved, ...JSON.parse(options.body) };
    return { ok: true, json: async () => saved };
  }));
  vi.stubGlobal('Pinia', { useAuthStore: () => auth });
  const auth = Vue.reactive({ isAuthenticated: true, userId: 'task-sidebar-owner', authGeneration: 1 });
  const preferences = useUserPreferences();
  const taskRow = row('task', { task });
  const otherTask = row('task', { catalogKey: 'yeaft:b:task', task, routeRef: { runtimeProvider: 'yeaft', agentId: 'b', sessionId: 'task' } });
  const project = { id: 'p', name: 'Project', members: [{ agentId: 'a', sessionId: 'task' }] };
  const mutateProject = vi.fn(async () => ({ ok: true }));
  wrapper = mount(UnifiedSessionList, { attachTo: document.body, props: { agents: [...agents, { id: 'b', online: true }],
    sessions: [taskRow, otherTask, row('chat')], projects: [project],
    projectStore: { mutateProject }, isSessionUnread: item => item.catalogKey === taskRow.catalogKey }, global: { mocks: { $t: t } } });
  await flushPromises();
  expect(wrapper.find('.tasks-section').exists()).toBe(false);
  expect(wrapper.get('.projects-section').findAll('.sidebar-session-row')).toHaveLength(1);
  expect(wrapper.get('.recents-section').findAll('.sidebar-session-row')).toHaveLength(2);
  expect(wrapper.get('.projects-section .sidebar-session-task').attributes('aria-label')).toBe('Task');
  expect(wrapper.get('.recents-section').findAll('.sidebar-session-task')).toHaveLength(1);
  expect(wrapper.get('.projects-section .sidebar-session-row .sidebar-session-unread').exists()).toBe(true);
  expect(wrapper.get('.sidebar-project-unread').exists()).toBe(true);
  await wrapper.get('.projects-section .sidebar-session-row').trigger('keydown', { key: 'Enter' });
  expect(wrapper.emitted('select')[0][0]).toEqual(taskRow);
  await wrapper.get('.projects-section .session-quick-action').trigger('click');
  expect(wrapper.emitted('action').at(-1)[0]).toEqual({ action: 'pin', row: taskRow });
  await wrapper.get('.projects-section .session-quick-action[aria-label="Remove from sidebar"]').trigger('click');
  expect(wrapper.emitted('action').at(-1)[0]).toEqual({ action: 'remove', row: taskRow });
  await wrapper.get('.projects-section .sidebar-session-row .session-dots-btn').trigger('click');
  const menu = document.querySelector('.session-menu-floating');
  expect(menu.textContent).toContain('Remove from project');
  await wrapper.vm.moveRow(taskRow, null);
  expect(mutateProject).toHaveBeenLastCalledWith('move_session', { sessionId: 'task', projectId: null }, 'a');
  // Use the same drag/reorder path across Projects and Recents for task rows.
  wrapper.vm.startDrag(otherTask);
  await wrapper.vm.dropOnProject(project);
  expect(mutateProject).toHaveBeenLastCalledWith('move_session', expect.objectContaining({ sessionId: 'task', projectId: 'p', catalogOrder: expect.any(Array) }), 'b');
  await wrapper.setProps({ projects: [{ ...project, members: [] }] });
  expect(wrapper.get('.recents-section').findAll('.sidebar-session-row')).toHaveLength(3);
  await wrapper.get('.recents-section .sidebar-section-toggle').trigger('click');
  expect(wrapper.find('.recents-section .sidebar-session-row').exists()).toBe(false);
  await flushPromises();
  expect(saved.sidebarCollapsedSections).toEqual({ recents: true });
  expect(JSON.parse(localStorage.getItem('yeaft-sidebar-section-collapse'))).toEqual({ tasks: true });
  await wrapper.get('.sidebar-task-create').trigger('click');
  expect(wrapper.emitted('create-task')).toHaveLength(1);
  const heading = wrapper.get('.recents-section .sidebar-section-heading');
  expect(heading.findAll('button').map(button => button.attributes('aria-label')))
    .toEqual(['New chat', 'New task', 'Recents']);
  expect(heading.findAll('button').at(-1).classes()).toContain('sidebar-section-toggle');
  expect(wrapper.get('.projects-section .sidebar-section-heading').findAll('button').map(button => button.attributes('aria-label')))
    .toEqual(['New project', 'Projects']);
  // The added shortcut uses exactly the existing task creation contract, even
  // while Recents is collapsed, and stays disabled during catalog hydration.
  await wrapper.get('.sidebar-recents-task-create').trigger('click');
  expect(wrapper.emitted('create-task')).toHaveLength(2);
  expect(wrapper.get('.sidebar-recents-task-create circle').attributes('r')).toBe('9');
  await wrapper.setProps({ loading: true });
  expect(wrapper.get('.sidebar-recents-task-create').attributes('disabled')).toBeDefined();
  await wrapper.get('.sidebar-recents-task-create').trigger('click');
  expect(wrapper.emitted('create-task')).toHaveLength(2);
  preferences.dispose();
});

it('creates task Sessions with the existing roster and folder contract and rejects unsupported Agents', async () => {
  const create = vi.fn(async () => ({ ok: true, session: { id: 'task', agentId: 'a', task } }));
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true, agents, currentAgent: 'a', createYeaftSession: create, sendWsMessage: vi.fn(), setActiveSessionFilter: vi.fn(), yeaftStatusByAgent: { a: { availableModels: [{ provider: 'test', id: 'model', label: 'Model', effortOptions: ['low', 'medium', 'high', 'xhigh'] }] } } });
  const vp = { snapshotStatus: 'ready', snapshotAgentId: 'a', lastVpSnapshotAgentId: 'a', vpList: [{ vpId: 'omni', name: 'Omni' }] };
  window.Pinia = { useChatStore: () => chat, useVpStore: () => vp, useSessionsStore: () => ({ sessionList: [], setActive: vi.fn() }) };
  wrapper = mount(SessionCreateModal, { props: { taskMode: true }, global: { mocks: { $t: t }, stubs: { ModernSelect: true, FolderPickerDialog: true, VpAvatar: true } } });
  expect(wrapper.vm.canSubmit).toBe(false);
  expect(document.querySelector('.task-create-header')).not.toBeNull();
  expect(document.querySelector('.yeaft-create-submit svg')).toBeNull();
  expect(document.querySelector('.session-create-flow.is-task .scheduled-task-editor')).not.toBeNull();
  expect(document.querySelector('.resume-modal-footer')?.closest('.session-create-flow')).toBeNull();
  await wrapper.setData({ taskDraft: task, taskValid: true, form: { ...wrapper.vm.form, workDir: '/repo', vpIds: ['omni'] } });
  expect(wrapper.vm.canSubmit).toBe(true);
  // The layout wrapper is no longer a fieldset: slot controls must explicitly
  // preserve native disabled semantics while the create request is in flight.
  await wrapper.setData({ busy: true, vpRosterOpen: true });
  expect(document.querySelector('.scheduled-task-editor').getAttribute('aria-disabled')).toBe('true');
  expect(document.querySelector('.yeaft-roster-default-star').disabled).toBe(true);
  expect([...document.querySelectorAll('.scheduled-task-editor input, .scheduled-task-editor textarea, .scheduled-task-editor button')]
    .every(control => control.disabled)).toBe(true);
  await wrapper.setData({ busy: false, vpRosterOpen: false });
  chat.scheduledTaskProtocolSupported = false;
  await Vue.nextTick();
  expect(wrapper.vm.canSubmit).toBe(false);
  expect(document.body.textContent).toContain(en['scheduledTasks.serverUpgrade']);
  await wrapper.vm.onSubmit();
  expect(create).not.toHaveBeenCalled();
  chat.scheduledTaskProtocolSupported = true;
  await Vue.nextTick();
  await wrapper.vm.onSubmit();
  await flushPromises();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', vpIds: ['omni'], workDir: '/repo', task }));
  expect(wrapper.vm.taskModelOptions.at(-1)).toMatchObject({ value: 'test/model', label: 'Model' });
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'test/model' } });
  await wrapper.vm.onSubmit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ config: { model: 'test/model' }, task }));
  expect(wrapper.vm.taskEffortOptions).toEqual([
    { value: '', label: 'Default' },
    { value: 'medium', label: 'Medium' }, { value: 'xhigh', label: 'X-High' },
  ]);
  chat.yeaftStatusByAgent.a.availableModels[0].effortOptions.unshift('minimal');
  await Vue.nextTick();
  expect(wrapper.vm.taskEffortOptions).not.toContainEqual({ value: 'minimal', label: 'Minimal' });
  for (const modelEffort of ['medium', 'xhigh']) {
    await wrapper.setData({ form: { ...wrapper.vm.form, modelEffort } });
    await wrapper.vm.onSubmit();
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ config: { model: 'test/model', modelEffort }, task }));
  }
  await wrapper.setData({ form: { ...wrapper.vm.form, modelEffort: '' } });
  await wrapper.vm.onSubmit();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ config: { model: 'test/model' }, task }));
  chat.agents = [{ ...agents[0], capabilities: [] }];
  await Vue.nextTick();
  expect(wrapper.vm.canSubmit).toBe(false);
  delete window.Pinia;
});

it('scopes task effort capabilities to the selected Agent and clears incompatible overrides', async () => {
  const models = [
    { provider: 'test', id: 'model', effortOptions: ['low', 'medium', 'high', 'xhigh'] },
    { provider: 'other', id: 'model', effortOptions: ['medium'] },
    { provider: 'test', id: 'plain' },
  ];
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true,
    agents: [...agents, { ...agents[0], id: 'b' }], currentAgent: 'a', sendWsMessage: vi.fn(),
    yeaftAvailableModels: models, yeaftStatusByAgent: { a: { availableModels: models }, b: { availableModels: [] } } });
  window.Pinia = { useChatStore: () => chat, useVpStore: () => ({}) };
  wrapper = mount(SessionCreateModal, { props: { taskMode: true }, global: { mocks: { $t: t }, stubs: { ModernSelect: true, FolderPickerDialog: true, VpAvatar: true } } });
  const effort = () => wrapper.findAllComponents({ name: 'ModernSelect' }).find(item => item.props('ariaLabel') === 'Effort');
  expect(effort().props('disabled')).toBe(true);
  expect(wrapper.vm.taskSessionConfig).toEqual({});
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'test/model' } });
  expect(effort().props('disabled')).toBe(false);
  await wrapper.setData({ form: { ...wrapper.vm.form, modelEffort: 'xhigh' } });
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'other/model' } });
  expect(wrapper.vm.form.modelEffort).toBe('');
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'test/model', modelEffort: 'xhigh' } });
  expect(wrapper.vm.form.modelEffort).toBe('xhigh');
  chat.yeaftStatusByAgent.a.availableModels[0].effortOptions = ['medium'];
  await Vue.nextTick();
  expect(wrapper.vm.form.modelEffort).toBe('');
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'test/plain' } });
  expect(effort().props('disabled')).toBe(true);
  await wrapper.setData({ form: { ...wrapper.vm.form, model: 'test/model', modelEffort: 'medium' } });
  await wrapper.setData({ busy: true });
  expect(effort().props('disabled')).toBe(true);
  await wrapper.setData({ busy: false, form: { ...wrapper.vm.form, agentId: 'b' } });
  expect(wrapper.vm.form.model).toBe('');
  expect(wrapper.vm.form.modelEffort).toBe('');
  expect(wrapper.vm.taskModelOptions).toHaveLength(1);
  expect(effort().props('disabled')).toBe(true);
  await wrapper.setProps({ taskMode: false });
  expect(effort()).toBeUndefined();
});

it('reuses schedule validation, emits only supported triggers and preserves an unchanged past schedule', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2039, 0, 1));
  const pastTask = { ...task, trigger: { type: 'schedule', scheduledFor: Date.now() - 86400000, recurrence: null } };
  wrapper = mount(ScheduledTaskEditor, { props: { modelValue: pastTask, 'onUpdate:modelValue': value => wrapper.setProps({ modelValue: value }) }, global: { mocks: { $t: t, $locale: 'en' }, stubs: { ModernSelect: true } } });
  expect(wrapper.emitted('valid')[0]).toEqual([true]);
  expect(wrapper.findComponent({ name: 'WorkCenterScheduleEditor' }).exists()).toBe(false);
  expect(wrapper.text()).toContain(en['scheduledTasks.existingSchedule']);
  await wrapper.get('.scheduled-task-existing-schedule button').trigger('click');
  expect(wrapper.findComponent({ name: 'WorkCenterScheduleEditor' }).exists()).toBe(true);
  expect(wrapper.vm.triggerOptions.map(item => item.value)).toEqual(['manual', 'schedule']);
  expect(wrapper.findAll('[role="switch"]')).toHaveLength(2);
  expect(wrapper.get('[aria-label="Trigger"] button[aria-pressed="true"]').text()).toBe('Schedule');
  wrapper.vm.updateSchedule({ ...wrapper.vm.schedule, date: '2040-01-02', timeZone: 'UTC', time: '09:30', frequency: 'weekly', weekdays: [5, 1], end: 'never' });
  await Vue.nextTick();
  expect(wrapper.props('modelValue').trigger).toEqual({ type: 'schedule', scheduledFor: Date.UTC(2040, 0, 2, 9, 30), recurrence: { frequency: 'weekly', timeZone: 'UTC', time: '09:30', weekdays: [1, 5], endsAt: null, maxRuns: null } });
  wrapper.vm.updateSchedule({ ...wrapper.vm.schedule, time: '25:00' });
  await Vue.nextTick();
  expect(wrapper.emitted('valid').at(-1)).toEqual([false]);
  await wrapper.setProps({ modelValue: { ...task, trigger: { type: 'connector', event: 'future' } } });
  expect(wrapper.vm.valid).toBe(false);
  expect(wrapper.text()).toContain(en['scheduledTasks.unsupportedTrigger']);
});

it('runs and pauses the Agent-scoped task schedule with revision, pending and failure guards, never cancelling execution', async () => {
  const configured = { ...task, revision: 'task-r1', trigger: { type: 'schedule', scheduledFor: Date.now() + 86400000 } };
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true, agents, connectionState: 'connected',
    runScheduledTask: vi.fn(async () => ({ ok: false, error: { message: 'Execution failed' } })),
    updateScheduledTask: vi.fn(async () => ({ ok: true })),
    isYeaftSessionProcessing: () => false, cancelYeaftSession: vi.fn() });
  window.Pinia = { useChatStore: () => chat };
  wrapper = mount(ScheduledTaskBar, { props: { agentId: 'a', session: { id: 'task', task: configured } }, global: { mocks: { $t: t } } });
  await wrapper.get('.scheduled-task-run').trigger('click');
  await flushPromises();
  expect(chat.runScheduledTask).toHaveBeenCalledWith({ agentId: 'a', sessionId: 'task' });
  expect(wrapper.get('[role="alert"]').text()).toBe('Execution failed');
  expect(wrapper.find('details').exists()).toBe(false);
  expect(wrapper.findAll('[role="alert"]')).toHaveLength(1);
  await wrapper.get('.scheduled-task-configure').trigger('click');
  expect(wrapper.emitted('configure')).toHaveLength(1);
  // Idle but enabled is exactly when users need to stop the next occurrence.
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeUndefined();
  await wrapper.get('.scheduled-task-stop').trigger('click');
  await flushPromises();
  expect(chat.updateScheduledTask).toHaveBeenCalledExactlyOnceWith({ agentId: 'a', sessionId: 'task',
    task: { enabled: false }, expectedRevision: 'task-r1' });
  expect(chat.cancelYeaftSession).not.toHaveBeenCalled();
  expect(wrapper.vm.error).toBe('');
  await wrapper.setProps({ session: { id: 'task', task: { ...configured, enabled: false, revision: 'task-r2' } } });
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('.scheduled-task-runtime').text()).toContain('Paused');
  await wrapper.vm.stop();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(1);
  // Pausing an enabled schedule is allowed during a run, and waits for its own
  // persistence ACK, not runtime changes, connectivity changes or broadcasts.
  const active = { ...configured, revision: 'task-r3', lastRun: { status: 'running' } };
  await wrapper.setProps({ session: { id: 'task', task: active } });
  let acknowledge;
  chat.updateScheduledTask.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  await wrapper.get('.scheduled-task-stop').trigger('click');
  expect(wrapper.get('.scheduled-task-stop').attributes('aria-label')).toBe(en['scheduledTasks.stopping']);
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.scheduled-task-runtime [role="status"]').text()).toBe('Running');
  const runsBefore = chat.runScheduledTask.mock.calls.length;
  await wrapper.vm.stop();
  await wrapper.vm.run();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(2);
  expect(chat.runScheduledTask).toHaveBeenCalledTimes(runsBefore);
  await wrapper.setProps({ session: { id: 'task', task: { ...active, enabled: false, lastRun: { status: 'completed' } } } });
  chat.connectionState = 'disconnected';
  await Vue.nextTick();
  expect(wrapper.vm.stopping).toBe(true);
  chat.connectionState = 'connected';
  acknowledge({ ok: true });
  await flushPromises();
  expect(wrapper.vm.stopping).toBe(false);
  expect(chat.cancelYeaftSession).not.toHaveBeenCalled();
  // A disabled schedule stays disabled even when ordinary conversation work is active.
  chat.isYeaftSessionProcessing = () => true;
  await Vue.nextTick();
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  await wrapper.vm.stop();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(2);
  chat.isYeaftSessionProcessing = () => false;
  await wrapper.setProps({ session: { id: 'task', task: configured } });
  for (const [result, message] of [[false, en['scheduledTasks.failed']],
    [{ ok: false, error: { code: 'task_conflict' } }, en['scheduledTasks.conflict']],
    [{ ok: false, error: { message: 'Persistence failed' } }, 'Persistence failed']]) {
    chat.updateScheduledTask.mockResolvedValueOnce(result);
    await wrapper.get('.scheduled-task-stop').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(message);
    expect(wrapper.vm.stopping).toBe(false);
    expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeUndefined();
  }
  chat.updateScheduledTask.mockRejectedValueOnce(new Error('Transport failed'));
  await wrapper.get('.scheduled-task-stop').trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('Transport failed');
  expect(wrapper.vm.stopping).toBe(false);
  await wrapper.setData({ busy: true });
  const updatesBefore = chat.updateScheduledTask.mock.calls.length;
  await wrapper.vm.stop();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(updatesBefore);
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  await wrapper.setData({ busy: false });
  chat.agents = [{ ...agents[0], online: false }];
  await Vue.nextTick();
  expect(wrapper.text()).toContain(en['scheduledTasks.offline']);
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  await wrapper.vm.stop();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(updatesBefore);
  chat.agents = [{ ...agents[0], capabilities: [] }];
  await Vue.nextTick();
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain(en['scheduledTasks.upgrade']);
  chat.scheduledTaskProtocolSupported = false;
  await Vue.nextTick();
  expect(wrapper.text()).toContain(en['scheduledTasks.serverUpgrade']);
  expect(wrapper.text()).not.toContain(en['scheduledTasks.upgrade']);
  chat.runScheduledTask.mockClear();
  await wrapper.vm.run();
  await wrapper.vm.stop();
  expect(chat.runScheduledTask).not.toHaveBeenCalled();
  expect(chat.updateScheduledTask).toHaveBeenCalledTimes(updatesBefore);
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeDefined();
  expect(chat.cancelYeaftSession).not.toHaveBeenCalled();
});

it('renders inline below the announcement and before the VP roster without a popover', async () => {
  window.Pinia = { useChatStore: () => ({ scheduledTaskProtocolSupported: true, agents }) };
  wrapper = mount(VpTimelinePane, { props: { rows: [] }, slots: {
    'scheduled-task': () => Vue.h(ScheduledTaskBar, { agentId: 'a', session: { id: 'task', task } }),
  }, global: { mocks: { $t: t } } });
  const sections = wrapper.findAll('.yeaft-session-status-section');
  expect(sections[0].classes()).toContain('yeaft-session-status-announcement');
  expect(sections[1].classes()).toContain('scheduled-task-bar');
  expect(sections[2].attributes('aria-label')).toBe(en['yeaft.sessionStatus.vps']);
  expect(sections[1].text()).toContain(en['scheduledTasks.never']);
  expect(sections[1].text()).not.toContain(en['scheduledTasks.runOnceHelp']);
  const run = sections[1].get('.scheduled-task-run');
  expect(run.attributes('title')).toBe(en['scheduledTasks.runOnceHelp']);
  expect(run.attributes('aria-description')).toBe(en['scheduledTasks.runOnceHelp']);
  expect(sections[1].findAll('button')).toHaveLength(3);
  expect(sections[1].find('.scheduled-task-state').exists()).toBe(false);
  const actions = sections[1].get('header .scheduled-task-bar-actions');
  expect(actions.findAll('button').map(button => button.attributes('aria-label')))
    .toEqual(['Run once', 'Pause schedule', 'Configure']);
  expect(actions.text()).toBe('');
  expect(sections[1].findAll('button').every(button => button.classes().includes('btn-ghost'))).toBe(true);
  const modal = document.createElement('div');
  modal.className = 'group-settings-overlay';
  document.body.append(modal);
  await wrapper.get('.scheduled-task-run').trigger('keydown', { key: 'Escape' });
  expect(wrapper.emitted('close')).toBeUndefined();
  modal.remove();
  await wrapper.get('.scheduled-task-run').trigger('keydown', { key: 'Escape' });
  expect(wrapper.emitted('close')).toHaveLength(1);
});

it('prevents duplicate manual requests, preserves paused schedules and renders pending/errors inline', async () => {
  let finish;
  const runScheduledTask = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  window.Pinia = { useChatStore: () => ({ scheduledTaskProtocolSupported: true, agents, runScheduledTask }) };
  const scheduled = { ...task, enabled: false, trigger: { type: 'schedule', scheduledFor: 2000000000000 }, nextRunAt: 2000000000000 };
  const original = JSON.stringify(scheduled);
  wrapper = mount(ScheduledTaskBar, { props: { agentId: 'a', session: { id: 'task', task: scheduled } }, global: { mocks: { $t: t } } });
  expect(wrapper.find('.scheduled-task-state').exists()).toBe(false);
  expect(wrapper.get('.scheduled-task-runtime').text()).toContain(en['scheduledTasks.paused']);
  expect(wrapper.get('.scheduled-task-stop').attributes('disabled')).toBeDefined();
  await wrapper.setProps({ session: { id: 'task', task: { ...task, enabled: false } } });
  expect(wrapper.get('.scheduled-task-runtime').text()).toContain(en['scheduledTasks.paused']);
  await wrapper.setProps({ session: { id: 'task', task: scheduled } });
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeUndefined();
  await wrapper.get('.scheduled-task-run').trigger('click');
  expect(wrapper.get('.scheduled-task-run').attributes('aria-label')).toBe(en['scheduledTasks.starting']);
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeDefined();
  await wrapper.vm.run();
  expect(runScheduledTask).toHaveBeenCalledExactlyOnceWith({ agentId: 'a', sessionId: 'task' });
  finish({ ok: false, error: 'Manual execution refused' });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('Manual execution refused');
  expect(wrapper.get('.scheduled-task-run').attributes('disabled')).toBeUndefined();
  expect(JSON.stringify(scheduled)).toBe(original);
});

it('saves only editable task fields and renders update errors without replacing Session settings', async () => {
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true, agents, updateScheduledTask: vi.fn(async () => ({ ok: false, error: { message: 'Save failed' } })) });
  window.Pinia = { useChatStore: () => chat };
  wrapper = mount(ScheduledTaskSettings, { props: { agentId: 'a', sessionId: 'task', task: { ...task, nextRunAt: null, lastRun: { status: 'completed' } } }, global: { mocks: { $t: t } } });
  await wrapper.get('textarea').setValue('Updated prompt');
  chat.scheduledTaskProtocolSupported = false;
  await Vue.nextTick();
  expect(wrapper.text()).toContain(en['scheduledTasks.serverUpgrade']);
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
  await wrapper.vm.save();
  expect(chat.updateScheduledTask).not.toHaveBeenCalled();
  expect(wrapper.get('textarea').element.value).toBe('Updated prompt');
  chat.scheduledTaskProtocolSupported = true;
  await Vue.nextTick();
  await wrapper.get('.btn-primary').trigger('click');
  await flushPromises();
  expect(chat.updateScheduledTask).toHaveBeenCalledWith({ agentId: 'a', sessionId: 'task', task: { ...task, prompt: 'Updated prompt' }, expectedRevision: undefined });
  expect(wrapper.get('[role="alert"]').text()).toBe('Save failed');
});

it('syncs pristine task snapshots, ignores runtime changes, and fences dirty external edits until reload', async () => {
  window.Pinia = { useChatStore: () => ({ scheduledTaskProtocolSupported: true, agents }) };
  wrapper = mount(ScheduledTaskSettings, { props: { agentId: 'a', sessionId: 'task', task: { ...task, revision: 'r1' } }, global: { mocks: { $t: t, $locale: 'en' } } });
  await wrapper.setProps({ task: { ...task, prompt: 'External prompt', revision: 'r2' } });
  expect(wrapper.get('textarea').element.value).toBe('External prompt');
  expect(wrapper.vm.baseRevision).toBe('r2');
  await wrapper.get('textarea').setValue('My local edit');
  await wrapper.setProps({ task: { ...task, prompt: 'External prompt', revision: 'r2', lastRun: { status: 'completed', finishedAt: 123 } } });
  expect(wrapper.vm.stale).toBe(false);
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeUndefined();
  await wrapper.setProps({ task: { ...task, prompt: 'Another tab', revision: 'r3', trigger: { type: 'schedule', scheduledFor: Date.now() + 86400000, recurrence: null } } });
  expect(wrapper.get('textarea').element.value).toBe('My local edit');
  expect(wrapper.get('.scheduled-task-stale').text()).toContain(en['scheduledTasks.stale']);
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
  await wrapper.get('.scheduled-task-stale button').trigger('click');
  expect(wrapper.get('textarea').element.value).toBe('Another tab');
  expect(wrapper.vm.baseRevision).toBe('r3');
  expect(wrapper.vm.dirty).toBe(false);
  expect(wrapper.find('.scheduled-task-stale').exists()).toBe(false);
  expect(wrapper.findComponent({ name: 'WorkCenterScheduleEditor' }).exists()).toBe(true);
});

it('sends the edit revision, accepts its own broadcast ACK, and preserves a conflicting draft', async () => {
  let finish;
  const chat = { scheduledTaskProtocolSupported: true, agents, updateScheduledTask: vi.fn(() => new Promise(resolve => { finish = resolve; })) };
  window.Pinia = { useChatStore: () => chat };
  wrapper = mount(ScheduledTaskSettings, { props: { agentId: 'a', sessionId: 'task', task: { ...task, revision: 'r1' } }, global: { mocks: { $t: t } } });
  await wrapper.get('textarea').setValue('First edit');
  await wrapper.get('.btn-primary').trigger('click');
  expect(chat.updateScheduledTask).toHaveBeenLastCalledWith({ agentId: 'a', sessionId: 'task', task: { ...task, prompt: 'First edit' }, expectedRevision: 'r1' });
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
  const accepted = { ...task, prompt: 'First edit', revision: 'r2' };
  await wrapper.setProps({ task: accepted });
  finish({ ok: true, session: { id: 'task', task: accepted } });
  await flushPromises();
  expect(wrapper.vm.stale).toBe(false);
  expect(wrapper.vm.dirty).toBe(false);
  expect(wrapper.vm.baseRevision).toBe('r2');
  expect(wrapper.text()).toContain(en['scheduledTasks.saved']);
  await wrapper.get('textarea').setValue('Keep this conflicting edit');
  await wrapper.get('.btn-primary').trigger('click');
  expect(chat.updateScheduledTask).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 'r2' }));
  finish({ ok: false, error: { code: 'task_conflict' } });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe(en['scheduledTasks.conflict']);
  expect(wrapper.get('textarea').element.value).toBe('Keep this conflicting edit');
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
});

it('lets a running task pause future triggers without interrupting the current run', async () => {
  const chat = { scheduledTaskProtocolSupported: true, agents, isYeaftSessionProcessing: () => true,
    updateScheduledTask: vi.fn(async () => ({ ok: true })) };
  window.Pinia = { useChatStore: () => chat };
  wrapper = mount(ScheduledTaskSettings, { props: { agentId: 'a', sessionId: 'task',
    task: { ...task, revision: 'running-revision', lastRun: { id: 'active-run', status: 'running' } } }, global: { mocks: { $t: t } } });
  expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined();
  await wrapper.get('input[role="switch"][aria-label="Enabled"]').setValue(false);
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeUndefined();
  await wrapper.get('.btn-primary').trigger('click');
  await flushPromises();
  expect(chat.updateScheduledTask).toHaveBeenCalledWith({ agentId: 'a', sessionId: 'task',
    expectedRevision: 'running-revision', task: { ...task, enabled: false } });
  expect(wrapper.props('task').lastRun).toEqual({ id: 'active-run', status: 'running' });
});

it('opens and dismisses notifications using their full Session identity and keeps failed navigation visible', async () => {
  const item = { id: 'notification', agentId: 'b', sessionId: 'same-id', taskName: 'Build', status: 'failed', error: 'Timeout', createdAt: 1 };
  const store = { scheduledTaskNotifications: [{ ...item, id: 'older', taskName: 'Earlier build' }, item], openScheduledTaskNotification: vi.fn(async () => false), dismissScheduledTaskNotification: vi.fn() };
  wrapper = mount(ScheduledTaskNotifications, { props: { store }, global: { mocks: { $t: t } } });
  expect(wrapper.findAll('.scheduled-task-notification')).toHaveLength(1);
  await wrapper.get('.scheduled-task-notifications-more').trigger('click');
  expect(wrapper.findAll('.scheduled-task-notification')).toHaveLength(2);
  await wrapper.get('.scheduled-task-notifications-more').trigger('click');
  await wrapper.get('.scheduled-task-notification-open').trigger('click');
  await flushPromises();
  expect(store.openScheduledTaskNotification).toHaveBeenCalledWith(item);
  expect(wrapper.get('[role="alert"]').text()).toBe(en['scheduledTasks.openFailed']);
  await wrapper.get('.scheduled-task-dismiss').trigger('click');
  expect(store.dismissScheduledTaskNotification).toHaveBeenCalledWith(item.id);
});


it('previews monthly multi-dates and keeps single-date wire compatibility, including short months', () => {
  const draft = { date: '2040-02-01', time: '09:30', timeZone: 'UTC', frequency: 'monthly', end: 'never', daysOfMonth: [31, 15, 1] };
  const now = Date.UTC(2040, 0, 1);
  expect(scheduleFormResult(draft, now)).toEqual({ scheduledFor: Date.UTC(2040, 1, 1, 9, 30), recurrence: { frequency: 'monthly', timeZone: 'UTC', time: '09:30', daysOfMonth: [1, 15, 31], endsAt: null, maxRuns: null } });
  expect(scheduleFormResult({ ...draft, daysOfMonth: [31] }, now)).toMatchObject({ scheduledFor: Date.UTC(2040, 1, 29, 9, 30), recurrence: { dayOfMonth: 31 } });
  expect(scheduleFormResult({ ...draft, daysOfMonth: [], dayOfMonth: 1 }, now)).toEqual({ error: 'invalidMonthDay' });
  for (const daysOfMonth of [[0], [32], ['1'], [1.5]]) expect(scheduleFormResult({ ...draft, daysOfMonth }, now)).toEqual({ error: 'invalidMonthDay' });
  expect(scheduleFormResult({ ...draft, daysOfMonth: undefined, dayOfMonth: 15 }, now).recurrence).toHaveProperty('dayOfMonth', 15);
});

it('rehydrates monthly multi-dates without silently changing a saved trigger on prompt-only edits', async () => {
  const trigger = { type: 'schedule', scheduledFor: Date.UTC(2040, 0, 15, 9, 30), recurrence: { frequency: 'monthly', time: '09:30', timeZone: 'UTC', daysOfMonth: [1, 15, 31], endsAt: null, maxRuns: null } };
  wrapper = mount(ScheduledTaskEditor, { props: { modelValue: { ...task, trigger }, monthlyMultipleSupported: true, 'onUpdate:modelValue': value => wrapper.setProps({ modelValue: value }) }, global: { mocks: { $t: t, $locale: 'en' } } });
  expect(wrapper.vm.schedule.daysOfMonth).toEqual([1, 15, 31]);
  expect(wrapper.findAll('.task-month-days-grid [aria-pressed="true"]').map(button => button.text())).toEqual(['1', '15', '31']);
  await wrapper.get('textarea').setValue('Only edit the prompt');
  expect(wrapper.props('modelValue').trigger).toEqual(trigger);
  expect(wrapper.get('textarea').attributes('aria-required')).toBe('true');
  expect(wrapper.get('.scheduled-task-prompt .task-required').text()).toBe('Required');
});

it('allows weekly multiple days and gates monthly multiple dates on additive Agent support', async () => {
  const draft = { date: '2040-02-01', time: '09:30', timeZone: 'UTC', frequency: 'weekly', end: 'never', weekdays: [1], dayOfMonth: 1 };
  wrapper = mount(WorkCenterScheduleEditor, { props: { modelValue: draft, compact: true, recurringSupported: true, 'onUpdate:modelValue': value => wrapper.setProps({ modelValue: value }) }, global: { mocks: { $t: t, $locale: 'en' } } });
  await wrapper.get('[aria-label="Wednesday"]').trigger('click');
  expect(wrapper.props('modelValue').weekdays).toEqual([1, 3]);
  await wrapper.setProps({ modelValue: { ...draft, frequency: 'monthly' } });
  await wrapper.findAll('.task-month-days-grid button')[14].trigger('click');
  expect(wrapper.props('modelValue').daysOfMonth).toEqual([15]);
  expect(wrapper.text()).toContain(en['scheduledTasks.monthDaysUpgrade']);
  await wrapper.setProps({ monthlyMultipleSupported: true });
  await wrapper.findAll('.task-month-days-grid button')[30].trigger('click');
  expect(wrapper.props('modelValue').daysOfMonth).toEqual([15, 31]);
  await wrapper.setProps({ disabled: true });
  expect(wrapper.findAll('.task-month-days-grid button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2040, 1, 1, 17));
  await wrapper.setProps({ disabled: false, modelValue: { ...draft, frequency: 'daily', time: '09:00' } });
  wrapper.vm.now = Date.now();
  await Vue.nextTick();
  expect(wrapper.vm.result.error).toBe('futureTime');
  expect(wrapper.get('.task-schedule-advanced').attributes('open')).toBeDefined();

});
