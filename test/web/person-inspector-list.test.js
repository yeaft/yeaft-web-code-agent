// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import PersonInspectorList, { newestPersonRecords } from '../../web/components/PersonInspectorList.js';
import PersonDebugLog from '../../web/components/PersonDebugLog.js';
import PersonThoughtJournal from '../../web/components/PersonThoughtJournal.js';
import PersonKnowledgeBrowser from '../../web/components/PersonKnowledgeBrowser.js';
import PersonTaskBrowser from '../../web/components/PersonTaskBrowser.js';
import PersonTurnUsage from '../../web/components/PersonTurnUsage.js';
import { personRecords } from '../fixtures/person-records.js';
import { personTurn } from '../fixtures/person-turns.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';

const t = (key, params = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
const records = (count, prefix = 'row') => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, seq: count - index, kind: `${prefix}-${index}`, createdAt: count - index }));
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
const global = { config: { globalProperties: { $t: t } } };
function renderList(props = {}) {
  wrapper = mount(PersonInspectorList, {
    props: { items: records(10), label: 'Records', moreLabel: 'Older', more: true, pageToken: 'cursor-1', estimateHeight: () => 100, ...props },
    attachTo: document.body,
    slots: { default: ({ item }) => Vue.h('details', { 'data-row-id': item.id }, [Vue.h('summary', item.id), Vue.h('p', 'Long detail')]) },
  });
  geometry();
  return wrapper;
}
function geometry(top = 650) {
  const scroller = wrapper.get('.person-inspector-list').element;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1000 },
  });
  scroller.scrollTop = top;
  return scroller;
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

describe('Person inspector paging intent', () => {
  it('loads one page on forward near-end intent, not on layout, resize, scroll or response completion', async () => {
    renderList();
    await wrapper.trigger('scroll');
    window.dispatchEvent(new Event('resize'));
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
    await wrapper.setProps({ loading: true });
    await wrapper.setProps({ items: records(30), pageToken: 'cursor-2', loading: false });
    await wrapper.trigger('scroll');
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(2);
  });

  it('keeps intention armed until the following native scroll frame, without requesting away from the end', async () => {
    renderList();
    const scroller = geometry(0);
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
    scroller.scrollTop = 650;
    await wrapper.trigger('scroll');
    expect(wrapper.emitted('more')).toHaveLength(1);
  });

  it.each([{ loading: true }, { disabled: true }, { stale: true }, { error: true }, { more: false }])('does not auto-page with the gate %j', async gate => {
    renderList(gate);
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
  });

  it('does not mistake disclosure Space activation for a paging gesture', async () => {
    renderList();
    await wrapper.get('summary').trigger('keydown', { key: ' ' });
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
  });

  it('does not retry the same failed cursor automatically, but offers an accessible retry button', async () => {
    renderList();
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    await wrapper.trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
    await wrapper.setProps({ error: true, stale: true });
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('more')).toHaveLength(2);
    expect(wrapper.get('button').attributes('type')).toBe('button');
  });

  it('ignores reverse wheel/touch gestures and scrolling inside a long detail pane', async () => {
    renderList();
    await wrapper.trigger('wheel', { deltaY: -100 });
    await wrapper.trigger('touchstart', { touches: [{ clientY: 100 }] });
    await wrapper.trigger('touchmove', { touches: [{ clientY: 120 }] });
    await flushFrames();
    const pane = wrapper.get('p').element;
    pane.style.overflowY = 'auto';
    Object.defineProperties(pane, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    await wrapper.get('p').trigger('wheel', { deltaY: 100 });
    await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
    await wrapper.trigger('touchmove', { touches: [{ clientY: 80 }] });
    await flushFrames();
    expect(wrapper.emitted('more')).toHaveLength(1);
  });
});

