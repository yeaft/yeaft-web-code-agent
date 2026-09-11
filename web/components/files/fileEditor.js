/**
 * fileEditor — CodeMirror editor composable for FilesTab.
 * Manages editor creation/destruction, undo history, file type detection, mode mapping.
 */

// File type detection constants
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.xls', '.pptx', '.ppt']);
const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov']);
const MD_EXT = new Set(['.md', '.markdown', '.mdx']);

export function getFileType(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = name.substring(dot).toLowerCase();
  if (OFFICE_EXT.has(ext)) return 'office';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'text';
}

export function isMarkdownFile(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return MD_EXT.has(name.substring(dot).toLowerCase());
}

export function getModeForFile(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const modeMap = {
    'js': 'javascript', 'mjs': 'javascript', 'jsx': 'javascript',
    'ts': { name: 'javascript', typescript: true },
    'tsx': { name: 'javascript', typescript: true },
    'json': { name: 'javascript', json: true },
    'py': 'python',
    'html': 'htmlmixed', 'htm': 'htmlmixed', 'vue': 'htmlmixed',
    'xml': 'xml', 'svg': 'xml',
    'css': 'css', 'scss': 'css', 'less': 'css',
    'sh': 'shell', 'bash': 'shell', 'zsh': 'shell',
    'c': 'text/x-csrc', 'h': 'text/x-csrc',
    'cpp': 'text/x-c++src', 'hpp': 'text/x-c++src',
    'cs': 'text/x-csharp',
    'java': 'text/x-java',
    'md': 'markdown', 'markdown': 'markdown',
  };
  return modeMap[ext] || 'text/plain';
}

export function createFileEditor(store, {
  activeFile, editorContainer, fontSize,
  clearFindMarkers, openFindBar, saveFile
}) {
  const debugStatus = Vue.ref('');
  const undoHistoryMap = Vue.reactive({});

  // Late-bound callbacks to avoid forward references.
  // Set via setKeyBindings() after dependent composables are created.
  let _openQuickOpen = () => {};
  let _openGoToLine = () => {};

  const setKeyBindings = ({ openQuickOpen, openGoToLine }) => {
    _openQuickOpen = openQuickOpen;
    _openGoToLine = openGoToLine;
  };

  const createEditor = (fileObj, retryCount = 0) => {
    if (!editorContainer.value) {
      if (retryCount < 20) {
        setTimeout(() => createEditor(fileObj, retryCount + 1), 100);
      }
      return;
    }
    if (!fileObj) return;

    editorContainer.value.innerHTML = '';

    if (typeof CodeMirror === 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = fileObj.content || '';
      ta.style.cssText = 'width:100%;height:100%;border:none;outline:none;resize:none;padding:12px;font-family:monospace;font-size:12px;background:var(--bg-main);color:var(--text-main);white-space:pre;tab-size:4;';
      ta.spellcheck = false;
      ta.addEventListener('input', () => {
        fileObj.content = ta.value;
        fileObj.isDirty = (ta.value !== fileObj.originalContent);
      });
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
      });
      editorContainer.value.appendChild(ta);
      debugStatus.value = '';
      return;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const theme = isDark ? 'material-darker' : 'default';
    try {
      const cm = CodeMirror(editorContainer.value, {
        value: fileObj.content || '',
        mode: getModeForFile(fileObj.name),
        theme: theme,
        lineNumbers: true,
        tabSize: 4,
        indentWithTabs: false,
        lineWrapping: false,
        readOnly: false,
        extraKeys: {
          'Ctrl-S': () => saveFile(),
          'Cmd-S': () => saveFile(),
          'Ctrl-P': () => _openQuickOpen(),
          'Cmd-P': () => _openQuickOpen(),
          'Ctrl-G': () => _openGoToLine(),
          'Cmd-G': () => _openGoToLine(),
          'Ctrl-F': () => openFindBar(false),
          'Cmd-F': () => openFindBar(false),
          'Ctrl-R': () => openFindBar(true),
          'Cmd-R': () => openFindBar(true),
          'Ctrl-H': () => openFindBar(true),
          'Cmd-H': () => openFindBar(true),
        }
      });

      cm.on('change', () => {
        const current = cm.getValue();
        fileObj.content = current;
        fileObj.isDirty = (current !== fileObj.originalContent);
      });

      fileObj.cmInstance = cm;
      cm.getWrapperElement().style.fontSize = fontSize.value + 'px';

      const convId = store.currentConversation;
      if (convId && undoHistoryMap[convId]?.[fileObj.path]) {
        cm.setHistory(undoHistoryMap[convId][fileObj.path]);
      }

      Vue.nextTick(() => {
        cm.refresh();
        setTimeout(() => cm.refresh(), 200);
      });

      debugStatus.value = '';
    } catch (err) {
      debugStatus.value = `Editor error: ${err.message}`;
      console.error('[FilesTab] createEditor:', err);
    }
  };

  const destroyEditor = () => {
    clearFindMarkers();
    const file = activeFile.value;
    if (file?.cmInstance) {
      file.cmInstance.toTextArea && file.cmInstance.toTextArea();
      file.cmInstance = null;
    }
    if (editorContainer.value) {
      editorContainer.value.innerHTML = '';
    }
  };

  const saveCurrentUndoHistory = () => {
    const convId = store.currentConversation;
    if (!convId) return;
    const file = activeFile.value;
    if (file?.cmInstance) {
      if (!undoHistoryMap[convId]) undoHistoryMap[convId] = {};
      undoHistoryMap[convId][file.path] = file.cmInstance.getHistory();
    }
  };

  const saveAllUndoHistory = (convId) => {
    if (!convId) return;
    const file = activeFile.value;
    if (file?.cmInstance) {
      if (!undoHistoryMap[convId]) undoHistoryMap[convId] = {};
      undoHistoryMap[convId][file.path] = file.cmInstance.getHistory();
    }
  };

  const cleanupUndoHistory = (convId, filePath) => {
    if (convId && undoHistoryMap[convId]) {
      delete undoHistoryMap[convId][filePath];
    }
  };

  const deleteConversationHistory = (convId) => {
    delete undoHistoryMap[convId];
  };

  return {
    debugStatus, undoHistoryMap,
    createEditor, destroyEditor, setKeyBindings,
    saveCurrentUndoHistory, saveAllUndoHistory,
    cleanupUndoHistory, deleteConversationHistory
  };
}
