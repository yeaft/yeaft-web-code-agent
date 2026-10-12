// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { normalizeBrowserPath } from '../../web/utils/folder-picker-path.js';

let createFileTabs;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createFileTabs } = await import('../../web/components/files/fileTabs.js'));
});

function harness(sendWsMessage = vi.fn(() => true)) {
  const store = {
    currentAgent: 'agent-a',
    currentConversation: 'conversation-a',
    clientId: 'client-a',
    sendWsMessage,
  };
  const onReselect = vi.fn();
  const tabs = createFileTabs(store, {
    onReselect,
    normalizePath: path => normalizeBrowserPath(path, '/workspace'),
    getEffectiveWorkDir: () => '/workspace',
    editorContainer: Vue.ref(null),
    createEditor: vi.fn(),
    destroyEditor: vi.fn(),
    clearFindMarkers: vi.fn(),
    saveCurrentUndoHistory: vi.fn(),
    saveAllUndoHistory: vi.fn(),
    cleanupUndoHistory: vi.fn(),
    deleteConversationHistory: vi.fn(),
    textPreviewMode: Vue.ref(false),
    renderOfficeLocal: vi.fn(),
    performFind: vi.fn(),
    findBarVisible: Vue.ref(false),
    findQuery: Vue.ref(''),
    t: key => key,
  });
  return { tabs, sendWsMessage, onReselect };
}

const route = {
  agentId: 'agent-a',
  conversationId: 'conversation-a',
  workDir: '/workspace',
};

