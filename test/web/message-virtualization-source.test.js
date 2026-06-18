import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('MessageList virtualization wiring', () => {
  it('routes Chat and Yeaft message blocks through the shared VirtualTranscript', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain("import VirtualTranscript from './VirtualTranscript.js';");
    expect(source).toContain('<VirtualTranscript');
    expect(source).toContain(':items="messageBlocks"');
    expect(source).toContain('@scroll-state="onVirtualTranscriptScrollState"');
    expect(source).toContain('the following VP replies into one virtual item');
    expect(source).toContain('v-if="block.type === \'message-block\'"');
    expect(source).not.toContain('<template v-for="block in messageBlocks"');
  });

  it('keeps remounted assistant action and tool UI state keyed by turn id', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const assistantTurnActionStates = Vue.reactive({});');
    expect(source).toContain('const toolExpandStates = Vue.reactive({});');
    expect(source).toContain(':actions-expanded="assistantTurnActionsExpandedFor(block)"');
    expect(source).toContain(':tool-expand-states="toolExpandStates"');
    expect(source).not.toContain('vpTurnExpandStates');
    expect(source).not.toContain(':expand-state="vpTurnExpandStateFor(block)"');
  });

  it('keeps load-more template handlers and loading state wired through setup', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('@click="onClickLoadMore"');
    expect(source).toContain('const onClickLoadMore = () => {');
    expect(source.match(/const onClickLoadMore = \(\) => \{/g)).toHaveLength(1);
    expect(source).toContain('onClickLoadMore,');
    expect(source).toContain('v-if="store.sessionLoading"');
    expect(source).not.toContain('v-if="sessionLoading"');
  });

  it('auto-loads more messages from the virtual scroll near-top event', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const LOAD_MORE_TOP_THRESHOLD = 100;');
    expect(source).toContain('const maybeLoadMoreNearTop = (scrollTop) => {');
    expect(source).toContain('if (scrollTop > LOAD_MORE_TOP_THRESHOLD) {');
    expect(source).toContain('onClickLoadMore();');
    expect(source).toContain('maybeLoadMoreNearTop(scrollTop || 0);');
    expect(source).toContain('if (containerRef.value) maybeLoadMoreNearTop(containerRef.value.scrollTop || 0);');
  });

  it('defers ResizeObserver measurements out of the observer callback', () => {
    const source = read('components/VirtualTranscript.js');

    expect(source).toContain('const pendingMeasurements = new Map();');
    expect(source).toContain('function scheduleMeasureElement(key, index, el) {');
    expect(source).toContain('requestAnimationFrame(() => {');
    expect(source).toContain('if (key) scheduleMeasureElement(key, index, entry.target);');
    expect(source).not.toContain('if (key) measureElement(key, index, entry.target);');
  });

});
