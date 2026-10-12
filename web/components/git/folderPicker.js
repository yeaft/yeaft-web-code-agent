/**
 * folderPicker — folder picker composable for GitStatusTab.
 */

export function createFolderPicker(store, effectiveGitWorkDir) {
  const folderPickerOpen = Vue.ref(false);
  const folderPickerPath = Vue.ref('');
  const folderPickerEntries = Vue.ref([]);
  const folderPickerLoading = Vue.ref(false);
  const folderPickerError = Vue.ref('');
  const folderPickerSelected = Vue.ref('');

  const loadFolderPickerDir = (dirPath) => {
    folderPickerLoading.value = true;
    folderPickerError.value = '';
    folderPickerSelected.value = '';
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: '_git_folder_picker',
      agentId: store.currentAgent,
      dirPath: dirPath,
      workDir: effectiveGitWorkDir.value,
      _clientId: store.clientId
    });
  };

  const openFolderPicker = () => {
    folderPickerOpen.value = true;
    folderPickerSelected.value = '';
    folderPickerLoading.value = true;
    folderPickerError.value = '';
    const defaultDir = effectiveGitWorkDir.value || '';
    folderPickerPath.value = defaultDir;
    folderPickerEntries.value = [];
    store.sendWsMessage({
      type: 'list_directory',
      conversationId: '_git_folder_picker',
      agentId: store.currentAgent,
      dirPath: defaultDir,
      workDir: effectiveGitWorkDir.value,
      _clientId: store.clientId
    });
  };

  const folderPickerNavigateUp = () => {
    if (!folderPickerPath.value) return;
    const isWin = folderPickerPath.value.includes('\\');
    const sep = isWin ? '\\' : '/';
    const parts = folderPickerPath.value.replace(/[/\\]$/, '').split(/[/\\]/);
    parts.pop();
    if (parts.length === 0) {
      folderPickerPath.value = '';
      loadFolderPickerDir('');
    } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
      folderPickerPath.value = parts[0] + '\\';
      loadFolderPickerDir(parts[0] + '\\');
    } else {
      const parent = parts.join(sep);
      folderPickerPath.value = parent;
      loadFolderPickerDir(parent);
    }
  };

  const folderPickerSelectItem = (entry) => {
    folderPickerSelected.value = entry.name;
  };

  const folderPickerEnter = (entry) => {
    const sep = folderPickerPath.value.includes('\\') || /^[A-Z]:/.test(entry.name) ? '\\' : '/';
    let newPath;
    if (!folderPickerPath.value) {
      newPath = entry.name + (entry.name.endsWith('\\') ? '' : '\\');
    } else {
      newPath = folderPickerPath.value.replace(/[/\\]$/, '') + sep + entry.name;
    }
    folderPickerPath.value = newPath;
    loadFolderPickerDir(newPath);
  };

  const confirmFolderPicker = (gitWorkDir, loadGitStatus) => {
    let path = folderPickerPath.value;
    if (!path || folderPickerLoading.value || folderPickerError.value) return;
    if (folderPickerSelected.value) {
      const sep = path.includes('\\') ? '\\' : '/';
      path = path.replace(/[/\\]$/, '') + sep + folderPickerSelected.value;
    }
    gitWorkDir.value = path;
    folderPickerOpen.value = false;
    loadGitStatus();
  };

  const handleDirectoryListing = (msg) => {
    if (msg.conversationId !== '_git_folder_picker') return false;
    folderPickerLoading.value = false;
    folderPickerError.value = msg.error || '';
    if (folderPickerError.value) {
      folderPickerEntries.value = [];
      folderPickerSelected.value = '';
      return true;
    }
    folderPickerEntries.value = (msg.entries || [])
      .filter(e => e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (msg.dirPath != null) folderPickerPath.value = msg.dirPath;
    return true;
  };

  return {
    folderPickerOpen, folderPickerPath, folderPickerEntries,
    folderPickerLoading, folderPickerError, folderPickerSelected,
    openFolderPicker, loadFolderPickerDir, folderPickerNavigateUp,
    folderPickerSelectItem, folderPickerEnter, confirmFolderPicker,
    handleDirectoryListing
  };
}
