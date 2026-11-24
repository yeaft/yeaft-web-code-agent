// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { orderUserTurnMessages } from '../../web/utils/concurrent-user-turns.js';

describe('concurrent user turn presentation', () => {
  it('settles finished roots in completion order independently of live layout', () => {
    const turn = (userTurnId, state, startedAt, endedAt) => ({ userTurnId, state, startedAt, ...(endedAt ? { endedAt } : {}) });
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
    expect(order([turn('a', 'running', 10), turn('b', 'aborted', 20, 30)])).toEqual(['o', 'b', 'rb', 'a', 'ra', 'c']);
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
      store.messages.push({ id: 'lost', type: 'user', content: 'recoverable input', userTurnId: 'lost', turnRelation: 'new', isHistory: true });
      store.yeaftSessionTurns = [{ userTurnId: 'lost', state: 'interrupted', executions: [] }];
      await Vue.nextTick();
      expect(wrapper.vm.turnGroups.filter(item => item.interrupted).map(item => item.id)).toEqual(['lost']);
      expect(wrapper.vm.historyBlocks.some(block => block.userTurnId === 'lost')).toBe(true);
      const { default: UserTurnBlock } = await import('../../web/components/UserTurnBlock.js');
      const { message, interrupted } = wrapper.vm.turnGroups.find(item => item.interrupted);
      const user = mount(UserTurnBlock, { props: { message, interrupted },
        global: { provide: { t: key => key }, mocks: { $t: key => key } } });
      try { expect(user.get('[role="status"]').text()).toBe('message.sessionTurnInterrupted'); } finally { user.unmount(); }
      store.messages.pop();
      store.yeaftSessionTurns = [
        { userTurnId: 'root', state: 'running', startedAt: 10 },
        { userTurnId: 'new', state: 'queued', startedAt: 20 },
      ];
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      store.yeaftSessionTurns[1].state = 'cancelling';
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(true);
      Object.assign(store.yeaftSessionTurns[1], { state: 'aborted', endedAt: 30 });
      await Vue.nextTick();
      expect(wrapper.vm.splitActive).toBe(false);
      expect(wrapper.vm.historyBlocks.map(block => block.userTurnId)).toEqual(['new', 'root']);
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});
