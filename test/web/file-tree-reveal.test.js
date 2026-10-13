import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { normalizeBrowserPath } from '../../web/utils/folder-picker-path.js';

let createFileTree;
let watchFilesConnection;
beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createFileTree } = await import('../../web/components/files/fileTree.js'));
  ({ watchFilesConnection } = await import('../../web/components/FilesTab.js'));
});
function setup({ workDir = '/workspace', workspaceLocked = false, send = true } = {}) {
  const selectedPaths = Vue.reactive(new Set(['/workspace/selected.txt']));
  const onReveal = vi.fn();
  const sendWsMessage = vi.fn(() => send);
  const tree = createFileTree({ currentAgent: 'agent', currentConversation: 'session', sendWsMessage }, {
    getEffectiveWorkDir: () => workDir,
    normalizePath: path => normalizeBrowserPath(path, workDir),
    selectedPaths, lastClickedIndex: Vue.ref(-1), openFileInTab: vi.fn(),
    clearSelection: () => selectedPaths.clear(), workspaceLocked, onReveal,
  });
  tree.initFileBrowser();
  const reply = (entries = [], error, request = sendWsMessage.mock.lastCall[0]) => tree.handleDirectoryListing({
    dirPath: request.dirPath, requestId: request.requestId, entries, error,
  });
  return { tree, selectedPaths, onReveal, sendWsMessage, reply };
}
const dir = name => ({ name, type: 'directory' });
const file = name => ({ name, type: 'file' });

function connectionHarness(runtimeProvider = 'yeaft', initial = {}) {
  const state = Vue.reactive({ connectionState: 'connected', authenticated: true,
    workbenchRouteProtocolSupported: true, workCenterWorkbenchProtocolSupported: true, ...initial });
  const h = setup();
  const tabs = { interruptFileReads: vi.fn() };
  const scope = Vue.effectScope();
  scope.run(() => watchFilesConnection(state, { tree: h.tree, tabs, runtimeProvider }));
  return { ...h, state, tabs, scope };
}

describe('Files directory transport handshake', () => {
  it('fences immediately and waits for authentication plus hello acknowledgement to retry', async () => {
    const h = connectionHarness();
    try {
      h.tree.revealPath('/workspace/file.txt');
      const oldRequest = h.sendWsMessage.mock.lastCall[0];
      h.state.connectionState = 'disconnected';
      h.reply([file('old.txt')], undefined, oldRequest);
      expect(h.tree.flattenedTree.value).toEqual([]);
      expect(h.tree.treeNodes['/workspace'].loading).toBe(false);
      expect(h.tabs.interruptFileReads).toHaveBeenCalledTimes(1);
      h.state.authenticated = false;
      h.state.workbenchRouteProtocolSupported = null;
      h.state.connectionState = 'connected';
      await Vue.nextTick();
      expect(h.sendWsMessage).toHaveBeenCalledTimes(1);
      h.tree.revealPath('/workspace/file.txt');
      expect(h.sendWsMessage).toHaveBeenCalledTimes(1);
      h.state.authenticated = true;
      h.state.workbenchRouteProtocolSupported = false;
      await Vue.nextTick();
      expect(h.sendWsMessage).toHaveBeenCalledTimes(1);
      h.state.workbenchRouteProtocolSupported = true;
      await Vue.nextTick();
      expect(h.sendWsMessage).toHaveBeenCalledTimes(2);
      expect(h.sendWsMessage.mock.lastCall[0].requestId).not.toBe(oldRequest.requestId);
      h.reply([file('file.txt')]);
      expect(h.tree.navigationPath.value).toBe('/workspace/file.txt');
      h.reply([file('old.txt')], undefined, oldRequest);
      expect(h.tree.navigationPath.value).toBe('/workspace/file.txt');
      expect(h.tree.flattenedTree.value.map(entry => entry.name)).toEqual(['file.txt']);
    } finally { h.scope.stop(); }
  });
});

describe('Files tree reveal', () => {
  it('fences interrupted root and ancestor requests and resumes the current reveal on reconnect', () => {
    const { tree, reply, sendWsMessage } = setup();
    const lostRoot = sendWsMessage.mock.lastCall[0];
    tree.revealPath('a/file.txt');
    tree.interruptDirectoryLoads();
    expect(tree.getTreeNode('/workspace').loading).toBe(false);
    reply([dir('old')], undefined, lostRoot);
    expect(tree.flattenedTree.value).toEqual([]);
    tree.resumeDirectoryLoads();
    const retryRoot = sendWsMessage.mock.lastCall[0];
    expect(retryRoot.requestId).not.toBe(lostRoot.requestId);
    reply([], 'ENOENT: no such file', lostRoot);
    expect(tree.getTreeNode('/workspace').loading).toBe(true);
    reply([dir('a')], undefined, retryRoot);
    const lostAncestor = sendWsMessage.mock.lastCall[0];
    tree.interruptDirectoryLoads();
    expect(tree.getTreeNode('/workspace/a').loading).toBe(false);
    tree.resumeDirectoryLoads();
    const retryAncestor = sendWsMessage.mock.lastCall[0];
    expect(retryAncestor.requestId).not.toBe(lostAncestor.requestId);
    reply([], 'ENOENT: no such file', lostAncestor);
    reply([file('file.txt')], undefined, retryAncestor);
    expect(tree.navigationPath.value).toBe('/workspace/a/file.txt');
    expect(sendWsMessage).toHaveBeenCalledTimes(4);
  });

  it('does not rebase or request outside a locked workspace, including prefix and dot escapes', () => {
    const { tree, reply, sendWsMessage } = setup({ workspaceLocked: true });
    reply([file('inside.txt')]);
    for (const path of ['/outside/file.txt', '/workspace-other/file.txt', '../file.txt', '/workspace/../../file.txt']) {
      expect(tree.revealPath(path)).toBe(false);
    }
    expect(tree.canNavigateTo('/')).toBe(false);
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(tree.treeRootPath.value).toBe('/workspace');
    expect(tree.revealPath('inside.txt')).toBe(true);
    expect(tree.navigationPath.value).toBe('/workspace/inside.txt');
  });
});
