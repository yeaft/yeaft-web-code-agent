/**
 * SessionCreateModal — workdir folder-picker WS protocol contract.
 *
 * Pins the wire shape that the folder-browser button sends and accepts.
 * Doesn't mount the component — just calls the methods directly with a
 * stub `this` so we can assert the WS payload + the directory_listing
 * reducer without dragging Vue, VpAvatar, or the real Pinia store into
 * the test environment.
 *
 * The `requestFolderPickerDir` / `handleFolderPickerMessage` method
 * names are part of the contract — the rewrite to chat-style layout
 * (task-session-create-chat-style) must preserve them so the agent's
 * `_workdir_picker` conversation id stays the same on both ends.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Stub Pinia BEFORE dynamic-importing the component, otherwise
// `import VpAvatar -> import { useVpStore } from '../stores/vp.js'`
// throws at module-load with `Pinia is not defined`.
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let SessionCreateModal;
beforeAll(async () => {
  SessionCreateModal = (await import('../../web/components/SessionCreateModal.js')).default;
});

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
