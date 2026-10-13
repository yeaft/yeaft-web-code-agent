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
});
