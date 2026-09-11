/**
 * fileTree — File tree composable for FilesTab.
 * Manages directory tree state, loading, expanding/collapsing, item clicks.
 */

export function createFileTree(store, { getEffectiveWorkDir, normalizePath, selectedPaths, lastClickedIndex, openFileInTab, clearSelection }) {
  const treePath = Vue.ref('');
  const treeRootPath = Vue.ref('');
  const treeNodes = Vue.reactive({});

  // VS Code style header state
  const editingTreePath = Vue.ref(false);
  const treePathInputRef = Vue.ref(null);

  const rootFolderName = Vue.computed(() => {
    if (!treeRootPath.value) return 'EXPLORER';
    const parts = treeRootPath.value.replace(/[\\/]+$/, '').split(/[\\/]/);
    return (parts[parts.length - 1] || treeRootPath.value).toUpperCase();
  });

  const startTreePathEdit = () => {
    editingTreePath.value = true;
    Vue.nextTick(() => treePathInputRef.value?.focus());
  };

  const confirmTreePath = () => {
    editingTreePath.value = false;
    loadRootDirectory();
  };

  const cancelTreePathEdit = () => {
    editingTreePath.value = false;
  };

  // Flattened tree computed
  const flattenedTree = Vue.computed(() => {
    const result = [];
    const walk = (dirPath, depth) => {
      const node = treeNodes[dirPath];
      if (!node || !node.entries) return;
      for (const entry of node.entries) {
        result.push({ ...entry, depth });
        if (entry.type === 'directory' && treeNodes[entry.path]?.expanded) {
          walk(entry.path, depth + 1);
        }
      }
    };
    if (treeRootPath.value && treeNodes[treeRootPath.value]?.expanded) {
      walk(treeRootPath.value, 0);
    }
    return result;
  });

  const loadTreeDirectory = (dirPath) => {
    const nDir = normalizePath(dirPath);
    if (!treeNodes[nDir]) {
      treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: true };
    } else {
      treeNodes[nDir].loading = true;
    }
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      dirPath: dirPath,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const loadRootDirectory = () => {
    const dir = treePath.value.trim();
    if (!dir) return;
    const nDir = normalizePath(dir);
    treeRootPath.value = nDir;
    Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
    treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: true };
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      dirPath: dir,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const toggleDirectory = (dirPath) => {
    const nDir = normalizePath(dirPath);
    const node = treeNodes[nDir];
    if (node) {
      if (node.loaded) {
        node.expanded = !node.expanded;
      } else {
        node.expanded = true;
        loadTreeDirectory(dirPath);
      }
    } else {
      treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: false };
      loadTreeDirectory(dirPath);
    }
  };

  const onTreeItemClick = (entry, event) => {
    const tree = flattenedTree.value;
    const clickedIndex = tree.findIndex(e => e.path === entry.path);

    if (event && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      if (event.shiftKey && lastClickedIndex.value >= 0 && clickedIndex >= 0) {
        const start = Math.min(lastClickedIndex.value, clickedIndex);
        const end = Math.max(lastClickedIndex.value, clickedIndex);
        if (!event.ctrlKey && !event.metaKey) {
          selectedPaths.clear();
        }
        for (let i = start; i <= end; i++) {
          selectedPaths.add(tree[i].path);
        }
      } else {
        if (selectedPaths.has(entry.path)) {
          selectedPaths.delete(entry.path);
        } else {
          selectedPaths.add(entry.path);
        }
      }
      lastClickedIndex.value = clickedIndex;
      return;
    }

    if (selectedPaths.size > 0) {
      selectedPaths.clear();
      lastClickedIndex.value = -1;
    }

    if (entry.type === 'directory') {
      toggleDirectory(entry.path);
    } else {
      openFileInTab(entry.path, entry.name);
    }
    lastClickedIndex.value = clickedIndex;
  };

  const removeTreeSubtree = (dirPath) => {
    const prefix = `${dirPath.replace(/\/$/, '')}/`;
    for (const path of Object.keys(treeNodes)) {
      if (path === dirPath || path.startsWith(prefix)) delete treeNodes[path];
    }
    for (const node of Object.values(treeNodes)) {
      if (node?.entries) node.entries = node.entries.filter(entry => entry.path !== dirPath);
    }
  };

  const isMissingDirectoryError = (error) => (
    typeof error === 'string' && /(?:ENOENT|not\s+(?:exist|found)|no such file)/i.test(error)
  );

  const isDirectoryInCurrentTree = (dirPath) => {
    if (dirPath === treeRootPath.value) return true;
    return Object.values(treeNodes).some(node => node?.entries?.some(entry => (
      entry.type === 'directory' && entry.path === dirPath
    )));
  };

  const handleDirectoryListing = (msg) => {
    const nDirPath = normalizePath(msg.dirPath);
    // A parent refresh may remove an expanded directory while its own listing
    // is still in flight. Ignore that late response instead of resurrecting an
    // invisible stale node that would be requested again on the next refresh.
    if (!isDirectoryInCurrentTree(nDirPath)) {
      removeTreeSubtree(nDirPath);
      return;
    }
    if (msg.error) {
      if (nDirPath !== treeRootPath.value && isMissingDirectoryError(msg.error)) {
        removeTreeSubtree(nDirPath);
      } else if (treeNodes[nDirPath]) {
        treeNodes[nDirPath].loading = false;
      }
      return;
    }
    const entries = (msg.entries || []).sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
    const basePath = nDirPath.replace(/\/$/, '');
    const enriched = entries.map(e => ({
      ...e,
      path: basePath + '/' + e.name
    }));

    const nextDirectoryPaths = new Set(
      enriched.filter(entry => entry.type === 'directory').map(entry => entry.path),
    );
    for (const previousEntry of treeNodes[nDirPath]?.entries || []) {
      if (previousEntry.type === 'directory' && !nextDirectoryPaths.has(previousEntry.path)) {
        removeTreeSubtree(previousEntry.path);
      }
    }

    if (!treeNodes[nDirPath]) {
      treeNodes[nDirPath] = { entries: enriched, expanded: true, loaded: true, loading: false };
    } else {
      treeNodes[nDirPath].entries = enriched;
      treeNodes[nDirPath].loaded = true;
      treeNodes[nDirPath].loading = false;
    }

    if (nDirPath === treeRootPath.value) {
      treePath.value = msg.dirPath;
    }
  };

  const clearTreeNodes = () => {
    Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
  };

  const initFileBrowser = () => {
    const dir = getEffectiveWorkDir();
    if (dir) {
      const nDir = normalizePath(dir);
      treePath.value = dir;
      treeRootPath.value = nDir;
      clearTreeNodes();
      loadTreeDirectory(dir);
    }
  };

  const refresh = () => {
    if (!treeRootPath.value) return;

    // Refresh every directory that is currently open instead of rebuilding the
    // tree from the root. Existing nodes keep their expanded state while fresh
    // listings arrive. If a directory disappeared, its parent listing or an
    // explicit not-found response removes that subtree without affecting the
    // rest of the refresh.
    const expandedPaths = Object.entries(treeNodes)
      .filter(([, node]) => node?.expanded)
      .map(([path]) => path);
    if (!expandedPaths.includes(treeRootPath.value)) {
      expandedPaths.unshift(treeRootPath.value);
    }
    for (const path of expandedPaths) {
      loadTreeDirectory(path);
    }
  };

  return {
    treePath, treeRootPath, treeNodes, flattenedTree,
    editingTreePath, treePathInputRef, rootFolderName,
    startTreePathEdit, confirmTreePath, cancelTreePathEdit,
    loadTreeDirectory, loadRootDirectory, toggleDirectory, onTreeItemClick,
    handleDirectoryListing, clearTreeNodes, initFileBrowser, refresh
  };
}
