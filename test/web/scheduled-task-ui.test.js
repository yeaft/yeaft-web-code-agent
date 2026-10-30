// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import UnifiedSessionList from '../../web/components/UnifiedSessionList.js';
globalThis.Pinia = { defineStore: () => () => ({}) };
const { default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js');
import { scheduleFormResult } from '../../web/utils/work-center-schedule.js';
import WorkCenterScheduleEditor from '../../web/components/WorkCenterScheduleEditor.js';
import en from '../../web/i18n/en.js';
import ScheduledTaskEditor from '../../web/components/ScheduledTaskEditor.js';
import ScheduledTaskBar from '../../web/components/ScheduledTaskBar.js';
import ScheduledTaskSettings from '../../web/components/ScheduledTaskSettings.js';
import ScheduledTaskNotifications from '../../web/components/ScheduledTaskNotifications.js';

let wrapper;
const t = key => en[key] || key;
const agents = [{ id: 'a', online: true, capabilities: ['scheduled_tasks'] }];
const task = { prompt: 'Check the build', enabled: true, notify: true, trigger: { type: 'manual' } };
const row = (id, extra = {}) => ({ catalogKey: `yeaft:a:${id}`, runtimeProvider: 'yeaft', title: id, availability: 'online', routeRef: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: id }, ...extra });
beforeEach(() => { vi.stubGlobal('Vue', Vue); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); delete window.Pinia; wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('lists task Sessions in recents or their owning Project with a badge and shared actions', async () => {
  // Old Tasks-collapse state must not hide tasks in either current section.
  localStorage.setItem('yeaft-sidebar-section-collapse', JSON.stringify({ tasks: true }));
  const taskRow = row('task', { task });
  const otherTask = row('task', { catalogKey: 'yeaft:b:task', task, routeRef: { runtimeProvider: 'yeaft', agentId: 'b', sessionId: 'task' } });
  const project = { id: 'p', name: 'Project', members: [{ agentId: 'a', sessionId: 'task' }] };
  const mutateProject = vi.fn(async () => ({ ok: true }));
  wrapper = mount(UnifiedSessionList, { attachTo: document.body, props: { agents: [...agents, { id: 'b', online: true }],
    sessions: [taskRow, otherTask, row('chat')], projects: [project],
    projectStore: { mutateProject }, isSessionUnread: item => item.catalogKey === taskRow.catalogKey }, global: { mocks: { $t: t } } });
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
  expect(JSON.parse(localStorage.getItem('yeaft-sidebar-section-collapse'))).toEqual({ projects: false, recents: true });
  await wrapper.get('.sidebar-task-create').trigger('click');
  expect(wrapper.emitted('create-task')).toHaveLength(1);
});

it('creates task Sessions with the existing roster and folder contract and rejects unsupported Agents', async () => {
  const create = vi.fn(async () => ({ ok: true, session: { id: 'task', agentId: 'a', task } }));
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true, agents, currentAgent: 'a', createYeaftSession: create, sendWsMessage: vi.fn(), setActiveSessionFilter: vi.fn(), yeaftStatusByAgent: { a: { availableModels: [{ provider: 'test', id: 'model', label: 'Model' }] } } });
  const vp = { snapshotStatus: 'ready', snapshotAgentId: 'a', lastVpSnapshotAgentId: 'a', vpList: [{ vpId: 'omni', name: 'Omni' }] };
  window.Pinia = { useChatStore: () => chat, useVpStore: () => vp, useSessionsStore: () => ({ sessionList: [], setActive: vi.fn() }) };
  wrapper = mount(SessionCreateModal, { props: { taskMode: true }, global: { mocks: { $t: t }, stubs: { ModernSelect: true, FolderPickerDialog: true } } });
  expect(wrapper.vm.canSubmit).toBe(false);
  expect(document.querySelector('.task-create-header')).not.toBeNull();
  expect(document.querySelector('.session-create-flow.is-task .scheduled-task-editor')).not.toBeNull();
  expect(document.querySelector('.resume-modal-footer')?.closest('.session-create-flow')).toBeNull();
  await wrapper.setData({ taskDraft: task, taskValid: true, form: { ...wrapper.vm.form, workDir: '/repo', vpIds: ['omni'] } });
  expect(wrapper.vm.canSubmit).toBe(true);
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
  chat.agents = [{ ...agents[0], capabilities: [] }];
  await Vue.nextTick();
  expect(wrapper.vm.canSubmit).toBe(false);
  delete window.Pinia;
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

it('runs the real Agent-scoped Session, reports failures, disables busy/offline/old Agents, and opens settings', async () => {
  const chat = Vue.reactive({ scheduledTaskProtocolSupported: true, agents, connectionState: 'connected', runScheduledTask: vi.fn(async () => ({ ok: false, error: { message: 'Execution failed' } })), isYeaftSessionProcessing: () => false });
  window.Pinia = { useChatStore: () => chat };
  wrapper = mount(ScheduledTaskBar, { props: { agentId: 'a', session: { id: 'task', task } }, global: { mocks: { $t: t } } });
  await wrapper.get('.btn-primary').trigger('click');
  await flushPromises();
  expect(chat.runScheduledTask).toHaveBeenCalledWith({ agentId: 'a', sessionId: 'task' });
  expect(wrapper.get('[role="alert"]').text()).toBe('Execution failed');
  await wrapper.get('.btn-secondary').trigger('click');
  expect(wrapper.emitted('configure')).toHaveLength(1);
  await wrapper.setProps({ session: { id: 'task', task: { ...task, lastRun: { status: 'running' } } } });
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
  await wrapper.setProps({ session: { id: 'task', task } });
  chat.agents = [{ ...agents[0], online: false }];
  await Vue.nextTick();
  expect(wrapper.text()).toContain(en['scheduledTasks.offline']);
  chat.agents = [{ ...agents[0], capabilities: [] }];
  await Vue.nextTick();
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain(en['scheduledTasks.upgrade']);
  chat.scheduledTaskProtocolSupported = false;
  await Vue.nextTick();
  expect(wrapper.text()).toContain(en['scheduledTasks.serverUpgrade']);
  expect(wrapper.text()).not.toContain(en['scheduledTasks.upgrade']);
  chat.runScheduledTask.mockClear();
  await wrapper.vm.run();
  expect(chat.runScheduledTask).not.toHaveBeenCalled();
  expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined();
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
