// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import ConcurrentUserTurns from '../../web/components/ConcurrentUserTurns.js';
import { orderUserTurnMessages, partitionUserTurnBlocks, isPendingUserTurn, userTurnExcerpt, hasParallelUserTurns } from '../../web/utils/concurrent-user-turns.js';

describe('concurrent user turn presentation', () => {
  it('keeps interleaved streams and supplements with their root, ordered by root time', () => {
    const a = { id: 'm1', type: 'user', content: 'first', timestamp: 10 };
    const b = { id: 'm2', type: 'user', content: 'second', timestamp: 20, userTurnId: 'm2' };
    const reply = { id: 'm3', type: 'assistant', userTurnId: 'm1', turnId: 'engine-a' };
    const supplement = { id: 'm4', type: 'user', content: 'also', userTurnId: 'm1', turnRelation: 'supplement' };
    const end = { id: 'm5', type: 'assistant', userTurnId: 'm2' };
    const continuation = { id: 'm6', type: 'assistant', userTurnId: 'm1', turnId: 'engine-a' };
    const original = [a, b, reply, supplement, end, continuation];
    const ordered = orderUserTurnMessages(original);
    // Confirmed supplements belong to the same input group, not a second AI
    // response boundary. Reordering is a view projection, never a transcript edit.
    expect(ordered.messages).toEqual([a, supplement, reply, continuation, b, end]);
    expect(original).toEqual([a, b, reply, supplement, end, continuation]);
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

  it('derives the parallel period from Agent times and settles finished roots in completion order', () => {
    const turn = (userTurnId, state, startedAt, endedAt) => ({ userTurnId, state, startedAt, ...(endedAt ? { endedAt } : {}) });
    expect(hasParallelUserTurns([])).toBe(false);
    expect(hasParallelUserTurns([turn('a', 'running', 10)])).toBe(false);
    expect(hasParallelUserTurns([turn('a', 'running', 10), turn('b', 'queued', 20)])).toBe(true);
    // The remaining live root keeps its lane whichever overlapping root ended first.
    expect(hasParallelUserTurns([turn('a', 'running', 10), turn('b', 'completed', 20, 30)])).toBe(true);
    expect(hasParallelUserTurns([turn('a', 'completed', 10, 30), turn('b', 'running', 20)])).toBe(true);
    // No overlap, an unknown end (older Agent) or an unknown start ends the period.
    expect(hasParallelUserTurns([turn('a', 'completed', 10, 15), turn('b', 'running', 20)])).toBe(false);
    expect(hasParallelUserTurns([turn('a', 'completed', 10), turn('b', 'running', 20)])).toBe(false);
    expect(hasParallelUserTurns([turn('a', 'completed', 10, 30), turn('b', 'running', 0)])).toBe(false);
    // An older Agent still keeps the lane when the later root ran during the live one.
    expect(hasParallelUserTurns([turn('a', 'running', 10), { ...turn('b', 'completed', 20), executions: [{ vpId: 'v' }] }])).toBe(true);
    // A task result reopening a root measures from the reopen: a root that ran
    // in between is not parallel, one that runs during the new span is.
    const reopened = { ...turn('a', 'running', 10), activeSince: 40 };
    expect(hasParallelUserTurns([reopened, turn('b', 'completed', 20, 30)])).toBe(false);
    expect(hasParallelUserTurns([reopened, turn('b', 'completed', 45, 50)])).toBe(true);
    expect(hasParallelUserTurns([reopened, turn('b', 'running', 20)])).toBe(true);
    // A routed root that never got an execution has nothing to overlap.
    expect(hasParallelUserTurns([turn('a', 'running', 10), { ...turn('r', 'completed', 20), executions: [] }])).toBe(false);

    const a = { id: 'a', type: 'user', content: 'earlier', timestamp: 10, userTurnId: 'a' };
    const b = { id: 'b', type: 'user', content: 'later', timestamp: 20, userTurnId: 'b' };
    const replyA = { id: 'ra', type: 'assistant', timestamp: 25, userTurnId: 'a' };
    const replyB = { id: 'rb', type: 'assistant', timestamp: 26, userTurnId: 'b' };
    const old = { id: 'o', type: 'user', content: 'old', timestamp: 1, userTurnId: 'o' };
    const optimistic = { id: 'c', type: 'user', content: 'just sent', timestamp: 40 };
    const rows = [old, a, b, replyA, replyB, optimistic];
    const order = turns => orderUserTurnMessages(rows, turns).messages.map(row => row.id);
    // Without a snapshot (or from an older Agent) questions keep their sent order.
    expect(order([])).toEqual(['o', 'a', 'ra', 'b', 'rb', 'c']);
    expect(order([turn('a', 'completed', 10), turn('b', 'completed', 20)])).toEqual(['o', 'a', 'ra', 'b', 'rb', 'c']);
    // A later root that finished first settles above the live one; the unrouted
    // optimistic send and older history keep their own slots.
    expect(order([turn('a', 'running', 10), turn('b', 'completed', 20, 30)])).toEqual(['o', 'b', 'rb', 'a', 'ra', 'c']);
    // Finishing the earlier root appends it after the already-settled answer.
    expect(order([turn('a', 'completed', 10, 50), turn('b', 'completed', 20, 30)])).toEqual(['o', 'b', 'rb', 'a', 'ra', 'c']);
    expect(rows.map(row => row.id)).toEqual(['o', 'a', 'b', 'ra', 'rb', 'c']);
    // A finished root without an end time (never ran) keeps its own slot
    // instead of jumping above every settled answer.
    const never = { id: 'n', type: 'user', content: 'failed send', timestamp: 15, userTurnId: 'n' };
    expect(orderUserTurnMessages([a, never, b, replyA, replyB], [turn('a', 'completed', 10, 50),
      { ...turn('n', 'completed', 15), executions: [] }, turn('b', 'completed', 20, 30)]).messages.map(row => row.id))
      .toEqual(['b', 'rb', 'n', 'a', 'ra']);
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
      // Latest must also resume the nested transcript after user reading.
      const transcript = wrapper.findComponent({ name: 'VirtualTranscript' }).vm.$.exposed;
      const bottom = vi.spyOn(transcript, 'scrollToBottom');
      const follow = vi.spyOn(transcript, 'setBottomFollowEnabled');
      api.revealLatest();
      expect(follow).toHaveBeenLastCalledWith(true);
      expect(bottom).toHaveBeenCalledTimes(1);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });

  it('keeps single-turn layout, derives the parallel layout across navigation, and returns only completed roots to history', async () => {
    vi.stubGlobal('Vue', Vue);
    const store = Vue.reactive({ currentView: 'yeaft', currentAgent: 'a', yeaftActiveSessionFilter: 's',
      currentConversation: 'conv', activeConversationId: 'conv', agents: [], isProcessing: false,
      messages: [{ id: 'm1', type: 'user', content: 'first', timestamp: 10 },
        { id: 'm2', type: 'user', content: 'second', timestamp: 20, userTurnId: 'm2' },
        { id: 'm3', type: 'assistant', content: 'first reply', userTurnId: 'm1', turnId: 'engine-1' }],
      yeaftSessionTurns: [{ userTurnId: 'm1', state: 'running', startedAt: 10 }], stopYeaftTurn: vi.fn(),
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
      store.yeaftSessionTurns.push({ userTurnId: 'm2', state: 'queued', startedAt: 20 });
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
      Object.assign(store.yeaftSessionTurns[0], { state: 'completed', endedAt: 30 });
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      expect(wrapper.vm.historyBlocks[0].originMessageId).toBe('m1');
      // Leaving and reopening the Session keeps the remaining lane; a latch in
      // this component used to reset here and drop it back into one column.
      const snapshot = store.yeaftSessionTurns;
      store.yeaftActiveSessionFilter = 'elsewhere';
      store.yeaftSessionTurns = [];
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(false);
      store.yeaftActiveSessionFilter = 's';
      store.yeaftSessionTurns = snapshot;
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      expect(wrapper.vm.pendingTurns.map(turn => turn.userTurnId)).toEqual(['m2']);
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(2);
      wrapper.vm.stopUserTurn(store.yeaftSessionTurns[1]);
      expect(store.stopYeaftTurn).toHaveBeenCalledWith({ userTurnId: 'm2' });
      Object.assign(store.yeaftSessionTurns[1], { state: 'completed', endedAt: 40 });
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(false);
      expect(wrapper.vm.historyBlocks.map(block => block.originMessageId)).toEqual(['m1', 'm2']);
      // A background result reopening m1 after m2 finished is not parallel: no
      // one-lane split, the reopened Workbench stays, and the live root reads last.
      store.workbenchExpanded = true;
      store.yeaftSessionTurns[0] = { userTurnId: 'm1', state: 'running', startedAt: 10, activeSince: 50 };
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(false);
      expect(store.workbenchExpanded).toBe(true);
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(2);
      expect(wrapper.vm.historyBlocks.map(block => block.originMessageId)).toEqual(['m2', 'm1']);
      store.yeaftSessionTurns[0] = { userTurnId: 'm1', state: 'completed', startedAt: 10, endedAt: 60 };
      await Vue.nextTick();
      expect(wrapper.vm.historyBlocks.map(block => block.originMessageId)).toEqual(['m2', 'm1']);
      // A new parallel period closes again, and direct split-to-split Session
      // navigation applies the default to the new owner exactly once.
      store.workbenchExpanded = true;
      store.yeaftSessionTurns = store.yeaftSessionTurns.map(turn => ({ ...turn, state: 'running' }));
      await Vue.nextTick();
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(3);
      store.workbenchExpanded = true;
      store.yeaftActiveSessionFilter = 'other-session';
      await Vue.nextTick();
      expect(store.toggleWorkbench).toHaveBeenCalledTimes(4);
      expect(store.workbenchExpanded).toBe(false);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });

  it('merges confirmed append tools and text into one response live and after replay without merging independent turns', async () => {
    vi.stubGlobal('Vue', Vue);
    const store = Vue.reactive({ currentView: 'yeaft', currentAgent: 'a', yeaftActiveSessionFilter: 's',
      currentConversation: 'conv', activeConversationId: 'conv', agents: [], isProcessing: false,
      messages: [], yeaftSessionTurns: [] });
    vi.stubGlobal('Pinia', { defineStore: () => () => ({}), useChatStore: () => store });
    const { default: MessageList } = await import('../../web/components/MessageList.js');
    const wrapper = mount({ ...MessageList, template: '<main ref="containerRef"></main>' });
    try {
      // Append while the same execution is using tools: routing metadata can
      // arrive after the optimistic user row. Only a confirmed supplement may
      // stop being a response boundary, and unrelated executions stay separate.
      store.messages = [
        { id: 'root', type: 'user', content: 'first', userTurnId: 'root' },
        { id: 'before', type: 'assistant', content: 'checking', userTurnId: 'root', turnId: 'engine', vpId: 'omni' },
        { id: 'tool-before', type: 'tool-use', toolId: 'before', toolName: 'Read', userTurnId: 'root', turnId: 'engine', vpId: 'omni' },
        { id: 'extra', type: 'user', content: 'also check eligibility' },
        { id: 'tool-after', type: 'tool-use', toolId: 'after', toolName: 'Grep', userTurnId: 'root', turnId: 'engine', vpId: 'omni' },
        { id: 'after', type: 'assistant', content: 'done', userTurnId: 'root', turnId: 'engine', vpId: 'omni' },
      ];
      await Vue.nextTick();
      expect(wrapper.vm.messageBlocks).toHaveLength(2);
      Object.assign(store.messages[3], { userTurnId: 'root', turnRelation: 'supplement' });
      await Vue.nextTick();
      const replies = () => wrapper.vm.turnGroups.filter(item => item.type === 'assistant-turn');
      expect(replies()).toHaveLength(1);
      expect(replies()[0].toolMsgs.map(tool => tool.toolId)).toEqual(['before', 'after']);
      expect(replies()[0].textSegments.map(segment => segment.content)).toEqual(['checking', 'done']);
      expect(wrapper.vm.messageBlocks).toHaveLength(1);
      expect(wrapper.vm.messageBlocks[0].originMessageId).toBe('root');
      expect(wrapper.vm.messageBlocks[0].items.map(item => item.type)).toEqual(['user', 'user', 'assistant-turn']);
      // A genuine new live execution under the same root keeps its boundary.
      store.messages.push({ id: 'retry', type: 'assistant', content: 'new execution', userTurnId: 'root', turnId: 'retry', vpId: 'omni' });
      await Vue.nextTick();
      expect(replies().map(item => item.turnId)).toEqual(['engine', 'retry']);
      store.messages.pop();
      // History replay uses the same grouping. Different speakers and unrelated
      // user turns still retain their own response blocks.
      store.messages.forEach(message => { message.isHistory = true; });
      await Vue.nextTick();
      expect(replies()).toHaveLength(1);
      store.messages.push(
        { id: 'vp', type: 'assistant', content: 'other VP', userTurnId: 'root', turnId: 'engine', vpId: 'other' },
        { id: 'new', type: 'user', content: 'unrelated', userTurnId: 'new', turnRelation: 'new' },
        { id: 'other', type: 'assistant', content: 'other answer', userTurnId: 'new', turnId: 'independent', vpId: 'omni' },
      );
      await Vue.nextTick();
      expect(replies().map(item => [item.speakerVpId, item.userTurnId])).toEqual([['omni', 'root'], ['other', 'root'], ['omni', 'new']]);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});
