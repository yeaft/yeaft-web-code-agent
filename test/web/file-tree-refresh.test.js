import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

let createFileTree;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createFileTree } = await import('../../web/components/files/fileTree.js'));
});

function createTree() {
  const sendWsMessage = vi.fn();
  const store = {
    currentConversation: 'session-1',
    currentAgent: 'agent-1',
    clientId: 'client-1',
    sendWsMessage,
  };
  const tree = createFileTree(store, {
    getEffectiveWorkDir: () => '/workspace',
    normalizePath: path => path.replace(/\\/g, '/').replace(/\/$/, '') || '/',
    selectedPaths: Vue.reactive(new Set()),
    lastClickedIndex: Vue.ref(-1),
    openFileInTab: vi.fn(),
    clearSelection: vi.fn(),
  });
  tree.treePath.value = '/workspace';
  tree.treeRootPath.value = '/workspace';
  return { tree, sendWsMessage };
}

function listing(dirPath, entries) {
  return { type: 'directory_listing', dirPath, entries };
}

describe('Files tree refresh', () => {
  it('reloads the root and every expanded directory without clearing expansion state', () => {
    const { tree, sendWsMessage } = createTree();
    tree.handleDirectoryListing(listing('/workspace', [
      { name: 'src', type: 'directory' },
      { name: 'docs', type: 'directory' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/src', [
      { name: 'components', type: 'directory' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/src/components', [
      { name: 'App.js', type: 'file' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/docs', [
      { name: 'README.md', type: 'file' },
    ]));
    tree.treeNodes['/workspace/docs'].expanded = false;
    sendWsMessage.mockClear();

    tree.refresh();

    expect(sendWsMessage.mock.calls.map(([message]) => message.dirPath)).toEqual([
      '/workspace',
      '/workspace/src',
      '/workspace/src/components',
    ]);
    expect(tree.treeNodes['/workspace'].expanded).toBe(true);
    expect(tree.treeNodes['/workspace/src'].expanded).toBe(true);
    expect(tree.treeNodes['/workspace/src/components'].expanded).toBe(true);
    expect(tree.treeNodes['/workspace/docs'].expanded).toBe(false);
    expect(tree.flattenedTree.value.map(entry => entry.path)).toEqual([
      '/workspace/docs',
      '/workspace/src',
      '/workspace/src/components',
      '/workspace/src/components/App.js',
    ]);
  });

  it('keeps the remaining tree usable when an expanded directory no longer exists', () => {
    const { tree, sendWsMessage } = createTree();
    tree.handleDirectoryListing(listing('/workspace', [
      { name: 'kept', type: 'directory' },
      { name: 'removed', type: 'directory' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/kept', [
      { name: 'kept.txt', type: 'file' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/removed', [
      { name: 'old.txt', type: 'file' },
    ]));
    sendWsMessage.mockClear();

    tree.refresh();
    tree.handleDirectoryListing(listing('/workspace', [
      { name: 'kept', type: 'directory' },
    ]));
    // The stale child can answer after its parent has already removed it.
    tree.handleDirectoryListing(listing('/workspace/removed', [
      { name: 'late.txt', type: 'file' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/kept', [
      { name: 'fresh.txt', type: 'file' },
    ]));

    expect(sendWsMessage.mock.calls.map(([message]) => message.dirPath)).toEqual([
      '/workspace',
      '/workspace/kept',
      '/workspace/removed',
    ]);
    expect(tree.treeNodes['/workspace/removed']).toBeUndefined();
    expect(tree.flattenedTree.value.map(entry => entry.path)).toEqual([
      '/workspace/kept',
      '/workspace/kept/fresh.txt',
    ]);
  });

  it('removes a missing expanded directory even when its parent listing is stale', () => {
    const { tree } = createTree();
    tree.handleDirectoryListing(listing('/workspace', [
      { name: 'removed', type: 'directory' },
    ]));
    tree.handleDirectoryListing(listing('/workspace/removed', [
      { name: 'old.txt', type: 'file' },
    ]));

    tree.handleDirectoryListing({
      type: 'directory_listing',
      dirPath: '/workspace/removed',
      entries: [],
      error: 'ENOENT: no such file or directory',
    });

    expect(tree.treeNodes['/workspace/removed']).toBeUndefined();
    expect(tree.flattenedTree.value).toEqual([]);
  });
});