describe('Person inspector window and keyboard continuity', () => {
  it('uses ordinary rows for a small page and the existing VirtualTranscript above twenty records', async () => {
    renderList({ items: records(20) });
    expect(wrapper.findAll('[data-row-id]')).toHaveLength(20);
    expect(wrapper.find('.virtual-transcript').exists()).toBe(false);
    await wrapper.setProps({ items: records(200) });
    await flushFrames();
    expect(wrapper.find('.virtual-transcript').element.parentElement).toBe(wrapper.element);
    expect(wrapper.findAll('[data-row-id]').length).toBeLessThan(20);
    expect(wrapper.findAll('[data-row-id]').length).toBeGreaterThan(0);
  });

  it('keeps expanded details when a row is windowed out and back, and restores focus on Escape', async () => {
    renderList({ items: records(200) });
    geometry(0);
    await wrapper.trigger('scroll');
    await flushFrames();
    const detail = wrapper.get('[data-row-id="row-0"]');
    detail.element.open = true;
    // Do not dispatch toggle: browsers queue it after details.open changes.
    await wrapper.trigger('keydown', { key: 'End' });
    await flushFrames();
    expect(wrapper.get('[data-row-id="row-199"] summary').element).toBe(document.activeElement);
    await wrapper.get('[data-row-id="row-199"] summary').trigger('keydown', { key: 'Home' });
    await flushFrames();
    const returned = wrapper.get('[data-row-id="row-0"]');
    expect(returned.element.open).toBe(true);
    expect(returned.get('summary').element).toBe(document.activeElement);
    await returned.get('p').trigger('keydown', { key: 'Escape' });
    expect(returned.element.open).toBe(false);
    expect(returned.get('summary').element).toBe(document.activeElement);
  });

  it.each([
    ['wheel', { deltaY: -100 }],
    ['touchstart', { touches: [{ clientY: 100 }] }],
    ['pointerdown', {}],
  ])('releases a keyboard target and pending adjustments on intentional %s, even while loading', async (type, event) => {
    renderList({ items: records(200) });
    geometry(0); await flushFrames();
    await wrapper.trigger('keydown', { key: 'Home' }); await flushFrames();
    const transcript = wrapper.vm.transcript;
    const clear = vi.spyOn(transcript, 'clearTargetAnchor');
    const cancel = vi.spyOn(transcript, 'cancelPendingBottomFollow');
    await wrapper.setProps({ loading: true });
    await wrapper.trigger(type, event);
    expect(clear).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    await wrapper.trigger('scroll'); await flushFrames();
    expect(wrapper.emitted('more')).toBeUndefined();
  });

  it('keeps keyboard targeting pinned through scroll and resize events', async () => {
    renderList({ items: records(200) }); geometry(0); await flushFrames();
    const transcript = wrapper.vm.transcript;
    const clear = vi.spyOn(transcript, 'clearTargetAnchor');
    const cancel = vi.spyOn(transcript, 'cancelPendingBottomFollow');
    await wrapper.trigger('keydown', { key: 'ArrowDown' }); await flushFrames();
    await wrapper.trigger('scroll'); window.dispatchEvent(new Event('resize')); await flushFrames();
    expect(clear).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });

  it('resets window, disclosure and paging fences on identity replacement, including reused row ids', async () => {
    renderList({ resetKey: 'agent-a:person', items: records(200) });
    geometry(0);
    await wrapper.trigger('scroll');
    await flushFrames();
    const detail = wrapper.get('[data-row-id="row-0"]');
    detail.element.open = true;
    await detail.trigger('toggle');
    await wrapper.trigger('keydown', { key: 'End' });
    await flushFrames();
    await wrapper.setProps({ resetKey: 'agent-b:person', items: records(200) });
    await flushFrames();
    expect(wrapper.element.scrollTop).toBe(0);
    expect(wrapper.find('[data-row-id="row-199"]').exists()).toBe(false);
    expect(wrapper.get('[data-row-id="row-0"]').element.open).toBe(false);
    await wrapper.setProps({ items: [] });
    expect(wrapper.findAll('[data-row-id]')).toHaveLength(0);
  });

  it('moves focus to the scroll region rather than losing it to the body when a focused row leaves the window', async () => {
    renderList({ items: records(200) });
    geometry(0);
    await wrapper.trigger('scroll');
    await flushFrames();
    wrapper.get('[data-row-id="row-0"] summary').element.focus();
    wrapper.element.scrollTop = 8000;
    await wrapper.trigger('scroll');
    await flushFrames();
    expect(document.activeElement).toBe(wrapper.element);
  });
});

