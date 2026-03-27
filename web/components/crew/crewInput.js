/**
 * crewInput — Composable factory for input handling, @-mention, slash-command autocomplete, file upload, message sending.
 */

import { DEFAULT_SLASH_COMMANDS, getCommandDescription, buildGroupedCommands } from '../../utils/slash-commands.js';

export function createCrewInput(store, authStore, { getInputRef, getFileInputRef, getCurrentPendingAsk }) {
  const inputText = Vue.ref('');
  const attachments = Vue.ref([]);
  const uploading = Vue.ref(false);
  const atMenuVisible = Vue.ref(false);
  const atQuery = Vue.ref('');
  const atMenuIndex = Vue.ref(0);

  // Slash command autocomplete state
  const slashMenuVisible = Vue.ref(false);
  const slashMenuIndex = Vue.ref(0);

  const canSend = Vue.computed(() => {
    const hasContent = inputText.value.trim() || attachments.value.length > 0;
    const notUploading = !uploading.value && attachments.value.every(a => a.fileId);
    return hasContent && notUploading;
  });

  const filteredAtRoles = Vue.computed(() => {
    if (!atMenuVisible.value) return [];
    const roles = store.currentCrewSession?.roles || [];
    const q = atQuery.value.toLowerCase();
    if (!q) return roles;
    return roles.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.displayName.toLowerCase().includes(q)
    );
  });

  // Slash command autocomplete computed properties (mirrors ChatInput.js logic)
  // Crew mode: use current conversation (crew session id) for per-session commands,
  // fallback to agent-level, then defaults
  const availableCommands = Vue.computed(() => {
    const convId = store.currentConversation;
    const agentId = store.currentAgent;
    const dynamic = (convId && store.slashCommandsMap[convId])
      || (agentId && store.slashCommandsMap[`agent:${agentId}`])
      || [];
    const commands = dynamic.length > 0 ? dynamic : DEFAULT_SLASH_COMMANDS;
    return commands.map(cmd => cmd.startsWith('/') ? cmd : '/' + cmd);
  });

  const slashFlatItems = Vue.computed(() => {
    const text = inputText.value.trim();
    if (!text.startsWith('/')) return [];
    const prefix = text.toLowerCase();
    return availableCommands.value
      .filter(cmd => cmd.toLowerCase().startsWith(prefix) && cmd.toLowerCase() !== prefix)
      .map(cmd => ({
        cmd,
        desc: getCommandDescription(cmd, store.slashCommandDescriptions)
      }));
  });

  const slashGroupedCommands = Vue.computed(() => buildGroupedCommands(slashFlatItems.value));

  const slashFilteredCommands = Vue.computed(() => slashFlatItems.value.map(item => item.cmd));

  function autoResize() {
    const textarea = getInputRef();
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  }

  function handleInput() {
    autoResize();
    const textarea = getInputRef();
    if (!textarea) return;
    const text = inputText.value;

    // Check slash command autocomplete first (only when input starts with / and has no spaces)
    const trimmed = text.trim();
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      slashMenuVisible.value = true;
      slashMenuIndex.value = 0;
      atMenuVisible.value = false;
      return;
    }
    slashMenuVisible.value = false;

    // Check @-mention
    const pos = textarea.selectionStart;
    const beforeCursor = text.substring(0, pos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeCursor[atIdx - 1]))) {
      const query = beforeCursor.substring(atIdx + 1);
      if (!/\s/.test(query)) {
        atQuery.value = query;
        atMenuVisible.value = true;
        atMenuIndex.value = 0;
        return;
      }
    }
    atMenuVisible.value = false;
  }

  function selectSlashCommand(cmd) {
    inputText.value = cmd + ' ';
    slashMenuVisible.value = false;
    Vue.nextTick(() => {
      getInputRef()?.focus();
    });
  }

  function selectAtRole(role) {
    const textarea = getInputRef();
    if (!textarea) return;
    const pos = textarea.selectionStart;
    const text = inputText.value;
    const beforeCursor = text.substring(0, pos);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const afterCursor = text.substring(pos);
      inputText.value = text.substring(0, atIdx) + '@' + role.displayName + ' ' + afterCursor;
      Vue.nextTick(() => {
        const newPos = atIdx + role.displayName.length + 2;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
      });
    }
    atMenuVisible.value = false;
  }

  function handleKeydown(e, sendMessage) {
    // Slash command autocomplete keyboard navigation
    if (slashMenuVisible.value && slashFilteredCommands.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuIndex.value = (slashMenuIndex.value + 1) % slashFilteredCommands.value.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuIndex.value = (slashMenuIndex.value - 1 + slashFilteredCommands.value.length) % slashFilteredCommands.value.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        selectSlashCommand(slashFilteredCommands.value[slashMenuIndex.value]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashMenuVisible.value = false;
        return;
      }
    }

    // @-mention keyboard navigation
    if (atMenuVisible.value && filteredAtRoles.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atMenuIndex.value = (atMenuIndex.value + 1) % filteredAtRoles.value.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atMenuIndex.value = (atMenuIndex.value - 1 + filteredAtRoles.value.length) % filteredAtRoles.value.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectAtRole(filteredAtRoles.value[atMenuIndex.value]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        atMenuVisible.value = false;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function onBlur() {
    setTimeout(() => {
      slashMenuVisible.value = false;
    }, 150);
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    e.target.value = '';
    Vue.nextTick(() => getInputRef()?.focus());
  }

  async function addFiles(files) {
    for (const file of files) {
      const attachment = { file, name: file.name, preview: null, uploading: true, fileId: null };
      if (file.type.startsWith('image/')) attachment.preview = URL.createObjectURL(file);
      attachments.value.push(attachment);
    }
    uploading.value = true;
    try {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const headers = {};
      if (authStore?.token) headers['Authorization'] = `Bearer ${authStore.token}`;
      const response = await fetch('/api/upload', { method: 'POST', headers, body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const result = await response.json();
      let resultIndex = 0;
      for (const attachment of attachments.value) {
        if (attachment.uploading && !attachment.fileId && resultIndex < result.files.length) {
          attachment.fileId = result.files[resultIndex].fileId;
          attachment.uploading = false;
          resultIndex++;
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      const failed = attachments.value.filter(a => !a.fileId);
      for (const f of failed) { if (f.preview) URL.revokeObjectURL(f.preview); }
      attachments.value = attachments.value.filter(a => a.fileId);
    } finally {
      uploading.value = false;
      Vue.nextTick(() => getInputRef()?.focus());
    }
  }

  function removeAttachment(index) {
    const attachment = attachments.value[index];
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    attachments.value.splice(index, 1);
    Vue.nextTick(() => getInputRef()?.focus());
  }

  function sendMessage(e, scrollToBottom) {
    if (e && e.preventDefault) e.preventDefault();
    if (!canSend.value) return;

    slashMenuVisible.value = false;

    const text = inputText.value.trim();

    // Intercept /btw side question
    if (text.startsWith('/btw ')) {
      store.sendBtwQuestion(text.substring(5));
      inputText.value = '';
      delete store.inputDrafts[store.currentConversation];
      const textarea = getInputRef();
      if (textarea) textarea.style.height = 'auto';
      return;
    }

    const attachmentInfos = attachments.value
      .filter(a => a.fileId)
      .map(a => ({
        fileId: a.fileId,
        name: a.name,
        preview: a.preview,
        isImage: a.file?.type?.startsWith('image/') || false,
        mimeType: a.file?.type || ''
      }));

    // AskUserQuestion answers are now handled by AskCard component's submit event,
    // no longer intercepted here in the input handler.

    store.sendCrewMessage(text, null, attachmentInfos.length > 0 ? attachmentInfos : undefined);
    inputText.value = '';
    attachments.value = [];
    delete store.inputDrafts[store.currentConversation];
    const textarea = getInputRef();
    if (textarea) textarea.style.height = 'auto';
    if (scrollToBottom) {
      Vue.nextTick(() => scrollToBottom());
    }
  }

  function saveDraft(convId) {
    if (convId && inputText.value) {
      store.inputDrafts[convId] = inputText.value;
    }
  }

  function restoreDraft(convId) {
    inputText.value = (convId && store.inputDrafts[convId]) || '';
  }

  return {
    inputText,
    attachments,
    uploading,
    atMenuVisible,
    atQuery,
    atMenuIndex,
    canSend,
    filteredAtRoles,
    // Slash command autocomplete
    slashMenuVisible,
    slashMenuIndex,
    slashFlatItems,
    slashGroupedCommands,
    slashFilteredCommands,
    selectSlashCommand,
    onBlur,
    // Methods
    handleInput,
    selectAtRole,
    handleKeydown,
    handlePaste,
    handleFileSelect,
    addFiles,
    removeAttachment,
    sendMessage,
    saveDraft,
    restoreDraft
  };
}
