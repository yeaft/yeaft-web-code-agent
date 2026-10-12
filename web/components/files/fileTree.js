/**
 * fileTree — File tree composable for FilesTab.
 * Manages directory tree state, loading, expanding/collapsing, item clicks.
 */

import { childDirectory, directoryBreadcrumbs, isPathWithinDirectory, parentDirectory } from '../../utils/folder-picker-path.js';

export function createFileTree(store, { getEffectiveWorkDir, normalizePath, selectedPaths, lastClickedIndex, openFileInTab, clearSelection, workspaceLocked = false, onReveal = () => {} }) {
  const treePath = Vue.ref('');
  const treeRootPath = Vue.ref('');
  const treeNodes = Vue.reactive({});
  const latestDirectoryRequestIds = new Map();
  let directoryRequestSequence = 0;
  const navigationPath = Vue.ref('');
  let revealSequence = 0;
  let pendingReveal = null;

  const cancelReveal = () => {
    revealSequence += 1;
    pendingReveal = null;
  };
  const canNavigateTo = path => !workspaceLocked
    || isPathWithinDirectory(normalizePath(path), normalizePath(getEffectiveWorkDir()));

  // Only request the next ancestor after its parent has accepted a listing.
  // Otherwise the existing membership fence rightly discards unseen children.
  const advanceReveal = () => {
    const reveal = pendingReveal;
    if (!reveal || reveal.root !== treeRootPath.value) return;
    const directories = directoryBreadcrumbs(reveal.type === 'directory'
      ? reveal.path : parentDirectory(reveal.path))
      .map(crumb => normalizePath(crumb.path))
      .filter(path => isPathWithinDirectory(path, reveal.root));
    for (let index = 0; index < directories.length; index += 1) {
      const path = directories[index];
      if (index > 0 && !treeNodes[directories[index - 1]]?.entries.some(entry => (
        entry.type === 'directory' && entry.path === path
      ))) {
        pendingReveal = null;
        return;
      }
      const node = treeNodes[path];
      if (node?.error) { pendingReveal = null; return; }
      if (node) node.expanded = true;
      if (node?.loading) return;
      if (!node?.loaded) { loadTreeDirectory(path); return; }
    }
    if (reveal.type === 'file' && !treeNodes[directories.at(-1)]?.entries.some(entry => (
      entry.type === 'file' && entry.path === reveal.path
    ))) {
      pendingReveal = null;
      return;
    }
    navigationPath.value = reveal.path;
    pendingReveal = null;
    Vue.nextTick(() => {
      if (reveal.id === revealSequence && navigationPath.value === reveal.path) onReveal(reveal.path);
    });
  };

  const revealPath = (path, type = 'file') => {
    cancelReveal();
    navigationPath.value = '';
    const target = normalizePath(path);
    if (!target || !canNavigateTo(target)) return false;
    clearSelection();
    if (!isPathWithinDirectory(target, treeRootPath.value)) {
      treePath.value = type === 'directory' ? target : parentDirectory(target);
      loadRootDirectory();
    }
    if (!treeRootPath.value) return false;
    const directories = directoryBreadcrumbs(type === 'directory' ? target : parentDirectory(target));
    // A fresh user intent may retry an earlier error once; the response never loops.
    for (const crumb of directories) {
      const node = treeNodes[normalizePath(crumb.path)];
      if (node?.error) { node.error = null; node.loaded = false; }
    }
    pendingReveal = { id: revealSequence, path: target, type, root: treeRootPath.value };
    advanceReveal();
    return true;
  };

  const nextDirectoryRequestId = (dirPath) => {
    const requestId = `files-tree-${++directoryRequestSequence}`;
    latestDirectoryRequestIds.set(dirPath, requestId);
    return requestId;
  };

  // VS Code style header state
  const editingTreePath = Vue.ref(false);
  const treePathInputRef = Vue.ref(null);

  const rootFolderName = Vue.computed(() => {
    if (!treeRootPath.value) return 'EXPLORER';
    return (directoryBreadcrumbs(treeRootPath.value).at(-1)?.label || treeRootPath.value).toUpperCase();
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
    if (!canNavigateTo(nDir)) return;
    if (!treeNodes[nDir]) {
      treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: true };
    } else {
      treeNodes[nDir].loading = true;
    }
    treeNodes[nDir].error = null;
    const sent = store.sendWsMessage({
      type: 'list_directory',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      requestId: nextDirectoryRequestId(nDir),
      dirPath: dirPath,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
    if (sent === false) {
      latestDirectoryRequestIds.delete(nDir);
      treeNodes[nDir].loading = false;
      treeNodes[nDir].error = 'send_failed';
      advanceReveal();
    }
  };

  const loadRootDirectory = () => {
    const dir = treePath.value.trim();
    if (!dir || !canNavigateTo(dir)) return;
    cancelReveal();
    navigationPath.value = '';
    clearSelection();
    treeRootPath.value = normalizePath(dir);
    Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
    latestDirectoryRequestIds.clear();
    loadTreeDirectory(dir);
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
      cancelReveal();
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

    cancelReveal();
    navigationPath.value = entry.path;
    if (entry.type === 'directory') {
      toggleDirectory(entry.path);
    } else {
      openFileInTab(entry.path, entry.name);
    }
    lastClickedIndex.value = clickedIndex;
  };

  const removeTreeSubtree = (dirPath) => {
    const prefix = `${dirPath.replace(/\/$/, '')}/`;
    if (navigationPath.value === dirPath || navigationPath.value.startsWith(prefix)) navigationPath.value = '';
    for (const path of Object.keys(treeNodes)) {
      if (path === dirPath || path.startsWith(prefix)) delete treeNodes[path];
    }
    for (const path of latestDirectoryRequestIds.keys()) {
      if (path === dirPath || path.startsWith(prefix)) latestDirectoryRequestIds.delete(path);
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
    const latestRequestId = latestDirectoryRequestIds.get(nDirPath);
    // The Agent echoes requestId. Once this client has issued a request for a
    // path, only its latest response may mutate that node. This also fences an
    // old ENOENT after the same directory has been recreated and refreshed.
    if ((latestRequestId && msg.requestId !== latestRequestId)
      || (!latestRequestId && msg.requestId)) return;
    if (latestRequestId) latestDirectoryRequestIds.delete(nDirPath);

    // A parent refresh may remove an expanded directory while its own listing
    // is still in flight. Ignore that late response instead of resurrecting an
    // invisible stale node that would be requested again on the next refresh.
    if (!isDirectoryInCurrentTree(nDirPath)) {
      removeTreeSubtree(nDirPath);
      return;
    }
    if (msg.error) {
      if (isMissingDirectoryError(msg.error)) {
        if (nDirPath === treeRootPath.value) {
          for (const entry of treeNodes[nDirPath]?.entries || []) {
            if (entry.type === 'directory') removeTreeSubtree(entry.path);
          }
          if (treeNodes[nDirPath]) {
            navigationPath.value = '';
            treeNodes[nDirPath].entries = [];
            treeNodes[nDirPath].loaded = true;
            treeNodes[nDirPath].loading = false;
          }
        } else {
          removeTreeSubtree(nDirPath);
        }
      } else if (treeNodes[nDirPath]) {
        treeNodes[nDirPath].loading = false;
      }
      if (treeNodes[nDirPath]) treeNodes[nDirPath].error = msg.error;
      advanceReveal();
      return;
    }
    const entries = (msg.entries || []).sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
    const enriched = entries.map(e => ({
      ...e,
      path: normalizePath(childDirectory(nDirPath, e.name))
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
      treeNodes[nDirPath].error = null;
    }

    if (nDirPath === treeRootPath.value) {
      treePath.value = msg.dirPath;
    }
    advanceReveal();
  };

  const clearTreeNodes = () => {
    cancelReveal();
    navigationPath.value = '';
    Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
    latestDirectoryRequestIds.clear();
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
    treePath, treeRootPath, treeNodes, flattenedTree, navigationPath, revealPath, cancelReveal, canNavigateTo,
    editingTreePath, treePathInputRef, rootFolderName,
    startTreePathEdit, confirmTreePath, cancelTreePathEdit,
    loadTreeDirectory, loadRootDirectory, toggleDirectory, onTreeItemClick,
    handleDirectoryListing, clearTreeNodes, initFileBrowser, refresh
  };
}
