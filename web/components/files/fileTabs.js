import { confirmDialog } from '../../utils/dialog.js';
/**
 * fileTabs — Tab management composable for FilesTab.
 * Manages open files, active tab, switching, closing, saving, tab state persistence.
 */
import { getFileType, isMarkdownFile } from './fileEditor.js';

export function createFileTabs(store, {
  normalizePath, getEffectiveWorkDir,
  editorContainer, createEditor, destroyEditor,
  clearFindMarkers, saveCurrentUndoHistory, saveAllUndoHistory,
  cleanupUndoHistory, deleteConversationHistory,
  mdPreviewMode, renderOfficeLocal,
  performFind, findBarVisible, findQuery, t
}) {
  const fileTabsMap = Vue.reactive({});
  const openFiles = Vue.ref([]);
  const activeFileIndex = Vue.ref(-1);
  const fileSaving = Vue.ref(false);
  const tabRevision = Vue.ref(0);
  const bumpTabRevision = () => { tabRevision.value += 1; };
  let restoreRequestSequence = 0;
  let pendingRestoreRequest = null;

  const beginTabsRestoreRequest = () => {
    const requestId = `file-tabs-${Date.now()}-${++restoreRequestSequence}`;
    pendingRestoreRequest = { requestId, tabRevision: tabRevision.value };
    return requestId;
  };

  const acceptTabsRestoreRequest = (requestId) => {
    const pending = pendingRestoreRequest;
    if (!pending || requestId !== pending.requestId) return false;
    pendingRestoreRequest = null;
    return tabRevision.value === pending.tabRevision;
  };

  const activeFile = Vue.computed(() => {
    if (activeFileIndex.value >= 0 && activeFileIndex.value < openFiles.value.length) {
      return openFiles.value[activeFileIndex.value];
    }
    return null;
  });
  const fileLoading = Vue.computed(() => !!activeFile.value?.loading);

  let _syncTabsTimer = null;
  const syncFileTabsToServer = () => {
    if (_syncTabsTimer) clearTimeout(_syncTabsTimer);
    _syncTabsTimer = setTimeout(() => {
      store.sendWsMessage({
        type: 'update_file_tabs',
        openFiles: openFiles.value.map(f => ({ path: f.path })),
        activeIndex: activeFileIndex.value
      });
    }, 500);
  };

  const saveTabsState = (convId) => {
    if (!convId) return;
    saveAllUndoHistory(convId);
    if (openFiles.value.length > 0) {
      fileTabsMap[convId] = {
        files: openFiles.value.map(f => ({
          path: f.path, name: f.name, content: f.content,
          originalContent: f.originalContent, isDirty: f.isDirty,
          fileType: f.fileType, agentId: f.agentId,
          conversationId: f.conversationId, workDir: f.workDir
        })),
        activeIndex: activeFileIndex.value
      };
    } else {
      delete fileTabsMap[convId];
    }
    syncFileTabsToServer();
  };

  const restoreTabsState = (convId) => {
    destroyEditor();
    if (!convId || !fileTabsMap[convId]) {
      if (openFiles.value.length > 0) bumpTabRevision();
      openFiles.value = [];
      activeFileIndex.value = -1;
      return;
    }
    const saved = fileTabsMap[convId];
    openFiles.value = saved.files.map(f => ({
      ...f,
      isDirty: f.isDirty || false,
      originalContent: f.originalContent || f.content,
      cmInstance: null,
      fileType: f.fileType || getFileType(f.name || ''),
      blobUrl: null, previewUrl: null, previewLoading: false,
      localPreviewReady: false, previewError: null,
      loading: false, loadError: null
    }));
    bumpTabRevision();
    activeFileIndex.value = saved.activeIndex;
    Vue.nextTick(() => {
      const file = activeFile.value;
      if (file && (!file.fileType || file.fileType === 'text') && editorContainer.value) {
        createEditor(file);
      }
    });
  };

  function openFileInTab(fullPath, name, route = {}) {
    const nPath = normalizePath(fullPath);
    const agentId = route.agentId || store.currentAgent || null;
    const conversationId = route.conversationId || store.currentConversation || '_explorer';
    const workDir = route.workDir || getEffectiveWorkDir();
    const existingIndex = openFiles.value.findIndex(f => f.path === nPath
      && (!f.agentId || f.agentId === agentId)
      && (!f.conversationId || f.conversationId === conversationId));
    if (existingIndex >= 0) {
      if (activeFileIndex.value !== existingIndex) {
        clearFindMarkers();
        saveCurrentUndoHistory();
        activeFileIndex.value = existingIndex;
        Vue.nextTick(() => {
          const file = openFiles.value[existingIndex];
          if (file && file.content != null && (!file.fileType || file.fileType === 'text')) createEditor(file);
        });
      }
      saveTabsState(store.currentConversation);
      return;
    }

    saveCurrentUndoHistory();
    const displayName = name || nPath.split(/[/\\]/).pop();
    const fileType = getFileType(displayName);
    openFiles.value.push({
      path: nPath, name: displayName, agentId, conversationId, workDir,
      content: null, originalContent: null,
      isDirty: false, cmInstance: null, fileType,
      blobUrl: null, previewUrl: null,
      previewLoading: fileType !== 'text', localPreviewReady: false, previewError: null,
      loading: true, loadError: null
    });
    bumpTabRevision();
    activeFileIndex.value = openFiles.value.length - 1;
    if (fileType === 'text') destroyEditor();
    saveTabsState(store.currentConversation);

    const requestId = route.requestId || `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const openedFile = openFiles.value[activeFileIndex.value];
    if (openedFile) openedFile.requestId = requestId;
    store.sendWsMessage({
      type: fileType === 'video' ? 'video_metadata' : 'read_file',
      conversationId,
      agentId,
      requestId,
      filePath: fullPath,
      workDir,
      _clientId: store.clientId
    });
  }

  const switchToTab = (index) => {
    if (index === activeFileIndex.value) return;
    clearFindMarkers();
    saveCurrentUndoHistory();
    activeFileIndex.value = index;
    saveTabsState(store.currentConversation);

    Vue.nextTick(() => {
      const file = openFiles.value[index];
      if (!file) return;
      if (!file.fileType || file.fileType === 'text') {
        if (isMarkdownFile(file.name)) {
          mdPreviewMode.value = true;
        } else if (file.content != null && editorContainer.value) {
          createEditor(file);
          if (findBarVisible.value && findQuery.value) {
            Vue.nextTick(() => performFind());
          }
        }
      } else if (file.fileType === 'office' && file.localPreviewReady) {
        Vue.nextTick(() => renderOfficeLocal(file));
      }
    });
  };

  const closeFileTabs = async (indices, { canCommit = () => true } = {}) => {
    const requested = [...new Set(indices)]
      .filter(index => Number.isInteger(index) && index >= 0 && index < openFiles.value.length)
      .sort((a, b) => a - b);
    if (requested.length === 0) return false;

    const filesToClose = requested.map(index => openFiles.value[index]);
    const requestedRevision = tabRevision.value;
    const dirtyFiles = filesToClose.filter(file => file?.isDirty);
    if (dirtyFiles.length > 0) {
      const message = dirtyFiles.length === 1
        ? t('files.unsavedConfirm', { name: dirtyFiles[0].name })
        : t('files.unsavedBatchConfirm', { count: dirtyFiles.length });
      if (!await confirmDialog(message, { destructive: true })) return false;
    }
    if (tabRevision.value !== requestedRevision || !canCommit()) return false;
    if (filesToClose.some(file => !openFiles.value.includes(file))) return false;

    const previousActiveFile = activeFile.value;
    let nextActiveFile = previousActiveFile;
    if (filesToClose.includes(previousActiveFile)) {
      const previousActiveIndex = openFiles.value.indexOf(previousActiveFile);
      nextActiveFile = openFiles.value.slice(previousActiveIndex + 1)
        .find(file => !filesToClose.includes(file))
        || openFiles.value.slice(0, previousActiveIndex).reverse()
          .find(file => !filesToClose.includes(file))
        || null;
    }

    for (const file of filesToClose) {
      cleanupUndoHistory(file.conversationId || store.currentConversation, file.path);
      if (file.blobUrl?.startsWith?.('blob:')) URL.revokeObjectURL(file.blobUrl);
    }
    for (const file of filesToClose) {
      const currentIndex = openFiles.value.indexOf(file);
      if (currentIndex >= 0) openFiles.value.splice(currentIndex, 1);
    }
    bumpTabRevision();

    if (openFiles.value.length === 0) {
      activeFileIndex.value = -1;
      destroyEditor();
    } else {
      activeFileIndex.value = Math.max(0, openFiles.value.indexOf(nextActiveFile));
    }

    saveTabsState(store.currentConversation);

    if (previousActiveFile !== activeFile.value && activeFile.value) {
      Vue.nextTick(() => {
        const newActive = activeFile.value;
        if (newActive && (!newActive.fileType || newActive.fileType === 'text') && newActive.content != null && editorContainer.value) {
          createEditor(newActive);
        }
      });
    }
    return true;
  };

  const closeFileTab = (index, options) => closeFileTabs([index], options);
  const closeTabsToLeft = (index, options) => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex < index), options);
  const closeTabsToRight = (index, options) => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex > index), options);
  const closeOtherTabs = (index, options) => closeFileTabs(openFiles.value.map((_, tabIndex) => tabIndex).filter(tabIndex => tabIndex !== index), options);
  const closeAllTabs = options => closeFileTabs(openFiles.value.map((_, index) => index), options);

  function saveFile() {
    const file = activeFile.value;
    if (!file || !file.isDirty || file.pendingSaveRequestId) return;
    fileSaving.value = true;
    const requestId = `file-save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    file.pendingSaveRequestId = requestId;
    file.pendingSaveContent = file.content;
    store.sendWsMessage({
      type: 'write_file',
      conversationId: file.conversationId || store.currentConversation || '_explorer',
      agentId: file.agentId || store.currentAgent,
      requestId,
      filePath: file.path,
      content: file.content,
      workDir: file.workDir || getEffectiveWorkDir(),
      _clientId: store.clientId
    });
  }

  const handleConversationDeleted = (event) => {
    const { conversationId } = event.detail;
    if (conversationId) {
      delete fileTabsMap[conversationId];
      deleteConversationHistory(conversationId);
    }
  };

  return {
    fileTabsMap, openFiles, activeFileIndex, activeFile,
    fileLoading, fileSaving, tabRevision, bumpTabRevision,
    beginTabsRestoreRequest, acceptTabsRestoreRequest,
    saveTabsState, restoreTabsState, openFileInTab,
    switchToTab, closeFileTab, closeFileTabs,
    closeTabsToLeft, closeTabsToRight, closeOtherTabs, closeAllTabs,
    saveFile,
    handleConversationDeleted
  };
}
