// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import FilePreviewFallback from '../../web/components/files/FilePreviewFallback.js';
import { getFileType } from '../../web/components/files/fileEditor.js';
import { createFilePreview } from '../../web/components/files/filePreview.js';

let createWsHandler;

beforeAll(async () => {
  globalThis.Vue = Vue;
  ({ createWsHandler } = await import('../../web/components/files/wsHandler.js'));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

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
  const renderOfficeLocal = vi.fn();
  const handler = createWsHandler({
    store: { currentAgent: 'agent-b', currentConversation: '_workbench:yeaft:agent-b:session-y' },
    normalizePath: path => path?.replace(/\\/g, '/'),
    getEffectiveWorkDir: () => '/fixture/project',
    openFiles, activeFileIndex, activeFile,
    fileSaving: Vue.ref(false), saveTabsState: vi.fn(), createEditor, openFileInTab,
    tree: {}, fp: {}, qo: {}, ops: { takePendingDownload: () => null },
    textPreviewMode: Vue.ref(false), renderOfficeLocal, editorContainer: Vue.ref(null),
    routeKey: 'yeaft:agent-b:session-y', workspaceGeneration: 'generation-1',
  });
  return { ...handler, openFiles, createEditor, cursor, renderOfficeLocal };
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

function binaryHarness(name, mimeType) {
  const h = harness();
  h.handleOpenFile({ detail: {
    filePath: name, agentId: 'agent-b', conversationId: '_workbench:yeaft:agent-b:session-y',
    workbenchRouteKey: 'yeaft:agent-b:session-y', workspaceGeneration: 'generation-1',
  } });
  const send = overrides => h.handleWorkbenchMessage({ detail: {
    type: 'file_content', requestId: 'read-1', filePath: name, binary: true, mimeType,
    previewUrl: '/api/preview/private?token=secret', agentId: 'agent-b',
    conversationId: '_workbench:yeaft:agent-b:session-y', workbenchRouteKey: 'yeaft:agent-b:session-y',
    workbenchWorkspaceGeneration: 'generation-1', ...overrides,
  } });
  return { ...h, send, file: h.openFiles.value[0] };
}

describe('non-text preview response safety', () => {
  it('treats unknown binary replies as download-only and confirms MIME before media rendering', async () => {
    const unknown = binaryHarness('unknown.custom', 'application/octet-stream');
    unknown.send();
    expect(unknown.file).toMatchObject({ fileType: 'binary', previewLoading: false, content: null });
    expect(unknown.createEditor).not.toHaveBeenCalled();
    const audio = binaryHarness('track.mp3', 'audio/mpeg');
    audio.file.fileType = 'audio';
    audio.send();
    expect(audio.file).toMatchObject({ fileType: 'audio', previewLoading: true, blobUrl: expect.stringContaining('/api/preview/private?token=secret') });
    audio.send({ mimeType: 'text/html' });
    expect(audio.file).toMatchObject({ fileType: 'binary', previewLoading: false });
    const failed = binaryHarness('too-large.zip', 'application/octet-stream');
    failed.send({ error: 'too large', errorCode: 'FILE_PREVIEW_TOO_LARGE', errorDetails: { sizeBytes: 22000000 } });
    expect(failed.file).toMatchObject({ loading: false, previewLoading: false, loadError: 'files.previewTooLarge' });
    await Vue.nextTick();
    expect(unknown.createEditor).not.toHaveBeenCalled();
  });

  it('ignores legacy online mode and preserves local download on Office fetch failure', async () => {
    localStorage.setItem('officePreviewMode', 'online');
    const fetch = vi.fn(async () => ({ ok: false, status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const h = binaryHarness('private.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    h.file.fileType = 'office';
    h.send();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/preview/private?token=secret'));
    expect(fetch.mock.calls[0][0]).not.toContain('officeapps');
    expect(h.file).toMatchObject({ previewLoading: false, previewError: 'Preview request failed (403)', blobUrl: expect.any(String) });
    expect(h.file.previewUrl).toBeUndefined();
    expect(h.renderOfficeLocal).not.toHaveBeenCalled();
  });

  it('does not render a local Office fetch after its tab closes', async () => {
    let complete;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
    const h = binaryHarness('closed.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    h.file.fileType = 'office';
    h.send();
    h.openFiles.value = [];
    complete({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.file.localPreviewReady).toBeUndefined();
    expect(h.renderOfficeLocal).not.toHaveBeenCalled();
  });
});

describe('preview fallback UI', () => {
  it('classifies supported media without changing OGG and renders escaped, accessible download errors', async () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'flac']) expect(getFileType(`TRACK.${ext.toUpperCase()}`)).toBe('audio');
    expect(getFileType('track.ogg')).toBe('video');
    for (const ext of ['doc', 'ppt', 'pptx', 'zip', 'bin']) expect(getFileType(`private.${ext}`)).toBe('binary');
    expect(getFileType('README')).toBe('text');
    const wrapper = mount(FilePreviewFallback, {
      props: { file: { name: '<img src=x>.zip', mimeType: 'application/octet-stream' }, error: '<script>failed</script>' },
      global: { mocks: { $t: key => key } },
    });
    expect(wrapper.attributes('role')).toBe('alert');
    expect(wrapper.find('img, script').exists()).toBe(false);
    expect(wrapper.text()).toContain('ZIP');
    expect(wrapper.text()).toContain('<script>failed</script>');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('download')).toHaveLength(1);
    wrapper.unmount();
  });

  it('terminates local DOCX rendering when its renderer is unavailable or rejects', async () => {
    const scope = Vue.effectScope();
    const file = { name: 'private.docx', _arrayBuffer: new ArrayBuffer(8) };
    const active = Vue.ref(file);
    const preview = scope.run(() => createFilePreview(active, { editorContainer: Vue.ref(null), t: key => key }));
    preview.officePreviewContainer.value = document.createElement('div');
    const previousDocx = window.docx;
    try {
      window.docx = undefined;
      expect(await preview.renderOfficeLocal(active.value)).toBe(false);
      expect(active.value).toMatchObject({ previewLoading: false, previewError: 'files.previewUnavailable' });
      window.docx = { renderAsync: vi.fn(async () => { throw new Error('Invalid archive'); }) };
      expect(await preview.renderOfficeLocal(active.value)).toBe(false);
      expect(active.value).toMatchObject({ previewLoading: false, previewError: 'Invalid archive' });
    } finally { window.docx = previousDocx; scope.stop(); }
  });
});
