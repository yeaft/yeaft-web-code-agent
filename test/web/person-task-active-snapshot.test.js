// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import PersonTaskBrowser from '../../web/components/PersonTaskBrowser.js';
import en from '../../web/i18n/en.js';

const t = key => en[key] || key;
const history = count => Array.from({ length: count }, (_, index) => ({ id: 'history-' + index, title: 'Settled ' + index, status: 'completed', createdAt: count - index + 100 }));
const snapshot = () => ({
  tasks: [{ id: 'old-shell', title: 'Old running shell', status: 'running', createdAt: 1 },
    { id: 'child-task', kind: 'sub_agent', agentId: 'old-agent', status: 'running', createdAt: 1 }],
  agents: [{ id: 'old-agent', name: 'Detached tools', status: 'completed', executionPending: true, createdAt: 2 }],
  truncated: false,
});
let wrapper;
let frames;
let sequence;
const flushFrames = async () => {
  for (let round = 0; round < 4; round++) {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(performance.now()));
    await Vue.nextTick();
  }
};
function render(page) {
  wrapper = mount(PersonTaskBrowser, {
    attachTo: document.body,
    props: { identityKey: 'owner:agent:person', page: { loaded: true, tasks: [], agents: [], ...page }, log: {} },
    global: { config: { globalProperties: { $t: t } } },
  });
  return wrapper;
}
beforeEach(() => {
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('ResizeObserver', undefined);
  frames = new Map();
  sequence = 0;
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('Person task active control snapshot', () => {
  it('keeps old shells and terminal cleanup controls ahead of a large settled history window', async () => {
    render({ tasks: history(300), active: snapshot(), nextCursor: 'older' });
    await flushFrames();
    const rows = wrapper.findAll('.person-task-item');
    expect(rows.length).toBeLessThan(20);
    expect(rows.slice(0, 2).map(row => row.attributes('data-task-id'))).toEqual(['old-agent', 'old-shell']);
    const child = wrapper.get('[data-task-id="old-agent"]');
    expect(child.text()).toContain(t('person.taskExecutionPending'));
    await child.findAll('button').find(button => button.text() === t('person.taskLog')).trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['child-task']);
    await child.findAll('button').find(button => button.text() === t('person.stopTask')).trigger('click');
    expect(document.activeElement).toBe(child.get('.btn-secondary').element);
    await child.get('.btn-secondary').trigger('click');
    expect(wrapper.emitted('stop')[0]).toEqual(['agent', 'old-agent']);
    expect(wrapper.text()).toContain(t('person.tasksActive'));
    expect(wrapper.text()).not.toContain(t('person.tasksEmpty'));
  });

  it('replaces rather than accumulates active-only rows and revokes stale historical controls when cleanup settles', async () => {
    const active = snapshot();
    render({ tasks: active.tasks, agents: active.agents, active });
    await wrapper.get('[data-task-id="old-agent"]').findAll('button').find(button => button.text() === t('person.stopTask')).trigger('click');
    expect(wrapper.find('.btn-secondary').exists()).toBe(true);
    await wrapper.setProps({ page: { ...wrapper.props('page'), active: { tasks: [], agents: [], truncated: false }, tasks: [] } });
    expect(wrapper.find('[data-task-id="old-shell"]').exists()).toBe(false);
    expect(wrapper.find('[data-task-id="old-agent"]').exists()).toBe(true);
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
    expect(wrapper.findAll('button').some(button => button.text() === t('person.stopTask'))).toBe(false);
    expect(wrapper.text()).not.toContain(t('person.taskExecutionPending'));
  });

  it('revokes confirmation on stale snapshots while preserving read-only logs and refresh', async () => {
    render({ active: snapshot() });
    const child = wrapper.get('[data-task-id="old-agent"]');
    await child.findAll('button').find(button => button.text() === t('person.stopTask')).trigger('click');
    expect(wrapper.find('.btn-secondary').exists()).toBe(true);
    await wrapper.setProps({ page: { ...wrapper.props('page'), stale: true } });
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
    expect(wrapper.findAll('button').some(button => button.text() === t('person.stopTask'))).toBe(false);
    await child.findAll('button').find(button => button.text() === t('person.taskLog')).trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['child-task']);
    await wrapper.get('.person-journal-toolbar button').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    await wrapper.setProps({ page: { ...wrapper.props('page'), stale: false } });
    expect(wrapper.findAll('button').filter(button => button.text() === t('person.stopTask'))).toHaveLength(2);
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
  });
});
