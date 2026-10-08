import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyRunningCatFrame, createRunningCatLoop, resolveRunningCatFrame } from '../../web/utils/running-cat.js';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('MessageList virtualization wiring', () => {
  it('starts the running cat immediately and applies frames without Vue state', () => {
    expect(resolveRunningCatFrame(0, 500).phase).toBe('speed-normal');
    expect(resolveRunningCatFrame(500, 500).transform).toBe('translate3d(16px, 0, 0) scaleX(1)');
    expect(resolveRunningCatFrame(7500, 400)).toEqual({
      phase: 'speed-crazy',
      transform: 'translate3d(400px, 0, 0) scaleX(-1)',
    });

    const classes = new Set(['speed-napping', 'unrelated']);
    const walkElement = { style: {} };
    const spriteElement = {
      classList: {
        toggle(className, enabled) {
          if (enabled) classes.add(className);
          else classes.delete(className);
        },
      },
    };
    applyRunningCatFrame(walkElement, spriteElement, resolveRunningCatFrame(3000, 200));
    expect(walkElement.style.transform).toBe('translate3d(43.6px, 0, 0) scaleX(1)');
    expect(classes.has('speed-fast')).toBe(true);
    expect(classes.has('speed-napping')).toBe(false);
    expect(classes.has('unrelated')).toBe(true);
  });
  it('owns at most one running cat animation frame chain', () => {
    const callbacks = new Map();
    const cancelled = [];
    let nextId = 1;
    let frames = 0;
    const loop = createRunningCatLoop({
      onFrame: () => { frames += 1; },
      requestFrame: callback => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame: id => {
        cancelled.push(id);
        callbacks.delete(id);
      },
    });

    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(false);
    expect(callbacks.size).toBe(1);
    const [firstId, firstCallback] = callbacks.entries().next().value;
    callbacks.delete(firstId);
    firstCallback();
    expect(frames).toBe(1);
    expect(callbacks.size).toBe(1);
    expect(loop.start()).toBe(false);
    expect(loop.stop()).toBe(true);
    expect(callbacks.size).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(loop.stop()).toBe(false);
  });

  it('keeps the running cat animation outside MessageList reactivity', () => {
    const source = read('components/MessageList.js');
    const splitPane = read('components/SplitPane.js');

    expect(source).toContain('applyRunningCatFrame(');
    expect(source).toContain('resolveRunningCatFrame(Date.now() - typingStartTime.value, travelPx)');
    expect(source).toContain('ref="catWalkRef"');
    expect(source).toContain('ref="catSpriteRef"');
    expect(source).not.toContain('now.value = Date.now();\n      const elapsed = (now.value - typingStartTime.value) % 19000;');
    expect(source).not.toContain(':style="catStyle"');
    expect(source).not.toContain(':class="catSpeed"');
    expect(splitPane).toContain('applyRunningCatFrame(');
    expect(splitPane).toContain('typingTimer = setInterval(() => {');
    expect(splitPane).toContain('now.value = Date.now();');
    expect(splitPane).not.toContain(':style="catStyle"');
    expect(splitPane).not.toContain(':class="catSpeed"');
  });






  it('auto-loads more messages from the virtual scroll near-top event', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('historyPrefetchThreshold,');
    expect(source).toContain('const maybeLoadMoreNearTop = (scrollTop, clientHeight = 0, { allowContinuation = false } = {}) => {');
    expect(source).toContain('if (scrollTop > historyPrefetchThreshold(clientHeight)) {');
    expect(source).toContain('onClickLoadMore();');
    expect(source).toContain('maybeLoadMoreNearTop(scrollTop || 0, clientHeight || 0);');
    expect(source).toContain('const continueLoadMoreIfStillNearTop = (beforeSnapshot) => {');
    expect(source).toContain('containerRef.value.clientHeight || 0,');
    expect(source).toContain('{ allowContinuation: true },');
    expect(source).toContain('const finishLoadMore = () => {');
    expect(source).not.toContain('const prevScrollHeight = containerRef.value.scrollHeight;');
    expect(source).not.toContain('containerRef.value.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;');
  });














  it('pauses bottom following before targeted history navigation', () => {
    const messageList = read('components/MessageList.js');
    const transcript = read('components/VirtualTranscript.js');

    expect(messageList).toContain('const pauseAutoFollow = () => {');
    expect(messageList).toContain('const markUserScrollIntent = () => {\n      pauseAutoFollow();');
    expect(messageList).toContain('const onPointerScrollStart = (event) => {\n      if (!isTranscriptScrollbarPointer(event, containerRef.value)) return;\n      pauseAutoFollow();');
    expect(messageList).toContain('const onScrollKey = (event) => {\n      if (!shouldMarkTranscriptKeyScroll(event, containerRef.value)) return;\n      pauseAutoFollow();');
    expect(messageList).not.toContain('resumeBoundaryReached: reachedBottom,');
    expect(messageList).toContain('const scrollToLatest = () => {');
    expect(messageList).toContain('virtualTranscriptRef.value?.clearTargetAnchor?.();');
    expect(messageList).toContain('store.showLatestYeaftMessageWindow?.(');
    expect(messageList).toContain('clearUserScrollInteraction();\n      resumeAutoFollow();\n      Vue.nextTick(scrollToBottom);');
    expect(messageList).toContain('virtualTranscriptRef.value?.cancelPendingBottomFollow?.();');
    expect(messageList).toContain('const revealMessage = async (target) => {\n      if (!target) return false;\n      pauseAutoFollow();');
    expect(messageList).not.toContain('scrollToBlock: (blockId) => {\n          resumeAutoFollow();');
    expect(messageList).toContain('Vue.watch(virtualTranscriptIdentity, () => {');
    expect(messageList).not.toContain('() => [store.activeConversationId, activeYeaftSessionId.value],');
    expect(transcript).toContain('function cancelPendingBottomFollow({ preserveTarget = false } = {}) {');
    expect(transcript).toContain('pendingScrollToBottom = false;');
    expect(transcript).toContain('expose({ scrollToBottom, scrollToKey, scrollToIndex, anchorTarget, clearTargetAnchor, cancelPendingBottomFollow, setBottomFollowEnabled });');
  });

});
