import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { browserPathKey, directoryBreadcrumbs, normalizeBrowserPath, parentDirectory } from '../../web/utils/folder-picker-path.js';

let createFileTree;
beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createFileTree } = await import('../../web/components/files/fileTree.js'));
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

describe('Files navigation paths', () => {
  it.each([
    ['Q:/', 'Q:/'], ['Q:\\deep\\file.txt', 'Q:/deep/file.txt'],
    ['\\\\server\\share\\deep\\file.txt', '//server/share/deep/file.txt'],
    ['//server/share', '//server/share/'],
    ['/home/back\\slash/file.txt', '/home/back\\slash/file.txt'],
    ['src/../deep/file.txt', '/workspace/deep/file.txt'],
    ['../../file.txt', '/file.txt'],
  ])('normalizes %s without node:path', (input, expected) => {
    expect(normalizeBrowserPath(input, '/workspace')).toBe(expected);
  });
  it('keeps drive and UNC roots and resolves relative paths from Windows workDir', () => {
    expect(parentDirectory('Q:/file.txt')).toBe('Q:/');
    expect(parentDirectory('//server/share/file.txt')).toBe('//server/share/');
    expect(normalizeBrowserPath('deep\\file.txt', 'Q:/work')).toBe('Q:/work/deep/file.txt');
    expect(directoryBreadcrumbs('/home/back\\slash/file.txt').map(crumb => crumb.label)).toEqual(['/', 'home', 'back\\slash', 'file.txt']);
  });
});

