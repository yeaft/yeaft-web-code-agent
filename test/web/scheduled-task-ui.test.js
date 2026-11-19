// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
globalThis.Pinia = { defineStore: () => () => ({}) };
import en from '../../web/i18n/en.js';
import ScheduledTaskSettings from '../../web/components/ScheduledTaskSettings.js';

let wrapper;
const t = key => en[key] || key;
const agents = [{ id: 'a', online: true, capabilities: ['scheduled_tasks'] }];
const task = { prompt: 'Check the build', enabled: true, notify: true, trigger: { type: 'manual' } };

beforeEach(() => { vi.stubGlobal('Vue', Vue); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); delete window.Pinia; wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

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