describe('Latest-first Person inspector projections', () => {
  it('orders loaded sequence records non-mutatingly and preserves undated catalog order', () => {
    const source = [{ id: 'old', seq: 1, createdAt: 20 }, { id: 'new', seq: 2, createdAt: 10 }];
    expect(newestPersonRecords(source).map(row => row.id)).toEqual(['new', 'old']);
    expect(source.map(row => row.id)).toEqual(['old', 'new']);
    expect(newestPersonRecords([{ id: 'b' }, { id: 'a' }]).map(row => row.id)).toEqual(['b', 'a']);
  });

  it('reverses the completed thought projection without breaking proposal/commit correlation', () => {
    wrapper = mount(PersonThoughtJournal, { props: { traces: personRecords() }, global });
    const kinds = wrapper.findAll('.person-thought').map(row => row.attributes('data-thought-kind'));
    expect(kinds[0]).toBe('committed');
    expect(wrapper.text()).toContain('Looking for a pattern in recent releases.');
    expect(wrapper.text()).not.toContain('PRIVATE SYSTEM PROMPT');
  });

  it('shows latest debug records before older traces', () => {
    wrapper = mount(PersonDebugLog, { props: { traces: [{ id: 'old', seq: 1 }, { id: 'new', seq: 2 }] }, global });
    expect(wrapper.findAll('[data-trace-id]').map(row => row.attributes('data-trace-id'))).toEqual(['new', 'old']);
  });

  it('keeps catalog kind labels discoverable while ordering dated concepts latest-first', () => {
    wrapper = mount(PersonKnowledgeBrowser, { props: { section: 'memory', page: { items: [
      { id: 'old', kind: 'interest', statement: 'Old concept', updatedAt: 1 },
      { id: 'new', kind: 'interest', statement: 'New concept', updatedAt: 2 },
    ] } }, global });
    expect(wrapper.findAll('[data-knowledge-id]').map(row => row.attributes('data-knowledge-id'))).toEqual(['new', 'old']);
    expect(wrapper.get('[data-knowledge-id="new"] summary').text()).toContain(t('person.group.interest'));
  });

  it('puts memory content first and preserves the complete text and escaped detail', () => {
    const statement = '<script>Never run this</script> ' + 'Full memory content. '.repeat(30);
    wrapper = mount(PersonKnowledgeBrowser, { props: { section: 'memory', page: { items: [
      { id: 'memory', kind: 'method', statement, revision: 1, epistemicState: 'uncertain' },
    ] } }, global });
    const summary = wrapper.get('summary');
    expect(summary.classes()).toContain('is-memory');
    expect(summary.element.firstElementChild.className).toBe('person-knowledge-excerpt');
    expect(summary.get('.person-knowledge-excerpt').text()).toBe(statement.trim());
    expect(wrapper.get('.person-knowledge-detail .person-prose').text()).toBe(statement.trim());
    expect(wrapper.find('script').exists()).toBe(false);
  });

  it.each([en, zhCN])('shows capability name, useful description and translated category without debug keys', messages => {
    wrapper = mount(PersonKnowledgeBrowser, { props: { section: 'skills', page: { items: [
      { id: 'CancelTask', domain: 'tasks', description: 'Cancel a background task.' },
      { id: 'CloseAgent', domain: 'orchestration', description: 'Close a child thread.' },
      { id: 'Output.publish', domain: 'delivery', description: 'Deliver a file snapshot.' },
      { id: 'FutureTool', domain: 'custom-domain', description: 'A future capability.' },
    ] } }, global: { config: { globalProperties: { $t: key => messages[key] || key } } } });
    const task = wrapper.get('[data-knowledge-id="CancelTask"] summary');
    expect(task.element.firstElementChild.className).toBe('person-knowledge-name');
    expect(task.get('.person-knowledge-name').text()).toBe('CancelTask');
    expect(task.get('.person-knowledge-excerpt').text()).toBe('Cancel a background task.');
    for (const domain of ['tasks', 'orchestration', 'delivery']) expect(messages['person.group.' + domain]).toBeTruthy();
    expect(task.get('.person-knowledge-kind').text()).toBe(messages['person.group.tasks']);
    expect(wrapper.get('[data-knowledge-id="FutureTool"] .person-knowledge-kind').text()).toBe('custom-domain');
    expect(wrapper.text()).not.toContain('person.group.');
  });

  it('keeps turns latest-first and presents older-page fallback even when stale', () => {
    wrapper = mount(PersonTurnUsage, { props: { page: { items: [{ ...personTurn(1), id: 'old' }, { ...personTurn(2), id: 'new' }], stale: true, nextCursor: 'older' } }, global });
    expect(wrapper.findAll('[data-turn-id]').map(row => row.attributes('data-turn-id'))).toEqual(['new', 'old']);
    expect(wrapper.get('.person-load-more').text()).toBe(t('person.usage.older'));
  });

  it('orders tasks and child threads by creation, with distinct keys for reused ids and correct log ownership', async () => {
    wrapper = mount(PersonTaskBrowser, { props: { page: { tasks: [{ id: 'same', title: 'Old shell', createdAt: 1 }], agents: [{ id: 'same', name: 'New thread', taskId: 'child-log', createdAt: 2 }], truncated: true }, log: {} }, global });
    const rows = wrapper.findAll('.person-task-item');
    expect(rows[0].text()).toContain('New thread');
    await rows[0].get('button').trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['child-log']);
    expect(wrapper.text()).toContain(t('person.tasksTruncated'));
    expect(wrapper.find('.person-load-more').exists()).toBe(false);
  });

  it('focuses confirmation, restores the stop trigger on cancel and clears confirmation after identity change', async () => {
    wrapper = mount(PersonTaskBrowser, { attachTo: document.body, props: { identityKey: 'a', page: { tasks: [{ id: 'task', status: 'running' }], agents: [] }, log: {} }, global });
    const stop = () => wrapper.findAll('button').find(button => button.text() === t('person.stopTask'));
    await stop().trigger('click');
    expect(document.activeElement).toBe(wrapper.get('.btn-secondary').element);
    await wrapper.findAll('button').find(button => button.text() === t('common.cancel')).trigger('click');
    expect(document.activeElement).toBe(stop().element);
    await stop().trigger('click');
    await wrapper.setProps({ identityKey: 'b' });
    expect(wrapper.find('.btn-secondary').exists()).toBe(false);
  });
});
