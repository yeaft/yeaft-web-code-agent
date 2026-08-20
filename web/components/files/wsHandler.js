/**
 * wsHandler — WebSocket message handler composable for FilesTab.
 * Centralizes all workbench-message handling in one place.
 */
import { getFileType, isMarkdownFile } from './fileEditor.js';
import { isWorkbenchMessageForRoute, workbenchMessageScope } from '../../utils/workbench-route.js';

export function createWsHandler({
  store, normalizePath, getEffectiveWorkDir,
  // File tabs
  openFiles, activeFileIndex, activeFile, fileLoading, fileSaving,
  saveTabsState, createEditor, openFileInTab,
  // Tree
  tree, setTreeVisible,
  // Folder picker
  fp,
  // Quick open
  qo,
  // File operations
  ops,
  // Preview
  mdPreviewMode, renderOfficeLocal, editorContainer, debugStatus,
  routeKey = '',
  workspaceGeneration = '',
}) {
  const pendingRevealLines = new Map();

  const revealLine = (file, line) => {
    if (!file || !Number.isFinite(line) || line <= 0) return;
    const targetLine = Math.max(0, Math.floor(line) - 1);
    const run = () => {
      const cm = file.cmInstance;
      if (!cm) return false;
      cm.setCursor({ line: targetLine, ch: 0 });
      cm.scrollIntoView({ line: targetLine, ch: 0 }, 80);
      cm.focus();
      return true;
    };
    Vue.nextTick(() => {
      if (!run()) setTimeout(run, 180);
    });
  };

  const handleWorkbenchMessage = (event) => {
    const msg = event.detail;
    if (!msg || !isWorkbenchMessageForRoute(msg, routeKey, workspaceGeneration)) return;
    const messageScope = workbenchMessageScope(msg, routeKey);

    switch (msg.type) {
      case 'directory_listing': {
        if (messageScope === 'files-folder-picker') {
          fp.handleFolderPickerListing(msg);
          return;
        }
        if (routeKey && messageScope !== 'main') return;
        tree.handleDirectoryListing(msg);
        break;
      }
      case 'file_content': {
        const nFilePath = normalizePath(msg.requestedFilePath || msg.filePath);
        const pendingDownload = ops.getPendingDownload();
        const isPendingDownload = pendingDownload
          && normalizePath(pendingDownload.path || pendingDownload) === nFilePath
          && (!pendingDownload.requestId || pendingDownload.requestId === msg.requestId);
        const responseTab = openFiles.value.find(f => f.path === nFilePath
          && (!f.agentId || !msg.agentId || f.agentId === msg.agentId)
          && (!f.conversationId || !msg.conversationId || f.conversationId === msg.conversationId));
        if (!isPendingDownload
            && (!responseTab || (responseTab.requestId && msg.requestId && msg.requestId !== responseTab.requestId))) return;
        if (responseTab) fileLoading.value = false;
        if (msg.error) {
          debugStatus.value = `Error: ${msg.error}`;
          if (isPendingDownload) ops.clearPendingDownload();
          if (responseTab) {
            responseTab.previewLoading = false;
            responseTab.previewError = msg.error;
          }
          return;
        }

        // A download request deliberately has no editor tab. Handle it before
        // tab matching so right-click Download works for unopened files too.
        if (isPendingDownload) {
          ops.clearPendingDownload();
          try {
            if (msg.binary) {
              const dlUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
              const a = document.createElement('a');
              a.href = dlUrl; a.download = nFilePath.split('/').pop() || 'download';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
            } else {
              const blob = new Blob([msg.content || ''], { type: 'application/octet-stream' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = nFilePath.split('/').pop() || 'download';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }
          } catch (e) { console.error('Download failed:', e); }
          return;
        }

        const tabIndex = openFiles.value.indexOf(responseTab);
        if (tabIndex >= 0) {
          const file = responseTab;
          if (msg.binary) {
            file.previewLoading = false;
            const previewBaseUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
            const ft = file.fileType || getFileType(file.name);
            file.fileType = ft;
            if (ft === 'pdf' || ft === 'image') {
              fetch(previewBaseUrl).then(r => r.blob()).then(blob => { file.blobUrl = URL.createObjectURL(blob); })
                .catch(e => { file.previewError = e.message; });
            } else if (ft === 'office') {
              const mode = localStorage.getItem('officePreviewMode') || 'local';
              if (mode === 'online') {
                file.previewUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewBaseUrl);
              } else {
                fetch(previewBaseUrl).then(r => r.arrayBuffer()).then(buf => {
                  file._arrayBuffer = buf; file.localPreviewReady = true;
                  if (tabIndex === activeFileIndex.value) Vue.nextTick(() => renderOfficeLocal(file));
                }).catch(e => { file.previewError = e.message; });
              }
            }
            saveTabsState(store.currentConversation);
            return;
          }
          file.content = msg.content || '';
          file.originalContent = msg.content || '';
          file.isDirty = false;
          saveTabsState(store.currentConversation);
          if (tabIndex === activeFileIndex.value) {
            if (isMarkdownFile(file.name) && mdPreviewMode.value) {
              // mdRenderedHtml computed updates automatically
            } else {
              Vue.nextTick(() => { setTimeout(() => createEditor(file), 100); });
            }
            const revealLineNumber = pendingRevealLines.get(nFilePath);
            pendingRevealLines.delete(nFilePath);
            revealLine(file, revealLineNumber);
          }
        }
        break;
      }
      case 'file_saved': {
        const nSavedPath = normalizePath(msg.requestedFilePath || msg.filePath);
        const savedFile = openFiles.value.find(f => f.path === nSavedPath
          && (!f.agentId || !msg.agentId || f.agentId === msg.agentId)
          && (!f.conversationId || !msg.conversationId || f.conversationId === msg.conversationId));
        if (!savedFile?.pendingSaveRequestId) return;
        // New Agents echo requestId. Old Agents do not, so accept a missing id
        // only for a real pending save after owner + path selected the tab.
        if (msg.requestId && msg.requestId !== savedFile.pendingSaveRequestId) return;
        fileSaving.value = false;
        const savedContent = savedFile.pendingSaveContent;
        delete savedFile.pendingSaveRequestId;
        delete savedFile.pendingSaveContent;
        if (msg.error) { console.error('File save failed:', msg.error); return; }
        savedFile.originalContent = savedContent ?? savedFile.content;
        savedFile.isDirty = savedFile.content !== savedFile.originalContent;
        saveTabsState(savedFile.conversationId || store.currentConversation);
        break;
      }
      case 'file_search_result': {
        qo.handleFileSearchResult(msg);
        break;
      }
      case 'file_op_result': {
        ops.handleFileOpResult(msg, tree.loadTreeDirectory, tree.treeRootPath.value);
        break;
      }
      case 'file_tabs_restored': {
        if (msg.openFiles?.length > 0 && openFiles.value.length === 0) {
          const pendingRestoreIndex = msg.activeIndex || 0;
          const totalFiles = msg.openFiles.length;
          for (const file of msg.openFiles) {
            const nPath = normalizePath(file.path);
            const name = nPath.split('/').pop();
            const fileType = getFileType(name);
            openFiles.value.push({
              path: nPath, name, content: null, originalContent: null,
              isDirty: false, cmInstance: null, fileType,
              blobUrl: null, previewUrl: null,
              previewLoading: fileType !== 'text', localPreviewReady: false, previewError: null
            });
            store.sendWsMessage({
              type: 'read_file',
              conversationId: store.currentConversation || '_explorer',
              agentId: store.currentAgent,
              filePath: file.path
            });
          }
          activeFileIndex.value = (pendingRestoreIndex >= 0 && pendingRestoreIndex < totalFiles)
            ? pendingRestoreIndex : 0;
        }
        break;
      }
    }
  };

  const handleOpenFile = (event) => {
    const {
      filePath: path,
      agentId = store.currentAgent,
      conversationId = store.currentConversation,
      workDir = getEffectiveWorkDir(),
      workbenchRouteKey = routeKey,
      hideTree = false,
      line = null,
    } = event.detail || {};
    const nPath = normalizePath(path);
    if (!nPath || !agentId || !conversationId || (routeKey && workbenchRouteKey !== routeKey)) return;
    if (hideTree && typeof setTreeVisible === 'function') setTreeVisible(false);
    if (Number.isFinite(line) && line > 0) pendingRevealLines.set(nPath, line);
    openFileInTab(nPath, nPath.split('/').pop(), { agentId, conversationId, workDir });
    revealLine(activeFile.value, line);
  };

  return {
    handleWorkbenchMessage,
    handleOpenFile
  };
}
