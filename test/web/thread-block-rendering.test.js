/**
 * thread-block-rendering.test.js — threadId is the first-level Unify block boundary.
 *
 * The production MessageList keeps detailed assistant-turn aggregation inline,
 * so this test pins the thread-block layer as a small logic replica plus source
 * guards. The rule is simple: in Unify, visible rows are wrapped into
 * consecutive blocks keyed by stable threadId, with turnId only as a legacy
 * fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

function blockIdForItem(item, index) {
  const msg = item.message || null;
  return item.threadId
    || item.turnId
    || msg?.threadId
    || msg?.turnId
    || (msg?.id ? `legacy_${msg.id}` : `legacy_${index}`);
}

function groupByThread(items) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current && current.items.length > 0) blocks.push(current);
    current = null;
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'system' || item.type === 'error') {
      flush();
      blocks.push(item);
      continue;
    }
    const threadId = blockIdForItem(item, i);
    if (!current || current.threadId !== threadId) {
      flush();
      current = { type: 'thread-block', threadId, items: [] };
    }
    current.items.push(item);
  }
  flush();
  return blocks;
}

describe('MessageList thread-block rendering source', () => {
  const src = read('web/components/MessageList.js');

  it('renders threadBlocks instead of flat turnGroups in the main loop', () => {
    expect(src).toContain('v-for="block in threadBlocks"');
    expect(src).toContain('class="thread-block"');
    expect(src).toContain(':data-thread-id="block.threadId"');
  });

  it('derives the first-level block id from threadId before turnId', () => {
    const idx = src.indexOf('const threadBlockIdForItem');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 500);
    expect(body.indexOf('item.threadId')).toBeLessThan(body.indexOf('item.turnId'));
    expect(body.indexOf('msg?.threadId')).toBeLessThan(body.indexOf('msg?.turnId'));
  });
});

describe('thread block grouping behavior', () => {
  it('keeps user input and assistant output in the same stable thread block after reload', () => {
    const blocks = groupByThread([
      { type: 'user', id: 'u-1', message: { id: 'u-1', threadId: 'thr-a', content: 'question' } },
      { type: 'assistant-turn', id: 'a-1', threadId: 'thr-a', textContent: 'answer' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].threadId).toBe('thr-a');
    expect(blocks[0].items.map(i => i.id)).toEqual(['u-1', 'a-1']);
  });

  it('splits pagination/realtime rows when threadId changes even if turnId is absent', () => {
    const blocks = groupByThread([
      { type: 'user', id: 'u-1', message: { id: 'u-1', threadId: 'thr-a' } },
      { type: 'assistant-turn', id: 'a-1', threadId: 'thr-a' },
      { type: 'user', id: 'u-2', message: { id: 'u-2', threadId: 'thr-b' } },
      { type: 'assistant-turn', id: 'a-2', threadId: 'thr-b' },
    ]);

    expect(blocks.map(b => b.threadId)).toEqual(['thr-a', 'thr-b']);
    expect(blocks[0].items.map(i => i.id)).toEqual(['u-1', 'a-1']);
    expect(blocks[1].items.map(i => i.id)).toEqual(['u-2', 'a-2']);
  });

  it('uses turnId as a legacy fallback only when threadId is missing', () => {
    const blocks = groupByThread([
      { type: 'user', id: 'u-legacy', message: { id: 'u-legacy', turnId: 'turn-1' } },
      { type: 'assistant-turn', id: 'a-legacy', turnId: 'turn-1' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].threadId).toBe('turn-1');
  });
});
