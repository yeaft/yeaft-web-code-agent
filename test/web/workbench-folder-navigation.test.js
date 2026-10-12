import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createFileTree } from '../../web/components/files/fileTree.js';
import { createFolderPicker } from '../../web/components/files/folderPicker.js';
import { createFolderPicker as createGitFolderPicker } from '../../web/components/git/folderPicker.js';

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
  it.each([
    ['Q:/Projects', 'Q:/'], ['Q:/', ''],
    ['Q:\\Projects', 'Q:\\'], ['Q:\\', ''],
    ['\\\\server\\share\\folder', '\\\\server\\share\\'],
    ['\\\\server\\share\\', ''],
    ['/home/user', '/home'], ['/', '/'],
    ['/home/back\\slash/project', '/home/back\\slash'],
  ])('navigates up from %s without creating drive-relative paths', (path, parent) => {
    picker.folderPickerPath.value = path;
    picker.folderPickerNavigateUp();
    expect(picker.folderPickerPath.value).toBe(parent);
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      dirPath: parent, agentId: 'agent-1', workDir: 'C:/active',
    }));
    expect(treePath.value).toBe('C:/active');
  });

  describe.each(['files', 'git'])('%s picker directory errors', kind => {
    it('shows errors, prevents confirmation and retries the requested path without stale entries', () => {
      const selectedPath = kind === 'files' ? treePath : Vue.ref('C:/active');
      const refresh = vi.fn();
      const currentPicker = kind === 'files' ? picker : createGitFolderPicker(store, selectedPath);
      const receive = msg => kind === 'files'
        ? currentPicker.handleFolderPickerListing(msg)
        : currentPicker.handleDirectoryListing({ ...msg, conversationId: '_git_folder_picker' });
      const confirm = () => currentPicker.confirmFolderPicker(selectedPath, refresh);

      currentPicker.openFolderPicker();
      confirm();
      expect(selectedPath.value).toBe('C:/active');
      expect(currentPicker.folderPickerOpen.value).toBe(true);
      receive({ dirPath: 'C:/active', entries: [{ name: 'stale', type: 'directory' }] });
      currentPicker.folderPickerSelectItem({ name: 'stale' });
      currentPicker.folderPickerPath.value = 'Z:\\requested';
      currentPicker.loadFolderPickerDir('Z:\\requested');
      receive({ dirPath: '', entries: [], error: 'Drive enumeration failed' });
      expect(currentPicker.folderPickerLoading.value).toBe(false);
      expect(currentPicker.folderPickerError.value).toBe('Drive enumeration failed');
      expect(currentPicker.folderPickerPath.value).toBe('Z:\\requested');
      expect(currentPicker.folderPickerEntries.value).toEqual([]);
      expect(currentPicker.folderPickerSelected.value).toBe('');
      confirm();
      expect(selectedPath.value).toBe('C:/active');
      expect(currentPicker.folderPickerOpen.value).toBe(true);

      currentPicker.loadFolderPickerDir(currentPicker.folderPickerPath.value);
      expect(store.sendWsMessage.mock.lastCall[0].dirPath).toBe('Z:\\requested');
      expect(currentPicker.folderPickerError.value).toBe('');
      expect(currentPicker.folderPickerLoading.value).toBe(true);
      receive({ dirPath: 'Z:\\requested', entries: [{ name: 'project', type: 'directory' }, { name: 'file.txt', type: 'file' }] });
      expect(currentPicker.folderPickerEntries.value).toEqual([{ name: 'project', type: 'directory' }]);
      confirm();
      expect(selectedPath.value).toBe('Z:\\requested');
      expect(currentPicker.folderPickerOpen.value).toBe(false);

      receive({ dirPath: '', entries: [], error: 'Drive enumeration failed' });
      currentPicker.openFolderPicker();
      expect(currentPicker.folderPickerError.value).toBe('');
    });

    it('distinguishes a successful empty drive list from enumeration failure', () => {
      const currentPicker = kind === 'files' ? picker : createGitFolderPicker(store, Vue.ref('C:/active'));
      currentPicker.folderPickerPath.value = '';
      currentPicker.loadFolderPickerDir('');
      const msg = { dirPath: '', entries: [] };
      if (kind === 'files') currentPicker.handleFolderPickerListing(msg);
      else currentPicker.handleDirectoryListing({ ...msg, conversationId: '_git_folder_picker' });
      expect(currentPicker.folderPickerLoading.value).toBe(false);
      expect(currentPicker.folderPickerError.value).toBe('');
      expect(currentPicker.folderPickerEntries.value).toEqual([]);
    });
  });

  it.each([
    ['', 'q:', 'q:\\'], ['Q:/', 'Projects', 'Q:/Projects'],
    ['Q:\\', 'Projects', 'Q:\\Projects'],
    ['\\\\server\\share\\', 'Projects', '\\\\server\\share\\Projects'],
    ['/', 'home', '/home'], ['/home/back\\slash', 'project', '/home/back\\slash/project'],
  ])('enters %s + %s using native separators', (path, name, expected) => {
    picker.folderPickerPath.value = path;
    picker.folderPickerEnter({ name });
    expect(picker.folderPickerPath.value).toBe(expected);
    expect(store.sendWsMessage.mock.lastCall[0].dirPath).toBe(expected);
  });

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
