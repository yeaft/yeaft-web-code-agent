// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import ConcurrentUserTurns from '../../web/components/ConcurrentUserTurns.js';
import { orderUserTurnMessages, partitionUserTurnBlocks, isPendingUserTurn, userTurnExcerpt } from '../../web/utils/concurrent-user-turns.js';

describe('concurrent user turn presentation', () => {
  it('keeps interleaved streams and supplements with their root, ordered by root time', () => {
    const a = { id: 'm1', type: 'user', content: 'first', timestamp: 10 };
    const b = { id: 'm2', type: 'user', content: 'second', timestamp: 20, userTurnId: 'm2' };
    const reply = { id: 'm3', type: 'assistant', userTurnId: 'm1', turnId: 'engine-a' };
    const supplement = { id: 'm4', type: 'user', content: 'also', userTurnId: 'm1', turnRelation: 'supplement' };
    const end = { id: 'm5', type: 'assistant', userTurnId: 'm2' };
    const ordered = orderUserTurnMessages([a, b, reply, supplement, end]);
    expect(ordered.messages).toEqual([a, reply, supplement, b, end]);
    expect(ordered.userTurnByMessage.get(supplement)).toBe('m1');
    expect(reply.turnId).toBe('engine-a');
  });

  it('partitions only pending turns without dropping rows and retains stable input order', () => {
    const blocks = ['a', 'b', 'c', 'a'].map((userTurnId, i) => ({ id: String(i), userTurnId }));
    const turns = [{ userTurnId: 'b', state: 'completed' }, { userTurnId: 'a', state: 'waiting' }, { userTurnId: 'c', state: 'queued' }];
    const result = partitionUserTurnBlocks(blocks, turns);
    expect(result.history).toEqual([blocks[1]]);
    expect(result.pending.map(turn => [turn.userTurnId, turn.blocks.map(block => block.id)])).toEqual([['a', ['0', '3']], ['c', ['2']]]);
    expect(['running', 'waiting', 'queued'].every(state => isPendingUserTurn({ state }))).toBe(true);
    expect(['error', 'completed', 'stopped'].some(state => isPendingUserTurn({ state }))).toBe(false);
  });

  it('preserves legacy rows and attaches old replies without inventing engine identity', () => {
    const rows = [{ id: 's', type: 'system' }, { id: 'm1', type: 'user', content: 'hello' }, { id: 'm2', type: 'assistant', content: 'world' }];
    const ordered = orderUserTurnMessages(rows);
    expect(ordered.messages).toEqual(rows);
    expect(ordered.userTurnByMessage.get(rows[2])).toBe('m1');
    expect(partitionUserTurnBlocks(rows, []).history).toEqual(rows);
    expect(userTurnExcerpt({ content: '  hello\n world  ' })).toBe('hello world');
    expect(userTurnExcerpt({ content: 'x'.repeat(100) })).toHaveLength(37);
  });

  it('renders the shared block template and scrolls accessible turn links without replacing columns', async () => {
    vi.stubGlobal('Vue', Vue);
    vi.stubGlobal('Pinia', { defineStore: () => () => ({}) });
    const { default: MessageBlock } = await import('../../web/components/MessageBlock.js');
    const errors = [];
    Vue.compile(MessageBlock.template, { onError: error => errors.push(error) });
    expect(errors).toEqual([]);
    const stop = vi.fn();
    const wrapper = mount(ConcurrentUserTurns, {
      props: { turns: [{ userTurnId: 'm1', state: 'running', blocks: [] }, { userTurnId: 'm2', state: 'waiting', blocks: [] }],
        messages: [{ id: 'm1', type: 'user', content: 'first task' }, { id: 'm2', type: 'user', content: 'second task' }], onStop: stop },
      global: { stubs: { VirtualTranscript: true }, config: { globalProperties: { $t: key => key } } },
    });
    try {
      const track = wrapper.get('.concurrent-turn-track').element;
      track.scrollTo = vi.fn();
      const tabs = wrapper.findAll('.concurrent-turn-tab');
      expect(tabs.map(tab => tab.text())).toEqual(['first task', 'second task']);
      await tabs[1].trigger('click');
      expect(track.scrollTo).toHaveBeenCalledTimes(1);
      await tabs[0].trigger('keydown', { key: 'End' });
      expect(track.scrollTo).toHaveBeenCalledTimes(2);
      expect(wrapper.findAll('.concurrent-turn-column')).toHaveLength(2);
      await wrapper.find('.concurrent-turn-header button').trigger('click');
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ userTurnId: 'm1' }));
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });

  it('hands off pane follow ownership for off-window navigation and scrollbar reading', async () => {
    vi.stubGlobal('Vue', Vue);
    const blocks = Array.from({ length: 20 }, (_, index) => ({ id: `block-${index}`, content: `row ${index}` }));
    const wrapper = mount(ConcurrentUserTurns, {
      attachTo: document.body,
      props: { turns: [{ userTurnId: 'root', state: 'running', blocks }],
        messages: [{ id: 'root', type: 'user', content: 'long execution' }], estimateHeight: () => 100 },
      slots: { default: '<template #default="{ block }"><div style="height:100px">{{ block.content }}</div></template>' },
      global: { config: { globalProperties: { $t: key => key } } },
    });
    try {
      const track = wrapper.get('.concurrent-turn-track').element;
      track.scrollTo = vi.fn();
      const body = wrapper.get('.concurrent-turn-body').element;
      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 });
      Object.defineProperty(body, 'clientWidth', { configurable: true, value: 280 });
      Object.defineProperty(body, 'offsetWidth', { configurable: true, value: 300 });
      body.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 300 });
      await Vue.nextTick();
      const api = wrapper.vm.$.exposed;
      expect(await api.revealBlock('root', 'block-0', { align: 'start' })).toBe(true);
      expect(wrapper.find('[data-virtual-id="block-0"]').exists()).toBe(true);
      // Explicit bottom intent resumes follow; a scrollbar press hands it back.
      await wrapper.get('.concurrent-turn-body').trigger('keydown', { key: 'End' });
      await wrapper.get('.concurrent-turn-body').trigger('pointerdown', { button: 0, clientX: 295, clientY: 100 });
      body.scrollTop = 0;
      body.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 40));
      await Vue.nextTick();
      expect(wrapper.find('[data-virtual-id="block-0"]').exists()).toBe(true);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });

  it('keeps single-turn layout, latches parallel layout, and returns only completed roots to history', async () => {
    vi.stubGlobal('Vue', Vue);
    const store = Vue.reactive({ currentView: 'yeaft', currentAgent: 'a', yeaftActiveSessionFilter: 's',
      currentConversation: 'conv', activeConversationId: 'conv', agents: [], isProcessing: false,
      messages: [{ id: 'm1', type: 'user', content: 'first', timestamp: 10 },
        { id: 'm2', type: 'user', content: 'second', timestamp: 20, userTurnId: 'm2' },
        { id: 'm3', type: 'assistant', content: 'first reply', userTurnId: 'm1', turnId: 'engine-1' }],
      yeaftSessionTurns: [{ userTurnId: 'm1', state: 'running' }], stopYeaftTurn: vi.fn(),
      workbenchExpanded: true, toggleWorkbench: vi.fn(function () { this.workbenchExpanded = !this.workbenchExpanded; }) });
    vi.stubGlobal('Pinia', { defineStore: () => () => ({}), useChatStore: () => store });
    const { default: MessageList } = await import('../../web/components/MessageList.js');
    const errors = [];
    Vue.compile(MessageList.template, { onError: error => errors.push(error) });
    expect(errors).toEqual([]);
    const wrapper = mount({ ...MessageList, template: '<main ref="containerRef"><span>{{ splitActive }}</span></main>' });
    try {
      expect(wrapper.vm.splitActive).toBe(false);
      expect(store.toggleWorkbench).not.toHaveBeenCalled();
      store.yeaftSessionTurns.push({ userTurnId: 'm2', state: 'queued' });
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      expect(store.workbenchExpanded).toBe(false);
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(1);
      // A manual reopen survives streaming and further live snapshot updates.
      store.workbenchExpanded = true;
      store.yeaftSessionTurns = store.yeaftSessionTurns.map(turn => ({ ...turn }));
      store.messages[2].content += ' live delta';
      await Vue.nextTick();
      expect(store.workbenchExpanded).toBe(true);
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(1);
      expect(wrapper.vm.historyBlocks).toEqual([]);
      expect(wrapper.vm.pendingTurns[0].blocks[0].items.map(item => item.type)).toEqual(['user', 'assistant-turn']);
      store.yeaftSessionTurns[0].state = 'completed';
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      expect(wrapper.vm.historyBlocks[0].originMessageId).toBe('m1');
      wrapper.vm.stopUserTurn(store.yeaftSessionTurns[1]);
      expect(store.stopYeaftTurn).toHaveBeenCalledWith({ userTurnId: 'm2' });
      store.yeaftSessionTurns[1].state = 'completed';
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(false);
      expect(wrapper.vm.historyBlocks.map(block => block.originMessageId)).toEqual(['m1', 'm2']);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});
