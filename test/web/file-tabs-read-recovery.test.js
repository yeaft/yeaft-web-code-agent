// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

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
  const tabs = createFileTabs(store, {
    normalizePath: path => path.replace(/\\/g, '/'),
    getEffectiveWorkDir: () => '/workspace',
    editorContainer: Vue.ref(null),
    createEditor: vi.fn(),
    destroyEditor: vi.fn(),
    clearFindMarkers: vi.fn(),
    saveCurrentUndoHistory: vi.fn(),
    saveAllUndoHistory: vi.fn(),
    cleanupUndoHistory: vi.fn(),
    deleteConversationHistory: vi.fn(),
    mdPreviewMode: Vue.ref(false),
    renderOfficeLocal: vi.fn(),
    performFind: vi.fn(),
    findBarVisible: Vue.ref(false),
    findQuery: Vue.ref(''),
    t: key => key,
  });
  return { tabs, sendWsMessage };
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