describe('Files tree reveal', () => {
  it('loads deep ancestors sequentially, highlights only after membership is known and clears bulk selection', async () => {
    const { tree, reply, sendWsMessage, selectedPaths, onReveal } = setup();
    tree.revealPath('a/b/file.txt');
    expect(selectedPaths.size).toBe(0);
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    reply([dir('a')]);
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe('/workspace/a');
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    reply([dir('b')]);
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe('/workspace/a/b');
    reply([file('file.txt')]);
    expect(tree.flattenedTree.value.map(entry => entry.path)).toContain('/workspace/a/b/file.txt');
    expect(tree.navigationPath.value).toBe('/workspace/a/b/file.txt');
    await Vue.nextTick();
    expect(onReveal).toHaveBeenCalledWith('/workspace/a/b/file.txt');
  });
  it('reveals folders including the root without turning navigation into bulk delete selection', () => {
    const { tree, reply, selectedPaths } = setup();
    reply([dir('a')]);
    tree.revealPath('/workspace/a', 'directory');
    reply([file('nested.txt')]);
    expect(tree.navigationPath.value).toBe('/workspace/a');
    expect(tree.treeNodes['/workspace/a'].expanded).toBe(true);
    tree.revealPath('/workspace', 'directory');
    expect(tree.navigationPath.value).toBe('/workspace');
    expect(selectedPaths.size).toBe(0);
  });
  it('does not let old reveal completions or scroll callbacks steal a new selection', async () => {
    const { tree, reply, onReveal } = setup();
    reply([dir('old'), file('current.txt')]);
    tree.revealPath('/workspace/old/file.txt');
    tree.revealPath('/workspace/current.txt');
    reply([file('file.txt')]);
    await Vue.nextTick();
    expect(tree.navigationPath.value).toBe('/workspace/current.txt');
    expect(onReveal.mock.calls).toEqual([['/workspace/current.txt']]);
    tree.revealPath('/workspace/current.txt');
    tree.revealPath('/workspace', 'directory');
    await Vue.nextTick();
    expect(onReveal.mock.lastCall).toEqual(['/workspace']);
  });
  it.each(['ENOENT: no such file', 'EACCES: permission denied'])('terminates on %s and allows a new intent to retry', error => {
    const { tree, reply, sendWsMessage } = setup();
    reply([dir('a')]);
    tree.revealPath('/workspace/a/b/file.txt');
    reply([], error);
    expect(tree.navigationPath.value).toBe('');
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    tree.revealPath('/workspace', 'directory');
    expect(tree.navigationPath.value).toBe('/workspace');
  });
  it('stops on missing listing membership and failed transport, not an ancestor-request loop', () => {
    const { tree, reply, sendWsMessage } = setup();
    tree.revealPath('/workspace/missing/file.txt');
    reply([]);
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(tree.navigationPath.value).toBe('');
    const failed = setup({ send: false });
    failed.tree.revealPath('/workspace/file.txt');
    expect(failed.sendWsMessage).toHaveBeenCalledTimes(2);
    expect(failed.tree.treeNodes['/workspace'].loading).toBe(false);
  });
  it('cancels a pending reveal on a newer bulk-selection intent', async () => {
    const { tree, reply, selectedPaths, onReveal } = setup();
    reply([dir('a'), file('current.txt')]);
    tree.revealPath('/workspace/a/file.txt');
    tree.onTreeItemClick(tree.flattenedTree.value.find(entry => entry.name === 'current.txt'), { ctrlKey: true });
    reply([file('file.txt')]);
    await Vue.nextTick();
    expect(selectedPaths.has('/workspace/current.txt')).toBe(true);
    expect(tree.navigationPath.value).toBe('');
    expect(onReveal).not.toHaveBeenCalled();
  });
  it('retries a failed ancestor only for a fresh intent', () => {
    const { tree, reply, sendWsMessage } = setup();
    reply([dir('a')]);
    tree.revealPath('/workspace/a/file.txt');
    reply([], 'EACCES: permission denied');
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    tree.revealPath('/workspace/a/file.txt');
    expect(sendWsMessage).toHaveBeenCalledTimes(3);
    reply([file('file.txt')]);
    expect(tree.navigationPath.value).toBe('/workspace/a/file.txt');
  });
  it('rebases ordinary external files, fences old root listings and never changes workDir', () => {
    const { tree, reply, sendWsMessage } = setup();
    const oldRoot = sendWsMessage.mock.lastCall[0];
    tree.revealPath('/outside/deep/external.txt');
    expect(tree.treeRootPath.value).toBe('/outside/deep');
    reply([file('external.txt')]);
    reply([dir('late')], undefined, oldRoot);
    expect(tree.navigationPath.value).toBe('/outside/deep/external.txt');
    expect(tree.treeNodes['/workspace']).toBeUndefined();
    expect(sendWsMessage.mock.calls.every(([message]) => message.workDir === '/workspace')).toBe(true);
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
  it.each(['Q:/', '//server/share/', '/home/back\\slash'])('reveals child filenames under %s', workDir => {
    const { tree, reply } = setup({ workDir });
    tree.revealPath('file.txt');
    reply([file('file.txt')]);
    expect(tree.navigationPath.value).toBe(normalizeBrowserPath('file.txt', workDir));
  });
  it.each([
    ['Q:/Work', 'q:/work/deep/nested/file.txt'],
    ['//Server/Share/Work', '//server/share/work/deep/nested/file.txt'],
    ['Q:/', 'q:/deep/nested/file.txt'],
    ['//Server/Share/', '//server/share/deep/nested/file.txt'],
  ])('matches Windows identities under %s while retaining listing spelling', async (workDir, target) => {
    const { tree, reply, sendWsMessage, onReveal, selectedPaths } = setup({ workDir });
    const rootRequest = sendWsMessage.mock.lastCall[0];
    // Root and directory replies may use another spelling than the request.
    tree.revealPath(target);
    reply([dir('Deep')], undefined, { ...rootRequest, dirPath: workDir.toLowerCase() });
    const deep = normalizeBrowserPath('Deep', workDir);
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe(deep);
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    reply([dir('Nested')], undefined, { ...sendWsMessage.mock.lastCall[0], dirPath: deep.toUpperCase() });
    const nested = `${deep}/Nested`;
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe(nested);
    reply([file('File.txt')]);
    expect(tree.navigationPath.value).toBe(`${nested}/File.txt`);
    expect(tree.flattenedTree.value.map(entry => entry.path)).toEqual([deep, nested, `${nested}/File.txt`]);
    await Vue.nextTick();
    expect(onReveal).toHaveBeenCalledWith(`${nested}/File.txt`);
    expect(selectedPaths.size).toBe(0);
    tree.revealPath(`${target.slice(0, target.lastIndexOf('/'))}`, 'directory');
    expect(tree.navigationPath.value).toBe(nested);
    tree.revealPath(workDir.toLowerCase(), 'directory');
    expect(tree.navigationPath.value).toBe(tree.treeRootPath.value);
    expect(sendWsMessage).toHaveBeenCalledTimes(3);
  });
  it.each(['Q:/Work', '//Server/Share/Work'])('fences mixed-case refresh/missing replies and removes stale subtrees under %s', async workDir => {
    const { tree, reply, sendWsMessage } = setup({ workDir });
    reply([dir('Deep')]);
    tree.revealPath('deep/file.txt');
    reply([file('File.txt')]);
    const deep = `${workDir}/Deep`;
    tree.refresh();
    const stale = sendWsMessage.mock.lastCall[0];
    tree.refresh();
    const fresh = sendWsMessage.mock.lastCall[0];
    reply([file('File.txt')], undefined, { ...fresh, dirPath: deep.toLowerCase() });
    reply([], 'ENOENT: no such file', { ...stale, dirPath: deep.toUpperCase() });
    expect(tree.getTreeNode(deep).entries.map(entry => entry.name)).toEqual(['File.txt']);
    tree.revealPath('DEEP/FILE.TXT');
    expect(tree.navigationPath.value).toBe(''); // still awaiting the root refresh
    const refreshedRoot = sendWsMessage.mock.calls.map(([message]) => message)
      .filter(message => browserPathKey(message.dirPath) === browserPathKey(workDir)).at(-1);
    reply([dir('Deep')], undefined, { ...refreshedRoot, dirPath: workDir.toLowerCase() });
    expect(tree.navigationPath.value).toBe(`${deep}/File.txt`);
    tree.refresh();
    const removedRequest = sendWsMessage.mock.lastCall[0];
    const rootRequest = sendWsMessage.mock.calls.map(([message]) => message)
      .filter(message => browserPathKey(message.dirPath) === browserPathKey(workDir)).at(-1);
    reply([], undefined, { ...rootRequest, dirPath: workDir.toUpperCase() });
    reply([file('late.txt')], undefined, { ...removedRequest, dirPath: deep.toLowerCase() });
    await Vue.nextTick();
    expect(tree.getTreeNode(deep)).toBeUndefined();
    expect(tree.flattenedTree.value).toEqual([]);
    expect(tree.navigationPath.value).toBe('');
    expect(Object.keys(tree.treeNodes)).toEqual([browserPathKey(workDir)]);
  });
  it.each(['Q:/Work', '//Server/Share/Work'])('retries mixed-case errors only for fresh intent in locked %s', workDir => {
    const { tree, reply, sendWsMessage } = setup({ workDir, workspaceLocked: true });
    reply([dir('Deep')]);
    tree.revealPath(`${workDir.toLowerCase()}/deep/file.txt`);
    reply([], 'EACCES: permission denied');
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    tree.revealPath(`${workDir.toUpperCase()}/DEEP/FILE.TXT`);
    expect(sendWsMessage).toHaveBeenCalledTimes(3);
    reply([file('File.txt')]);
    expect(tree.navigationPath.value).toBe(`${workDir}/Deep/File.txt`);
    expect(tree.revealPath(`${workDir.toLowerCase()}-other/file.txt`)).toBe(false);
    expect(tree.treeRootPath.value).toBe(workDir);
  });
  it('does not conflate POSIX case or backslashes during reveal', () => {
    const { tree, reply, sendWsMessage } = setup({ workDir: '/Work/back\\slash' });
    reply([dir('Deep'), dir('deep')]);
    tree.revealPath('deep/file.txt');
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe('/Work/back\\slash/deep');
    reply([file('File.txt')]);
    expect(tree.navigationPath.value).toBe('');
    tree.revealPath('deep/File.txt');
    expect(tree.navigationPath.value).toBe('/Work/back\\slash/deep/File.txt');
    tree.revealPath('Deep/file.txt');
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe('/Work/back\\slash/Deep');
    reply([file('file.txt')]);
    expect(tree.navigationPath.value).toBe('/Work/back\\slash/Deep/file.txt');
  });
  it('cancels a pending reveal when the root changes or the component is disposed', async () => {
    const { tree, reply, onReveal } = setup();
    reply([dir('a')]);
    tree.revealPath('/workspace/a/file.txt');
    tree.clearTreeNodes();
    reply([file('file.txt')]);
    await Vue.nextTick();
    expect(tree.navigationPath.value).toBe('');
    expect(onReveal).not.toHaveBeenCalled();
  });
});
