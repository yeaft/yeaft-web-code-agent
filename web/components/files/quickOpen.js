/**
 * quickOpen — Quick Open (Ctrl+P), Go to Line (Ctrl+G), and file search composable.
 */

export function createQuickOpen(store, { getEffectiveWorkDir, treePath, openFileInTab, revealPath }) {
  // File search state
  const searchQuery = Vue.ref('');
  const searchResults = Vue.ref([]);
  const searchLoading = Vue.ref(false);
  let searchDebounceTimer = null;

  // Quick Open (Ctrl+P) state
  const quickOpenVisible = Vue.ref(false);
  const quickOpenQuery = Vue.ref('');
  const quickOpenResults = Vue.ref([]);
  const quickOpenSelectedIndex = Vue.ref(0);
  const quickOpenLoading = Vue.ref(false);
  const quickOpenInput = Vue.ref(null);
  let quickOpenDebounceTimer = null;

  // Go to Line (Ctrl+G) state
  const goToLineVisible = Vue.ref(false);
  const goToLineValue = Vue.ref('');
  const goToLineInput = Vue.ref(null);

  // Shared file search sender
  const sendFileSearch = (query) => {
    if (!store.currentAgent || !query.trim()) return;
    store.sendWsMessage({
      type: 'file_search',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      query: query.trim(),
      dirPath: treePath.value || getEffectiveWorkDir() || '',
      _clientId: store.clientId
    });
  };

  // --- File Search ---
  const onSearchInput = () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (!searchQuery.value.trim()) {
      searchResults.value = [];
      searchLoading.value = false;
      return;
    }
    searchLoading.value = true;
    searchDebounceTimer = setTimeout(() => {
      sendFileSearch(searchQuery.value);
    }, 300);
  };

  const clearSearch = () => {
    searchQuery.value = '';
    searchResults.value = [];
    searchLoading.value = false;
  };

  const onSearchResultClick = (r) => {
    if (r.type === 'directory') {
      revealPath(r.fullPath, 'directory');
      clearSearch();
    } else {
      openFileInTab(r.fullPath, r.name);
      clearSearch();
    }
  };

  // --- Quick Open ---
  const openQuickOpen = () => {
    quickOpenVisible.value = true;
    quickOpenQuery.value = '';
    quickOpenResults.value = [];
    quickOpenSelectedIndex.value = 0;
    quickOpenLoading.value = false;
    Vue.nextTick(() => quickOpenInput.value?.focus());
  };

  const closeQuickOpen = () => {
    quickOpenVisible.value = false;
    quickOpenQuery.value = '';
    quickOpenResults.value = [];
  };

  const onQuickOpenInput = () => {
    if (quickOpenDebounceTimer) clearTimeout(quickOpenDebounceTimer);
    if (!quickOpenQuery.value.trim()) {
      quickOpenResults.value = [];
      quickOpenLoading.value = false;
      return;
    }
    quickOpenLoading.value = true;
    quickOpenSelectedIndex.value = 0;
    quickOpenDebounceTimer = setTimeout(() => {
      sendFileSearch(quickOpenQuery.value);
    }, 200);
  };

  const quickOpenSelectNext = () => {
    if (quickOpenResults.value.length > 0) {
      quickOpenSelectedIndex.value = (quickOpenSelectedIndex.value + 1) % quickOpenResults.value.length;
    }
  };

  const quickOpenSelectPrev = () => {
    if (quickOpenResults.value.length > 0) {
      quickOpenSelectedIndex.value = (quickOpenSelectedIndex.value - 1 + quickOpenResults.value.length) % quickOpenResults.value.length;
    }
  };

  const quickOpenOpenFile = (r) => {
    if (r.type !== 'directory') {
      openFileInTab(r.fullPath, r.name);
    }
    closeQuickOpen();
  };

  const quickOpenConfirm = () => {
    const sel = quickOpenResults.value[quickOpenSelectedIndex.value];
    if (sel) quickOpenOpenFile(sel);
  };

  // --- Go to Line ---
  const openGoToLine = () => {
    goToLineVisible.value = true;
    goToLineValue.value = '';
    Vue.nextTick(() => goToLineInput.value?.focus());
  };

  const closeGoToLine = () => {
    goToLineVisible.value = false;
    goToLineValue.value = '';
  };

  const goToLineConfirm = (activeFile) => {
    const line = parseInt(goToLineValue.value);
    if (isNaN(line) || line < 1) return;
    const file = activeFile.value;
    if (file?.cmInstance) {
      const cm = file.cmInstance;
      const targetLine = Math.min(line - 1, cm.lineCount() - 1);
      cm.setCursor({ line: targetLine, ch: 0 });
      cm.scrollIntoView({ line: targetLine, ch: 0 }, 100);
      cm.focus();
    }
    closeGoToLine();
  };

  // Handle search results from server
  const handleFileSearchResult = (msg) => {
    const results = msg.results || [];
    if (quickOpenVisible.value) {
      if (msg.query && msg.query.trim() === quickOpenQuery.value.trim()) {
        quickOpenResults.value = results;
        quickOpenLoading.value = false;
        quickOpenSelectedIndex.value = 0;
      }
    } else {
      if (msg.query && msg.query.trim() === searchQuery.value.trim()) {
        searchResults.value = results;
        searchLoading.value = false;
      }
    }
  };

  return {
    // File search
    searchQuery, searchResults, searchLoading,
    onSearchInput, clearSearch, onSearchResultClick,
    // Quick Open
    quickOpenVisible, quickOpenQuery, quickOpenResults, quickOpenSelectedIndex,
    quickOpenLoading, quickOpenInput,
    openQuickOpen, closeQuickOpen, onQuickOpenInput,
    quickOpenSelectNext, quickOpenSelectPrev, quickOpenConfirm, quickOpenOpenFile,
    // Go to Line
    goToLineVisible, goToLineValue, goToLineInput,
    openGoToLine, closeGoToLine, goToLineConfirm,
    // Message handler
    handleFileSearchResult
  };
}
