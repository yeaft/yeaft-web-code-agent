import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderPickerData, folderPickerMethods } from '../../web/components/mixins/folder-picker-mixin.js';
import { childDirectory, directoryBreadcrumbs, parentDirectory } from '../../web/utils/folder-picker-path.js';

function createPicker() {
  const sendWsMessage = vi.fn(() => true);
  const picker = {
    ...folderPickerData(),
    folderPickerAgentId: 'agent-1',
    defaultWorkDir: '/agent/default',
    chat: { sendWsMessage },
    folderPickerInitialDir: () => '/projects/yeaft',
    folderPickerSetWorkDir: vi.fn(),
    ...folderPickerMethods,
  };
  const reply = (extra = {}) => picker.handleFolderPickerMessage({ detail: {
    type: 'directory_listing', conversationId: '_workdir_picker',
    requestId: sendWsMessage.mock.lastCall[0].requestId,
    agentId: 'agent-1', dirPath: picker.folderPickerPath, entries: [], ...extra,
  } });
  return { picker, sendWsMessage, reply };
}

describe('shared work-directory picker workflow', () => {
  afterEach(() => vi.useRealTimers());

  it('uses only the Agent-scoped read-only pre-Session directory protocol', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage } = createPicker();
    picker.openFolderPicker();
    expect(sendWsMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'list_directory', conversationId: '_workdir_picker', directoryPickerScope: 'agent',
      requestId: expect.stringMatching(/^folder-picker-/), agentId: 'agent-1', dirPath: '/projects/yeaft',
    });
  });

  it('ignores responses and stops retries after cancellation', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage, reply } = createPicker();
    picker.openFolderPicker();
    picker.closeFolderPicker();
    reply({ dirPath: '/projects/late', entries: [{ name: 'late', type: 'directory' }] });
    vi.advanceTimersByTime(15000);
    expect(picker.folderPickerOpen).toBe(false);
    expect(picker.folderPickerEntries).toEqual([]);
    expect(picker.folderPickerPath).toBe('/projects/yeaft');
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it('only confirms a successfully loaded current directory, never a draft or an in-flight target', () => {
    vi.useFakeTimers();
    const { picker, reply } = createPicker();
    picker.openFolderPicker();
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).not.toHaveBeenCalled();
    reply();
    expect(picker.canConfirmFolderPicker()).toBe(true); // empty directory is valid
    picker.folderPickerEditPath('/another');
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).not.toHaveBeenCalled();
    picker.loadFolderPickerDir('/another');
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).not.toHaveBeenCalled();
    reply({ dirPath: '/canonical/another' });
    expect(picker.folderPickerDraft).toBe('/canonical/another');
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).toHaveBeenCalledExactlyOnceWith('/canonical/another');
    expect(picker.folderPickerOpen).toBe(false);
  });

  it('keeps an edited draft when an earlier path load finishes', () => {
    vi.useFakeTimers();
    const { picker, reply } = createPicker();
    picker.openFolderPicker();
    picker.folderPickerEditPath('/typing');
    reply();
    expect(picker.folderPickerDraft).toBe('/typing');
    expect(picker.canConfirmFolderPicker()).toBe(false);
  });

  it('shows permission/not-found errors without marking an empty result as valid, and allows retry', () => {
    vi.useFakeTimers();
    const { picker, reply, sendWsMessage } = createPicker();
    picker.openFolderPicker();
    const firstId = sendWsMessage.mock.lastCall[0].requestId;
    reply({ error: 'EACCES: permission denied' });
    expect(picker.folderPickerError).toBe('loadFailed');
    expect(picker.folderPickerErrorDetail).toContain('EACCES');
    expect(picker.folderPickerLoading).toBe(false);
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).not.toHaveBeenCalled();
    picker.loadFolderPickerDir(picker.folderPickerPath);
    expect(picker.folderPickerError).toBe('');
    expect(sendWsMessage.mock.lastCall[0].requestId).not.toBe(firstId);
    reply();
    expect(picker.canConfirmFolderPicker()).toBe(true);
  });

  it('retries once with a fresh request fence, then exposes a timeout instead of spinning forever', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage, reply } = createPicker();
    picker.openFolderPicker();
    const firstId = sendWsMessage.mock.lastCall[0].requestId;
    vi.advanceTimersByTime(5000);
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    expect(sendWsMessage.mock.lastCall[0].requestId).not.toBe(firstId);
    reply({ requestId: firstId });
    expect(picker.folderPickerLoaded).toBe(false);
    vi.advanceTimersByTime(15000);
    expect(sendWsMessage).toHaveBeenCalledTimes(2);
    expect(picker.folderPickerError).toBe('timeout');
    picker.loadFolderPickerDir(picker.folderPickerPath);
    reply();
    expect(picker.canConfirmFolderPicker()).toBe(true);
  });

  it('fails immediately on a disconnected send and can recover', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage, reply } = createPicker();
    sendWsMessage.mockReturnValueOnce(false);
    picker.openFolderPicker();
    expect(picker.folderPickerError).toBe('unavailable');
    expect(picker.folderPickerLoading).toBe(false);
    picker.loadFolderPickerDir('/projects/yeaft');
    reply();
    expect(picker.canConfirmFolderPicker()).toBe(true);
  });

  it('ignores stale paths, mismatched agents and stale successes/errors after reopening', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage, reply } = createPicker();
    picker.openFolderPicker();
    const oldId = sendWsMessage.mock.lastCall[0].requestId;
    picker.loadFolderPickerDir('/new');
    reply({ requestId: oldId, dirPath: '/old' });
    reply({ agentId: 'agent-2', error: 'wrong agent' });
    expect(picker.folderPickerLoading).toBe(true);
    expect(picker.folderPickerPath).toBe('/new');
    picker.folderPickerAgentId = 'agent-2';
    reply();
    expect(picker.folderPickerLoaded).toBe(false);
    picker.folderPickerAgentId = 'agent-1';
    picker.closeFolderPicker();
    picker.openFolderPicker();
    reply({ requestId: oldId, error: 'old failure' });
    expect(picker.folderPickerError).toBe('');
    reply();
    picker.folderPickerAgentId = 'agent-2';
    picker.confirmFolderPicker();
    expect(picker.folderPickerSetWorkDir).not.toHaveBeenCalled();
  });

  it('normalizes bare drive input and requires entering a drive before confirming', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage, reply } = createPicker();
    picker.openFolderPicker();
    picker.loadFolderPickerDir('');
    reply({ dirPath: '/', entries: [] });
    expect(picker.folderPickerDraft).toBe('/');
    expect(picker.canConfirmFolderPicker()).toBe(true);
    picker.loadFolderPickerDir('');
    reply({ dirPath: '', entries: [{ name: 'C:', type: 'directory' }] });
    expect(picker.canConfirmFolderPicker()).toBe(false);
    picker.loadFolderPickerDir('c:');
    expect(sendWsMessage.mock.lastCall[0].dirPath).toBe('c:\\');
    reply();
    expect(picker.canConfirmFolderPicker()).toBe(true);
  });
});

