/**
 * crewScroll — Composable factory for scroll management, history loading, block visibility.
 */
export function createCrewScroll(store, { getMessagesRef, getFeatureBlocks, getConversationId }) {
  const isAtBottom = Vue.ref(true);
  const visibleBlockCount = Vue.ref(20);
  const isLoadingMore = Vue.ref(false);
  const isLoadingHistory = Vue.ref(false);

  // Center panel only renders global blocks, so visibility window must count
  // globals — not all blocks. Otherwise feature blocks push PM messages out.
  const globalBlocks = Vue.computed(() => {
    return getFeatureBlocks().filter(b => b.type === 'global');
  });

  const visibleBlocks = Vue.computed(() => {
    const all = globalBlocks.value;
    if (all.length <= visibleBlockCount.value) return all;
    return all.slice(all.length - visibleBlockCount.value);
  });

  const hiddenBlockCount = Vue.computed(() => {
    return Math.max(0, globalBlocks.value.length - visibleBlockCount.value);
  });

  const hasOlderMessages = Vue.computed(() => {
    const sid = getConversationId ? getConversationId() : store.currentConversation;
    const older = store.crewOlderMessages[sid];
    return older?.hasMore || false;
  });

  function scrollToBottom() {
    const el = getMessagesRef();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function checkIfAtBottom() {
    const el = getMessagesRef();
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
  }

  function onScroll() {
    isAtBottom.value = checkIfAtBottom();
    const scrollEl = getMessagesRef();
    if (scrollEl && scrollEl.scrollTop < 100) {
      if (hiddenBlockCount.value > 0) {
        loadMoreBlocks();
      } else if (hasOlderMessages.value && !isLoadingHistory.value) {
        loadHistory();
      }
    }
  }

  function loadMoreBlocks() {
    if (isLoadingMore.value || hiddenBlockCount.value <= 0) return;
    isLoadingMore.value = true;

    const scrollEl = getMessagesRef();
    const oldScrollHeight = scrollEl.scrollHeight;
    const oldScrollTop = scrollEl.scrollTop;

    visibleBlockCount.value = Math.min(
      visibleBlockCount.value + 10,
      globalBlocks.value.length
    );

    Vue.nextTick(() => {
      const newScrollHeight = scrollEl.scrollHeight;
      scrollEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
      isLoadingMore.value = false;
    });
  }

  function loadHistory(watchFn) {
    if (isLoadingHistory.value || !hasOlderMessages.value) return;
    const sid = getConversationId ? getConversationId() : store.currentConversation;
    const requested = store.loadCrewHistory(sid);
    if (!requested) return;
    // Use provided watchFn or fall back to Vue.watch (works in Options API created() scope)
    const doWatch = watchFn || ((getter, cb) => Vue.watch(getter, cb));
    isLoadingHistory.value = true;
    const unwatch = doWatch(
      () => store.crewOlderMessages[sid]?.loading,
      (loading) => {
        if (loading === false) {
          unwatch();
          isLoadingHistory.value = false;
          const scrollEl = getMessagesRef();
          const oldScrollHeight = scrollEl?.scrollHeight || 0;
          const oldScrollTop = scrollEl?.scrollTop || 0;
          visibleBlockCount.value = globalBlocks.value.length;
          Vue.nextTick(() => {
            if (scrollEl) {
              const newScrollHeight = scrollEl.scrollHeight;
              scrollEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
            }
          });
        }
      }
    );
  }

  function scrollToMeaningfulContent() {
    Vue.nextTick(() => scrollToBottom());
  }

  function scrollToBottomAndReset() {
    visibleBlockCount.value = 20;
    Vue.nextTick(() => scrollToBottom());
  }

  function smartScrollToBottom() {
    if (isAtBottom.value) Vue.nextTick(() => scrollToBottom());
  }

  function scrollToRoleLatest(roleName, featureBlocks, expandedFeatures, expandedHistories, rootEl) {
    const blocks = featureBlocks;
    let targetBlock = null;
    let isInLatestTurn = false;

    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const turns = block.turns;
      if (!turns) continue;
      for (let j = turns.length - 1; j >= 0; j--) {
        const turn = turns[j];
        const turnRole = turn.type === 'turn' ? turn.role : turn.message?.role;
        if (turnRole === roleName) {
          targetBlock = block;
          isInLatestTurn = j === turns.length - 1;
          break;
        }
      }
      if (targetBlock) break;
    }

    if (!targetBlock) return;

    // visibleBlockCount gates global blocks only; compute needed count accordingly
    if (targetBlock.type === 'global') {
      const globals = blocks.filter(b => b.type === 'global');
      const gIdx = globals.indexOf(targetBlock);
      const needed = globals.length - gIdx;
      if (needed > visibleBlockCount.value) {
        visibleBlockCount.value = needed;
      }
    }

    if (targetBlock.type === 'feature' && targetBlock.taskId) {
      expandedFeatures[targetBlock.taskId] = true;
      if (!isInLatestTurn) {
        expandedHistories[targetBlock.taskId] = true;
      }
    }

    Vue.nextTick(() => {
      const els = rootEl.querySelectorAll(`.crew-message[data-role="${roleName}"]`);
      const el = els.length > 0 ? els[els.length - 1] : null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('crew-msg-highlight');
        setTimeout(() => el.classList.remove('crew-msg-highlight'), 2000);
      }
    });
  }

  function scrollToFeature(taskId, expandedFeatures, rootEl) {
    expandedFeatures[taskId] = true;
    Vue.nextTick(() => {
      const el = rootEl.querySelector(`.crew-feature-thread[data-task-id="${taskId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  return {
    isAtBottom,
    visibleBlockCount,
    isLoadingMore,
    isLoadingHistory,
    visibleBlocks,
    hiddenBlockCount,
    hasOlderMessages,
    scrollToBottom,
    onScroll,
    loadMoreBlocks,
    loadHistory,
    scrollToMeaningfulContent,
    scrollToBottomAndReset,
    smartScrollToBottom,
    scrollToRoleLatest,
    scrollToFeature
  };
}
