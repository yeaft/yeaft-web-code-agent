// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { orderUserTurnMessages, hasParallelUserTurns } from '../../web/utils/concurrent-user-turns.js';

describe('concurrent user turn presentation', () => {
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
    // An older Agent reopens without activeSince. A live root that already
    // finished an execution cannot use its question time against roots
    // without an end time; one still in its first execution can. End times
    // (newer Agents) are unaffected.
    const ran = { ...turn('b', 'completed', 20), executions: [{ vpId: 'v', state: 'completed' }] };
    const legacyReopened = { ...turn('a', 'running', 10), executions: [{ vpId: 'v', state: 'completed' }, { vpId: 'v', state: 'running' }] };
    expect(hasParallelUserTurns([legacyReopened, ran])).toBe(false);
    expect(hasParallelUserTurns([legacyReopened, turn('b', 'running', 20)])).toBe(true);
    expect(hasParallelUserTurns([{ ...turn('a', 'running', 10), executions: [{ vpId: 'v', state: 'running' }] }, ran])).toBe(true);
    expect(hasParallelUserTurns([legacyReopened, { ...ran, endedAt: 30 }])).toBe(true);

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