describe('file tab read recovery', () => {
  it.each([
    ['q:/work/deep/file.txt', 'Q:/Work/Deep/File.txt'],
    ['//server/share/work/deep/file.txt', '//Server/Share/Work/Deep/File.txt'],
  ])('reuses the dirty Windows buffer and its undo key when opening listing spelling %s', (reference, listing) => {
    const { tabs, sendWsMessage } = harness();
    tabs.openFileInTab(reference);
    const original = tabs.activeFile.value;
    original.content = 'unsaved edit';
    original.originalContent = 'disk content';
    original.isDirty = true;
    original.loading = false;
    const undoOwnerPath = original.path;
    tabs.openFileInTab('/workspace/other.txt');
    tabs.openFileInTab(listing, 'File.txt');
    expect(tabs.openFiles.value).toHaveLength(2);
    expect(tabs.activeFile.value).toBe(original);
    expect(original).toMatchObject({ path: undoOwnerPath, content: 'unsaved edit', originalContent: 'disk content', isDirty: true });
    expect(sendWsMessage.mock.calls.filter(([msg]) => msg.type === 'read_file').map(([msg]) => msg.filePath))
      .toEqual([reference, '/workspace/other.txt']);
    tabs.saveTabsState('conversation-a');
    tabs.restoreTabsState('conversation-a');
    tabs.openFileInTab(listing);
    expect(tabs.openFiles.value).toHaveLength(2);
    expect(tabs.activeFile.value).toMatchObject({ path: undoOwnerPath, content: 'unsaved edit', isDirty: true });
  });
  it('keeps Windows identities scoped to Agent and conversation', () => {
    const { tabs } = harness();
    tabs.openFileInTab('q:/work/file.txt');
    tabs.openFileInTab('Q:/Work/File.txt', '', { agentId: 'agent-b' });
    tabs.openFileInTab('Q:/Work/File.txt', '', { conversationId: 'conversation-b' });
    expect(tabs.openFiles.value).toHaveLength(3);
  });
  it('keeps distinct POSIX case and literal backslashes as separate file identities', () => {
    const { tabs } = harness();
    for (const path of ['/workspace/File.txt', '/workspace/file.txt', '/workspace/back\\slash.txt', '/workspace/back/slash.txt']) {
      tabs.openFileInTab(path);
    }
    expect(tabs.openFiles.value.map(file => file.path)).toEqual([
      '/workspace/File.txt', '/workspace/file.txt', '/workspace/back\\slash.txt', '/workspace/back/slash.txt',
    ]);
  });
  it('reselects an active tab for tree navigation without touching edits or requesting content', () => {
    const { tabs, sendWsMessage, onReselect } = harness();
    tabs.openFileInTab('/workspace/file.txt');
    const file = tabs.activeFile.value;
    file.content = 'unsaved';
    file.isDirty = true;
    tabs.switchToTab(0);
    tabs.openFileInTab('/workspace/file.txt');
    expect(onReselect.mock.calls).toEqual([['/workspace/file.txt'], ['/workspace/file.txt']]);
    expect(file.content).toBe('unsaved');
    expect(file.isDirty).toBe(true);
    expect(sendWsMessage.mock.calls.filter(([msg]) => msg.type === 'read_file')).toHaveLength(1);
  });
  it('shows a synchronous error when the read cannot be sent and retries with a new correlated request', () => {
    const sendWsMessage = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const { tabs } = harness(sendWsMessage);

    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    const file = tabs.activeFile.value;
    const failedRequestId = file.requestId;
    expect(file).toMatchObject({
      loading: false,
      content: null,
      loadError: 'files.readSendFailed',
    });

    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    const reads = sendWsMessage.mock.calls.map(([message]) => message)
      .filter(message => message.type === 'read_file');
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatchObject({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      filePath: 'docs/readme.txt',
      workDir: '/workspace',
      _clientId: 'client-a',
    });
    expect(reads[1].requestId).not.toBe(failedRequestId);
    expect(file).toMatchObject({ loading: true, loadError: null, requestId: reads[1].requestId });
  });

  it('interrupts pending reads on disconnect and allows another click without reloading successful tabs', () => {
    const { tabs, sendWsMessage } = harness();
    tabs.openFileInTab('docs/loaded.txt', 'loaded.txt', route);
    const loaded = tabs.activeFile.value;
    loaded.content = 'saved content';
    loaded.loading = false;
    const loadedRequestId = loaded.requestId;
    tabs.openFileInTab('docs/pending.txt', 'pending.txt', route);
    const pending = tabs.activeFile.value;
    const oldRequestId = pending.requestId;
    tabs.interruptFileReads();
    expect(pending).toMatchObject({ loading: false, content: null, loadError: 'files.readInterrupted' });
    expect(pending.requestId).not.toBe(oldRequestId);
    expect(loaded).toMatchObject({ content: 'saved content', loadError: null, requestId: loadedRequestId });
    tabs.openFileInTab('docs/pending.txt', 'pending.txt', route);
    expect(pending).toMatchObject({ loading: true, loadError: null });
    const reads = sendWsMessage.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'read_file');
    expect(reads).toHaveLength(3);
    expect(reads[2].requestId).not.toBe(oldRequestId);
  });

  it('does not duplicate an in-flight read or retry over dirty and loaded content', () => {
    const { tabs, sendWsMessage } = harness();
    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    const file = tabs.activeFile.value;
    const requestId = file.requestId;

    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    expect(sendWsMessage.mock.calls.map(([message]) => message.type).filter(type => type === 'read_file')).toHaveLength(1);
    expect(file.requestId).toBe(requestId);

    file.loading = false;
    file.loadError = 'timed out';
    file.content = 'local edit';
    file.originalContent = 'server content';
    file.isDirty = true;
    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    expect(sendWsMessage.mock.calls.map(([message]) => message.type).filter(type => type === 'read_file')).toHaveLength(1);
    expect(file).toMatchObject({ content: 'local edit', originalContent: 'server content', isDirty: true });

    file.isDirty = false;
    tabs.openFileInTab('docs/readme.txt', 'readme.txt', route);
    expect(sendWsMessage.mock.calls.map(([message]) => message.type).filter(type => type === 'read_file')).toHaveLength(1);
    expect(file.content).toBe('local edit');
  });
});
