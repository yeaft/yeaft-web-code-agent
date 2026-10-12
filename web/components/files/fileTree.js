/**
 * fileTree — File tree composable for FilesTab.
 * Manages directory tree state, loading, expanding/collapsing, item clicks.
 */

import { browserPathKey, childDirectory, directoryBreadcrumbs, isPathWithinDirectory, parentDirectory } from '../../utils/folder-picker-path.js';

export function createFileTree(store, { getEffectiveWorkDir, normalizePath, selectedPaths, lastClickedIndex, openFileInTab, clearSelection, workspaceLocked = false, onReveal = () => {} }) {
  const treePath = Vue.ref('');
  const treeRootPath = Vue.ref('');
  const treeNodes = Vue.reactive({});
  // Identity keys fold Windows casing; node/entry paths retain spelling for IO
  // and display. POSIX names (including backslashes) remain case-sensitive.
  const pathKey = path => browserPathKey(normalizePath(path));
  const samePath = (left, right) => pathKey(left) === pathKey(right);
  const getTreeNode = path => treeNodes[pathKey(path)];
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
    if (!reveal || !samePath(reveal.root, treeRootPath.value)) return;
    const directories = directoryBreadcrumbs(reveal.type === 'directory'
      ? reveal.path : parentDirectory(reveal.path))
      .map(crumb => normalizePath(crumb.path))
      .filter(path => isPathWithinDirectory(path, reveal.root));
    let directoryPath = treeRootPath.value;
    for (let index = 0; index < directories.length; index += 1) {
      if (index > 0) {
        const entry = getTreeNode(directoryPath)?.entries.find(entry => (
          entry.type === 'directory' && samePath(entry.path, directories[index])
        ));
        if (!entry) { pendingReveal = null; return; }
        directoryPath = entry.path;
      }
      const node = getTreeNode(directoryPath);
      if (node?.error) { pendingReveal = null; return; }
      if (node) node.expanded = true;
      if (node?.loading) return;
      if (!node?.loaded) { loadTreeDirectory(directoryPath); return; }
    }
    let revealedPath = directoryPath;
    if (reveal.type === 'file') {
      const entry = getTreeNode(directoryPath)?.entries.find(entry => (
        entry.type === 'file' && samePath(entry.path, reveal.path)
      ));
      if (!entry) { pendingReveal = null; return; }
      revealedPath = entry.path;
    }
    navigationPath.value = revealedPath;
    pendingReveal = null;
    Vue.nextTick(() => {
      if (reveal.id === revealSequence && samePath(navigationPath.value, revealedPath)) onReveal(revealedPath);
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
      const node = getTreeNode(crumb.path);
      if (node?.error) { node.error = null; node.loaded = false; }
    }
    pendingReveal = { id: revealSequence, path: target, type, root: treeRootPath.value };
    advanceReveal();
    return true;
  };

  const nextDirectoryRequestId = (dirPath) => {
    const requestId = `files-tree-${++directoryRequestSequence}`;
    latestDirectoryRequestIds.set(pathKey(dirPath), requestId);
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
      const node = getTreeNode(dirPath);
      if (!node || !node.entries) return;
      for (const entry of node.entries) {
        result.push({ ...entry, depth });
        if (entry.type === 'directory' && getTreeNode(entry.path)?.expanded) {
          walk(entry.path, depth + 1);
        }
      }
    };
    if (treeRootPath.value && getTreeNode(treeRootPath.value)?.expanded) {
      walk(treeRootPath.value, 0);
    }
    return result;
  });

  const loadTreeDirectory = (dirPath) => {
    const nDir = pathKey(dirPath);
    if (!canNavigateTo(nDir)) return;
    if (!treeNodes[nDir]) {
      treeNodes[nDir] = { path: normalizePath(dirPath), entries: [], expanded: true, loaded: false, loading: true };
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
    const nDir = pathKey(dirPath);
    const node = treeNodes[nDir];
    if (node) {
      if (node.loaded) {
        node.expanded = !node.expanded;
      } else {
        node.expanded = true;
        loadTreeDirectory(dirPath);
      }
    } else {
      treeNodes[nDir] = { path: normalizePath(dirPath), entries: [], expanded: true, loaded: false, loading: false };
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
    const key = pathKey(dirPath);
    if (isPathWithinDirectory(pathKey(navigationPath.value), key)) navigationPath.value = '';
    for (const path of Object.keys(treeNodes)) {
      if (isPathWithinDirectory(path, key)) delete treeNodes[path];
    }
    for (const path of latestDirectoryRequestIds.keys()) {
      if (isPathWithinDirectory(path, key)) latestDirectoryRequestIds.delete(path);
    }
    for (const node of Object.values(treeNodes)) {
      if (node?.entries) node.entries = node.entries.filter(entry => !samePath(entry.path, dirPath));
    }
  };

  const isMissingDirectoryError = (error) => (
    typeof error === 'string' && /(?:ENOENT|not\s+(?:exist|found)|no such file)/i.test(error)
  );

  const isDirectoryInCurrentTree = (dirPath) => {
    if (samePath(dirPath, treeRootPath.value)) return true;
    return Object.values(treeNodes).some(node => node?.entries?.some(entry => (
      entry.type === 'directory' && samePath(entry.path, dirPath)
    )));
  };

  const handleDirectoryListing = (msg) => {
    const nDirPath = pathKey(msg.dirPath);
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
        if (samePath(nDirPath, treeRootPath.value)) {
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
    const directoryPath = treeNodes[nDirPath]?.path
      || (samePath(nDirPath, treeRootPath.value) ? treeRootPath.value : normalizePath(msg.dirPath));
    const enriched = entries.map(e => ({
      ...e,
      path: normalizePath(childDirectory(directoryPath, e.name))
    }));

    const nextDirectoryPaths = new Set(
      enriched.filter(entry => entry.type === 'directory').map(entry => pathKey(entry.path)),
    );
    for (const previousEntry of treeNodes[nDirPath]?.entries || []) {
      if (previousEntry.type === 'directory' && !nextDirectoryPaths.has(pathKey(previousEntry.path))) {
        removeTreeSubtree(previousEntry.path);
      }
    }

    if (!treeNodes[nDirPath]) {
      treeNodes[nDirPath] = { path: directoryPath, entries: enriched, expanded: true, loaded: true, loading: false };
    } else {
      treeNodes[nDirPath].entries = enriched;
      treeNodes[nDirPath].loaded = true;
      treeNodes[nDirPath].loading = false;
      treeNodes[nDirPath].error = null;
    }

    if (samePath(nDirPath, treeRootPath.value)) {
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
    const expandedPaths = Object.values(treeNodes)
      .filter(node => node?.expanded)
      .map(node => node.path);
    if (!expandedPaths.some(path => samePath(path, treeRootPath.value))) {
      expandedPaths.unshift(treeRootPath.value);
    }
    for (const path of expandedPaths) {
      loadTreeDirectory(path);
    }
  };

  return {
    treePath, treeRootPath, treeNodes, getTreeNode, samePath, flattenedTree, navigationPath, revealPath, cancelReveal, canNavigateTo,
    editingTreePath, treePathInputRef, rootFolderName,
    startTreePathEdit, confirmTreePath, cancelTreePathEdit,
    loadTreeDirectory, loadRootDirectory, toggleDirectory, onTreeItemClick,
    handleDirectoryListing, clearTreeNodes, initFileBrowser, refresh
  };
}
