// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

let createWsHandler;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createWsHandler } = await import('../../web/components/files/wsHandler.js'));
});

afterEach(() => vi.useRealTimers());

function harness() {
  const openFiles = Vue.ref([]);
  const activeFileIndex = Vue.ref(-1);
  const activeFile = Vue.computed(() => openFiles.value[activeFileIndex.value]);
  const cursor = vi.fn();
  const createEditor = vi.fn(file => {
    file.cmInstance = { setCursor: cursor, scrollIntoView: vi.fn(), focus: vi.fn() };
  });
  const openFileInTab = vi.fn((path, name, owner) => {
    openFiles.value.push({
      path, name, ...owner, requestId: 'read-1', loading: true,
      content: null, originalContent: null, fileType: 'text', cmInstance: null,
    });
    activeFileIndex.value = openFiles.value.length - 1;
  });
  const handler = createWsHandler({
    store: { currentAgent: 'agent-b', currentConversation: '_workbench:yeaft:agent-b:session-y' },
    normalizePath: path => path?.replace(/\\/g, '/'),
    getEffectiveWorkDir: () => '/fixture/project',
    openFiles, activeFileIndex, activeFile,
    fileSaving: Vue.ref(false), saveTabsState: vi.fn(), createEditor, openFileInTab,
    tree: {}, fp: {}, qo: {}, ops: { takePendingDownload: () => null },
    mdPreviewMode: Vue.ref(false), renderOfficeLocal: vi.fn(), editorContainer: Vue.ref(null),
    routeKey: 'yeaft:agent-b:session-y', workspaceGeneration: 'generation-1',
  });
  return { ...handler, openFiles, createEditor, cursor };
}

describe('Files response correlation', () => {
  it('loads an absolute file_content response into a relative tab by request id and reveals its line', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.handleOpenFile({ detail: {
      filePath: 'docs/guide.txt', agentId: 'agent-b',
      conversationId: '_workbench:yeaft:agent-b:session-y',
      workbenchRouteKey: 'yeaft:agent-b:session-y', workspaceGeneration: 'generation-1',
      line: 3,
    } });

    h.handleWorkbenchMessage({ detail: {
      type: 'file_content', requestId: 'read-1',
      filePath: '/fixture/project/docs/guide.txt', content: 'zero\none\ntarget',
      agentId: 'agent-b', conversationId: '_workbench:yeaft:agent-b:session-y',
      workbenchRouteKey: 'yeaft:agent-b:session-y', workbenchWorkspaceGeneration: 'generation-1',
    } });

    expect(h.openFiles.value[0]).toMatchObject({
      path: 'docs/guide.txt', content: 'zero\none\ntarget', loading: false,
    });
    await Vue.nextTick();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.createEditor).toHaveBeenCalledWith(h.openFiles.value[0]);
    expect(h.cursor).toHaveBeenCalledWith({ line: 2, ch: 0 });
  });

  it('does not accept a matching request id from a different conversation', () => {
    const h = harness();
    h.handleOpenFile({ detail: {
      filePath: 'docs/guide.txt', agentId: 'agent-b',
      conversationId: '_workbench:yeaft:agent-b:session-y',
      workbenchRouteKey: 'yeaft:agent-b:session-y', workspaceGeneration: 'generation-1',
    } });
    h.handleWorkbenchMessage({ detail: {
      type: 'file_content', requestId: 'read-1', filePath: '/fixture/project/docs/guide.txt',
      content: 'wrong', agentId: 'agent-b', conversationId: '_workbench:yeaft:agent-b:other',
      workbenchRouteKey: 'yeaft:agent-b:session-y', workbenchWorkspaceGeneration: 'generation-1',
    } });
    expect(h.openFiles.value[0]).toMatchObject({ loading: true, content: null });
  });
});
