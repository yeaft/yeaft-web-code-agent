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

  it('deduplicates by record kind and ID, with the snapshot overriding cached terminal status', () => {
    render({
      tasks: [{ id: 'same', title: 'Cached shell', status: 'completed', createdAt: 4 }],
      agents: [{ id: 'same', name: 'Cached child', status: 'completed', executionPending: false, createdAt: 3 }],
      active: {
        tasks: [{ id: 'same', title: 'Live shell', status: 'running', createdAt: 4 }],
        agents: [{ id: 'same', name: 'Live child', status: 'completed', executionPending: true, createdAt: 3 }],
      },
    });
    expect(wrapper.findAll('.person-task-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Live shell');
    expect(wrapper.text()).toContain('Live child');
    expect(wrapper.text()).not.toContain('Cached');
    expect(wrapper.findAll('button').filter(button => button.text() === t('person.stopTask'))).toHaveLength(2);
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

  it('shows active-only records without an incorrect empty state and distinguishes snapshot truncation from history paging', () => {
    render({ active: { ...snapshot(), truncated: true }, nextCursor: 'older', truncated: true });
    expect(wrapper.text()).not.toContain(t('person.tasksEmpty'));
    expect(wrapper.text()).toContain(t('person.tasksTruncated'));
    expect(wrapper.text()).toContain(t('person.tasksHistoryMore'));
    expect(wrapper.get('.person-load-more').text()).toBe(t('person.loadMore'));
  });

  it('retains loaded historical controls omitted from a truncated active snapshot', () => {
    render({ tasks: [{ id: 'overflow-shell', status: 'running' }], agents: [{ id: 'overflow-agent', status: 'completed', executionPending: true }], active: { tasks: [], agents: [], truncated: true } });
    expect(wrapper.findAll('button').filter(button => button.text() === t('person.stopTask'))).toHaveLength(2);
    expect(wrapper.text()).toContain(t('person.taskExecutionPending'));
    expect(wrapper.text()).toContain(t('person.tasksTruncated'));
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

  it('uses creation time and binary ID ties within active-first groups', () => {
    render({ tasks: [{ id: 'a', createdAt: 30, status: 'completed' }, { id: 'Z', createdAt: 30, status: 'completed' },
      { id: 'old', createdAt: 1, updatedAt: 100, status: 'completed' }],
      agents: [{ id: 'child', createdAt: 20, updatedAt: 200, status: 'completed' }], active: snapshot() });
    expect(wrapper.findAll('.person-task-item').map(row => row.attributes('data-task-id')))
      .toEqual(['old-agent', 'old-shell', 'Z', 'a', 'child', 'old']);
  });

  it('opens a projected child log without a matching task in either independently paged window', async () => {
    render({ active: { tasks: [], agents: [{ id: 'old-child', taskId: 'durable-child-log', status: 'completed', executionPending: true }] } });
    await wrapper.get('[data-task-id="old-child"] button').trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['durable-child-log']);
  });

  it('pages once on forward scroll intent with an accessible fallback and no response-driven drain', async () => {
    render({ tasks: history(5), active: snapshot(), nextCursor: 'older-1' });
    const list = wrapper.get('.person-inspector-list');
    Object.defineProperties(list.element, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 } });
    list.element.scrollTop = 650;
    await list.trigger('scroll');
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
    await list.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
    await wrapper.setProps({ page: { ...wrapper.props('page'), loading: true } });
    await wrapper.setProps({ page: { ...wrapper.props('page'), loading: false, tasks: history(10), nextCursor: 'older-2' } });
    await list.trigger('scroll');
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
    await wrapper.get('.person-load-more').trigger('click');
    expect(wrapper.emitted('more')).toHaveLength(2);
  });

  it('clears confirmation and active rows on identity reset, including reused IDs', async () => {
    render({ active: snapshot() });
    await wrapper.get('[data-task-id="old-shell"]').findAll('button').find(button => button.text() === t('person.stopTask')).trigger('click');
    await wrapper.setProps({ identityKey: 'owner:other-agent:person', page: { loaded: true, tasks: [{ id: 'old-shell', title: 'Replacement', status: 'completed' }], agents: [], active: { tasks: [], agents: [] } } });
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Old running shell');
    expect(wrapper.text()).not.toContain('Detached tools');
    expect(wrapper.text()).toContain('Replacement');
    expect(wrapper.findAll('button').some(button => button.text() === t('person.stopTask'))).toBe(false);
  });
});