describe('directory navigation paths', () => {
  it('keeps POSIX / as a real root and exposes clickable ancestor targets', () => {
    expect(parentDirectory('/')).toBe('/');
    expect(parentDirectory('/home')).toBe('/');
    expect(childDirectory('/', 'home')).toBe('/home');
    expect(directoryBreadcrumbs('/home/user/projects/')).toEqual([
      { label: '/', path: '/' }, { label: 'home', path: '/home' },
      { label: 'user', path: '/home/user' }, { label: 'projects', path: '/home/user/projects' },
    ]);
    expect(childDirectory('/home', 'back\\slash')).toBe('/home/back\\slash');
  });

  it('handles drive roots, lowercase drives, slash paths and UNC share boundaries', () => {
    expect(childDirectory('', 'c:')).toBe('c:\\');
    expect(parentDirectory('C:\\')).toBe('');
    expect(parentDirectory('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentDirectory('d:/projects')).toBe('d:/');
    expect(childDirectory('d:/', 'projects')).toBe('d:/projects');
    expect(parentDirectory('\\\\server\\share\\folder')).toBe('\\\\server\\share\\');
    expect(directoryBreadcrumbs('\\\\server\\share')).toEqual([{ label: '\\\\server\\share\\', path: '\\\\server\\share\\' }]);
    expect(parentDirectory('\\\\server\\share\\')).toBe('');
  });
});
