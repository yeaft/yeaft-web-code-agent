import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createFileTree } from '../../web/components/files/fileTree.js';
import { createFolderPicker } from '../../web/components/files/folderPicker.js';

let picker;
let store;
let treePath;
let treeRootPath;
beforeEach(() => {
  vi.stubGlobal('Vue', Vue);
  store = { currentAgent: 'agent-1', currentConversation: 'session-1', clientId: 'client-1', sendWsMessage: vi.fn() };
  const tree = createFileTree(store, {
    getEffectiveWorkDir: () => 'C:/active', normalizePath: path => path.replace(/\\/g, '/'),
    selectedPaths: new Set(), lastClickedIndex: Vue.ref(-1), openFileInTab: vi.fn(), clearSelection: vi.fn(),
  });
  treePath = tree.treePath;
  treeRootPath = tree.treeRootPath;
  treePath.value = 'C:/active';
  treeRootPath.value = 'C:/active';
  picker = createFolderPicker(store, {
    getEffectiveWorkDir: () => 'C:/active', treePath,
    loadRootDirectory: tree.loadRootDirectory,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Workbench folder navigation outside the Session cwd', () => {
  it('changes only the Files tree when confirming another Agent folder', () => {
    picker.folderPickerPath.value = 'Q:/Projects';
    picker.folderPickerSelectItem({ name: 'picasso' });
    picker.confirmFolderPicker();
    expect(treePath.value).toBe('Q:/Projects/picasso');
    expect(treeRootPath.value).toBe('Q:/Projects/picasso');
    expect(store.sendWsMessage.mock.lastCall[0]).toMatchObject({
      conversationId: 'session-1', agentId: 'agent-1', dirPath: 'Q:/Projects/picasso', workDir: 'C:/active',
    });
  });
});
