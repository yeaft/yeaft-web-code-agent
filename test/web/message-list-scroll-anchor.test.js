/**
 * MessageList history pagination scroll anchoring.
 *
 * Group/Yeaft history prepends older messages at the top of the list. The
 * viewport must keep the same visible row after the document grows above it,
 * both for automatic near-top loading and the explicit "load more" affordance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

describe('MessageList history pagination scroll anchoring', () => {
  const src = read('web/components/MessageList.js');

  it('centralizes prepend anchoring in a shared helper', () => {
    expect(src).toContain('const preserveScrollAnchorDuringLoad = (loadFn, loadingRef) => {');
    expect(src).toContain('const prevScrollHeight = containerRef.value.scrollHeight;');
    expect(src).toContain('const prevScrollTop = containerRef.value.scrollTop;');
    expect(src).toContain('containerRef.value.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;');
  });

  it('uses the same anchor restoration for near-top auto load and click load-more', () => {
    expect(src.match(/preserveScrollAnchorDuringLoad\(/g)?.length).toBe(2);

    const scrollSegment = src.slice(src.indexOf('const onScroll = () => {'), src.indexOf('const scrollToBottom = () => {'));
    expect(scrollSegment).toContain('preserveScrollAnchorDuringLoad(');
    expect(scrollSegment).toContain('store.loadMoreYeaftHistory()');
    expect(scrollSegment).toContain('store.loadMoreMessages()');

    const clickSegment = src.slice(src.indexOf('const onClickLoadMore = () => {'), src.indexOf('return {', src.indexOf('const onClickLoadMore = () => {')));
    expect(clickSegment).toContain('preserveScrollAnchorDuringLoad(');
    expect(clickSegment).toContain('store.loadMoreYeaftHistory()');
    expect(clickSegment).toContain('store.loadMoreMessages()');
  });


  it('surfaces a chat-mode-style jump-to-latest control when scrolled away', () => {
    expect(src).toContain('class="scroll-to-latest"');
    expect(src).toContain(':class="{ \'is-hidden\': isAtBottom }"');
    expect(src).toContain('@click="scrollToLatest"');
    expect(src).toContain("{{ $t('message.scrollToLatest') }}");

    const latestSegment = src.slice(src.indexOf('const scrollToLatest = () => {'), src.indexOf('const smartScrollToBottom = () => {'));
    expect(latestSegment).toContain('isAtBottom.value = true;');
    expect(latestSegment).toContain('Vue.nextTick(scrollToBottom);');
  });

  it('does not rely only on loading flag transitions, covering synchronous cached prepends', () => {
    expect(src).toContain('Covers synchronous test doubles and cached responses');
    expect(src).toContain('Vue.nextTick(() => {');
    expect(src).toContain('if (!loadingRef || !loadingRef()) restore();');
  });
});
