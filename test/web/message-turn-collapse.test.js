import { describe, expect, it } from 'vitest';
import {
  annotateMessageBlocksForResponseCollapse,
  estimateCollapsedMessageBlockHeight,
  visibleItemsForMessageBlock,
} from '../../web/utils/message-turn-collapse.js';

function user(id) {
  return { type: 'user', id, message: { id, content: id } };
}

function assistant(id, extra = {}) {
  return { type: 'assistant-turn', id, textContent: id, ...extra };
}

describe('message turn response collapse', () => {
  it('keeps the newest two user turns expanded and collapses older responses by default', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3')] },
      { type: 'message-block', id: 'turn-4', messageId: 'u4', items: [user('u4'), assistant('a4')] },
    ]);

    expect(blocks.map(block => block.responseCollapsed)).toEqual([true, true, false, false]);
    expect(visibleItemsForMessageBlock(blocks[0])).toEqual([blocks[0].items[0]]);
    expect(visibleItemsForMessageBlock(blocks[3])).toEqual(blocks[3].items);
  });

  it('lets explicit user expansion override the default collapsed state', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3')] },
    ], { u1: false });

    expect(blocks[0].responseCollapseKey).toBe('u1');
    expect(blocks[0].responseCollapsed).toBe(false);
  });

  it('does not collapse streaming responses', () => {
    const blocks = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
      { type: 'message-block', id: 'turn-2', messageId: 'u2', items: [user('u2'), assistant('a2')] },
      { type: 'message-block', id: 'turn-3', messageId: 'u3', items: [user('u3'), assistant('a3', { isStreaming: true })] },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(blocks[0].responseCollapsible).toBe(true);
    expect(blocks[0].responseCollapsed).toBe(true);
    expect(blocks[2].responseCollapsible).toBe(false);
    expect(blocks[2].responseCollapsed).toBe(false);
  });

  it('uses compact height estimates for collapsed response blocks', () => {
    const [block] = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(estimateCollapsedMessageBlockHeight(block, () => 100)).toBe(144);
  });
});
