import { confirmDialog } from '../../utils/dialog.js';

/**
 * fileOperations — file CRUD operations composable for FilesTab.
 */

export function createFileOperations(store, refs) {
  const { getEffectiveWorkDir, treePath } = refs;

  const selectedPaths = Vue.reactive(new Set());
  const lastClickedIndex = Vue.ref(-1);
  const fileOperating = Vue.ref(false);
  const fileOpFeedback = Vue.ref(null);
  let fileOpFeedbackTimer = null;
  let fileOpTimer = null;

  const newFileDialogVisible = Vue.ref(false);
  const newFileName = Vue.ref('');
  const newFileType = Vue.ref('file');
  const newFileInput = Vue.ref(null);
  const moveDialogVisible = Vue.ref(false);
  const moveDestination = Vue.ref('');
  const moveDestInput = Vue.ref(null);

  const contextMenu = Vue.reactive({ visible: false, x: 0, y: 0, entry: null });
  const renameDialogVisible = Vue.ref(false);
  const renameNewName = Vue.ref('');
  const renameInput = Vue.ref(null);
  let pendingDownload = null;

  const dragState = Vue.reactive({ dragging: null, dropTarget: null });
  const externalDropActive = Vue.ref(false);

  const showFileOpFeedback = (ok, message) => {
    if (fileOpFeedbackTimer) clearTimeout(fileOpFeedbackTimer);
    fileOpFeedback.value = { ok, message };
    fileOpFeedbackTimer = setTimeout(() => { fileOpFeedback.value = null; }, 4000);
  };

  const startFileOp = () => {
    fileOperating.value = true;
    if (fileOpTimer) clearTimeout(fileOpTimer);
    fileOpTimer = setTimeout(() => {
      if (fileOperating.value) {
        fileOperating.value = false;
        showFileOpFeedback(false, 'Operation timed out');
      }
    }, 15000);
  };

  const toggleSelection = (path) => {
    if (selectedPaths.has(path)) {
      selectedPaths.delete(path);
    } else {
      selectedPaths.add(path);
    }
  };

  const clearSelection = () => {
    selectedPaths.clear();
    lastClickedIndex.value = -1;
  };

  const showNewFileDialog = (type) => {
    newFileType.value = type;
    newFileName.value = '';
    newFileDialogVisible.value = true;
    Vue.nextTick(() => newFileInput.value?.focus());
  };

  const confirmNewFile = () => {
    const name = newFileName.value.trim();
    if (!name) return;
    newFileDialogVisible.value = false;

    const basePath = treePath.value || getEffectiveWorkDir();
    if (!basePath) return;

    const sep = basePath.includes('\\') ? '\\' : '/';
    const filePath = basePath.replace(/[/\\]$/, '') + sep + name;

    startFileOp();
    store.sendWsMessage({
      type: 'create_file',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      filePath,
      isDirectory: newFileType.value === 'directory',
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const deleteSingleFile = async (entry, t) => {
    const name = entry.path.split('/').pop();
    if (!await confirmDialog(t('files.deleteConfirm', { name }) + (entry.type === 'directory' ? t('files.deleteDirHint') : ''), { destructive: true })) return;

    startFileOp();
    store.sendWsMessage({
      type: 'delete_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [entry.path],
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const deleteSelected = async (t) => {
    const count = selectedPaths.size;
    if (count === 0) return;
    if (!await confirmDialog(t('files.deleteSelectedConfirm', { count }), { destructive: true })) return;

    startFileOp();
    store.sendWsMessage({
      type: 'delete_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [...selectedPaths],
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const openMoveDialog = () => {
    moveDestination.value = treePath.value || getEffectiveWorkDir() || '';
    moveDialogVisible.value = true;
    Vue.nextTick(() => moveDestInput.value?.focus());
  };

  const confirmMove = () => {
    const dest = moveDestination.value.trim();
    if (!dest || selectedPaths.size === 0) return;
    moveDialogVisible.value = false;

    startFileOp();
    store.sendWsMessage({
      type: 'move_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [...selectedPaths],
      destination: dest,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  // Context menu
  const showContextMenu = (event, entry) => {
    const menuW = 180, menuH = 240;
    let x = event.clientX, y = event.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH;
    contextMenu.entry = entry;
    contextMenu.x = x;
    contextMenu.y = y;
    contextMenu.visible = true;
  };

  const hideContextMenu = () => { contextMenu.visible = false; };

  const ctxRename = () => {
    const entry = contextMenu.entry;
    hideContextMenu();
    if (!entry) return;
    renameNewName.value = entry.name;
    renameDialogVisible.value = true;
    Vue.nextTick(() => {
      const input = renameInput.value;
      if (input) {
        input.focus();
        if (entry.type === 'file') {
          const dotIdx = entry.name.lastIndexOf('.');
          if (dotIdx > 0) {
            input.setSelectionRange(0, dotIdx);
          } else {
            input.select();
          }
        } else {
          input.select();
        }
      }
    });
  };

  const confirmRename = () => {
    const entry = contextMenu.entry;
    const name = renameNewName.value.trim();
    if (!name || !entry || name === entry.name) {
      renameDialogVisible.value = false;
      return;
    }
    renameDialogVisible.value = false;

    const parts = entry.path.replace(/\/$/, '').split('/');
    parts.pop();
    const parentDir = parts.join('/') || '/';

    startFileOp();
    store.sendWsMessage({
      type: 'move_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [entry.path],
      destination: parentDir,
      newName: name,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const ctxCopy = () => {
    const entry = contextMenu.entry;
    hideContextMenu();
    if (!entry) return;

    const parts = entry.path.replace(/\/$/, '').split('/');
    parts.pop();
    const parentDir = parts.join('/') || '/';

    startFileOp();
    store.sendWsMessage({
      type: 'copy_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [entry.path],
      destination: parentDir,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const ctxMoveTo = () => {
    const entry = contextMenu.entry;
    hideContextMenu();
    if (!entry) return;
    selectedPaths.clear();
    selectedPaths.add(entry.path);
    openMoveDialog();
  };

  const ctxDelete = (t) => {
    const entry = contextMenu.entry;
    hideContextMenu();
    if (!entry) return;
    deleteSingleFile(entry, t);
  };

  const ctxDownload = () => {
    const entry = contextMenu.entry;
    hideContextMenu();
    if (!entry || entry.type !== 'file') return;
    const requestId = `file-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingDownload = { path: entry.path, requestId };
    store.sendWsMessage({
      type: 'read_file',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      requestId,
      filePath: entry.path,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  // Drag & Drop
  const onDragStart = (event, entry) => {
    dragState.dragging = entry;
    event.dataTransfer.setData('text/plain', entry.path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (event, entry) => {
    if (!dragState.dragging && event.dataTransfer.types.includes('Files')) {
      if (entry.type === 'directory') {
        event.dataTransfer.dropEffect = 'copy';
        dragState.dropTarget = entry.path;
      }
      return;
    }
    if (!dragState.dragging || entry.type !== 'directory') return;
    if (entry.path === dragState.dragging.path) return;
    if (entry.path.startsWith(dragState.dragging.path + '/')) return;
    event.dataTransfer.dropEffect = 'move';
    dragState.dropTarget = entry.path;
  };

  const onDragLeave = (event) => {
    const related = event.relatedTarget;
    if (related && event.currentTarget.contains(related)) return;
    dragState.dropTarget = null;
  };

  const onDrop = (event, entry, handleExternalFileDrop) => {
    dragState.dropTarget = null;

    if (!dragState.dragging && event.dataTransfer.files.length > 0 && entry.type === 'directory') {
      handleExternalFileDrop(event.dataTransfer.files, entry.path);
      return;
    }

    if (!dragState.dragging || entry.type !== 'directory') {
      dragState.dragging = null;
      return;
    }
    if (entry.path === dragState.dragging.path) {
      dragState.dragging = null;
      return;
    }

    startFileOp();
    store.sendWsMessage({
      type: 'move_files',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      paths: [dragState.dragging.path],
      destination: entry.path,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });

    dragState.dragging = null;
  };

  const onTreeDragOver = (event) => {
    if (dragState.dragging) return;
    if (event.dataTransfer.types.includes('Files')) {
      event.dataTransfer.dropEffect = 'copy';
      externalDropActive.value = true;
    }
  };

  const onTreeDragLeave = (event) => {
    const related = event.relatedTarget;
    if (related && event.currentTarget.contains(related)) return;
    externalDropActive.value = false;
  };

  const onTreeDrop = (event, treeRootPath, handleExternalFileDrop) => {
    externalDropActive.value = false;
    if (dragState.dragging) return;
    if (event.dataTransfer.files.length > 0) {
      const targetDir = treePath.value || treeRootPath || getEffectiveWorkDir();
      handleExternalFileDrop(event.dataTransfer.files, targetDir);
    }
  };

  const handleExternalFileDrop = async (fileList, targetDir) => {
    if (!targetDir) return;

    const files = [];
    const readPromises = [];

    for (const file of fileList) {
      readPromises.push(
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = btoa(
              new Uint8Array(reader.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
            files.push({ name: file.name, data: base64 });
            resolve();
          };
          reader.onerror = () => resolve();
          reader.readAsArrayBuffer(file);
        })
      );
    }

    await Promise.all(readPromises);
    if (files.length === 0) return;

    fileOperating.value = true;
    if (fileOpTimer) clearTimeout(fileOpTimer);
    fileOpTimer = setTimeout(() => {
      if (fileOperating.value) {
        fileOperating.value = false;
        showFileOpFeedback(false, 'Upload timed out');
      }
    }, 30000);

    store.sendWsMessage({
      type: 'upload_to_dir',
      conversationId: store.currentConversation || '_explorer',
      agentId: store.currentAgent,
      files,
      dirPath: targetDir,
      workDir: getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  };

  const handleFileOpResult = (msg, loadTreeDirectory, treeRootPath) => {
    fileOperating.value = false;
    if (fileOpTimer) { clearTimeout(fileOpTimer); fileOpTimer = null; }
    showFileOpFeedback(msg.success, msg.success ? msg.message : (msg.error || 'Operation failed'));
    if (msg.success) {
      if (treeRootPath) loadTreeDirectory(treeRootPath);
      if (msg.operation === 'delete' || msg.operation === 'move') {
        selectedPaths.clear();
        lastClickedIndex.value = -1;
      }
    }
  };

  const getPendingDownload = () => pendingDownload;
  const clearPendingDownload = () => { pendingDownload = null; };

  const cleanup = () => {
    if (fileOpFeedbackTimer) clearTimeout(fileOpFeedbackTimer);
    if (fileOpTimer) clearTimeout(fileOpTimer);
  };

  return {
    selectedPaths, lastClickedIndex, fileOperating, fileOpFeedback,
    newFileDialogVisible, newFileName, newFileType, newFileInput,
    moveDialogVisible, moveDestination, moveDestInput,
    contextMenu, renameDialogVisible, renameNewName, renameInput,
    dragState, externalDropActive,
    showFileOpFeedback, toggleSelection, clearSelection,
    showNewFileDialog, confirmNewFile,
    deleteSingleFile, deleteSelected,
    openMoveDialog, confirmMove,
    showContextMenu, hideContextMenu,
    ctxRename, confirmRename, ctxCopy, ctxMoveTo, ctxDelete, ctxDownload,
    onDragStart, onDragOver, onDragLeave, onDrop,
    onTreeDragOver, onTreeDragLeave, onTreeDrop, handleExternalFileDrop,
    handleFileOpResult, getPendingDownload, clearPendingDownload,
    cleanup
  };
}
