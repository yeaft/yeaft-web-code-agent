import { childDirectory, parentDirectory } from '../../utils/folder-picker-path.js';

/**
 * folderPicker — Folder picker dialog composable for FilesTab.
 */

export function createFolderPicker(store, { getEffectiveWorkDir, treePath, treeRootPath, treeNodes, normalizePath, loadTreeDirectory }) {
  const folderPickerOpen = Vue.ref(false);
  const folderPickerPath = Vue.ref('');
  const folderPickerEntries = Vue.ref([]);
  const folderPickerLoading = Vue.ref(false);
  const folderPickerSelected = Vue.ref('');

  const openFolderPicker = () => {
    folderPickerOpen.value = true;
    folderPickerSelected.value = '';
    folderPickerLoading.value = true;
    const defaultDir = treePath.value || getEffectiveWorkDir() || '';
    folderPickerPath.value = defaultDir;
    folderPickerEntries.value = [];
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: '_folder_picker',
      agentId: store.currentAgent,
      dirPath: defaultDir,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const loadFolderPickerDir = (dirPath) => {
    folderPickerLoading.value = true;
    folderPickerSelected.value = '';
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: '_folder_picker',
      agentId: store.currentAgent,
      dirPath: dirPath,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const folderPickerNavigateUp = () => {
    if (!folderPickerPath.value) return;
    const parent = parentDirectory(folderPickerPath.value);
    folderPickerPath.value = parent;
    loadFolderPickerDir(parent);
  };

  const folderPickerSelectItem = (entry) => {
    folderPickerSelected.value = entry.name;
  };

  const folderPickerEnter = (entry) => {
    const newPath = childDirectory(folderPickerPath.value, entry.name);
    folderPickerPath.value = newPath;
    loadFolderPickerDir(newPath);
  };

  const confirmFolderPicker = () => {
    let path = folderPickerPath.value;
    if (!path) return;
    if (folderPickerSelected.value) {
      path = childDirectory(path, folderPickerSelected.value);
    }
    treePath.value = path;
    folderPickerOpen.value = false;
    const nPath = normalizePath(path);
    treeRootPath.value = nPath;
    Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
    treeNodes[nPath] = { entries: [], expanded: true, loaded: false, loading: true };
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      dirPath: path,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  // Handle directory listing for folder picker
  const handleFolderPickerListing = (msg) => {
    folderPickerLoading.value = false;
    folderPickerEntries.value = (msg.entries || [])
      .filter(e => e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (msg.dirPath != null) folderPickerPath.value = msg.dirPath;
  };

  return {
    folderPickerOpen, folderPickerPath, folderPickerEntries,
    folderPickerLoading, folderPickerSelected,
    openFolderPicker, folderPickerNavigateUp,
    folderPickerSelectItem, folderPickerEnter, confirmFolderPicker,
    handleFolderPickerListing
  };
}
