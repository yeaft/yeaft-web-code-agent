import { readFileSync } from 'node:fs';
import { computed, reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  annotateMessageBlocksForResponseCollapse,
  collapsedResponsePreviewForMessageBlock,
  estimateCollapsedMessageBlockHeight,
  visibleItemsForMessageBlock,
} from '../../web/utils/message-turn-collapse.js';

function user(id) {
  return { type: 'user', id, message: { id, content: id } };
}

function assistant(id, extra = {}) {
  return { type: 'assistant-turn', id, textContent: id, ...extra };
}

const readWebFile = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

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

  it('reacts when an explicit collapse state is added for a previously missing key', () => {
    const collapseStates = reactive({});
    const sourceBlocks = [
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
    ];
    const annotated = computed(() => annotateMessageBlocksForResponseCollapse(
      sourceBlocks,
      collapseStates,
      { expandedRecentUserTurns: 0 }
    ));

    expect(annotated.value[0].responseCollapsed).toBe(true);
    collapseStates.u1 = false;
    expect(annotated.value[0].responseCollapsed).toBe(false);
  });

  it('keeps a first-line response preview when a block is collapsed', () => {
    const [block] = annotateMessageBlocksForResponseCollapse([
      {
        type: 'message-block',
        id: 'turn-1',
        messageId: 'u1',
        items: [user('u1'), assistant('a1', { textContent: '\n\n# First visible line\nSecond line' })],
      },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(block.responseCollapsed).toBe(true);
    expect(block.collapsedResponsePreview).toBe('First visible line');
    expect(collapsedResponsePreviewForMessageBlock(block)).toBe('First visible line');
  });

  it('uses compact height estimates for collapsed response blocks with a preview row', () => {
    const [block] = annotateMessageBlocksForResponseCollapse([
      { type: 'message-block', id: 'turn-1', messageId: 'u1', items: [user('u1'), assistant('a1')] },
    ], {}, { expandedRecentUserTurns: 0 });

    expect(estimateCollapsedMessageBlockHeight(block, () => 100)).toBe(182);
  });

  it('renders collapse controls inside the assistant footer actions', () => {
    const assistantTurnSource = readWebFile('components/AssistantTurn.js');
    const messageListSource = readWebFile('components/MessageList.js');
    const cssSource = readWebFile('styles/chat-messages.css');

    expect(assistantTurnSource).toContain('class="response-collapse-btn"');
    expect(assistantTurnSource).toContain("@click=\"$emit('toggle-response-collapse')\"");
    expect(messageListSource).toContain(':response-collapsible="responseToggleBelongsToItem(block, item)"');
    expect(messageListSource).toContain('class="message-block-collapsed-preview"');
    expect(messageListSource).toContain('collapsedResponsePreview(block)');
    expect(messageListSource).not.toContain('class="message-turn-collapse-toggle"');
    expect(cssSource).toContain('.message-block-collapsed-response .message-block-collapse-footer');
    expect(cssSource).toContain('opacity: 1;');
    expect(cssSource).toContain('.copy-full-btn,\n.response-collapse-btn');
    expect(cssSource).not.toContain('.message-turn-collapse-toggle');
  });
});
