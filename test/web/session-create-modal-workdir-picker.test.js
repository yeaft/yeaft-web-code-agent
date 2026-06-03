import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionCreateModal from '../../web/components/SessionCreateModal.js';

describe('SessionCreateModal workdir picker protocol', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the existing workdir picker conversation id when requesting directories', () => {
    vi.useFakeTimers();
    const sent = [];
    const ctx = {
      folderPickerAgentId: 'agent-1',
      chat: { sendWsMessage: msg => sent.push(msg) },
      defaultWorkDir: '/repo',
      _folderPickerTimer: null,
      folderPickerLoading: false,
      folderPickerOpen: false,
      requestFolderPickerDir: SessionCreateModal.methods.requestFolderPickerDir,
    };

    SessionCreateModal.methods.requestFolderPickerDir.call(ctx, '/repo/src');

    expect(sent).toEqual([{
      type: 'list_directory',
      conversationId: '_workdir_picker',
      agentId: 'agent-1',
      dirPath: '/repo/src',
      workDir: '/repo',
    }]);
    expect(sent[0].conversationId).not.toBe('_yeaft_session_workdir_picker');
    if (ctx._folderPickerTimer) clearTimeout(ctx._folderPickerTimer);
  });

  it('accepts directory listings from the existing workdir picker conversation id', () => {
    vi.useFakeTimers();
    const ctx = {
      _folderPickerTimer: setTimeout(() => {}, 1000),
      folderPickerLoading: true,
      folderPickerEntries: [],
      folderPickerPath: '',
    };

    SessionCreateModal.methods.handleFolderPickerMessage.call(ctx, {
      detail: {
        type: 'directory_listing',
        conversationId: '_workdir_picker',
        dirPath: '/repo',
        entries: [
          { name: 'zeta', type: 'directory' },
          { name: 'file.txt', type: 'file' },
          { name: 'alpha', type: 'directory' },
        ],
      },
    });

    expect(ctx._folderPickerTimer).toBeNull();
    expect(ctx.folderPickerLoading).toBe(false);
    expect(ctx.folderPickerPath).toBe('/repo');
    expect(ctx.folderPickerEntries).toEqual([
      { name: 'alpha', type: 'directory' },
      { name: 'zeta', type: 'directory' },
    ]);
  });
});
